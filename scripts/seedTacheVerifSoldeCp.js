"use strict";
/**
 * Crée UNE tâche interne RH, assignée à Ala (code "AC"), lui demandant de vérifier et corriger les
 * soldes de congés payés (solde N-1 + solde année en cours, Onglet 7 GRH) de toute l'équipe salariée au
 * regard de leur date d'embauche réelle, et de mettre à jour le CRM en conséquence.
 *
 * Contexte (cadrage avec Rémi le 11/11/2026) : demande initiale "calculer le solde de Hinda à sa date
 * d'embauche", précisée ensuite ainsi — PAS de calcul automatique qui réécrirait les soldes existants
 * (Rémi confirme que ceux de Cindy et Ala sont normalement déjà corrects), mais une vérification humaine
 * par Ala sur TOUTE l'équipe (règle générale, pas seulement Hinda), qui reste libre de corriger à la main
 * comme aujourd'hui (aucun champ verrouillé par ce script ni par board.html).
 *
 * Ce script ne modifie AUCUNE donnée de solde lui-même — il se contente de poser la tâche. Le calcul et
 * la correction effective des soldes restent un acte humain d'Ala dans la fiche GRH (Onglet 7), comme le
 * reste de la saisie RH.
 *
 * Idempotent : id déterministe "verif-solde-cp-equipe-2026-11" — un nouveau lancement avec --apply
 * remplace le même document plutôt que de le dupliquer (donc jamais 2 fois la même tâche).
 *
 * SÉCURITÉ "zéro perte / jamais sans GO" : dry-run par défaut (affiche le document prévu, n'écrit RIEN).
 * N'écrit dans la base que si on lui passe --apply explicitement, à lancer seulement après validation
 * avec Rémi et après déploiement (ce script ne pousse rien sur GitHub, ne touche que la base "taches").
 *
 * Usage :
 *   node scripts/seedTacheVerifSoldeCp.js            # dry-run (par défaut)
 *   node scripts/seedTacheVerifSoldeCp.js --apply     # écrit réellement dans la collection "taches"
 *
 *   Variable d'env DATABASE_URL : base cible (sinon dev locale).
 */

const TASK_ID = "verif-solde-cp-equipe-2026-11";

function buildTaskDoc() {
  return {
    clientId: null,
    clientNom: null,
    interne: true,
    categorieInterne: "RH",
    titre: "Vérifier et corriger les soldes CP de l'équipe (dates d'embauche)",
    affecte: "AC",
    etat: "a_traiter",
    detail:
      "Demande de Rémi (11/11/2026) : vérifier, pour chaque salarié(e) concerné(e) (hors Gérants TNS — " +
      "Rémi et Mélissa), que le solde de congés payés affiché dans la fiche GRH (Onglet 7 → panneau " +
      "\"🏖️ Solde congés payés\" et nouveau sous-onglet \"🏖️ CP\" du panneau Heures travaillées) est " +
      "cohérent avec sa date d'embauche réelle (acquisition légale : 2,5 j/mois depuis l'embauche, " +
      "période de référence juin→mai, moins les CP déjà pris/décomptés). Corriger directement dans la " +
      "fiche (champs \"Solde N-1\" / \"Solde année en cours\", bouton \"💾 Mettre à jour le solde\") " +
      "chaque écart constaté, puis mettre à jour le CRM en conséquence.\n\n" +
      "Priorité : la fiche de Hinda (solde encore approximatif, saisi en démarrage du nouveau système " +
      "Heures travaillées). Rémi indique que les soldes de Cindy et d'Ala elle-même sont normalement " +
      "déjà corrects à ce jour — à reconfirmer malgré tout en passant en revue toute l'équipe, plutôt " +
      "que de supposer sans vérifier.\n\n" +
      "Aucun calcul automatique n'a été mis en place à la place de cette vérification humaine (décision " +
      "explicite de Rémi le 11/11/2026) — la correction reste manuelle, comme le reste de la saisie RH.",
    typeTache: "standard",
    criticite: "moyenne",
    echeance: null,
    recurrente: false,
    messages: [],
    rdvId: null, rdvDate: null, rdvHeure: null, rdvLieu: null,
    redacteur: "RE",
    createdAt: new Date().toISOString(),
    treatedAt: null,
  };
}

async function main() {
  const apply = process.argv.includes("--apply");
  const doc = buildTaskDoc();

  console.log(`=== Tâche prévue (id déterministe : "${TASK_ID}") ===`);
  console.log(JSON.stringify(doc, null, 2));

  if (!apply) {
    console.log(`\n(dry-run — aucune écriture effectuée. Relancer avec --apply pour créer réellement la ` +
      `tâche, après validation avec Rémi et après déploiement.)`);
    process.exit(0);
  }

  console.log(`\n--apply : écriture dans la collection "taches"...`);
  const db = require("../src/db");
  await db.set("taches", TASK_ID, doc);
  console.log(`✅ Tâche créée/mise à jour (upsert par id déterministe "${TASK_ID}") — assignée à Ala (AC).`);
  const c = await db.getClient();
  await c.end();
}

main().catch((e) => {
  console.error("❌ Échec de la création de la tâche:", e);
  process.exit(1);
});
