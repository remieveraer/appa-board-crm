"use strict";
/**
 * Client PostgreSQL minimal, 100% Node.js natif (net/tls/crypto) — sans le
 * paquet npm "pg".
 *
 * Pourquoi : l'accès au registre npm public (registry.npmjs.org) est bloqué
 * dans cet environnement (403), et le miroir interne observé dans le cache
 * (artifactory.infra.ant.dev) refuse aussi l'accès anonyme aux paquets
 * génériques comme "pg" (401). Plutôt que de bloquer tout le projet sur un
 * accès réseau qu'on ne contrôle pas, ce module réimplémente uniquement ce
 * dont ce serveur a besoin du protocole de câblage PostgreSQL ("wire
 * protocol" v3), dans le même esprit "zéro dépendance" que le serveur
 * d'authentification déjà en place (src/auth.js, src/sessions.js).
 *
 * Couvre : connexion TCP + upgrade TLS optionnel (sslmode=require, requis
 * par Scalingo en production), authentification SCRAM-SHA-256 (RFC 5802 /
 * RFC 7677 — méthode par défaut de PostgreSQL 14+ et de Scalingo), repli
 * MD5 et mot de passe en clair pour compatibilité, requêtes simples (DDL,
 * migrations) et requêtes paramétrées (protocole étendu Parse/Bind/
 * Execute/Sync — évite toute injection SQL par concaténation de chaînes).
 *
 * Ne couvre PAS (volontairement, hors besoin de ce projet) : pooling
 * avancé multi-connexions concurrentes sur un même client, LISTEN/NOTIFY,
 * COPY, transactions imbriquées, formats binaires (tout circule en texte —
 * largement suffisant pour ce volume de données et beaucoup plus simple à
 * auditer).
 */

const net = require("net");
const tls = require("tls");
const crypto = require("crypto");
const { EventEmitter } = require("events");

// ---------- Constantes protocole ----------

const AUTH_OK = 0;
const AUTH_CLEARTEXT = 3;
const AUTH_MD5 = 5;
const AUTH_SASL = 10;
const AUTH_SASL_CONTINUE = 11;
const AUTH_SASL_FINAL = 12;

// ---------- Utilitaires bas niveau : construction de messages ----------

function buildMessage(type, payload) {
  // type: null pour un message sans octet de type (uniquement le message de démarrage / SSLRequest)
  const len = 4 + payload.length;
  const header = Buffer.alloc(type ? 5 : 4);
  let offset = 0;
  if (type) {
    header.write(type, 0, "ascii");
    offset = 1;
  }
  header.writeInt32BE(len, offset);
  return Buffer.concat([header, payload]);
}

function cString(str) {
  return Buffer.concat([Buffer.from(str, "utf8"), Buffer.from([0])]);
}

function buildStartupMessage(user, database) {
  const parts = [
    cString("user"), cString(user),
    cString("database"), cString(database),
    cString("client_encoding"), cString("UTF8"),
    Buffer.from([0]),
  ];
  const body = Buffer.concat(parts);
  const len = 4 + 4 + body.length; // longueur + version protocole + body
  const buf = Buffer.alloc(len);
  buf.writeInt32BE(len, 0);
  buf.writeInt32BE(196608, 4); // 3.0 << 16
  body.copy(buf, 8);
  return buf;
}

const SSL_REQUEST = (() => {
  const buf = Buffer.alloc(8);
  buf.writeInt32BE(8, 0);
  buf.writeInt32BE(80877103, 4); // code magique SSLRequest
  return buf;
})();

// ---------- SCRAM-SHA-256 (RFC 5802 / RFC 7677) ----------

function randomNonce() {
  return crypto.randomBytes(18).toString("base64");
}

function hmac(key, data) {
  return crypto.createHmac("sha256", key).update(data).digest();
}

function sha256(data) {
  return crypto.createHash("sha256").update(data).digest();
}

function xorBuffers(a, b) {
  const out = Buffer.alloc(a.length);
  for (let i = 0; i < a.length; i++) out[i] = a[i] ^ b[i];
  return out;
}

function saltedPassword(password, salt, iterations) {
  return crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256");
}

