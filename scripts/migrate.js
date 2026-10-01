"use strict";
/**
 * Applique les migrations SQL du dossier migrations/ dans l'ordre
 * alphabétique (d'où le préfixe numérique 001_, 002_...), une seule fois
 * chacune — suivi dans la table _migrations. Usage : npm run migrate
 * (variable d'env DATABASE_URL requise, ou fallback dev local ci-dessous).
 */
const fs = require("fs");
const path = require("path");
const { PgClient } = require("../src/pg-client");

const CONN =
  process.env.DATABASE_URL || "postgres://appa_dev:appa_dev_local@localhost:5432/appa_board_dev";
const MIGRATIONS_DIR = path.join(__dirname, "..", "migrations");

async function main() {
  const client = PgClient.fromConnectionString(CONN);
  await client.connect();
  console.log(`Connecté à ${maskConn(CONN)}`);

  // La toute première migration crée _migrations elle-même — on ne peut
  // donc pas s'y référer avant de savoir si elle existe déjà.
  const tableExists = await client.query(
    "SELECT 1 FROM information_schema.tables WHERE table_name = '_migrations'"
  );
  const applied = new Set();
  if (tableExists.rows.length) {
    const r = await client.query("SELECT filename FROM _migrations");
    for (const row of r.rows) applied.add(row.filename);
  }

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();

  let ranCount = 0;
  for (const file of files) {
    if (applied.has(file)) {
      console.log(`⏭  ${file} déjà appliquée`);
      continue;
    }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8");
    console.log(`▶  Application de ${file}...`);
    await client.simpleQuery(sql);
    await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
    console.log(`✓  ${file} appliquée`);
    ranCount++;
  }

  await client.end();
  console.log(ranCount ? `\n✅ ${ranCount} migration(s) appliquée(s).` : "\n✅ Rien à faire, schéma déjà à jour.");
}

function maskConn(connStr) {
  try {
    const u = new URL(connStr);
    return `${u.protocol}//${u.username}:***@${u.host}${u.pathname}`;
  } catch (e) {
    return "(chaîne de connexion)";
  }
}

main().catch((e) => {
  console.error("❌ Échec de migration:", e.message);
  process.exit(1);
});
