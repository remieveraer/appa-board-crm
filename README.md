# BOARD CRM APPA SERVICES — serveur d'hébergement

Serveur unique (page + API données + API authentification + API
documents protégés) qui remplace la version "artefact claude.ai" du board
par une vraie application web, utilisable par toute l'équipe, hébergée sur
Scalingo.

## Pourquoi zéro dépendance npm

Ce projet n'installe **aucun paquet externe** (`dependencies: {}` dans
`package.json`) — uniquement les modules natifs de Node.js (`http`, `net`,
`tls`, `crypto`, `fs`). Ce n'est pas un choix de style : l'accès au
registre npm public est bloqué dans l'environnement où ce projet a été
construit, donc `express` et `pg` n'ont pas pu être installés. Plutôt que
de bloquer le projet, `src/pg-client.js` réimplémente directement la
partie du protocole PostgreSQL nécessaire (connexion, authentification
SCRAM-SHA-256, requêtes paramétrées) — testé de bout en bout contre une
vraie base PostgreSQL (`test/pg-client.test.js`, `test/db.test.js`).

Conséquence pratique pour vous : **aucun `npm install` n'est nécessaire**
avant de démarrer ce serveur, ni en local ni sur Scalingo — ce qui
simplifie aussi le déploiement.

## Démarrage local

```bash
cp .env.example .env
# adapter DATABASE_URL si besoin (une base PostgreSQL locale doit exister)
npm run migrate      # crée le schéma (une seule table générique "documents")
npm run seed         # importe les 272 clients + 26 prestataires réels
npm start             # démarre le serveur sur le port 3000
```

Puis ouvrir `http://localhost:3000/`.

## Déploiement sur Scalingo

1. Créer l'application Scalingo (nom au choix, ex. `appa-board`).
2. Attacher l'addon **PostgreSQL** (n'importe quel plan) — Scalingo fournit
   alors automatiquement la variable d'environnement `DATABASE_URL`, avec
   `sslmode=require` déjà inclus dans l'URL (géré par `src/pg-client.js`).
3. Pousser ce dossier sur le remote git Scalingo de l'application
   (`git push scalingo main`) — Scalingo détecte le `Procfile` et démarre
   `node src/server.js` automatiquement, sans étape de build (zéro
   dépendance = rien à compiler ni installer).
4. Une fois déployé, exécuter une seule fois, depuis le terminal Scalingo
   (`scalingo run bash` sur l'application) :
   ```bash
   npm run migrate
   npm run seed
   ```
5. Régler `NODE_ENV=production` dans les variables d'environnement
   Scalingo (active le cookie `Secure` sur les sessions).
6. Communiquer l'URL Scalingo à l'équipe — chacun se connecte avec son
   code + mot de passe habituel (RE/ME/CG/OC/AC/RL), inchangés.

## Ce qui est fait et testé (28/09/2026)

- **Authentification réelle** : PIN puis identité + mot de passe,
  hachage scrypt, sessions httpOnly, anti-bruteforce (5 essais puis 15 min
  de blocage) — 13/13 tests automatisés passants (`test/auth.test.js`),
  identique à la version déjà validée précédemment.
- **API données générique** (`/api/db/:collection[/:id]`, GET/POST/PUT/
  PATCH/DELETE) — remplace `claude.use("db")`, backée par PostgreSQL réel,
  testée de bout en bout.
- **API documents protégés** (`/api/docs`, `/api/docs/:id/download`) —
  sert les 16 fichiers réels (originaux .pptx/.docx, plus la peine de
  passer par des PDF convertis comme sur claude.ai), avec mot de passe
  vérifié côté serveur (scrypt, jamais en clair) et restriction par
  identité pour les 4 documents réservés RE/ME — testé de bout en bout
  (accès public OK, mot de passe correct/incorrect, document réservé
  refusé pour une autre identité).
- **Import des données réelles** : 272 clients + 26 prestataires importés
  et vérifiés en base (`npm run seed`). Sur les 80 anomalies relevées lors
  de la migration (voir `board_test/migration/anomalies.json`) : 72
  (MJPM non rattaché à l'annuaire) sont maintenant rattachées à leur fiche
  client précise via le champ `aCorriger` (66 fiches concernées — l'équipe
  les verra directement dans le board une fois en ligne), et les 8
  restantes (état RUM ambigu : "VIR. SEPA", "inchangé"...) étaient déjà
  neutralisées par le script de migration d'origine (`rumStatut` laissé
  vide, le board les affiche par défaut "à traiter") — aucune anomalie
  n'est donc ignorée ou perdue.

## Ce qui est fait depuis (28/09/2026, suite)

- **Déploiement Scalingo réel effectué** : application `appa-board-crm`,
  addon PostgreSQL `postgresql-starter-512`, code poussé, migrations +
  import des données réelles exécutés en production. Live à
  `https://appa-board-crm.osc-fr1.scalingo.io`.
- **`public/board.html` adapté** : la page appelle désormais `makeApiDb()`
  (nouveau, dans le fichier) au lieu de `claude.use("db")` dès que
  `claude` est indisponible (systématique hors claude.ai) — sondage
  (« polling ») de `/api/db/...` toutes les ~5 secondes, immédiat au
  premier chargement. Le portail d'accès (`checkPinGate`, `submitPin`,
  `submitGateIdentity`, `requestIdentityChange`) appelle réellement
  `/api/auth/{pin,login,me,logout}` — les constantes `PIN_CODE` et
  `MP_PRENOM` (mots de passe en clair dans le code source) ont été
  supprimées du fichier.
