"use strict";
/**
 * Gestion des sessions — stockage en mémoire côté serveur (v1).
 *
 * Le navigateur ne reçoit jamais qu'un identifiant de session aléatoire et
 * opaque (cookie httpOnly + Secure + SameSite=Strict) — jamais le mot de
 * passe, jamais un identifiant "devinable". Toute la vérification se fait
 * côté serveur, dans cette table en mémoire.
 *
 * Limite connue (à documenter pour Rémi) : cette table est vidée si le
 * serveur redémarre — tout le monde devra se reconnecter. Acceptable pour
 * une v1 à 6 utilisateurs ; à remplacer par un stockage persistant (Redis
 * ou la base de données réelle) une fois l'hébergement définitif choisi.
 */

const crypto = require("crypto");

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8h — une journée de travail
// Un jeton PIN reste valable 15 min et peut être réessayé sur plusieurs
// identités pendant ce délai (un mot de passe mal tapé ne doit pas obliger
// à retaper le code d'accès) — il n'est invalidé que par son expiration ou
// par un login RÉUSSI (invalidatePinToken), jamais par un simple échec.
const PIN_TTL_MS = 15 * 60 * 1000;

const sessions = new Map(); // sessionId -> { code, name, expiresAt }
const pinTokens = new Map(); // pinToken -> { expiresAt }

function createPinToken() {
  const token = crypto.randomBytes(32).toString("hex");
  pinTokens.set(token, { expiresAt: Date.now() + PIN_TTL_MS });
  return token;
}

function isValidPinToken(token) {
  const entry = pinTokens.get(token);
  if (!entry) return false;
  if (Date.now() > entry.expiresAt) {
    pinTokens.delete(token);
    return false;
  }
  return true;
}

function invalidatePinToken(token) {
  pinTokens.delete(token);
}

function createSession(identity) {
  const sessionId = crypto.randomBytes(32).toString("hex");
  sessions.set(sessionId, {
    code: identity.code,
    name: identity.name,
    expiresAt: Date.now() + SESSION_TTL_MS,
  });
  return sessionId;
}

function getSession(sessionId) {
  if (!sessionId) return null;
  const entry = sessions.get(sessionId);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    sessions.delete(sessionId);
    return null;
  }
  return entry;
}

function destroySession(sessionId) {
  sessions.delete(sessionId);
}

// Nettoyage périodique des entrées expirées (évite une fuite mémoire lente)
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of sessions) if (now > entry.expiresAt) sessions.delete(id);
  for (const [token, entry] of pinTokens) if (now > entry.expiresAt) pinTokens.delete(token);
}, 5 * 60 * 1000).unref();

module.exports = {
  createPinToken,
  isValidPinToken,
  invalidatePinToken,
  createSession,
  getSession,
  destroySession,
};
