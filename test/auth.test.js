"use strict";
/**
 * Suite de vérification end-to-end du serveur d'authentification.
 * Lance un vrai serveur sur un port de test, l'attaque avec de vraies
 * requêtes HTTP, et vérifie chaque scénario avant toute mise en prod.
 *
 * IMPORTANT : ces tests utilisent des identifiants FICTIFS dédiés
 * (test/fixtures/test-users.json), jamais les vrais mots de passe de
 * l'équipe — pour que ce fichier de test puisse être commité/déployé sans
 * jamais exposer un vrai identifiant en clair.
 *
 * Usage : npm test
 */

const { spawn } = require("child_process");
const http = require("http");
const path = require("path");

const PORT = 4173;
const BASE = `http://127.0.0.1:${PORT}`;

let failures = 0;
let passed = 0;

function ok(condition, label) {
  if (condition) {
    passed++;
    console.log(`  OK  - ${label}`);
  } else {
    failures++;
    console.log(`  FAIL - ${label}`);
  }
}

function request(method, urlPath, { body, cookie } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const headers = { "Content-Type": "application/json" };
    if (data) headers["Content-Length"] = Buffer.byteLength(data);
    if (cookie) headers["Cookie"] = cookie;

    const req = http.request(BASE + urlPath, { method, headers }, (res) => {
      let raw = "";
      res.on("data", (c) => (raw += c));
      res.on("end", () => {
        let parsed = null;
        try {
          parsed = raw ? JSON.parse(raw) : null;
        } catch (e) {
          /* laisse parsed à null */
        }
        resolve({
          status: res.statusCode,
          body: parsed,
          setCookie: res.headers["set-cookie"],
        });
      });
    });
    req.on("error", reject);
    if (data) req.write(data);
    req.end();
  });
}

function extractCookie(setCookieHeader, name) {
  if (!setCookieHeader) return null;
  const arr = Array.isArray(setCookieHeader) ? setCookieHeader : [setCookieHeader];
  for (const c of arr) {
    if (c.startsWith(name + "=")) return c.split(";")[0];
  }
  return null;
}

function waitForServer(maxAttempts = 30) {
  return new Promise((resolve, reject) => {
    let attempts = 0;
    const tryOnce = () => {
      attempts++;
      http
        .get(BASE + "/api/health", (res) => {
          res.resume();
          resolve();
        })
        .on("error", () => {
          if (attempts >= maxAttempts) return reject(new Error("Le serveur ne répond pas"));
          setTimeout(tryOnce, 100);
        });
    };
    tryOnce();
  });
}

async function main() {
  const serverPath = path.join(__dirname, "..", "src", "server.js");
  const fixturePath = path.join(__dirname, "fixtures", "test-users.json");
  const child = spawn(process.execPath, [serverPath], {
    env: { ...process.env, PORT: String(PORT), NODE_ENV: "test", USERS_CONFIG_PATH: fixturePath },
    stdio: ["ignore", "pipe", "pipe"],
  });

  try {
    await waitForServer();

    // 1. Mauvais PIN -> rejeté
    let res = await request("POST", "/api/auth/pin", { body: { pin: "MAUVAIS" } });
    ok(res.status === 401, "PIN incorrect rejeté (401)");

    // 2. Bon PIN -> jeton renvoyé
    res = await request("POST", "/api/auth/pin", { body: { pin: "TESTPIN0000" } });
    ok(res.status === 200 && typeof res.body.pinToken === "string", "PIN correct accepté, jeton reçu");
    const pinToken = res.body.pinToken;

    // 3. Login avec mauvais mot de passe -> rejeté, ET le jeton PIN reste
    //    valable (un mot de passe mal tapé ne doit pas forcer à retaper le
    //    code d'accès de l'équipe)
    res = await request("POST", "/api/auth/login", {
      body: { pinToken, code: "CG", password: "MAUVAIS_MDP" },
    });
    ok(res.status === 401, "Mot de passe incorrect rejeté (401)");

    // 4. Login avec bon mot de passe, même jeton PIN -> session créée
    res = await request("POST", "/api/auth/login", {
      body: { pinToken, code: "CG", password: "TESTPASS_CG_0003" },
    });
    ok(res.status === 200 && res.body.code === "CG" && res.body.name === "Cindy Grech", "Login correct accepté, identité renvoyée");
    const sessionCookie = extractCookie(res.setCookie, "appa_session");
    ok(!!sessionCookie, "Cookie de session posé (httpOnly côté serveur)");

    // 5. Un login RÉUSSI consomme le jeton PIN : il ne doit plus être
    //    rejouable pour créer une deuxième session
    res = await request("POST", "/api/auth/login", {
      body: { pinToken, code: "CG", password: "TESTPASS_CG_0003" },
    });
    ok(res.status === 401, "Le jeton PIN ne peut pas être réutilisé après un login réussi");

    // 6. /me sans cookie -> non authentifié
    res = await request("GET", "/api/auth/me");
    ok(res.status === 401, "/api/auth/me sans session -> 401");

    // 7. /me avec cookie -> identité correcte
    res = await request("GET", "/api/auth/me", { cookie: sessionCookie });
    ok(res.status === 200 && res.body.code === "CG", "/api/auth/me avec session valide -> identité correcte");

    // 8. Logout -> session détruite
    res = await request("POST", "/api/auth/logout", { cookie: sessionCookie });
    ok(res.status === 200, "Logout renvoie 200");
    res = await request("GET", "/api/auth/me", { cookie: sessionCookie });
    ok(res.status === 401, "/api/auth/me après logout -> 401 (session bien détruite)");

    // 9. Anti-bruteforce : 5 échecs consécutifs sur la même identité -> verrou
    let pinRes = await request("POST", "/api/auth/pin", { body: { pin: "TESTPIN0000" } });
    let freshToken = pinRes.body.pinToken;
    let lastStatus = null;
    for (let i = 0; i < 5; i++) {
      // chaque essai a besoin d'un jeton PIN frais (usage unique) mais le
      // compteur anti-bruteforce, lui, est par identité+IP et persiste
      pinRes = await request("POST", "/api/auth/pin", { body: { pin: "TESTPIN0000" } });
      freshToken = pinRes.body.pinToken;
      const attempt = await request("POST", "/api/auth/login", {
        body: { pinToken: freshToken, code: "AC", password: "FAUX" + i },
      });
      lastStatus = attempt.status;
    }
    ok(lastStatus === 401, "5 échecs enregistrés (401 chacun)");

    pinRes = await request("POST", "/api/auth/pin", { body: { pin: "TESTPIN0000" } });
    freshToken = pinRes.body.pinToken;
    res = await request("POST", "/api/auth/login", {
      body: { pinToken: freshToken, code: "AC", password: "TESTPASS_AC_0005" },
    });
    ok(res.status === 429, "6e tentative -> verrouillé (429) même avec le bon mot de passe");

    // 10. Une autre identité n'est pas affectée par le verrou de AC
    pinRes = await request("POST", "/api/auth/pin", { body: { pin: "TESTPIN0000" } });
    freshToken = pinRes.body.pinToken;
    res = await request("POST", "/api/auth/login", {
      body: { pinToken: freshToken, code: "RL", password: "TESTPASS_RL_0006" },
    });
    ok(res.status === 200 && res.body.code === "RL", "Le verrou sur AC n'empêche pas RL de se connecter");
  } finally {
    child.kill();
  }

  console.log(`\n${passed} tests réussis, ${failures} échecs`);
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Erreur pendant les tests :", e);
  process.exit(1);
});