// ---------- Parsing d'un flux de messages backend ----------

class MessageReader extends EventEmitter {
  // File d'attente (queue) plutôt qu'un simple emit direct : plusieurs
  // messages backend arrivent très souvent dans un seul paquet TCP (ex. une
  // RowDescription + plusieurs DataRow + CommandComplete + ReadyForQuery
  // pour une petite requête). Avec un emit direct + listener .once() côté
  // consommateur, seul le premier message d'un même paquet serait reçu et
  // les suivants seraient silencieusement perdus (le buffer les a déjà
  // consommés). La queue garantit qu'aucun message n'est perdu, quel que
  // soit le découpage TCP.
  constructor() {
    super();
    this.buffer = Buffer.alloc(0);
    this.queue = [];
  }
  push(chunk) {
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, chunk]) : chunk;
    this._drain();
  }
  _drain() {
    // Chaque message backend : 1 octet type + int32 longueur (longueur inclut ces 4 octets, pas le type)
    for (;;) {
      if (this.buffer.length < 5) break;
      const type = String.fromCharCode(this.buffer[0]);
      const len = this.buffer.readInt32BE(1);
      const total = 1 + len;
      if (this.buffer.length < total) break;
      const payload = this.buffer.subarray(5, total);
      this.buffer = this.buffer.subarray(total);
      this.queue.push({ type, payload });
    }
    if (this.queue.length) this.emit("readable");
  }
  /** Retire et renvoie le prochain message déjà en file, ou null s'il n'y en a pas. */
  shift() {
    return this.queue.length ? this.queue.shift() : null;
  }
}

// ---------- Client ----------

class PgClient {
  /**
   * @param {object} opts { host, port, user, password, database, ssl }
   *   ssl: false | true | { rejectUnauthorized: boolean }
   */
  constructor(opts) {
    this.opts = opts;
    this.socket = null;
    this.reader = new MessageReader();
    this.connected = false;
    this._connectPromise = null;
    // La connexion est une seule socket TCP partagée : le protocole de câblage PostgreSQL exige
    // qu'une requête soit entièrement écrite puis entièrement lue avant d'en démarrer une autre sur
    // la même connexion (sinon les réponses de deux requêtes concurrentes s'entrelacent et se
    // corrompent mutuellement — bug réel constaté le 28/09/2026 : plusieurs `db.list()` déclenchés
    // en parallèle par le sondage ~5s du board renvoyaient une erreur "undefined n'est pas un JSON
    // valide" sur certaines collections). _queue sérialise donc tous les appels à query()/
    // simpleQuery() sur cette instance : chacun attend son tour plutôt que de s'exécuter en parallèle.
    this._queue = Promise.resolve();
  }

