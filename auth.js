/* Single-owner Google sign-in. The whole site is private: only OWNER_EMAIL
   may sign in, everyone else is turned away. Server-side OAuth 2.0 code flow
   (no third-party script on the page, so the CSP stays tight), with a
   stateless HMAC-signed session cookie.

   Enabled only when GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and OWNER_EMAIL are
   all set; otherwise the site runs open (local dev). */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "data");

const CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET || "";
const OWNER_EMAIL = (process.env.OWNER_EMAIL || "").trim().toLowerCase();
export const authEnabled = Boolean(CLIENT_ID && CLIENT_SECRET && OWNER_EMAIL);

// Session-signing secret: from env, or generated once and persisted so
// sessions survive restarts.
function loadSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  const f = path.join(DATA_DIR, "session-secret");
  try { return fs.readFileSync(f, "utf8").trim(); } catch { /* generate */ }
  const s = crypto.randomBytes(32).toString("hex");
  try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, s); } catch {}
  return s;
}
const SECRET = loadSecret();
const SESSION_DAYS = 30;

const hmac = (s) => crypto.createHmac("sha256", SECRET).update(s).digest("base64url");

function signSession(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${body}.${hmac(body)}`;
}
function verifySession(token) {
  if (!token || !token.includes(".")) return null;
  const [body, mac] = token.split(".");
  const expect = hmac(body);
  if (!mac || mac.length !== expect.length) return null;
  if (!crypto.timingSafeEqual(Buffer.from(mac), Buffer.from(expect))) return null;
  try {
    const p = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch { return null; }
}

function parseCookies(req) {
  const out = {};
  const h = req.headers.cookie;
  if (!h) return out;
  for (const part of h.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const isHttps = (req) => Boolean(req.secure || req.headers["x-forwarded-proto"] === "https");
const cookie = (name, value, req, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isHttps(req) ? "; Secure" : ""}`;

// The login page carries an inline <style>, so it needs a slightly looser CSP
// than the app (which forbids inline styles). No inline scripts either way.
function sendLogin(res, message) {
  res.set("Content-Security-Policy", [
    "default-src 'self'", "style-src 'self' 'unsafe-inline'", "img-src 'self' data:",
    "script-src 'none'", "frame-ancestors 'none'",
  ].join("; "));
  res.status(200).type("html").send(`<!doctype html><html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>RuneScribe — sign in</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:flex; align-items:center; justify-content:center;
    background: radial-gradient(1000px 600px at 50% -10%, rgba(217,192,122,.06), transparent 60%), #0b0b0a;
    color:#e9e2cf; font-family: Georgia, "Times New Roman", serif; text-align:center; padding:24px; }
  .card { max-width:380px; }
  .glyph { font-size:56px; }
  h1 { font-family: Georgia, serif; letter-spacing:6px; font-size:20px; color:#f2df9f; font-weight:600; margin:14px 0 4px; text-transform:uppercase; }
  p { color:#a99f83; font-size:15px; line-height:1.5; margin:8px 0 22px; }
  .msg { color:#e0918a; font-size:14px; margin-bottom:16px; }
  a.btn { display:inline-flex; align-items:center; gap:10px; text-decoration:none;
    background:#f2df9f; color:#1c1403; font-weight:600; font-family: Georgia, serif;
    padding:12px 22px; border-radius:10px; font-size:15px; }
  a.btn:hover { filter:brightness(1.06); }
  .foot { margin-top:20px; font-size:12px; color:#6d6752; }
</style></head>
<body><div class="card">
  <div class="glyph">🧙</div>
  <h1>RuneScribe</h1>
  <p>A private Old School RuneScape account tracker.</p>
  ${message ? `<div class="msg">${String(message).replace(/[<>&"]/g, "")}</div>` : ""}
  <a class="btn" href="/auth/google">Sign in with Google</a>
  <div class="foot">Private — only the owner may enter.</div>
</div></body></html>`);
}

// Gate middleware: allow health/SEO/auth routes; require a session for the
// rest. API requests get 401 JSON, navigations get the login page.
export function gate(req, res, next) {
  if (!authEnabled) return next();
  const p = req.path;
  if (p === "/healthz" || p === "/robots.txt" || p === "/sitemap.xml" || p.startsWith("/auth/")) return next();
  const sess = verifySession(parseCookies(req).rs_session);
  if (sess) { req.user = sess; return next(); }
  if (p.startsWith("/api/")) return res.status(401).json({ error: "Sign in to continue." });
  return sendLogin(res);
}

export function installAuthRoutes(app, originFor) {
  app.get("/auth/google", (req, res) => {
    if (!authEnabled) return res.redirect("/");
    const state = crypto.randomBytes(16).toString("hex");
    res.append("Set-Cookie", cookie("rs_oauth_state", state, req, 600));
    const url = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: `${originFor(req)}/auth/google/callback`,
      response_type: "code",
      scope: "openid email profile",
      state,
      access_type: "online",
      prompt: "select_account",
    });
    res.redirect(url);
  });

  app.get("/auth/google/callback", async (req, res) => {
    if (!authEnabled) return res.redirect("/");
    const cookies = parseCookies(req);
    res.append("Set-Cookie", cookie("rs_oauth_state", "", req, 0));
    if (!req.query.code || !req.query.state || req.query.state !== cookies.rs_oauth_state) {
      return sendLogin(res, "Sign-in couldn't be verified. Please try again.");
    }
    try {
      const tokenRes = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code: String(req.query.code),
          client_id: CLIENT_ID,
          client_secret: CLIENT_SECRET,
          redirect_uri: `${originFor(req)}/auth/google/callback`,
          grant_type: "authorization_code",
        }),
      });
      const tok = await tokenRes.json();
      if (!tok.id_token) throw new Error("no id_token in token response");
      // The id_token came directly from Google's token endpoint over a
      // client-secret-authenticated TLS channel, so its payload is trusted.
      const claims = JSON.parse(Buffer.from(tok.id_token.split(".")[1], "base64url").toString("utf8"));
      const email = String(claims.email || "").toLowerCase();
      if (!claims.email_verified || email !== OWNER_EMAIL) {
        return sendLogin(res, "That account isn't the owner of this tracker.");
      }
      res.append("Set-Cookie", cookie("rs_session", signSession({ email, iat: Date.now(), exp: Date.now() + SESSION_DAYS * 864e5 }), req, SESSION_DAYS * 86400));
      res.redirect("/");
    } catch {
      return sendLogin(res, "Couldn't complete sign-in. Please try again.");
    }
  });

  app.get("/auth/logout", (req, res) => {
    res.append("Set-Cookie", cookie("rs_session", "", req, 0));
    res.redirect("/");
  });
}

export default { authEnabled, gate, installAuthRoutes };
