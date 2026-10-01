"use strict";
/**
 * Test manuel/smoke du client PostgreSQL maison (src/pg-client.js) contre
 * une vraie base PostgreSQL locale de dev. Pas un framework de test formel
 * (zéro dépendance oblige) — un script qui échoue bruyamment (exit 1) si
 * quelque chose ne va pas.
 */
const assert = require("assert");
const { PgClient } = require("../src/pg-client");

const CONN =
  process.env.DATABASE_URL || "postgres://appa_dev:appa_dev_local@localhost:5432/appa_board_dev";

async function main() {
  const client = PgClient.fromConnectionString(CONN);
  await client.connect();
  console.log("✓ Connexion + authentification SCRAM-SHA-256 réussie");

  // Requête simple
  const r1 = await client.simpleQuery("SELECT 1 as un, 'ok' as statut");
  assert.strictEqual(r1.rows[0].un, "1");
  assert.strictEqual(r1.rows[0].statut, "ok");
  console.log("✓ simpleQuery OK");

  // DDL via simpleQuery
  await client.simpleQuery("DROP TABLE IF EXISTS _pgclient_test");
  await client.simpleQuery("CREATE TABLE _pgclient_test (id TEXT PRIMARY KEY, data JSONB, n INT)");
  console.log("✓ DDL (CREATE TABLE) OK");

  // Requête paramétrée : insertion
  await client.query("INSERT INTO _pgclient_test (id, data, n) VALUES ($1, $2::jsonb, $3)", [
    "a1",
    JSON.stringify({ nom: "Test Accentué éà", n: 42 }),
    7,
  ]);
  console.log("✓ query() paramétrée (INSERT) OK");

  // Lecture + vérif round-trip JSONB + UTF8
  const r2 = await client.query("SELECT id, data, n FROM _pgclient_test WHERE id = $1", ["a1"]);
  assert.strictEqual(r2.rows.length, 1);
  const parsed = JSON.parse(r2.rows[0].data);
  assert.strictEqual(parsed.nom, "Test Accentué éà");
  assert.strictEqual(parsed.n, 42);
  assert.strictEqual(r2.rows[0].n, "7");
  console.log("✓ query() paramétrée (SELECT) + round-trip UTF8/JSONB OK");

  // Valeur NULL en paramètre
  await client.query("UPDATE _pgclient_test SET n = $1 WHERE id = $2", [null, "a1"]);
  const r3 = await client.query("SELECT n FROM _pgclient_test WHERE id = $1", ["a1"]);
  assert.strictEqual(r3.rows[0].n, null);
  console.log("✓ Paramètre NULL OK");

  // Plusieurs lignes en une requête (teste la robustesse multi-messages dans un même paquet TCP)
  for (let i = 0; i < 50; i++) {
    await client.query("INSERT INTO _pgclient_test (id, data, n) VALUES ($1, $2::jsonb, $3)", [
      "bulk" + i,
      JSON.stringify({ i }),
      i,
    ]);
  }
  const r4 = await client.query("SELECT id FROM _pgclient_test WHERE id LIKE 'bulk%' ORDER BY n");
  assert.strictEqual(r4.rows.length, 50);
  console.log("✓ 50 lignes en une seule requête (multi-DataRow) OK — aucune perte de message");

  // Erreur SQL correctement propagée (et la connexion reste utilisable après)
  let caught = null;
  try {
    await client.query("SELECT * FROM table_qui_nexiste_pas");
  } catch (e) {
    caught = e;
  }
  assert.ok(caught, "une erreur SQL aurait dû être levée");
  console.log("✓ Erreur SQL propagée proprement:", caught.message.split("\n")[0]);

  const r5 = await client.query("SELECT count(*)::int as total FROM _pgclient_test");
  assert.strictEqual(r5.rows[0].total, "51");
  console.log("✓ Connexion toujours utilisable après une erreur SQL");

  await client.simpleQuery("DROP TABLE _pgclient_test");
  await client.end();
  console.log("\n✅ Tous les tests pg-client.js sont passés.");
}

main().catch((e) => {
  console.error("❌ ÉCHEC:", e);
  process.exit(1);
});
