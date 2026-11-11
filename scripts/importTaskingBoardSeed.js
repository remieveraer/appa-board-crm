"use strict";
/**
 * Importe les 101 tâches historiques de l'export Tasking Board Cowork
 * (scripts/data/tasking-board-export-2026-10-23.json, fourni par Rémi le
 * 23/10/2026) dans la collection "taches" du board CRM.
 *
 * Deux familles de tâches :
 *  - "Portefeuille clients 84/13" + "Facturation clients" : tâches à
 *    rattacher à un vrai client existant. Le nom (champ sujet_dossier, ou
 *    absent pour "Facturation clients") est comparé — normalisé
 *    (majuscules, sans accents, Nom/Prénom dans les deux sens) — aux vraies
 *    fiches de la collection "clients". Une correspondance UNIQUE est
 *    nécessaire : zéro ou plusieurs correspondances => la tâche est
 *    exclue de l'import et listée dans le rapport "non rattachées", JAMAIS
 *    devinée. Les pseudo-dossiers qui ne sont pas des noms de clients
 *    (AUTRE, CALENDRIER PROBLEME, URGENT RMP) sont traités pareil : jamais
 *    rattachés automatiquement.
 *  - Toutes les autres catégories (RH & Droit social, Communication &
 *    LinkedIn, Coordination soins & Consignes salariés, Franchise &
 *    Gouvernance, Informatique & Matériel, Autre/Divers, + l'anomalie
 *    Fiscal classée en Autre/Divers) : tâches internes, avec
 *    categorieInterne posé selon CATEGORIES_INTERNES (board.html).
 *
 * Idempotent : id déterministe "import-tasking-<id_interne original>"
 * (ou "import-tasking-<hash>" si l'export n'avait pas d'id interne) — un
 * nouveau lancement avec --apply remplace les mêmes documents plutôt que
 * de les dupliquer.
 *
 * SÉCURITÉ "zéro perte / jamais sans GO" : le script est en DRY-RUN par
 * défaut (affiche le plan complet, n'écrit RIEN). Il ne touche la base
 * que si on lui passe --apply explicitement.
 *
 * Usage :
 *   node scripts/importTaskingBoardSeed.js                 # dry-run (par défaut)
 *   node scripts/importTaskingBoardSeed.js --apply          # écrit réellement
 *   node scripts/importTaskingBoardSeed.js --selftest        # vérifie la logique de mapping avec des données fictives, sans toucher la base
 *
 *   Variable d'env DATABASE_URL : base cible (sinon dev locale).
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const EXPORT_JSON = path.join(__dirname, "data", "tasking-board-export-2026-10-23.json");

// Catégories de l'export qui désignent une tâche liée à un dossier client réel.
const CATEGORIES_CLIENT = new Set(["📁 Portefeuille clients 84", "📁 Portefeuille clients 13", "💶 Facturation clients"]);

// Dossiers/"sujets" rencontrés sous une catégorie client qui ne sont PAS des noms de clients réels —
// jamais matchés automatiquement, toujours listés en "non rattachées" pour revue manuelle.
const PSEUDO_DOSSIERS_NON_CLIENT = new Set(["AUTRE", "CALENDRIER PROBLEME", "URGENT RMP"]);

// Mapping catégorie export -> code categorieInterne (board.html, CATEGORIES_INTERNES).
const CATEGORIE_TO_INTERNE = {
  "👥 RH & Droit social": "RH",
  "📣 Communication & LinkedIn": "COMM",
  "🩺 Coordination soins & Consignes salariés": "COORDINATION",
  "🏛️ Franchise & Gouvernance": "FRANCHISE",
  "💻 Informatique & Matériel": "INFORMATIQUE",
  "🗂️ Autre / Divers (hors client)": "AUTRE",
  "⚠️ Fiscal / Impôts locaux (catégorie libre / non standard)": "AUTRE", // anomalie isolée, pas une vraie catégorie à part
};

// Priorité export -> criticité board. Les deux échelles ont 4 niveaux ; alignées par libellé/couleur
// identique quand il y en a un (Moyenne<->moyenne, Faible<->basse), sinon par rang.
// 🔴 Urgent est volontairement mappé sur "haute" et non "extreme" : Urgent est la priorité la PLUS
// courante dans l'export (large majorité des tâches) — la réserver à "extreme" noierait le badge ‼️
// du board, pensé pour signaler une vraie exception, pas un usage courant.
const PRIORITE_TO_CRITICITE = {
  "🔴 Urgent": "haute",
  "🟠 Moyenne": "moyenne",
  "🟡 Normal": "moyenne",
  "🟢 Faible": "basse",
};

// Avancement export -> état board.
const AVANCEMENT_TO_ETAT = {
  "🟣 À planifier": "a_traiter",
  "🟠 Planifié": "en_cours",
  "🔵 Communiqué": "traite",
};

function stripAccents(s) {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}
function normName(s) {
  return stripAccents(String(s || "")).toUpperCase().replace(/[^A-Z]+/g, " ").trim();
}
function nameTokens(s) {
  return normName(s).split(" ").filter(Boolean);
}

/** Essaie de faire correspondre `sujetDossier` (ex. "AULAS Denise") à une fiche de `clients`
 * (chaque fiche a un champ `nom`, format libre). Retourne le client si correspondance UNIQUE,
 * sinon null (et le détail des candidats pour le rapport). */
