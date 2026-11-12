// Test helpers: an OpenID provider in-process (its own RSA key, discovery, JWKS and token endpoints on a free port),
// the cloud with memory adapters and a clock, and a client that keeps cookies like a browser.
import crypto from "node:crypto";
import http from "node:http";
import { handle } from "../src/api.mjs";
import { oidcClient } from "../src/auth/oidc.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";

export const PUBLIC_URL = "https://cloud.example";
export const CLIENT_ID = "imitor-test.apps.example";
export const CLIENT_SECRET = "test-client-secret";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");

/** A signed JWT. key: a private KeyObject; header extras (kid) and claims as given. */
export function signJwt(claims, { key, kid, alg = "RS256" }) {
  const head = b64({ alg, typ: "JWT", kid });
  const body = b64(claims);
  const sig = crypto.sign("RSA-SHA256", Buffer.from(`${head}.${body}`), key).toString("base64url");
  return `${head}.${body}.${sig}`;
}

/**
 * The fake provider. issue(code, { claims, sign }) registers what the token endpoint answers for a code; the answer is
 * only given for the right client, secret, redirect URI and PKCE verifier. rotate() replaces the signing key.
 */
export async function fakeProvider({ clientId = CLIENT_ID, clientSecret = CLIENT_SECRET } = {}) {
  let keys = [newKey()];
  const codes = new Map();
  const calls = { discovery: 0, jwks: 0, token: 0 };
  function newKey() {
    const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
    return { kid: crypto.randomBytes(6).toString("hex"), privateKey, publicKey };
  }
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://x");
    const send = (status, value) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(value));
    if (url.pathname === "/.well-known/openid-configuration") {
      calls.discovery++;
      return send(200, { issuer: provider.issuer, authorization_endpoint: `${provider.issuer}/authorize`, token_endpoint: `${provider.issuer}/token`, jwks_uri: `${provider.issuer}/jwks` });
    }
    if (url.pathname === "/jwks") {
      calls.jwks++;
      return send(200, { keys: keys.map((k) => ({ ...k.publicKey.export({ format: "jwk" }), kid: k.kid, alg: "RS256", use: "sig" })) });
    }
    if (url.pathname === "/token" && req.method === "POST") {
      calls.token++;
      let text = "";
      for await (const chunk of req) text += chunk;
      const form = Object.fromEntries(new URLSearchParams(text));
      const entry = codes.get(form.code);
      if (!entry || form.grant_type !== "authorization_code" || form.client_id !== clientId || form.client_secret !== clientSecret) return send(400, { error: "invalid_grant" });
      if (form.redirect_uri !== entry.redirectUri) return send(400, { error: "invalid_grant" });
      if (crypto.createHash("sha256").update(form.code_verifier || "").digest("base64url") !== entry.challenge) return send(400, { error: "invalid_grant" });
      codes.delete(form.code);
      return send(200, { access_token: "at", token_type: "Bearer", expires_in: 3600, id_token: entry.token() });
    }
    send(404, { error: "not found" });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const provider = {
    issuer: `http://127.0.0.1:${server.address().port}`,
    calls,
    get key() { return keys[0]; },
    rotate() { keys = [newKey()]; },
    /**
     * What the token endpoint answers for `code`, for an authorization URL the cloud redirected to. claims are laid over
     * valid ones (this issuer, this client, the URL's nonce, now); sign: { key, kid } to sign with something else.
     */
    issue(code, authorizeUrl, { claims = {}, sign = null, now = () => new Date() } = {}) {
      const q = new URL(authorizeUrl).searchParams;
      const t = Math.floor(now().getTime() / 1000);
      const base = { iss: provider.issuer, aud: clientId, sub: "100200300400", email: "ada@example.com", email_verified: true, name: "Ada Lovelace", iat: t, exp: t + 3600, nonce: q.get("nonce") };
      codes.set(code, { redirectUri: q.get("redirect_uri"), challenge: q.get("code_challenge"), token: () => signJwt({ ...base, ...claims }, sign || { key: keys[0].privateKey, kid: keys[0].kid }) });
    },
    close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }),
  };
  return provider;
}

/** A clock that only moves when told: now(), advance(ms), set(iso). */
export function clock(start = "2026-11-12T10:00:00.000Z") {
  let t = Date.parse(start);
  const now = () => new Date(t);
  now.advance = (ms) => { t += ms; };
  now.set = (iso) => { t = Date.parse(iso); };
  return now;
}

/** The cloud with memory adapters. opts: { provider, allowed, adminToken, cronSecret }. */
export function cloud({ provider = null, allowed = ["ada@example.com"], adminToken = null, cronSecret = null, now = clock() } = {}) {
  const db = memoryDb({ now });
  const storage = memoryStorage({ baseUrl: "https://storage.example", now: () => now().getTime() });
  const oidc = provider && oidcClient({
    clientId: CLIENT_ID, clientSecret: CLIENT_SECRET, redirectUri: `${PUBLIC_URL}/auth/google/callback`,
    discoveryUrl: `${provider.issuer}/.well-known/openid-configuration`, issuers: [provider.issuer], now,
  });
  const logged = [];
  const deps = { db, storage, publicUrl: PUBLIC_URL, oidc, allowedEmails: new Set(allowed), adminToken, cronSecret, now, log: (e) => logged.push(e) };
  return { db, storage, deps, now, logged };
}

/**
 * A browser: keeps cookies per name, sends Origin on everything but GET (as browsers do), follows nothing.
 * call(method, path, { body, form, headers, origin }) -> { status, headers, text, json, location }.
 */
export function browser(deps) {
  const jar = new Map();
  async function call(method, path, { body, form, headers = {}, origin = PUBLIC_URL } = {}) {
    const h = { ...headers };
    if (jar.size) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
    if (method !== "GET" && method !== "HEAD" && origin) h.origin = origin;
    let payload;
    if (form) {
      h["content-type"] = "application/x-www-form-urlencoded";
      payload = new URLSearchParams(form).toString();
    } else if (body !== undefined) {
      h["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    const res = await handle(new Request(new URL(path, PUBLIC_URL), { method, headers: h, body: payload }), deps);
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(";").map((s) => s.trim());
      const i = pair.indexOf("=");
      const name = pair.slice(0, i);
      if (attrs.some((a) => /^max-age=0$/i.test(a))) jar.delete(name);
      else jar.set(name, pair.slice(i + 1));
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: res.status, headers: res.headers, text, json, location: res.headers.get("location"), cookies: res.headers.getSetCookie() };
  }
  return { call, jar };
}

/** Sign `b` (a browser) in through the fake provider; returns the callback's answer. opts as provider.issue, plus next. */
export async function googleSignIn(b, provider, { code = crypto.randomBytes(6).toString("hex"), next = null, now, ...issue } = {}) {
  const start = await b.call("GET", `/auth/google${next ? `?next=${encodeURIComponent(next)}` : ""}`);
  if (start.status !== 302) throw new Error(`/auth/google answered ${start.status}: ${start.text}`);
  provider.issue(code, start.location, { now, ...issue });
  const state = new URL(start.location).searchParams.get("state");
  return { start, done: await b.call("GET", `/auth/google/callback?code=${code}&state=${issue.state ?? state}`) };
}
