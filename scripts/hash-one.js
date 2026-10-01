"use strict";
// Petit utilitaire ponctuel : hache un mot de passe donné en argument et affiche le hash scrypt.
// Usage : node scripts/hash-one.js "motdepasse"
const { hashPassword } = require("../src/auth");
const pw = process.argv[2];
if (!pw) {
  console.error("Usage: node scripts/hash-one.js <motdepasse>");
  process.exit(1);
}
console.log(hashPassword(pw));