function matchClient(sujetDossier, clients) {
  if (!sujetDossier) return { client: null, candidates: [] };
  const target = nameTokens(sujetDossier);
  if (!target.length) return { client: null, candidates: [] };
  const targetSet = new Set(target);
  const candidates = clients.filter((c) => {
    const tokens = nameTokens(c.nom || c.nomComplet || `${c.nom || ""} ${c.prenom || ""}`);
    if (!tokens.length) return false;
    // tous les tokens du dossier export doivent se retrouver dans le nom client (ordre libre,
    // gère "AULAS Denise" vs "Denise AULAS" vs "AULAS" seul).
    return target.every((t) => tokens.includes(t));
  });
  if (candidates.length === 1) return { client: candidates[0], candidates };
  return { client: null, candidates };
}

function parseDateLoose(s) {
  if (!s) return null;
  // "2026-09-14" ou ISO complet -> ISO complet
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s + "T00:00:00.000Z";
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString();
}

function deterministicId(rec) {
  const base = rec.id_interne || crypto.createHash("sha1").update(rec.titre + "|" + (rec.cree_le || "")).digest("hex").slice(0, 16);
  return "import-tasking-" + base;
}

function buildTaskDoc(rec, matchedClient) {
  const isClientCat = CATEGORIES_CLIENT.has(rec.categorie);
  const criticite = PRIORITE_TO_CRITICITE[rec.priorite] || "moyenne";
  const estArchive = !!rec.archive;
  const etat = estArchive ? "valide" : (AVANCEMENT_TO_ETAT[rec.avancement] || "a_traiter");
  const detailParts = [];
  if (rec.detail) detailParts.push(rec.detail);
  if (rec.commentaire) detailParts.push("Commentaire original : " + rec.commentaire);
  if (rec.echeances_mensuelles) detailParts.push("Échéances mensuelles (tâche récurrente dans l'export d'origine) : " + rec.echeances_mensuelles);
  detailParts.push(`[Import Tasking Board 23/10/2026 — id d'origine : ${rec.id_interne || "(aucun)"}]`);
  const doc = {
    clientId: isClientCat && matchedClient ? matchedClient.id : null,
    clientNom: isClientCat && matchedClient ? (matchedClient.nom || matchedClient.nomComplet || rec.sujet_dossier) : null,
    interne: !(isClientCat && matchedClient),
    categorieInterne: !(isClientCat && matchedClient) ? (CATEGORIE_TO_INTERNE[rec.categorie] || "AUTRE") : null,
    titre: rec.titre,
    affecte: null,
    etat,
    detail: detailParts.join("\n\n"),
    typeTache: "standard",
    criticite,
    echeance: parseDateLoose(rec.echeance),
    recurrente: !!rec.recurrence,
    messages: [],
    rdvId: null, rdvDate: null, rdvHeure: null, rdvLieu: null,
    redacteur: "RE",
    createdAt: parseDateLoose(rec.cree_le) || new Date().toISOString(),
    treatedAt: estArchive ? (parseDateLoose(rec.traitee_le) || new Date().toISOString()) : null,
  };
  return doc;
}

async function loadRealClients(db) {
  try {
    const docs = await db.list("clients");
    return docs.map((d) => ({ id: d.id, ...d.data }));
  } catch (e) {
    console.warn("⚠ Impossible de lire la collection 'clients' (base inaccessible ?) :", e.message);
    return null;
  }
}

