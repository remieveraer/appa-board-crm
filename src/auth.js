"use strict";
/**
 * Hachage et vérification de mots de passe — 100% Node.js natif (module
 * "crypto"), aucune dépendance externe nécessaire.
 *
 * Algorithme : scrypt (RFC 7914), une fonction de dérivation de clé
 * "memory-hard" — recommandée par l'ANSSI et le NIST au même titre que
 * bcrypt/argon2 pour le stockage de mots de passe. Chaque mot de passe a
 * son propre sel aléatoire (16 octets), donc deux mots de passe identiques
 * ne produisent jamais le même hash stocké.
 */

const crypto = require("crypto");

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1 }; // paramètres standards recommandés

function hashPassword(plainPassword) {
  if (typeof plainPassword !== "string" || plainPassword.length === 0) {
    throw new Error("Mot de passe vide ou invalide");
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = crypto.scryptSync(plainPassword, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

function verifyPassword(plainPassword, storedHash) {
  if (typeof plainPassword !== "string" || typeof storedHash !== "string") return false;
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, saltHex, keyHex] = parts;
  try {
    const salt = Buffer.from(saltHex, "hex");
    const expectedKey = Buffer.from(keyHex, "hex");
    const derivedKey = crypto.scryptSync(plainPassword, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
    // Comparaison en temps constant — évite les attaques par mesure de latence
    return derivedKey.length === expectedKey.length && crypto.timingSafeEqual(derivedKey, expectedKey);
  } catch (e) {
    return false;
  }
}

module.exports = { hashPassword, verifyPassword };
