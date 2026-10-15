"use strict";
/**
 * Couche d'accès générique aux "collections" du board, au-dessus du client
 * PostgreSQL maison (src/pg-client.js). Reproduit côté serveur le même
 * modèle que le board utilisait déjà côté client avec
 * db.collection(x).doc(id) — une seule table "documents" (collection, id,
 * data JSONB), donc aucune migration de schéma nécessaire quand une
 * nouvelle collection apparaît dans board.html.
 *
 * Un seul PgClient est réutilisé pour toute la durée de vie du process
 * (pas de pool — le volume attendu est ~6 utilisateurs en interne, une
 * seule connexion series suffit largement ; à revoir si la volumétrie
 * change significativement). Une reconnexion automatique est tentée si la
 * connexion tombe (ex. redémarrage de la base côté Scalingo).
 */
const crypto = require("crypto");
const { PgClient } = require("./pg-client");

let client = null;
let connectingPromise = null;

function connString() {
  return (
    process.env.DATABASE_URL || "postgres://appa_dev:appa_dev_local@localhost:5432/appa_board_dev"
  );
}

async function getClient() {
  if (client && client.connected) return client;
  if (connectingPromise) return connectingPromise;
  connectingPromise = (async () => {
    const c = PgClient.fromConnectionString(connString());
    c.on("error", (err) => {
      console.error("Connexion PostgreSQL perdue, reconnexion à la prochaine requête:", err.message);
      client = null;
    });
    await c.connect();
    client = c;
    connectingPromise = null;
    return c;
  })();
  return connectingPromise;
}

function newId() {
  return crypto.randomBytes(12).toString("hex");
}

/** Liste tous les documents d'une collection. `sinceMs` (optionnel) : uniquement ceux modifiés après ce timestamp (ms epoch) — utilisé par le polling incrémental côté client. */
async function list(collection, sinceMs) {
  const c = await getClient();
  const r = sinceMs
    ? await c.query(
        "SELECT id, data, extract(epoch from updated_at) * 1000 as updated_at_ms FROM documents WHERE collection = $1 AND updated_at > to_timestamp($2::double precision / 1000) ORDER BY updated_at ASC",
        [collection, sinceMs]
      )
    : await c.query(
        "SELECT id, data, extract(epoch from updated_at) * 1000 as updated_at_ms FROM documents WHERE collection = $1 ORDER BY updated_at ASC",
        [collection]
      );
  return r.rows.map(rowToDoc);
}

/** Noms de toutes les collections présentes en base (lecture seule — utilisé par l'export de sauvegarde). */
async function listCollections() {
  const c = await getClient();
  const r = await c.query("SELECT DISTINCT collection FROM documents ORDER BY collection ASC");
  return r.rows.map((row) => row.collection);
}

/** Un document précis, ou null s'il n'existe pas. */
async function get(collection, id) {
  const c = await getClient();
  const r = await c.query(
    "SELECT id, data, extract(epoch from updated_at) * 1000 as updated_at_ms FROM documents WHERE collection = $1 AND id = $2",
    [collection, id]
  );
  return r.rows.length ? rowToDoc(r.rows[0]) : null;
}

/** Crée un document — id fourni ou généré automatiquement. Écrase si l'id existe déjà (comportement "set"). */
async function add(collection, data, id) {
  const c = await getClient();
  const docId = id || newId();
  await c.query(
    "INSERT INTO documents (collection, id, data, updated_at) VALUES ($1, $2, $3::jsonb, now()) " +
      "ON CONFLICT (collection, id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()",
    [collection, docId, JSON.stringify(data)]
  );
  return get(collection, docId);
}

/** Remplace intégralement un document (équivalent .set()). */
async function set(collection, id, data) {
  return add(collection, data, id);
}

/** Fusionne (shallow merge) des champs dans un document existant — équivalent .update(). Échoue si le document n'existe pas. */
async function update(collection, id, patch) {
  const c = await getClient();
  const r = await c.query(
    "UPDATE documents SET data = data || $3::jsonb, updated_at = now() WHERE collection = $1 AND id = $2 RETURNING id",
    [collection, id, JSON.stringify(patch)]
  );
  if (!r.rows.length) {
    const err = new Error(`Document introuvable: ${collection}/${id}`);
    err.code = "NOT_FOUND";
    throw err;
  }
  return get(collection, id);
}

/** Supprime un document. */
async function remove(collection, id) {
  const c = await getClient();
  await c.query("DELETE FROM documents WHERE collection = $1 AND id = $2", [collection, id]);
}

function rowToDoc(row) {
  return {
    id: row.id,
    data: JSON.parse(row.data),
    updatedAt: Math.round(parseFloat(row.updated_at_ms)),
  };
}

module.exports = { list, get, add, set, update, remove, listCollections, getClient, newId };