function planImport(records, clients) {
  const plan = { clientLinked: [], internal: [], unmatched: [] };
  for (const rec of records) {
    const isClientCat = CATEGORIES_CLIENT.has(rec.categorie);
    if (isClientCat) {
      const sujet = rec.sujet_dossier;
      const isPseudo = sujet && PSEUDO_DOSSIERS_NON_CLIENT.has(sujet.toUpperCase());
      if (!sujet || isPseudo || !clients) {
        plan.unmatched.push({ rec, raison: !sujet ? "aucun nom de dossier dans l'export (ex. Facturation clients)" : isPseudo ? `dossier "${sujet}" n'est pas un nom de client réel` : "base clients inaccessible pour vérifier" });
        continue;
      }
      const { client, candidates } = matchClient(sujet, clients);
      if (!client) {
        plan.unmatched.push({ rec, raison: candidates.length === 0 ? `aucune fiche client ne correspond à "${sujet}"` : `${candidates.length} fiches client correspondent à "${sujet}" (ambigu) : ${candidates.map((c) => c.nom).join(", ")}` });
        continue;
      }
      plan.clientLinked.push({ rec, client, doc: buildTaskDoc(rec, client) });
    } else {
      plan.internal.push({ rec, doc: buildTaskDoc(rec, null) });
    }
  }
  return plan;
}

function printPlan(plan) {
  console.log(`\n=== PLAN D'IMPORT ===`);
  console.log(`Tâches client (rattachées à une fiche réelle, correspondance unique) : ${plan.clientLinked.length}`);
  for (const { rec, client } of plan.clientLinked) {
    console.log(`  - [${rec.id_interne || "?"}] "${rec.titre}" -> client "${client.nom}" (id=${client.id})`);
  }
  console.log(`\nTâches internes (classées par catégorie) : ${plan.internal.length}`);
  const byCat = {};
  for (const { doc } of plan.internal) byCat[doc.categorieInterne] = (byCat[doc.categorieInterne] || 0) + 1;
  for (const [cat, n] of Object.entries(byCat)) console.log(`  - ${cat} : ${n}`);
  console.log(`\n⚠ Tâches NON rattachées (exclues de l'import, à traiter manuellement) : ${plan.unmatched.length}`);
  for (const { rec, raison } of plan.unmatched) {
    console.log(`  - [${rec.id_interne || "?"}] "${rec.titre}" (${rec.categorie}) — ${raison}`);
  }
  const total = plan.clientLinked.length + plan.internal.length + plan.unmatched.length;
  console.log(`\nTotal : ${total} (import prévu : ${plan.clientLinked.length + plan.internal.length}, exclues : ${plan.unmatched.length})`);
}

async function main() {
  const apply = process.argv.includes("--apply");
  const selftest = process.argv.includes("--selftest");

  if (selftest) {
    const fakeClients = [
      { id: "c1", nom: "AULAS Denise" },
      { id: "c2", nom: "DONAT Irène" },
      { id: "c3", nom: "MARTIN Jean" },
      { id: "c4", nom: "Jean MARTIN-DUBOIS" }, // sosie partiel volontaire, pour tester l'ambiguïté
    ];
    const records = JSON.parse(fs.readFileSync(EXPORT_JSON, "utf8"));
    const plan = planImport(records, fakeClients);
    printPlan(plan);
    const aulas = plan.clientLinked.find((x) => x.rec.id_interne === "aulas-atir-carpentras");
    const martinAmbigu = plan.unmatched.find((x) => x.rec.sujet_dossier === "MARTIN Jean");
    console.log("\n--- Vérifications self-test ---");
    console.log("AULAS Denise correctement rattachée :", !!aulas && aulas.client.id === "c1" ? "OK" : "ÉCHEC");
    console.log("MARTIN Jean exclu car ambigu (2 fiches correspondraient) :", martinAmbigu ? "OK" : "ÉCHEC (attendu : exclu, pas deviné)");
    process.exit(0);
  }

  const records = JSON.parse(fs.readFileSync(EXPORT_JSON, "utf8"));
  console.log(`${records.length} tâches chargées depuis l'export Tasking Board.`);

  const db = require("../src/db");
  const clients = await loadRealClients(db);
  const plan = planImport(records, clients);
  printPlan(plan);

  if (!apply) {
    console.log(`\n(dry-run — aucune écriture effectuée. Relancer avec --apply pour importer réellement, après validation du plan ci-dessus avec Rémi.)`);
    process.exit(0);
  }

  console.log(`\n--apply : écriture dans la collection "taches"...`);
  let written = 0;
  for (const { rec, doc } of [...plan.clientLinked, ...plan.internal]) {
    await db.set("taches", deterministicId(rec), doc);
    written++;
  }
  console.log(`✅ ${written} tâches importées (upsert par id déterministe import-tasking-<id d'origine>).`);
  const c = await db.getClient();
  await c.end();
}

main().catch((e) => {
  console.error("❌ Échec de l'import:", e);
  process.exit(1);
});
