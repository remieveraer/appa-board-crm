"use strict";
/**
 * Migration "Formule Duo" — fusionne les anciennes paires de fiches séparées (Structure A : 2 fiches
 * client distinctes, chacune avec formuleDuo:true, tarif plein sur l'une + remise REMISE_DUO sur
 * l'autre) en UNE fiche unique (Structure B : c.structureDuo=true + champs p2* pour la 2e personne,
 * voir board.html). Cadrage verrouillé avec Rémi (09-14/10/2026, repris le 16/10/2026) :
 *
 *  - Appariement : 2 clients type FORMULE, formuleDuo:true, statut!=="INACTIF" (pas déjà archivés),
 *    pas déjà structureDuo (pas déjà migrés), même formuleBase, même (adresse+cp+ville) normalisée.
 *    EXACTEMENT 2 candidats requis pour une même clé — 0 (fiche seule), 1 (idem) ou 3+ (ambigu) =>
 *    exclus et reportés avec le motif précis, JAMAIS deviné/apparié au hasard.
 *  - Nouvelle fiche : la personne au tarifTTC le plus élevé devient "personne 1" (réutilise les champs
 *    existants nom/prenom/dateNaissance/numSS/mjpmId/mjpmNomBrut/mjpmAdresse/mjpmTel/mjpmMail/
 *    mesureLibre/personneConfianceNom/personneConfianceCoord/medecinTraitant/tel — aucun renommage,
 *    zéro régression pour tout le code existant qui lit ces champs), l'autre devient "personne 2"
 *    (mêmes champs préfixés p2). En cas d'égalité de tarif, la 1ère par ordre alphabétique du nom.
 *  - tarifTTC de la nouvelle fiche = SOMME EXACTE des deux anciens tarifTTC — le prix actuellement
 *    facturé n'est JAMAIS modifié par la migration (exigence explicite de Rémi). Seuls les NOUVEAUX
 *    clients Duo créés après la migration profitent des tarifs officiels 350€/720€/1290€
 *    (PRIX_DUO_OFFICIEL, board.html).
 *  - Les 2 anciennes fiches sont ARCHIVÉES (statut:"INACTIF", motifInactif explicite pointant vers la
 *    nouvelle fiche), JAMAIS supprimées, et restent intégralement consultables (même logique que
 *    l'archivage Océane, GRH_IDENTITIES_ARCHIVEES). Zéro perte de donnée.
 *  - Tous les champs de la fiche fusionnée restent normalement modifiables ensuite via "✏️ Modifier"
 *    (aucun champ bloqué/verrouillé — exigence explicite de Rémi, voir toggleEditClient/saveEditClient
 *    dans board.html).
 *
 * Usage :
 *   node scripts/migrateFormuleDuo.js --selftest   (valide la logique d'appariement, jeu de données fictif)
 *   node scripts/migrateFormuleDuo.js               (dry-run contre la vraie base — affiche le plan, écrit rien)
 *   node scripts/migrateFormuleDuo.js --apply        (écrit réellement — à lancer seulement après validation
 *                                                      du plan ci-dessus avec Rémi)
 */
const crypto = require("crypto");

