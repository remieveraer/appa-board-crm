-- Migration 001 — schéma initial BOARD CRM APPA SERVICES
--
-- Un seul modèle générique "documents" (collection, id) -> JSONB, qui
-- reproduit exactement le modèle Firestore-like déjà utilisé par le code
-- métier du board (db.collection(x).doc(id)) : aucune table par collection
-- n'est nécessaire, donc aucune migration de schéma à écrire ni à
-- maintenir quand une nouvelle collection apparaît côté board.html.
--
-- Couvre les ~15 collections déjà utilisées par le board : prestataires,
-- clients, taches, journal, rdv, historique, declarations, meta, grh,
-- beneficiaires, rlReporting, rlDvp, rlReportingFranchise,
-- rlDiscussionFranchise, kpiReportingCa.

CREATE TABLE IF NOT EXISTS documents (
  collection  TEXT NOT NULL,
  id          TEXT NOT NULL,
  data        JSONB NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (collection, id)
);

-- Liste d'une collection entière (l'accès le plus fréquent : chaque écran
-- du board charge une collection en entier au démarrage puis se synchronise
-- par polling)
CREATE INDEX IF NOT EXISTS idx_documents_collection ON documents (collection);

-- Polling incrémental : "donne-moi ce qui a changé dans cette collection
-- depuis ma dernière synchro" (utilisé par le shim client db.collection(x).onSnapshot)
CREATE INDEX IF NOT EXISTS idx_documents_collection_updated ON documents (collection, updated_at);

-- Accélère les recherches à l'intérieur du JSON (ex. recherche client par nom/numéro)
CREATE INDEX IF NOT EXISTS idx_documents_data_gin ON documents USING GIN (data);

-- Table de suivi des migrations déjà appliquées (scripts/migrate.js)
CREATE TABLE IF NOT EXISTS _migrations (
  filename    TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
