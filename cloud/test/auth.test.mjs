// Sign-in against a fake OpenID provider in-process, sessions, sign-out, CSRF and the admin token.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { SESSION_DAYS } from "../src/auth/session.mjs";
import { browser, CLIENT_ID, cloud, fakeProvider, googleSignIn, HTML, PUBLIC_URL } from "./helpers.mjs";

const DAY = 24 * 3600 * 1000;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

async function setup(t, opts = {}) {
  const provider = await fakeProvider();
  t.after(() => provider.close());
  const c = cloud({ provider, ...opts });
  return { ...c, provider, b: browser(c.deps) };
}

test("Google sign-in: PKCE, state and nonce; a first sign-in on the allowlist makes the user and binds the sub", async (t) => {
  const s = await setup(t);
  const { start, done } = await googleSignIn(s.b, s.provider, { next: "/p/fernwood/runs", now: s.now });
  const auth = new URL(start.location);
  assert.equal(auth.origin + auth.pathname, `${s.provider.issuer}/authorize`);
  const q = Object.fromEntries(auth.searchParams);
  assert.deepEqual({ ...q, state: null, nonce: null, code_challenge: null }, {
    response_type: "code", client_id: CLIENT_ID, redirect_uri: `${PUBLIC_URL}/auth/google/callback`, scope: "openid email profile",
    state: null, nonce: null, code_challenge: null, code_challenge_method: "S256", prompt: "select_account",
  });
  assert.ok(q.state.length >= 43 && q.nonce.length >= 43 && q.state !== q.nonce);
  const flowCookie = start.cookies.find((c) => c.startsWith("__Host-imitor_signin="));
  assert.match(flowCookie, /; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=600$/);

  assert.equal(done.status, 303);
  assert.equal(done.location, "/p/fernwood/runs");
  const session = done.cookies.find((c) => c.startsWith("__Host-imitor_session="));
  assert.match(session, /^__Host-imitor_session=[A-Za-z0-9_-]{43}; Path=\/; HttpOnly; SameSite=Lax; Secure; Max-Age=2592000$/);
  assert.ok(done.cookies.some((c) => /^__Host-imitor_signin=; .*Max-Age=0$/.test(c)), "the sign-in cookie is used once");

  const token = s.b.jar.get("__Host-imitor_session");
  const stored = await s.db.getSession(sha(token));
  assert.ok(stored, "only the SHA-256 of the cookie value is stored");
  assert.equal(await s.db.getSession(token), null);
  assert.equal(stored.expiresAt, new Date(s.now().getTime() + SESSION_DAYS * DAY).toISOString());

  const user = await s.db.findUserByEmail("ada@example.com");
  assert.deepEqual({ email: user.email, name: user.name, allowed: user.allowed }, { email: "ada@example.com", name: "Ada Lovelace", allowed: true });
  assert.deepEqual((await s.db.findIdentity("google", "100200300400")).userId, user.id);
  assert.deepEqual((await s.db.listAudit()).map((a) => a.action), ["user.create", "user.signin"]);

  const home = await s.b.call("GET", "/projects", { headers: HTML });
  assert.equal(home.status, 200);
  assert.match(home.text, /Ada Lovelace/);
  assert.match(home.headers.get("content-security-policy"), /default-src 'none'.*frame-ancestors 'none'/);

  // Replaying the callback (same code and state) does nothing: the sign-in cookie is gone.
  const replay = await s.b.call("GET", `/auth/google/callback?code=x&state=${q.state}`);
  assert.equal(replay.status, 400);
});

test("afterwards the sub decides: a changed address still signs in, the address alone never does", async (t) => {
  const s = await setup(t);
  assert.equal((await googleSignIn(s.b, s.provider, { now: s.now })).done.status, 303);
  const other = browser(s.deps);
  const moved = await googleSignIn(other, s.provider, { now: s.now, claims: { email: "ada@new.example" } });
  assert.equal(moved.done.status, 303, "same sub, address no longer on the list");
  const thief = browser(s.deps);
  const taken = await googleSignIn(thief, s.provider, { now: s.now, claims: { sub: "999", email: "ada@example.com" } });
  assert.equal(taken.done.status, 403, "the address on the list, but another Google account already holds it");
  assert.match(taken.done.text, /This Imitor Cloud is invite-only/);
  assert.equal(await s.db.findIdentity("google", "999"), null);

  // A person the owner turned off (allowed = false) is out, sessions and all.
  const user = await s.db.findUserByEmail("ada@example.com");
  await s.db.updateUser(user.id, { allowed: false });
  assert.equal((await s.b.call("GET", "/projects", { headers: HTML })).status, 302);
  assert.equal((await googleSignIn(browser(s.deps), s.provider, { now: s.now })).done.status, 403);
});

