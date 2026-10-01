"use strict";
/**
 * Importe les 272 clients + 26 prestataires réels migrés depuis le CRM
 * Excel (board_test/migration/clients_out.json,
 * prestataires_out.json) dans la base PostgreSQL du board, en respectant
 * la décision proposée à Rémi (audit des 80 anomalies livré le
 * 28/09/2026, "sauf avis contraire") : tout est importé tel quel, et les
 * ~17 fiches client concernées par une anomalie non triviale (MJPM non
 * rattaché à l'annuaire, état RUM ambigu) sont marquées via le champ
 * `aCorriger` — déjà prévu dans le schéma de données mais jamais alimenté
 * par le script de migration d'origine — pour que l'équipe les retrouve et
 * les corrige directement dans le board une fois en ligne, sans qu'aucune
 * donnée ne soit silencieusement perdue ou approximée.
 *
 * Idempotent : peut être relancé sans dupliquer (upsert par id réel du
 * dossier, ex. "cli-F-2024-001-F2" / "prest-01-binkus" — pas d'id généré
 * aléatoirement, pour rester stable entre deux exécutions et lisible).
 *
 * Usage : npm run seed
 *   Variables d'env :
 *     DATABASE_URL           (sinon : base de dev locale)
 *     MIGRATION_DIR           dossier contenant clients_out.json,
 *                              prestataires_out.json, anomalies.json
 *                              (défaut : board_test/migration à côté de ce projet)
 */
const fs = require("fs");
const path = require("path");
const db = require("../src/db");

const MIGRATION_DIR =
  process.env.MIGRATION_DIR || path.join(__dirname, "..", "migration-data");

function loadJson(name) {
  const p = path.join(MIGRATION_DIR, name);
  if (!fs.existsSync(p)) throw new Error(`Fichier de migration introuvable : ${p}`);
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function anomalyKey(source, row) {
  return `${source}::${row}`;
}

async function main() {
  const clients = loadJson("clients_out.json");
  const prestataires = loadJson("prestataires_out.json");
  const anomalies = loadJson("anomalies.json");

  const anomaliesByKey = new Map();
  for (const a of anomalies) {
    const key = anomalyKey(a.source, a.row);
    if (!anomaliesByKey.has(key)) anomaliesByKey.set(key, []);
    anomaliesByKey.get(key).push({ champ: a.champ, valeur: a.valeur, raison: a.raison });
  }

  let flaggedCount = 0;
  let matchedAnomalies = 0;

  console.log(`Import de ${clients.length} clients...`);
  for (const c of clients) {
    const key = anomalyKey(c._sourceSheet, c._sourceRow);
    const matches = anomaliesByKey.get(key);
    const record = { ...c };
    if (matches && matches.length) {
      const existing = Array.isArray(record.aCorriger) ? record.aCorriger : [];
      // Fusion sans doublon (relance idempotente : ne pas empiler la même anomalie deux fois)
      const merged = [...existing];
      for (const m of matches) {
        if (!merged.some((e) => e.champ === m.champ && e.valeur === m.valeur)) merged.push(m);
      }
      record.aCorriger = merged;
      flaggedCount++;
      matchedAnomalies += matches.length;
    }
    await db.set("clients", record.id, record);
  }
  console.log(`✓ ${clients.length} clients importés (upsert par id réel)`);
  console.log(`✓ ${flaggedCount} fiches marquées aCorriger (${matchedAnomalies} anomalies rattachées sur ${anomalies.length} au total)`);

  const unmatchedAnomalies = anomalies.length - matchedAnomalies;
  if (unmatchedAnomalies > 0) {
    console.log(
      `⚠ ${unmatchedAnomalies} anomalie(s) n'ont pu être rattachées à aucune fiche client (source/ligne sans correspondance _sourceSheet/_sourceRow) — à vérifier manuellement.`
    );
  }

  console.log(`\nImport de ${prestataires.length} prestataires...`);
  for (const p of prestataires) {
    await db.set("prestataires", p.id, p);
  }
  console.log(`✓ ${prestataires.length} prestataires importés (upsert par id réel)`);

  const c = await db.getClient();
  const totalClients = await c.query("SELECT count(*)::int as n FROM documents WHERE collection = 'clients'");
  const totalPrest = await c.query("SELECT count(*)::int as n FROM documents WHERE collection = 'prestataires'");
  console.log(`\nVérification en base : ${totalClients.rows[0].n} clients, ${totalPrest.rows[0].n} prestataires.`);
  await c.end();
  console.log("\n✅ Import terminé.");
}

main().catch((e) => {
  console.error("❌ Échec de l'import:", e);
  process.exit(1);
});
