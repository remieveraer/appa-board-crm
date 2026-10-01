"use strict";
/** Utilitaires HTTP partagés — portés tels quels depuis appa-board-auth-server/src/server.js. */
const NODE_ENV = process.env.NODE_ENV || "development";
const COOKIE_SECURE = NODE_ENV === "production";
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || "";

function setSecurityHeaders(res, opts = {}) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  // La page elle-même (board.html) a besoin d'exécuter son propre JS/CSS inline
  // (elle est distribuée en un seul fichier, dans le même esprit que l'artefact
  // claude.ai d'origine) — donc CSP moins strict que pour les réponses API pures.
  res.setHeader(
    "Content-Security-Policy",
    opts.isPage
      ? "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'"
      : "default-src 'none'"
  );
  if (ALLOWED_ORIGIN) {
    res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
}

function sendJson(res, statusCode, body) {
  const payload = JSON.stringify(body);
  res.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  res.end(payload);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;
  header.split(";").forEach((pair) => {
    const idx = pair.indexOf("=");
    if (idx === -1) return;
    const key = pair.slice(0, idx).trim();
    const val = pair.slice(idx + 1).trim();
    cookies[key] = decodeURIComponent(val);
  });
  return cookies;
}

function setCookie(res, name, value, maxAgeSeconds) {
  const parts = [
    `${name}=${encodeURIComponent(value)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (COOKIE_SECURE) parts.push("Secure");
  const existing = res.getHeader("Set-Cookie");
  const newHeader = existing ? [].concat(existing, parts.join("; ")) : parts.join("; ");
  res.setHeader("Set-Cookie", newHeader);
}

function clearCookie(res, name) {
  setCookie(res, name, "", 0);
}

function readJsonBody(req, maxBytes = 10 * 1024) {
  return new Promise((resolve, reject) => {
    let data = "";
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Payload trop volumineux"));
        req.destroy();
        return;
      }
      data += chunk;
    });
    req.on("end", () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error("JSON invalide"));
      }
    });
    req.on("error", reject);
  });
}

function clientKey(req, suffix) {
  const ip = req.socket.remoteAddress || "unknown";
  return `${suffix}:${ip}`;
}

module.exports = {
  setSecurityHeaders,
  sendJson,
  parseCookies,
  setCookie,
  clearCookie,
  readJsonBody,
  clientKey,
  COOKIE_SECURE,
  NODE_ENV,
};