- **Bug de concurrence corrigé dans `src/pg-client.js`** : la connexion
  PostgreSQL unique (une seule socket TCP réutilisée pour toutes les
  requêtes) n'était pas sûre pour des requêtes concurrentes — exactement
  le cas du board, qui interroge ses ~14 collections en parallèle toutes
  les 5 secondes. Deux requêtes lancées en même temps pouvaient
  entrelacer leurs réponses sur le fil et corrompre les données lues
  (symptôme observé : erreur serveur "undefined n'est pas un JSON valide"
  sur certaines collections, dont `clients`/`prestataires` — probable
  cause de l'affichage de données tronquées/partielles constaté en test).
  Corrigé en sérialisant tous les appels `query()`/`simpleQuery()` d'une
  même connexion (file d'attente interne) — testé avec 14 requêtes
  lancées simultanément, plus aucune erreur.
- Vérifié de bout en bout avec un navigateur automatisé (Playwright) :
  connexion (étape 1 code équipe + étape 2 identité/mot de passe) contre
  les vraies routes serveur, chargement des 272 clients / 26 prestataires
  réels (plus de mode démo), écriture (`add`/`update`/`set`), et
  déconnexion — 0 erreur console, 0 requête `/api/db/...` en échec.

## Ce qui est fait depuis (28/09/2026, suite 2)

- **Connexion PIN cassée sur iPhone corrigée** : le champ code d'équipe
  n'avait aucun attribut `autocapitalize`/`autocorrect`. Sur iOS Safari,
  la mise en majuscule automatique de début de champ transformait
  silencieusement "appa2026" tapé en minuscules en "Appa2026" avant
  l'envoi — alors que le PIN réel stocké côté serveur est "APPA2026" (en
  entier). Sur Mac, ce comportement de clavier n'existe pas, d'où la
  différence observée. Corrigé par `autocapitalize="characters"` sur le
  champ + normalisation systématique en majuscules côté client avant
  l'appel à `/api/auth/pin` (le PIN d'équipe n'étant pas un mot de passe
  individuel, l'imposer en majuscules ne change rien pour personne). Le
  champ mot de passe personnel (`gatePwInput`), lui, reçoit
  `autocapitalize="none"` pour que la casse tapée par chacun (ex.
  "CINDY 1996") ne soit jamais altérée par le clavier mobile.
- **Icône toujours affichée en ancienne version malgré le déploiement de
  v7** : confirmé par Rémi — le fichier serveur avait bien changé, mais
  iOS/Safari conservent une copie mise en cache de l'icône à cette URL
  exacte (`/icons/icon-180.png`), indépendamment du contenu réel renvoyé
  par le serveur, et la re-servent telle quelle même après un nouveau
  déploiement. Corrigé en ajoutant un paramètre de version (`?v=2`) à
  toutes les URLs d'icônes et au manifest (`board.html` +
  `manifest.webmanifest`) : une URL jamais vue auparavant force un
  nouveau téléchargement réseau, contournant tous les niveaux de cache
  (navigateur, système, CDN éventuel) — il ne reste plus qu'à
  retirer/réinstaller le raccourci une dernière fois pour déclencher ce
  nouveau téléchargement (voir message de livraison).
