"use strict";
/**
 * Serveur unique BOARD CRM APPA SERVICES — page + API données + API
 * authentification + API documents protégés, en un seul process Node.js
 * natif (aucune dépendance npm — voir README.md "Pourquoi zéro dépendance").
 *
 * Remplace :
 *  - claude.use("db") / claude.use("downloads") (disponibles uniquement à
 *    l'intérieur de claude.ai) par une vraie base PostgreSQL (src/db.js) et
 *    de vrais téléchargements de fichiers servis par ce serveur ;
 *  - la vérification du PIN/mot de passe côté navigateur (lisible dans le
 *    code source de la page) par une vérification côté serveur, avec
 *    sessions httpOnly (src/auth.js, src/sessions.js, déjà testés — 13/13 —
 *    et repris tels quels depuis appa-board-auth-server).
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

loadDotEnv();

const { verifyPassword } = require("./auth");
const sessions = require("./sessions");
const rateLimiter = require("./rateLimiter");
const db = require("./db");
const {
  setSecurityHeaders,
  sendJson,
  parseCookies,
  setCookie,
  clearCookie,
  readJsonBody,
  clientKey,
} = require("./httpUtils");

function loadDotEnv() {
  const envPath = path.join(__dirname, "..", ".env");
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, "utf8").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) process.env[key] = value;
  }
}

const PORT = process.env.PORT || 3000;
const NODE_ENV = process.env.NODE_ENV || "development";
const PUBLIC_DIR = path.join(__dirname, "..", "public");
const FILES_DIR = path.join(__dirname, "..", "files");

const USERS_PATH = process.env.USERS_CONFIG_PATH || path.join(__dirname, "..", "config", "users.json");
const DOCS_PATH = process.env.DOCS_CONFIG_PATH || path.join(__dirname, "..", "config", "docs.json");
let usersConfig = JSON.parse(fs.readFileSync(USERS_PATH, "utf8"));
let docsConfig = JSON.parse(fs.readFileSync(DOCS_PATH, "utf8"));

// ---------- Auth : PIN / login / session (identique à appa-board-auth-server) ----------

async function handlePin(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: "Requête invalide" });
  }
  const key = clientKey(req, "pin");
  if (rateLimiter.isLocked(key)) {
    return sendJson(res, 429, {
      error: "Trop de tentatives. Réessayez dans quelques minutes.",
      retryAfterSeconds: rateLimiter.remainingLockoutSeconds(key),
    });
  }
  const { pin } = body;
  if (!verifyPassword(String(pin || ""), usersConfig.pinHash)) {
    rateLimiter.recordFailure(key);
    return sendJson(res, 401, { error: "Code incorrect" });
  }
  rateLimiter.recordSuccess(key);
  const pinToken = sessions.createPinToken();
  return sendJson(res, 200, { pinToken });
}

async function handleLogin(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (e) {
    return sendJson(res, 400, { error: "Requête invalide" });
  }
  const { pinToken, code, password } = body;
  if (!sessions.isValidPinToken(String(pinToken || ""))) {
    return sendJson(res, 401, { error: "Session expirée, recommencez depuis le code d'accès." });
  }
  const identityCode = String(code || "").toUpperCase();
  const key = clientKey(req, `login:${identityCode}`);
  if (rateLimiter.isLocked(key)) {
    return sendJson(res, 429, {
      error: "Trop de tentatives sur ce compte. Réessayez dans quelques minutes.",
      retryAfterSeconds: rateLimiter.remainingLockoutSeconds(key),
    });
  }
  const identity = usersConfig.identities.find((u) => u.code === identityCode);
  const ok = identity && verifyPassword(String(password || ""), identity.passwordHash);
  if (!ok) {
    rateLimiter.recordFailure(key);
    return sendJson(res, 401, { error: "Identifiant ou mot de passe incorrect" });
  }
  rateLimiter.recordSuccess(key);
  sessions.invalidatePinToken(String(pinToken || ""));
  const sessionId = sessions.createSession(identity);
  setCookie(res, "appa_session", sessionId, 8 * 60 * 60);
  return sendJson(res, 200, { code: identity.code, name: identity.name });
}

function requireSession(req) {
  const cookies = parseCookies(req);
  return sessions.getSession(cookies.appa_session);
}

async function handleMe(req, res) {
  const session = requireSession(req);
  if (!session) return sendJson(res, 401, { error: "Non authentifié" });
  return sendJson(res, 200, { code: session.code, name: session.name });
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req);
  if (cookies.appa_session) sessions.destroySession(cookies.appa_session);
  clearCookie(res, "appa_session");
  return sendJson(res, 200, { ok: true });
}

// ---------- Données génériques (/api/db/:collection[/:id]) ----------
// Toute collection est autorisée par construction (le board en crée
// dynamiquement — meta, rlReporting, etc.) : la sécurité vient de
// l'authentification (session requise), pas d'une liste blanche de noms.

const COLLECTION_RE = /^[a-zA-Z0-9_]{1,64}$/;
const DOC_ID_RE = /^[a-zA-Z0-9_-]{1,128}$/;

async function handleDataRoute(req, res, session, parts, query) {
  const [collection, id] = parts;
  if (!COLLECTION_RE.test(collection)) return sendJson(res, 400, { error: "Nom de collection invalide" });
  if (id !== undefined && !DOC_ID_RE.test(id)) return sendJson(res, 400, { error: "Identifiant de document invalide" });

  try {
    if (!id) {
      if (req.method === "GET") {
        const since = query.get("since");
        const docs = await db.list(collection, since ? parseInt(since, 10) : undefined);
        return sendJson(res, 200, { docs });
      }
      if (req.method === "POST") {
        const body = await readJsonBody(req, 2 * 1024 * 1024); // 2 Mo : suffisant pour un document, évite les abus
        const doc = await db.add(collection, body.data !== undefined ? body.data : body, body.id);
        return sendJson(res, 201, { doc });
      }
      return sendJson(res, 405, { error: "Méthode non autorisée" });
    }

    if (req.method === "GET") {
      const doc = await db.get(collection, id);
      if (!doc) return sendJson(res, 404, { error: "Document introuvable" });
      return sendJson(res, 200, { doc });
    }
    if (req.method === "PUT") {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const doc = await db.set(collection, id, body.data !== undefined ? body.data : body);
      return sendJson(res, 200, { doc });
    }
    if (req.method === "PATCH") {
      const body = await readJsonBody(req, 2 * 1024 * 1024);
      const doc = await db.update(collection, id, body.data !== undefined ? body.data : body);
      return sendJson(res, 200, { doc });
    }
    if (req.method === "DELETE") {
      await db.remove(collection, id);
      return sendJson(res, 200, { ok: true });
    }
    return sendJson(res, 405, { error: "Méthode non autorisée" });
  } catch (e) {
    if (e.code === "NOT_FOUND") return sendJson(res, 404, { error: "Document introuvable" });
    if (e.message === "JSON invalide" || e.message === "Payload trop volumineux") {
      return sendJson(res, 400, { error: e.message });
    }
    throw e;
  }
}

// ---------- Documents protégés (/api/docs) ----------

function docPublicMeta(d) {
  return { id: d.id, titre: d.titre, mime: d.mime, protege: !!d.passwordGroup, reserve: d.reservedTo.length > 0 };
}

async function handleDocsList(req, res, session) {
  const visible = docsConfig.documents.filter((d) => d.reservedTo.length === 0 || d.reservedTo.includes(session.code));
  return sendJson(res, 200, { documents: visible.map(docPublicMeta) });
}

async function handleDocDownload(req, res, session, docId) {
  const entry = docsConfig.documents.find((d) => d.id === docId);
  if (!entry) return sendJson(res, 404, { error: "Document introuvable" });
  if (entry.reservedTo.length > 0 && !entry.reservedTo.includes(session.code)) {
    return sendJson(res, 403, { error: "Document réservé — accès non autorisé pour votre identité" });
  }
  if (entry.passwordGroup) {
    let body;
    try {
      body = await readJsonBody(req);
    } catch (e) {
      return sendJson(res, 400, { error: "Requête invalide" });
    }
    const key = clientKey(req, `doc:${docId}`);
    if (rateLimiter.isLocked(key)) {
      return sendJson(res, 429, {
        error: "Trop de tentatives. Réessayez dans quelques minutes.",
        retryAfterSeconds: rateLimiter.remainingLockoutSeconds(key),
      });
    }
    const hash = docsConfig.passwordGroups[entry.passwordGroup];
    if (!verifyPassword(String(body.password || ""), hash)) {
      rateLimiter.recordFailure(key);
      return sendJson(res, 401, { error: "Mot de passe incorrect" });
    }
    rateLimiter.recordSuccess(key);
  }
  const filePath = path.join(FILES_DIR, entry.file);
  if (!filePath.startsWith(FILES_DIR) || !fs.existsSync(filePath)) {
    return sendJson(res, 404, { error: "Fichier introuvable côté serveur" });
  }
  const stat = fs.statSync(filePath);
  res.writeHead(200, {
    "Content-Type": entry.mime,
    "Content-Length": stat.size,
    "Content-Disposition": `attachment; filename="${encodeURIComponent(entry.file)}"`,
    "Cache-Control": "no-store",
  });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- Fichiers statiques (la page board.html) ----------

function serveStatic(req, res, urlPath) {
  const rel = urlPath === "/" ? "board.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(PUBLIC_DIR, rel);
  if (!filePath.startsWith(PUBLIC_DIR) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    setSecurityHeaders(res);
    return sendJson(res, 404, { error: "Introuvable" });
  }
  setSecurityHeaders(res, { isPage: true });
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { ".html": "text/html; charset=utf-8", ".js": "application/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".json": "application/json; charset=utf-8", ".png": "image/png", ".svg": "image/svg+xml", ".webmanifest": "application/manifest+json; charset=utf-8", ".ico": "image/x-icon" };
  res.writeHead(200, { "Content-Type": mimeMap[ext] || "application/octet-stream" });
  fs.createReadStream(filePath).pipe(res);
}

// ---------- Routage ----------

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = new URL(req.url, "http://localhost");
    const urlPath = parsedUrl.pathname;

    if (req.method === "OPTIONS") {
      setSecurityHeaders(res);
      res.writeHead(204);
      return res.end();
    }

    if (!urlPath.startsWith("/api/")) {
      return serveStatic(req, res, urlPath);
    }

    setSecurityHeaders(res);

    if (req.method === "POST" && urlPath === "/api/auth/pin") return await handlePin(req, res);
    if (req.method === "POST" && urlPath === "/api/auth/login") return await handleLogin(req, res);
    if (req.method === "POST" && urlPath === "/api/auth/logout") return await handleLogout(req, res);
    if (req.method === "GET" && urlPath === "/api/auth/me") return await handleMe(req, res);
    if (req.method === "GET" && urlPath === "/api/health") return sendJson(res, 200, { ok: true });

    // Tout le reste de /api/ exige une session valide
    const session = requireSession(req);
    if (!session) return sendJson(res, 401, { error: "Non authentifié" });

    if (urlPath === "/api/docs" && req.method === "GET") return await handleDocsList(req, res, session);
    const docDlMatch = urlPath.match(/^\/api\/docs\/([a-zA-Z0-9_-]+)\/download$/);
    if (docDlMatch && req.method === "POST") return await handleDocDownload(req, res, session, docDlMatch[1]);

    const dataMatch = urlPath.match(/^\/api\/db\/([^/]+)(?:\/([^/]+))?$/);
    if (dataMatch) {
      const parts = [dataMatch[1], dataMatch[2]].filter((x) => x !== undefined);
      return await handleDataRoute(req, res, session, parts, parsedUrl.searchParams);
    }

    return sendJson(res, 404, { error: "Route inconnue" });
  } catch (e) {
    console.error("Erreur serveur:", e);
    if (!res.headersSent) sendJson(res, 500, { error: "Erreur serveur" });
  }
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`BOARD CRM APPA SERVICES — serveur en écoute sur le port ${PORT} (env: ${NODE_ENV})`);
  });
}

module.exports = server;