  _enqueue(fn) {
    const run = this._queue.then(fn, fn);
    this._queue = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  static fromConnectionString(connStr) {
    const u = new URL(connStr);
    const sslParam = u.searchParams.get("sslmode");
    let ssl = false;
    if (sslParam && sslParam !== "disable") {
      ssl = { rejectUnauthorized: sslParam !== "no-verify" && sslParam !== "require" };
      // "require" chez Scalingo : chiffré mais chaîne de certification interne
      // non nécessairement vérifiable depuis l'extérieur — on chiffre quand
      // même le trafic (protège la donnée en transit) sans forcer la
      // vérification de certificat, sauf sslmode=verify-full explicite.
      if (sslParam === "verify-full" || sslParam === "verify-ca") ssl.rejectUnauthorized = true;
    }
    return new PgClient({
      host: u.hostname,
      port: u.port ? parseInt(u.port, 10) : 5432,
      user: decodeURIComponent(u.username),
      password: decodeURIComponent(u.password),
      database: u.pathname.replace(/^\//, ""),
      ssl,
    });
  }

  async connect() {
    if (this._connectPromise) return this._connectPromise;
    this._connectPromise = this._connect();
    return this._connectPromise;
  }

  async _connect() {
    const { host, port, user, password, database, ssl } = this.opts;
    let socket = net.connect({ host, port });
    await new Promise((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });

    if (ssl) {
      socket.write(SSL_REQUEST);
      const sslResp = await new Promise((resolve, reject) => {
        socket.once("data", resolve);
        socket.once("error", reject);
      });
      if (sslResp[0] === 0x53 /* 'S' */) {
        socket = await new Promise((resolve, reject) => {
          const tlsSocket = tls.connect(
            { socket, rejectUnauthorized: ssl.rejectUnauthorized !== false, servername: host },
            () => resolve(tlsSocket)
          );
          tlsSocket.once("error", reject);
        });
      } else if (sslResp[0] === 0x4e /* 'N' */) {
        // le serveur refuse le chiffrement — on continue en clair (dev local)
      } else {
        throw new Error("Réponse SSLRequest inattendue du serveur PostgreSQL");
      }
    }

    this.socket = socket;
    socket.on("data", (chunk) => this.reader.push(chunk));
    socket.on("error", (err) => this.emit && this.emit("error", err));

    socket.write(buildStartupMessage(user, database));
    await this._handleAuth(password);
    await this._waitForReadyForQuery();
    this.connected = true;
  }

  _nextMessage() {
    // Sert d'abord depuis la file déjà remplie (cas courant : plusieurs
    // messages reçus dans le même paquet TCP) — n'attend un nouvel
    // événement "readable" que si la file est vide.
    const queued = this.reader.shift();
    if (queued) return Promise.resolve(queued);
    return new Promise((resolve, reject) => {
      const onReadable = () => {
        cleanup();
        const msg = this.reader.shift();
        if (msg) resolve(msg);
        else this._nextMessage().then(resolve, reject); // course rare : reboucle proprement
      };
      const onErr = (err) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error("Connexion PostgreSQL fermée de manière inattendue"));
      };
      const cleanup = () => {
        this.reader.removeListener("readable", onReadable);
        this.socket.removeListener("error", onErr);
        this.socket.removeListener("close", onClose);
      };
      this.reader.once("readable", onReadable);
      this.socket.once("error", onErr);
      this.socket.once("close", onClose);
    });
  }

  async _handleAuth(password) {
    let scramState = null;
    for (;;) {
      const { type, payload } = await this._nextMessage();
      if (type === "E") throw new Error(parseErrorResponse(payload));
      if (type !== "R") continue; // ParameterStatus etc. avant auth : ignorer
      const authType = payload.readInt32BE(0);

      if (authType === AUTH_OK) {
        return;
      }
      if (authType === AUTH_CLEARTEXT) {
        this.socket.write(buildMessage("p", cString(password)));
        continue;
      }
      if (authType === AUTH_MD5) {
        const salt = payload.subarray(4, 8);
        const inner = crypto
          .createHash("md5")
          .update(password + this.opts.user)
          .digest("hex");
        const outer = crypto
          .createHash("md5")
          .update(Buffer.concat([Buffer.from(inner, "utf8"), salt]))
          .digest("hex");
        this.socket.write(buildMessage("p", cString("md5" + outer)));
        continue;
      }
      if (authType === AUTH_SASL) {
        const mechs = payload.subarray(4).toString("utf8").split("\0").filter(Boolean);
        if (!mechs.includes("SCRAM-SHA-256")) {
          throw new Error("Le serveur PostgreSQL ne propose pas SCRAM-SHA-256 (mécanismes: " + mechs.join(",") + ")");
        }
        const clientNonce = randomNonce();
        const clientFirstBare = `n=,r=${clientNonce}`;
        const clientFirst = `n,,${clientFirstBare}`;
        scramState = { clientNonce, clientFirstBare };
        const body = Buffer.concat([cString("SCRAM-SHA-256"), Buffer.alloc(4), Buffer.from(clientFirst, "utf8")]);
        body.writeInt32BE(Buffer.byteLength(clientFirst, "utf8"), cString("SCRAM-SHA-256").length);
        this.socket.write(buildMessage("p", body));
        continue;
      }
      if (authType === AUTH_SASL_CONTINUE) {
        const serverFirst = payload.subarray(4).toString("utf8");
        const params = Object.fromEntries(serverFirst.split(",").map((kv) => [kv[0], kv.slice(2)]));
        const { r: combinedNonce, s: saltB64, i: iterStr } = params;
        if (!combinedNonce.startsWith(scramState.clientNonce)) {
          throw new Error("SCRAM: nonce serveur invalide (possible interception)");
        }
        const iterations = parseInt(iterStr, 10);
        const salt = Buffer.from(saltB64, "base64");
        const sp = saltedPassword(password, salt, iterations);
        const clientKey = hmac(sp, "Client Key");
        const storedKey = sha256(clientKey);
        const clientFinalWithoutProof = `c=biws,r=${combinedNonce}`;
        const authMessage = `${scramState.clientFirstBare},${serverFirst},${clientFinalWithoutProof}`;
        const clientSignature = hmac(storedKey, authMessage);
        const clientProof = xorBuffers(clientKey, clientSignature);
        const clientFinal = `${clientFinalWithoutProof},p=${clientProof.toString("base64")}`;

        const serverKey = hmac(sp, "Server Key");
        scramState.expectedServerSignature = hmac(serverKey, authMessage).toString("base64");

        this.socket.write(buildMessage("p", Buffer.from(clientFinal, "utf8")));
        continue;
      }
      if (authType === AUTH_SASL_FINAL) {
        const serverFinal = payload.subarray(4).toString("utf8");
        const params = Object.fromEntries(serverFinal.split(",").map((kv) => [kv[0], kv.slice(2)]));
        if (scramState && params.v && params.v !== scramState.expectedServerSignature) {
          throw new Error("SCRAM: signature serveur invalide (possible interception) — connexion refusée");
        }
        continue; // l'AuthenticationOk suit dans un message séparé
      }
      throw new Error("Méthode d'authentification PostgreSQL non supportée (code " + authType + ")");
    }
  }