function stripAccents(s) {
  return String(s || "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "");
}
// Clé d'appariement : adresse+CP+ville normalisées. Une adresse incomplète ne doit jamais servir de
// base à un appariement — on exclut explicitement plutôt que de deviner.
function normAdresse(c) {
  return stripAccents(`${c.adresse || ""} ${c.cp || ""} ${c.ville || ""}`)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function planMigration(clients) {
  const candidats = clients.filter(
    (c) => c.type === "FORMULE" && c.formuleDuo === true && !c.structureDuo && c.statut !== "INACTIF"
  );
  const groupes = {};
  const exclus = [];
  candidats.forEach((c) => {
    const adr = normAdresse(c);
    if (!adr) {
      exclus.push({ client: c, motif: "adresse incomplète — appariement impossible sans deviner" });
      return;
    }
    const key = (c.formuleBase || "?") + "|" + adr;
    (groupes[key] = groupes[key] || []).push(c);
  });

  const paires = [];
  Object.values(groupes).forEach((liste) => {
    if (liste.length === 2) {
      paires.push(liste);
    } else if (liste.length === 1) {
      exclus.push({ client: liste[0], motif: "aucun second client Duo à la même adresse/formule — fiche seule" });
    } else {
      liste.forEach((c) =>
        exclus.push({
          client: c,
          motif: `${liste.length} clients Duo partagent la même adresse/formule (ambigu, groupe non apparié automatiquement)`,
        })
      );
    }
  });
  return { paires, exclus };
}

// Construit la fiche fusionnée pour une paire donnée. Id déterministe (dérivé des 2 anciens ids) pour
// un re-calcul stable (même paire -> même id si le script est relancé avant d'avoir appliqué).
function buildMergedDoc(paire) {
  const [a, b] = paire
    .slice()
    .sort((x, y) => (y.tarifTTC || 0) - (x.tarifTTC || 0) || (x.nom || "").localeCompare(y.nom || ""));
  const year = new Date().getFullYear();
  const hash = crypto.createHash("sha1").update(a.id + "|" + b.id).digest("hex").slice(0, 8);
  const newId = `CLF-DUO-${year}-${hash}`;
  const dateMigration = new Date().toISOString();
  const doc = {
    type: "FORMULE",
    formuleBase: a.formuleBase,
    formuleDuo: true,
    structureDuo: true,
    statut: a.statut,
    motifInactif: null,
    dateDebutContrat: a.dateDebutContrat || b.dateDebutContrat || null,
    avenant: a.avenant || { actif: false },
    nom: a.nom,
    prenom: a.prenom,
    dateNaissance: a.dateNaissance || null,
    numSS: a.numSS || null,
    adresse: a.adresse || b.adresse || "",
    cp: a.cp || b.cp || "",
    ville: a.ville || b.ville || "",
    departement: a.departement || b.departement || null,
    tel: a.tel || null,
    mail: a.mail || b.mail || null,
    // Prix actuellement facturé CONSERVÉ tel quel (somme exacte des 2 anciens tarifs) — jamais aligné
    // automatiquement sur la grille officielle 2026 (exigence explicite de Rémi).
    tarifTTC: +((a.tarifTTC || 0) + (b.tarifTTC || 0)).toFixed(2),
    // La notion de "taux de remise" (calculée vs. prix de base d'une SEULE personne) n'a plus de sens
    // sur une fiche unique au tarif total du couple — jamais recalculée au hasard, laissée à NC.
    tauxRemise: null,
    modePaiement: a.modePaiement || b.modePaiement || null,
    mjpmId: a.mjpmId || null,
    mjpmNomBrut: a.mjpmNomBrut || null,
    mjpmAdresse: a.mjpmAdresse || null,
    mjpmTel: a.mjpmTel || null,
    mjpmMail: a.mjpmMail || null,
    mesureLibre: a.mesureLibre || null,
    personneConfianceNom: a.personneConfianceNom || null,
    personneConfianceCoord: a.personneConfianceCoord || null,
    medecinTraitant: a.medecinTraitant || null,
    numContrat: a.numContrat || null,
    numRum: a.numRum || null,
    rumStatut: a.rumStatut || null,
    aCorriger: [],
    checklist: {},
    p2Nom: b.nom || null,
    p2Prenom: b.prenom || null,
    p2DateNaissance: b.dateNaissance || null,
    p2NumSS: b.numSS || null,
    p2Tel: b.tel || null,
    p2MjpmId: b.mjpmId || null,
    p2MjpmNomBrut: b.mjpmNomBrut || null,
    p2MjpmAdresse: b.mjpmAdresse || null,
    p2MjpmTel: b.mjpmTel || null,
    p2MjpmMail: b.mjpmMail || null,
    p2MesureLibre: b.mesureLibre || null,
    p2PersonneConfianceNom: b.personneConfianceNom || null,
    p2PersonneConfianceCoord: b.personneConfianceCoord || null,
    p2MedecinTraitant: b.medecinTraitant || null,
    migrationDuo: {
      ancienId1: a.id,
      ancienId2: b.id,
      ancienTarif1: a.tarifTTC || 0,
      ancienTarif2: b.tarifTTC || 0,
      dateMigration,
    },
    historique: [{ who: "MIGRATION", when: dateMigration, what: `Fusion automatique Formule Duo depuis ${a.id} + ${b.id}` }],
  };
  return { newId, doc, ancienA: a, ancienB: b };
}

function printPlan(plan) {
  console.log("\n=== PLAN DE MIGRATION FORMULE DUO ===");
  console.log(`Paires appariées (fusion prévue) : ${plan.paires.length}`);
  plan.paires.forEach((paire) => {
    const { newId, ancienA, ancienB } = buildMergedDoc(paire);
    console.log(
      `  - [${newId}] ${ancienA.nom} ${ancienA.prenom || ""} + ${ancienB.nom} ${ancienB.prenom || ""} (${ancienA.formuleBase}) <- ${ancienA.id} (${ancienA.tarifTTC || 0}€) + ${ancienB.id} (${ancienB.tarifTTC || 0}€) = ${(ancienA.tarifTTC || 0) + (ancienB.tarifTTC || 0)}€`
    );
  });
  console.log(`\n⚠ Fiches NON appariées (exclues de la migration, à traiter manuellement) : ${plan.exclus.length}`);
  plan.exclus.forEach(({ client, motif }) => {
    console.log(`  - [${client.id}] ${client.nom} ${client.prenom || ""} (${client.formuleBase || "?"}) — ${motif}`);
  });
  console.log(`\nTotal candidats Duo (Structure A) analysés : ${plan.paires.length * 2 + plan.exclus.length}`);
}

function selftest() {
  const fakeClients = [
    { id: "T-A1", nom: "AULAS", prenom: "Denise", type: "FORMULE", formuleBase: "F2", formuleDuo: true, statut: "ACTIF", adresse: "12 rue des Lilas", cp: "13120", ville: "Gardanne", tarifTTC: 390, tel: "0600000001" },
    { id: "T-A2", nom: "AULAS", prenom: "Marcel", type: "FORMULE", formuleBase: "F2", formuleDuo: true, statut: "ACTIF", adresse: "12 rue des Lilas", cp: "13120", ville: "Gardanne", tarifTTC: 292.5, tel: "0600000002" },
    // Trio à la même adresse -> ambigu, les 3 doivent être exclus (jamais apparié au hasard)
    { id: "T-B1", nom: "MARTIN", prenom: "Paul", type: "FORMULE", formuleBase: "F1", formuleDuo: true, statut: "ACTIF", adresse: "5 avenue du Parc", cp: "13100", ville: "Aix-en-Provence", tarifTTC: 195, tel: "" },
    { id: "T-B2", nom: "MARTIN", prenom: "Julie", type: "FORMULE", formuleBase: "F1", formuleDuo: true, statut: "ACTIF", adresse: "5 avenue du Parc", cp: "13100", ville: "Aix-en-Provence", tarifTTC: 156, tel: "" },
    { id: "T-B3", nom: "MARTIN", prenom: "Autre", type: "FORMULE", formuleBase: "F1", formuleDuo: true, statut: "ACTIF", adresse: "5 avenue du Parc", cp: "13100", ville: "Aix-en-Provence", tarifTTC: 156, tel: "" },
    // Fiche Duo seule (plus de second à la même adresse) -> exclue
    { id: "T-C1", nom: "DONAT", prenom: "Irène", type: "FORMULE", formuleBase: "F3", formuleDuo: true, statut: "ACTIF", adresse: "8 impasse des Fleurs", cp: "84000", ville: "Avignon", tarifTTC: 590, tel: "" },
    // Non-Duo : ne doit jamais apparaître dans le plan (ni apparié, ni listé en exclu)
    { id: "T-D1", nom: "SOLO", prenom: "Robert", type: "FORMULE", formuleBase: "F1", formuleDuo: false, statut: "ACTIF", adresse: "1 rue Seule", cp: "13000", ville: "Marseille", tarifTTC: 195, tel: "" },
    // Déjà migré (structureDuo déjà vrai) : ne doit jamais être re-proposé
    { id: "T-E1", nom: "DEJA", prenom: "Migre", type: "FORMULE", formuleBase: "F2", formuleDuo: true, structureDuo: true, statut: "ACTIF", adresse: "2 rue Faite", cp: "13000", ville: "Marseille", tarifTTC: 500, tel: "" },
  ];
  const plan = planMigration(fakeClients);
  printPlan(plan);
  console.log("\n--- Vérifications self-test ---");
  const okAulas = plan.paires.some((p) => p.some((c) => c.id === "T-A1") && p.some((c) => c.id === "T-A2"));
  console.log("AULAS Denise/Marcel correctement appariés :", okAulas ? "OK" : "ÉCHEC");
  const okMartinExclu =
    plan.exclus.some((e) => e.client.id === "T-B1") &&
    plan.exclus.some((e) => e.client.id === "T-B2") &&
    plan.exclus.some((e) => e.client.id === "T-B3") &&
    !plan.paires.some((p) => p.some((c) => c.id.startsWith("T-B")));
  console.log("Trio MARTIN (3 fiches même adresse) exclu car ambigu :", okMartinExclu ? "OK" : "ÉCHEC");
  const okDonatExclu = plan.exclus.some((e) => e.client.id === "T-C1") && !plan.paires.some((p) => p.some((c) => c.id === "T-C1"));
  console.log("DONAT Irène (fiche seule) exclue :", okDonatExclu ? "OK" : "ÉCHEC");
  const okSoloAbsent = !plan.paires.some((p) => p.some((c) => c.id === "T-D1")) && !plan.exclus.some((e) => e.client.id === "T-D1");
  console.log("SOLO Robert (non-Duo) absent du plan :", okSoloAbsent ? "OK" : "ÉCHEC");
  const okDejaMigreAbsent = !plan.paires.some((p) => p.some((c) => c.id === "T-E1")) && !plan.exclus.some((e) => e.client.id === "T-E1");
  console.log("DEJA Migre (structureDuo déjà vrai) absent du plan :", okDejaMigreAbsent ? "OK" : "ÉCHEC");
  const tarifSommeOk = (() => {
    const paireAulas = plan.paires.find((p) => p.some((c) => c.id === "T-A1"));
    if (!paireAulas) return false;
    const { doc } = buildMergedDoc(paireAulas);
    return doc.tarifTTC === 390 + 292.5;
  })();
  console.log("Tarif fusionné = somme exacte des 2 anciens tarifs (zéro perte) :", tarifSommeOk ? "OK" : "ÉCHEC");
  if (!(okAulas && okMartinExclu && okDonatExclu && okSoloAbsent && okDejaMigreAbsent && tarifSommeOk)) {
    process.exitCode = 1;
  }
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

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--selftest")) {
    selftest();
    process.exit(process.exitCode || 0);
  }
  const apply = args.includes("--apply");

  const db = require("../src/db");
  const clients = await loadRealClients(db);
  if (!clients) {
    console.error("Aucune migration possible sans lire les vraies fiches — relancer ce script contre la vraie base de production.");
    process.exitCode = 1;
    return;
  }
  console.log(`${clients.length} clients chargés depuis la base.`);
  const plan = planMigration(clients);
  printPlan(plan);

  if (!apply) {
    console.log("\n(dry-run — aucune écriture effectuée. Relancer avec --apply pour migrer réellement, après validation du plan ci-dessus avec Rémi.)");
    return;
  }

  console.log(`\n--apply : fusion de ${plan.paires.length} paire(s)...`);
  for (const paire of plan.paires) {
    const { newId, doc, ancienA, ancienB } = buildMergedDoc(paire);
    await db.set("clients", newId, doc);
    const dateMigration = doc.migrationDuo.dateMigration;
    await db.update("clients", ancienA.id, {
      statut: "INACTIF",
      motifInactif: `Fusionné en fiche Duo unique ${newId} (migration Formule Duo, ${dateMigration})`,
    });
    await db.update("clients", ancienB.id, {
      statut: "INACTIF",
      motifInactif: `Fusionné en fiche Duo unique ${newId} (migration Formule Duo, ${dateMigration})`,
    });
    console.log(`  ✅ ${newId} créé — ${ancienA.id} et ${ancienB.id} archivés (statut INACTIF, jamais supprimés, toujours consultables).`);
  }
  console.log("\nMigration terminée. Les anciennes fiches restent consultables dans l'archive (Onglet 1, statut Inactif).");
  const c = await db.getClient();
  await c.end();
}

main().catch((e) => {
  console.error("❌ Échec de la migration :", e);
  process.exit(1);
});
