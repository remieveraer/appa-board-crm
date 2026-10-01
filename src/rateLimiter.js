"use strict";
/**
 * Anti-bruteforce simple, en mémoire, sans dépendance externe.
 *
 * Pourquoi c'est nécessaire : les mots de passe choisis (prénom + année de
 * naissance) sont mémorisables mais devinables par quelqu'un qui connaît
 * l'équipe. Ce verrou compense en limitant drastiquement le nombre d'essais
 * possibles : après 5 échecs sur une même identité (RE/ME/CG/OC/AC/RL),
 * cette identité est bloquée 15 minutes, quel que soit qui essaie et d'où.
 */

const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const WINDOW_MS = 10 * 60 * 1000;

const attempts = new Map(); // key (ex: "login:CG") -> { count, firstAttemptAt, lockedUntil }

function isLocked(key) {
  const entry = attempts.get(key);
  if (!entry || !entry.lockedUntil) return false;
  if (Date.now() > entry.lockedUntil) {
    attempts.delete(key);
    return false;
  }
  return true;
}

function remainingLockoutSeconds(key) {
  const entry = attempts.get(key);
  if (!entry || !entry.lockedUntil) return 0;
  return Math.max(0, Math.ceil((entry.lockedUntil - Date.now()) / 1000));
}

function recordFailure(key) {
  const now = Date.now();
  let entry = attempts.get(key);
  if (!entry || now - entry.firstAttemptAt > WINDOW_MS) {
    entry = { count: 0, firstAttemptAt: now, lockedUntil: null };
  }
  entry.count += 1;
  if (entry.count >= MAX_ATTEMPTS) {
    entry.lockedUntil = now + LOCKOUT_MS;
  }
  attempts.set(key, entry);
}

function recordSuccess(key) {
  attempts.delete(key);
}

setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of attempts) {
    const stale = !entry.lockedUntil && now - entry.firstAttemptAt > WINDOW_MS;
    const lockoutOver = entry.lockedUntil && now > entry.lockedUntil;
    if (stale || lockoutOver) attempts.delete(key);
  }
}, 5 * 60 * 1000).unref();

module.exports = { isLocked, remainingLockoutSeconds, recordFailure, recordSuccess, MAX_ATTEMPTS };