  async _waitForReadyForQuery() {
    for (;;) {
      const { type, payload } = await this._nextMessage();
      if (type === "E") throw new Error(parseErrorResponse(payload));
      if (type === "Z") return;
      // S (ParameterStatus), K (BackendKeyData), N (NoticeResponse) : ignorés
    }
  }

  /** Requête simple, sans paramètres — pour DDL/migrations. Renvoie {rows} de la dernière commande. */
  async simpleQuery(sql) {
    return this._enqueue(() => this._simpleQuery(sql));
  }
  async _simpleQuery(sql) {
    this.socket.write(buildMessage("Q", cString(sql)));
    let columns = null;
    let rows = [];
    let allResults = [];
    for (;;) {
      const { type, payload } = await this._nextMessage();
      if (type === "E") {
        await this._waitForReadyForQuery().catch(() => {});
        throw new Error(parseErrorResponse(payload));
      }
      if (type === "T") {
        columns = parseRowDescription(payload);
      } else if (type === "D") {
        rows.push(parseDataRow(payload, columns));
      } else if (type === "C") {
        allResults.push({ rows, command: payload.toString("utf8").replace(/\0$/, "") });
        rows = [];
        columns = null;
      } else if (type === "Z") {
        return allResults.length ? allResults[allResults.length - 1] : { rows: [], command: "" };
      }
      // I (EmptyQueryResponse), N (NoticeResponse) : ignorés
    }
  }

