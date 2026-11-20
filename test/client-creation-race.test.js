"use strict";
/**
 * Test de non-régression — bug signalé par Rémi le 20/11/2026 :
 * "A CHAQUE FOIS QUE JE REMPLI UN CLIENT IL ME EFFACE UN °_°" — deux
 * créations de client quasi simultanées dans deux onglets différents
 * calculaient le même "prochain" numéro de contrat côté client
 * (clients.filter(c=>c.type===type).length + 1), et la seconde écrasait
 * silencieusement toute la fiche de la première (ex. MOCHKAREFF Yves
 * perdu par ISSOREL RENE, tous deux CLF-2026-217, prouvé par le journal
 * d'audit : MOCHKAREFF créé + 7 modifications de checklist à 16:04-16:07,
 * puis ISSOREL créé à 16:09:45 avec le MÊME id).
 *
 * Ce test attaque le vrai endpoint HTTP /api/clients (pas juste la couche
 * db.js) avec de VRAIES requêtes concurrentes, pour reproduire fidèlement
 * deux onglets soumettant le formulaire "Nouveau client" au même instant,
 * et vérifie que :
 *   1. les deux créations reçoivent des ids DIFFÉRENTS ;
 *   2. les deux fiches existent ensuite en base, intactes ;
 *   3. une rafale de 10 créations strictement simultanées ne produit
 *      jamais de collision.
 *
 * Utilise les identifiants FICTIFS de test/fixtures/test-users.json
 * (jamais les vrais identifiants de l'équipe) et une base Postgres locale
 * dédiée (voir DATABASE_URL ci-dessous) — jamais la base de production.
 *
 * Usage : npm run test:client-race  (ou directement : node test/client-creation-race.test.js)
 * Pré-requis : une base Postgres locale migrée (node scripts/migrate.js)
 * joignable via DATABASE_URL (par défaut : la même base dev que db.test.js).
 */

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 4174;
const BASE = `http://127.0.0.1:${PORT}`;
const DATABASE_URL =
  process.env.DATABASE_URL || "postgres://appa_dev:appa_dev_local@localhost:5432/appa_board_dev";

let failures = 0;
let passed = 0;

function ok(condition, label) {
  if (condition) {
    passed++;
    console.log(`  OK  - ${label}`);
  } else {
    failures++;
    console.log(`  FAIL - ${label}`);
  }
}

function request(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    if (cookie) headers["Cookie"] = cookie;
    const req = http.request(BASE + urlPath, { method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (e) {}
        resolve({ status: res.statusCode, body: parsed, setCookie: res.headers["set-cookie"] });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

async function loginAs(code, password) {
  const pinRes = await request("POST", "/api/auth/pin", { body: { pin: "TESTPIN0000" } });
  const pinToken = pinRes.body.pinToken;
  const loginRes = await request("POST", "/api/auth/login", { body: { pinToken, code, password } });
  const cookie = (loginRes.setCookie || [])[0].split(";")[0];
  return cookie;
}

async function waitForServer() {
  for (let i = 0; i < 50; i++) {
    try {
      const r = await request("GET", "/api/health");
      if (r.status === 200) return;
    } catch (e) {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Le serveur de test n'a jamais répondu à /api/health");
}

async function main() {
  // Nettoyage préalable (test idempotent, réexécutable) : purge uniquement
  // les clients de test créés par CE fichier et les compteurs associés —
  // jamais les vraies données de production (base locale dédiée uniquement).
  const db = require("../src/db");
  const client = await db.getClient();
  await client.query("DELETE FROM documents WHERE collection = 'clients' AND id LIKE $1", ["CLF-%"]);
  await client.query("DELETE FROM documents WHERE collection = '_counters' AND id LIKE 'clients_FORMULE_%'");

  const serverPath = path.join(__dirname, "..", "src", "server.js");
  const fixturePath = path.join(__dirname, "fixtures", "test-users.json");
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", USERS_CONFIG_PATH: fixturePath, DATABASE_URL },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stderr.on("data", (d) => process.stderr.write(`[serveur] ${d}`));

  try {
    await waitForServer();
    const cookie = await loginAs("CG", "TESTPASS_CG_0003");

    // Reproduit EXACTEMENT le scénario de Rémi : deux créations envoyées en
    // parallèle (comme deux onglets soumettant le formulaire au même instant).
    const [mochkareffRes, issorelRes] = await Promise.all([
      request("POST", "/api/clients", {
        cookie,
        body: { type: "FORMULE", data: { nom: "MOCHKAREFF", prenom: "Yves" } },
      }),
      request("POST", "/api/clients", {
        cookie,
        body: { type: "FORMULE", data: { nom: "ISSOREL", prenom: "RENE" } },
      }),
    ]);

    ok(mochkareffRes.status === 201 && issorelRes.status === 201, "Les deux créations réussissent (201)");

    const idMochkareff = mochkareffRes.body && mochkareffRes.body.doc && mochkareffRes.body.doc.id;
    const idIssorel = issorelRes.body && issorelRes.body.doc && issorelRes.body.doc.id;
    ok(!!idMochkareff && !!idIssorel, "Les deux réponses contiennent un id");
    ok(idMochkareff !== idIssorel, `Les deux créations reçoivent des ids DIFFÉRENTS (${idMochkareff} / ${idIssorel}) — c'était la cause du bug`);

    // Relit les deux fiches en base pour s'assurer qu'aucune n'a écrasé l'autre.
    const getMochkareff = await request("GET", `/api/db/clients/${idMochkareff}`, { cookie });
    const getIssorel = await request("GET", `/api/db/clients/${idIssorel}`, { cookie });
    ok(
      getMochkareff.status === 200 && getMochkareff.body.doc.data.nom === "MOCHKAREFF",
      "La fiche MOCHKAREFF existe toujours, intacte, après la création concurrente d'ISSOREL"
    );
    ok(
      getIssorel.status === 200 && getIssorel.body.doc.data.nom === "ISSOREL",
      "La fiche ISSOREL existe, intacte"
    );

    // Rafale de 10 créations strictement simultanées -> jamais de collision.
    const manyResults = await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        request("POST", "/api/clients", { cookie, body: { type: "FORMULE", data: { nom: `RAFALE${i}` } } })
      )
    );
    const allCreated = manyResults.every((r) => r.status === 201);
    ok(allCreated, "Les 10 créations simultanées de la rafale réussissent toutes (201)");
    const ids = manyResults.map((r) => r.body.doc.id);
    ok(new Set(ids).size === ids.length, `10 créations simultanées -> 10 ids uniques (${ids.join(", ")})`);

    // Vérifie aussi que l'ancien chemin (PUT direct sur /api/db/clients/:id,
    // qui reste un upsert volontaire pour les mises à jour de fiches
    // existantes) continue de fonctionner normalement — ce n'est PAS ce
    // chemin qui a changé, seule la création initiale passe maintenant par
    // /api/clients.
    const updateRes = await request("PUT", `/api/db/clients/${idMochkareff}`, {
      cookie,
      body: { ...getMochkareff.body.doc.data, tel: "0600000000" },
    });
    ok(updateRes.status === 200 && updateRes.body.doc.data.tel === "0600000000", "La mise à jour normale d'une fiche existante fonctionne toujours");
  } finally {
    child.kill();
  }

  console.log(`\n${passed} tests réussis, ${failures} échecs`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error("Erreur inattendue:", e);
  process.exit(1);
});