test("refused ID tokens: wrong aud, wrong iss, expired, issued in the future, bad signature, nonce mismatch", async (t) => {
  const s = await setup(t);
  const t0 = Math.floor(s.now().getTime() / 1000);
  const forged = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const cases = [
    [{ claims: { aud: "someone-else.apps.example" } }, /for another application/],
    [{ claims: { aud: [CLIENT_ID, "other"], azp: "other" } }, /for another application/],
    [{ claims: { iss: "https://accounts.example" } }, /issued by https:\/\/accounts\.example/],
    [{ claims: { exp: t0 - 120, iat: t0 - 3720 } }, /has expired/],
    [{ claims: { iat: t0 + 600 } }, /issued in the future/],
    [{ sign: { key: forged, kid: s.provider.key.kid } }, /signature does not match/],
    [{ claims: { nonce: "not-the-nonce" } }, /does not belong to this sign-in/],
  ];
  for (const [issue, error] of cases) {
    const b = browser(s.deps);
    const { done } = await googleSignIn(b, s.provider, { now: s.now, ...issue });
    assert.equal(done.status, 400, JSON.stringify(issue.claims || "signature"));
    assert.match(done.text, /Sign-in could not be verified/);
    assert.match(done.text, error);
    assert.equal(b.jar.has("__Host-imitor_session"), false);
  }
  // Within the minute of skew is fine.
  assert.equal((await googleSignIn(browser(s.deps), s.provider, { now: s.now, claims: { exp: t0 - 30 } })).done.status, 303);
  assert.equal((await s.db.listAudit()).filter((a) => a.action === "user.create").length, 1, "nothing made for a refused token");
});

test("unverified address, not on the allowlist, state mismatch and a cancelled sign-in create nothing", async (t) => {
  const s = await setup(t);
  const unverified = await googleSignIn(browser(s.deps), s.provider, { now: s.now, claims: { email_verified: false } });
  assert.equal(unverified.done.status, 403);
  assert.match(unverified.done.text, /has not verified the address/);

  const stranger = await googleSignIn(browser(s.deps), s.provider, { now: s.now, claims: { sub: "555", email: "mallory@example.com" } });
  assert.equal(stranger.done.status, 403);
  assert.match(stranger.done.text, /This Imitor Cloud is invite-only/);

  const b = browser(s.deps);
  const mismatch = await googleSignIn(b, s.provider, { now: s.now, state: "an-attackers-state" });
  assert.equal(mismatch.done.status, 400);
  assert.match(mismatch.done.text, /Start signing in again/);
  assert.equal(s.provider.calls.token, 2, "a mismatched state never reaches the token endpoint");

  const noCookie = await browser(s.deps).call("GET", "/auth/google/callback?code=abc&state=abc");
  assert.equal(noCookie.status, 400);
  const start = await b.call("GET", "/auth/google");
  const cancelled = await b.call("GET", `/auth/google/callback?error=access_denied&state=${new URL(start.location).searchParams.get("state")}`);
  assert.equal(cancelled.status, 400);
  assert.match(cancelled.text, /Google sign-in was cancelled/);

  assert.equal(await s.db.findUserByEmail("ada@example.com"), null);
  assert.equal(await s.db.findUserByEmail("mallory@example.com"), null);
  assert.deepEqual((await s.db.listAudit()).map((a) => a.action), []);
});

test("an unknown kid fetches the keys again (rotation); a known one does not", async (t) => {
  const s = await setup(t);
  await googleSignIn(s.b, s.provider, { now: s.now });
  assert.equal(s.provider.calls.jwks, 1);
  await googleSignIn(browser(s.deps), s.provider, { now: s.now });
  assert.equal(s.provider.calls.jwks, 1, "cached");
  s.provider.rotate();
  s.now.advance(2 * 60 * 1000);
  assert.equal((await googleSignIn(browser(s.deps), s.provider, { now: s.now })).done.status, 303);
  assert.equal(s.provider.calls.jwks, 2);
  assert.equal(s.provider.calls.discovery, 1, "discovery is cached too");
});