  /**
   * Requête paramétrée (protocole étendu) — $1, $2... dans sql, valeurs en
   * texte dans params (null autorisé). Toujours sûr vis-à-vis de
   * l'injection SQL : les valeurs ne sont jamais concaténées dans le texte
   * de la requête, elles voyagent dans des messages Bind séparés.
   */
  async query(sql, params = []) {
    return this._enqueue(() => this._query(sql, params));
  }
  async _query(sql, params = []) {
    const parseMsg = buildMessage(
      "P",
      Buffer.concat([cString(""), cString(sql), Buffer.from([0, 0])]) // 0 types de paramètres déclarés : le serveur les infère
    );

    const paramBuffers = params.map((p) => {
      if (p === null || p === undefined) return null;
      return Buffer.from(String(p), "utf8");
    });
    const bindParts = [cString(""), cString("")]; // portal="", statement=""
    const formatCodesHeader = Buffer.alloc(2);
    formatCodesHeader.writeInt16BE(0, 0); // 0 format codes = tout en texte
    bindParts.push(formatCodesHeader);
    const numParamsBuf = Buffer.alloc(2);
    numParamsBuf.writeInt16BE(paramBuffers.length, 0);
    bindParts.push(numParamsBuf);
    for (const buf of paramBuffers) {
      if (buf === null) {
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeInt32BE(-1, 0);
        bindParts.push(lenBuf);
      } else {
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeInt32BE(buf.length, 0);
        bindParts.push(lenBuf, buf);
      }
    }
    const resultFormatHeader = Buffer.alloc(2);
    resultFormatHeader.writeInt16BE(0, 0); // 0 = tous les résultats en texte
    bindParts.push(resultFormatHeader);
    const bindMsg = buildMessage("B", Buffer.concat(bindParts));

    const describeMsg = buildMessage("D", Buffer.concat([Buffer.from("P", "ascii"), cString("")]));
    const executeMsg = buildMessage("E", Buffer.concat([cString(""), Buffer.alloc(4)]));
    const syncMsg = buildMessage("S", Buffer.alloc(0));

    this.socket.write(Buffer.concat([parseMsg, bindMsg, describeMsg, executeMsg, syncMsg]));

    let columns = null;
    let rows = [];
    let error = null;
    for (;;) {
      const { type, payload } = await this._nextMessage();
      if (type === "E") {
        error = new Error(parseErrorResponse(payload));
      } else if (type === "T") {
        columns = parseRowDescription(payload);
      } else if (type === "D") {
        rows.push(parseDataRow(payload, columns));
      } else if (type === "Z") {
        if (error) throw error;
        return { rows };
      }
      // 1 (ParseComplete), 2 (BindComplete), C (CommandComplete), n (NoData) : ignorés
    }
  }

  async end() {
    if (!this.socket) return;
    try {
      this.socket.write(buildMessage("X", Buffer.alloc(0)));
    } catch (e) {
      // déjà fermé, tant pis
    }
    this.socket.end();
    this.connected = false;
  }
}

// EventEmitter minimal pour les erreurs socket post-connexion (évite un crash Node si personne n'écoute)
Object.setPrototypeOf(PgClient.prototype, EventEmitter.prototype);

function parseRowDescription(payload) {
  let offset = 0;
  const count = payload.readInt16BE(offset);
  offset += 2;
  const cols = [];
  for (let i = 0; i < count; i++) {
    const nameEnd = payload.indexOf(0, offset);
    const name = payload.subarray(offset, nameEnd).toString("utf8");
    offset = nameEnd + 1 + 18; // nom\0 + tableOid(4) + colAttr(2) + typeOid(4) + typeLen(2) + typeMod(4) + formatCode(2) = 18 octets après le \0
    cols.push(name);
  }
  return cols;
}

function parseDataRow(payload, columns) {
  let offset = 0;
  const count = payload.readInt16BE(offset);
  offset += 2;
  const row = {};
  for (let i = 0; i < count; i++) {
    const len = payload.readInt32BE(offset);
    offset += 4;
    const colName = columns ? columns[i] : String(i);
    if (len === -1) {
      row[colName] = null;
    } else {
      row[colName] = payload.subarray(offset, offset + len).toString("utf8");
      offset += len;
    }
  }
  return row;
}

function parseErrorResponse(payload) {
  const fields = {};
  let offset = 0;
  while (offset < payload.length) {
    const code = String.fromCharCode(payload[offset]);
    offset += 1;
    if (code === "\0") break;
    const end = payload.indexOf(0, offset);
    fields[code] = payload.subarray(offset, end).toString("utf8");
    offset = end + 1;
  }
  const parts = [];
  if (fields.S) parts.push(fields.S);
  if (fields.C) parts.push(`[${fields.C}]`);
  if (fields.M) parts.push(fields.M);
  if (fields.D) parts.push(`— ${fields.D}`);
  return parts.join(" ") || "Erreur PostgreSQL inconnue";
}

module.exports = { PgClient };
