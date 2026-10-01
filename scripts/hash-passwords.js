#!/usr/bin/env node
"use strict";
/**
 * Génère config/users.json (hashs uniquement) à partir d'une liste en clair
 * fournie sur l'entrée standard (JSON), pour ne JAMAIS écrire un mot de
 * passe en clair dans un fichier du dépôt.
 *
 * Usage :
 *   echo '{
 *     "pin": "VOTRE_PIN_ICI",
 *     "identities": [
 *       { "code": "RE", "name": "Rémi Everaer",       "password": "..." },
 *       { "code": "ME", "name": "Mélissa Everaer",    "password": "..." }
 *     ]
 *   }' | node scripts/hash-passwords.js
 *
 * Le fichier d'entrée en clair (si vous en utilisez un) doit être supprimé
 * immédiatement après exécution — ne jamais le committer.
 */

const fs = require("fs");
const path = require("path");
const { hashPassword } = require("../src/auth");

function readStdin() {
  return new Promise((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", reject);
  });
}

async function main() {
  const raw = await readStdin();
  let input;
  try {
    input = JSON.parse(raw);
  } catch (e) {
    console.error("Entrée JSON invalide :", e.message);
    process.exit(1);
  }

  if (!input.pin || !Array.isArray(input.identities)) {
    console.error('Format attendu : { "pin": "...", "identities": [{ "code", "name", "password" }, ...] }');
    process.exit(1);
  }

  const out = {
    pinHash: hashPassword(input.pin),
    identities: input.identities.map((id) => {
      if (!id.code || !id.name || !id.password) {
        throw new Error(`Entrée incomplète pour ${JSON.stringify(id)}`);
      }
      return { code: id.code, name: id.name, passwordHash: hashPassword(id.password) };
    }),
    generatedAt: new Date().toISOString(),
  };

  const outPath = path.join(__dirname, "..", "config", "users.json");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  console.log(`OK — ${out.identities.length} identités hachées, écrites dans ${outPath}`);
  console.log("Aucun mot de passe en clair n'a été écrit sur disque.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