test("sessions slide for 30 days from last use, then expire; sign-out and sign-out everywhere delete them", async (t) => {
  const s = await setup(t);
  await googleSignIn(s.b, s.provider, { now: s.now });
  const hash = sha(s.b.jar.get("__Host-imitor_session"));

  s.now.advance(12 * 3600 * 1000);
  const quiet = await s.b.call("GET", "/projects", { headers: HTML });
  assert.equal(quiet.status, 200);
  assert.deepEqual(quiet.cookies, [], "not refreshed within the first day");

  s.now.advance(2 * DAY);
  const refreshed = await s.b.call("GET", "/projects", { headers: HTML });
  assert.match(refreshed.cookies[0], /^__Host-imitor_session=.*Max-Age=2592000$/);
  assert.equal((await s.db.getSession(hash)).expiresAt, new Date(s.now().getTime() + SESSION_DAYS * DAY).toISOString());

  s.now.advance(SESSION_DAYS * DAY + 1000);
  const late = await s.b.call("GET", "/projects", { headers: HTML });
  assert.equal(late.status, 302);
  assert.equal(late.location, "/login");
  assert.equal(await s.db.getSession(hash), null, "an expired session is deleted when it is seen");
  assert.match(late.cookies[0], /^__Host-imitor_session=; .*Max-Age=0$/);

  // Sign out: this session only.
  const phone = browser(s.deps);
  await googleSignIn(s.b, s.provider, { now: s.now });
  await googleSignIn(phone, s.provider, { now: s.now });
  const out = await s.b.call("POST", "/logout");
  assert.equal(out.status, 303);
  assert.equal(out.location, "/login");
  assert.equal(s.b.jar.has("__Host-imitor_session"), false);
  assert.equal((await s.b.call("GET", "/projects", { headers: HTML })).status, 302);
  assert.equal((await phone.call("GET", "/projects", { headers: HTML })).status, 200, "the other browser is still signed in");

  // Everywhere: every session of the person.
  await googleSignIn(s.b, s.provider, { now: s.now });
  assert.equal((await phone.call("POST", "/logout/everywhere")).status, 303);
  assert.equal((await s.b.call("GET", "/projects", { headers: HTML })).status, 302);
  assert.equal((await phone.call("GET", "/projects", { headers: HTML })).status, 302);
  assert.ok((await s.db.listAudit()).some((a) => a.action === "user.signout-everywhere"));
});

test("CSRF: a cookie-authenticated POST needs Origin (or Referer) equal to PUBLIC_URL", async (t) => {
  const s = await setup(t);
  await googleSignIn(s.b, s.provider, { now: s.now });
  for (const origin of [null, "https://evil.example", "null", "https://cloud.example.evil.example"]) {
    const res = await s.b.call("POST", "/projects", { body: { name: "fernwood" }, origin });
    assert.equal(res.status, 403, String(origin));
    assert.equal(res.json.error, "this request did not come from a page of this server");
  }
  assert.equal((await s.b.call("POST", "/logout", { origin: "https://evil.example" })).status, 403);
  assert.equal((await s.b.call("GET", "/projects", { headers: HTML })).status, 200, "still signed in");
  assert.equal((await s.b.call("POST", "/projects", { body: { name: "fernwood" }, origin: null, headers: { referer: `${PUBLIC_URL}/` } })).status, 201, "a same-origin Referer is enough");
  assert.equal((await s.b.call("POST", "/projects", { body: { name: "ferns" } })).status, 201);
  assert.deepEqual((await s.db.listUserProjects((await s.db.findUserByEmail("ada@example.com")).id)).map((p) => p.slug), ["fernwood", "ferns"].sort());
});

test("the admin token signs in the first admin on a private instance; it is off unless set", async (t) => {
  const off = cloud();
  assert.equal((await browser(off.deps).call("GET", "/login/token")).status, 404);
  const login = await browser(off.deps).call("GET", "/login");
  assert.match(login.text, /Sign-in is not set up on this server/);

  const token = crypto.randomBytes(32).toString("base64url");
  const s = cloud({ adminToken: token });
  const b = browser(s.deps);
  assert.match((await b.call("GET", "/login")).text, /Sign in with the admin token/);
  assert.equal((await b.call("GET", "/login/token")).status, 200);
  const wrong = await b.call("POST", "/login/token", { form: { token: token.slice(0, -1) + "x" } });
  assert.equal(wrong.status, 401);
  assert.match(wrong.text, /That is not the admin token/);
  assert.equal((await b.call("POST", "/login/token", { form: { token }, origin: "https://evil.example" })).status, 403, "login CSRF");
  const right = await b.call("POST", "/login/token", { form: { token, next: "/p/local/" } });
  assert.equal(right.status, 303);
  assert.equal(right.location, "/p/local/");
  assert.equal((await b.call("GET", "/projects", { headers: HTML })).status, 200);
  const admin = await s.db.findUserByEmail("admin");
  assert.equal(admin.allowed, true);
  assert.deepEqual((await s.db.listAudit()).map((a) => a.action), ["user.signin-refused", "user.create", "user.signin"]);

  const evil = await browser(s.deps).call("POST", "/login/token", { form: { token, next: "//evil.example/x" } });
  assert.equal(evil.location, "/projects", "next stays on this server");
});

test("on http://localhost the cookies drop __Host- and Secure; anywhere else they keep both", async (t) => {
  const provider = await fakeProvider();
  t.after(() => provider.close());
  const s = cloud({ provider });
  s.deps.publicUrl = "http://127.0.0.1:8787";
  const b = browser(s.deps);
  const start = await b.call("GET", "/auth/google");
  assert.match(start.cookies[0], /^imitor_signin=[^;]+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=600$/);
});
