"use strict";
const assert = require("assert");
const db = require("../src/db");

async function main() {
  const COL = "_test_clients";
  const c = await db.getClient();
  await c.query("DELETE FROM documents WHERE collection = $1", [COL]);

  const d1 = await db.add(COL, { nom: "Dupont", ville: "Gréasque" });
  assert.ok(d1.id);
  assert.strictEqual(d1.data.nom, "Dupont");
  console.log("✓ add() génère un id et stocke les données");

  const fetched = await db.get(COL, d1.id);
  assert.strictEqual(fetched.data.ville, "Gréasque");
  console.log("✓ get() relit le document");

  const updated = await db.update(COL, d1.id, { ville: "Marseille", tel: "0600000000" });
  assert.strictEqual(updated.data.ville, "Marseille");
  assert.strictEqual(updated.data.nom, "Dupont"); // merge, pas remplacement
  assert.strictEqual(updated.data.tel, "0600000000");
  console.log("✓ update() fusionne sans écraser les champs existants");

  let notFoundErr = null;
  try {
    await db.update(COL, "id_inexistant", { x: 1 });
  } catch (e) {
    notFoundErr = e;
  }
  assert.strictEqual(notFoundErr && notFoundErr.code, "NOT_FOUND");
  console.log("✓ update() sur un id inexistant lève NOT_FOUND");

  await db.add(COL, { nom: "Martin" }, "id_fixe");
  const list1 = await db.list(COL);
  assert.strictEqual(list1.length, 2);
  console.log("✓ list() renvoie tous les documents de la collection");

  const since = Date.now();
  await new Promise((r) => setTimeout(r, 50));
  await db.update(COL, "id_fixe", { nom: "Martin modifié" });
  const list2 = await db.list(COL, since);
  assert.strictEqual(list2.length, 1);
  assert.strictEqual(list2[0].id, "id_fixe");
  console.log("✓ list(collection, sinceMs) filtre correctement (polling incrémental)");

  await db.remove(COL, "id_fixe");
  const afterDelete = await db.get(COL, "id_fixe");
  assert.strictEqual(afterDelete, null);
  console.log("✓ remove() supprime bien le document");

  await c.query("DELETE FROM documents WHERE collection = $1", [COL]);
  console.log("\n✅ Tous les tests db.js sont passés.");
  process.exit(0);
}

main().catch((e) => {
  console.error("❌ ÉCHEC:", e);
  process.exit(1);
});