- **Nom de l'application renommé en "APPA SERVICES"** (au lieu de "Board
  CRM APPA Services" / "Board APPA") — `<title>`, meta
  `apple-mobile-web-app-title`, et `name`/`short_name` du
  `manifest.webmanifest` : c'est ce nom qui apparaît dans l'onglet du
  navigateur et sous l'icône une fois l'app installée sur Dock/écran
  d'accueil. Le titre affiché à l'intérieur du board lui-même ("BOARD CRM
  APPA SERVICES" en en-tête de page et sur l'écran de connexion) n'a pas
  été touché — uniquement le nom de l'application au niveau système.
- **Mots de passe personnels également normalisés en majuscules** (même
  logique que le PIN ci-dessus, à la demande explicite de l'équipe) :
  `submitGateIdentity()` convertit désormais systématiquement la saisie en
  majuscules avant l'envoi à `/api/auth/login` — cohérent avec les 6
  mots de passe stockés (REMI13, MELISSA13, "CINDY 1996", OCEANE2007,
  ALA2000, ROMAIN1988), tous déjà en entier majuscules. Le champ précise
  maintenant "majuscules/minuscules sans importance" pour l'équipe.
- **Icône de l'application régénérée** : l'icône installée sur Dock/écran
  d'accueil utilisait un recadrage serré sur le bouclier seul (mal centré
  au goût de l'équipe). Remplacée par le logo complet — bouclier +
  "APPA SERVICES" + le slogan "Orchestrer votre autonomie au quotidien" —
  centré sur un fond blanc, régénéré depuis une version haute résolution
  du logo (1184×1116, trouvée dans un support PowerPoint existant, bien
  plus nette que le logo 160×160 utilisé initialement, lui-même extrait
  de l'en-tête de `board.html`). Toutes les tailles (16/32/180/192/512)
  régénérées à partir de ce même master haute résolution.
  ⚠️ Les appareils qui ont déjà "ajouté à l'écran d'accueil / au Dock"
  ont mis en cache l'ancienne icône au moment de l'installation — il faut
  retirer puis réinstaller le raccourci sur chaque appareil pour voir la
  nouvelle icône (voir message de livraison).

## Ce qui reste à faire

- **Téléchargement des documents protégés (`downloadDoc`, onglets
  Ressources/Montage dossier)** : `public/board.html` utilise encore
  l'ancien mécanisme (constantes `PPT_RESERVE_PASSWORD`/`DOC_DL_PASSWORD`
  en clair, liste `RESSOURCES_DOCS` avec des chemins `docs/...` qui
  n'existent pas sur ce serveur) au lieu des routes déjà prêtes et testées
  côté serveur (`/api/docs`, `/api/docs/:id/download`, avec les 16
  fichiers réels dans `files/` et le catalogue `config/docs.json`). Les
  boutons de téléchargement de ces 2 onglets ne fonctionneront donc pas
  tels quels une fois hébergés — prochaine étape.
- `SS_PASSWORD` (révélation du champ numéro de sécurité sociale masqué,
  ligne ~7740) reste vérifié côté navigateur en clair — à migrer vers une
  vérification serveur dans un second temps, hors urgence.
- Les modules restants du board (GRH, KPI/Projections, onglet Romain)
  n'ont pas de traitement particulier : ils passent déjà par la même API
  générique `/api/db/...` via `makeApiDb()`, sans code serveur
  supplémentaire à écrire.

## Structure du projet

```
src/
  pg-client.js   client PostgreSQL maison (zéro dépendance)
  db.js          couche générique par "collection" (JSONB) au-dessus de pg-client
  auth.js        hachage/vérification scrypt (inchangé depuis appa-board-auth-server)
  sessions.js    sessions + jetons PIN en mémoire (inchangé)
  rateLimiter.js anti-bruteforce en mémoire (inchangé)
  httpUtils.js   utilitaires HTTP partagés (cookies, JSON, en-têtes de sécurité)
  server.js      point d'entrée : routage HTTP (page + toutes les API)
migrations/
  001_init.sql   schéma (une seule table générique "documents")
scripts/
  migrate.js               applique les migrations
  seed-from-migration.js   importe les données réelles migrées
  hash-passwords.js        génère les hash scrypt des mots de passe d'équipe
config/
  users.json     identités + hash des mots de passe (ne jamais committer en clair)
  docs.json      catalogue des 16 documents réels + hash des mots de passe documents
files/           les 16 fichiers réels (PDF/PPTX/DOCX originaux)
public/
  board.html     la page du board (À ADAPTER — voir "Ce qui reste à faire")
test/            tests automatisés (auth, pg-client, db)
```
