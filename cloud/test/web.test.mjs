// Projects and their keys for signed-in people, membership on every project route, files, the interface in cloud
// mode, security headers and scheduled retention.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { handle, KEEP_DAYS } from "../src/api.mjs";
import { CAPS, noMail } from "../src/mail/index.mjs";
import { admit, HOME, safeNext, UNSUBSCRIBE_FAILURES } from "../src/web.mjs";
import { browser, cloud, HTML, PUBLIC_URL } from "./helpers.mjs";

const TOKEN = crypto.randomBytes(32).toString("base64url");
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

/** A cloud with two signed-in people (admin token for Ada, a session made directly for Bob). */
async function setup(opts = {}) {
  const c = cloud({ adminToken: TOKEN, ...opts });
  const ada = browser(c.deps);
  await ada.call("POST", "/login/token", { form: { token: TOKEN } });
  const bobUser = await c.db.createUser({ email: "bob@example.com", name: "Bob", allowed: true });
  const bob = browser(c.deps);
  const secret = crypto.randomBytes(32).toString("base64url");
  await c.db.createSession({ idHash: sha(secret), userId: bobUser.id, expiresAt: new Date(c.now().getTime() + 86400e3 * 30).toISOString() });
  bob.jar.set("__Host-imitor_session", secret);
  return { ...c, ada, bob, bobUser };
}

/** Push a ready run straight into the repository and storage. files: { path: bytes }. */
async function readyRun(c, project, clientRunId, files = { "screens/a-01-home-iphone-16-light.png": "png-a" }, { status = "ready", lines } = {}) {
  const id = `run_${crypto.randomBytes(10).toString("hex")}`;
  const list = Object.entries(files).map(([path, bytes]) => ({ path, size: bytes.length, sha256: sha(bytes), contentType: "image/png", key: `${project.id}/${id}/${path}` }));
  for (const f of list) c.storage.objects.set(f.key, { body: Buffer.from(files[f.path]), contentType: f.contentType });
  const shots = list.map((f) => ({ file: f.path, flow: "a", shot: "01-home", device: "iphone-16", scheme: "light", route: "/", stubs: [] }));
  const run = { schemaVersion: 1, id: clientRunId, status: "passed", title: "Larger tap targets", pr: null, branch: "main", commit: "abc1234", by: { name: "CI", kind: "ci" }, shots: shots.length, problems: 0, startedAt: c.now().toISOString(), finishedAt: c.now().toISOString(), devices: ["iphone-16"], schemes: ["light"], flows: [{ name: "a", status: "passed", device: "iphone-16", scheme: "light", after: null, state: null, seeded: false, clock: null, steps: shots.map((s, i) => ({ index: i + 1, name: s.shot, status: "ok", shot: s.file, route: "/", standIns: [], state: null, seeded: false })) }] };
  await c.db.createRun({ id, projectId: project.id, clientRunId, schemaVersion: 1, run, manifest: { shots, problems: [] }, files: list, keyId: null, lines });
  if (status === "ready") await c.db.updateRun(id, { status: "ready", completedAt: c.now().toISOString() });
  return id;
}

test("projects: create (the creator owns it), list mine, unique slugs; a form gets a redirect, JSON gets JSON", async () => {
  const s = await setup();
  const made = await s.ada.call("POST", "/projects", { body: { name: "  Fernwood   app " } });
  assert.equal(made.status, 201);
  assert.deepEqual({ ...made.json.project, id: null, createdAt: null }, { id: null, name: "Fernwood app", slug: "fernwood-app", createdAt: null, role: "owner" });
  const form = await s.ada.call("POST", "/projects", { form: { name: "Fernwood app" } });
  assert.equal(form.status, 303);
  assert.equal(form.location, "/p/fernwood-app-2/settings#access-keys");
  assert.equal((await s.ada.call("POST", "/projects", { body: { name: "" } })).status, 400);
  assert.equal((await s.ada.call("POST", "/projects", { form: { name: "x".repeat(81) } })).status, 400);
  assert.deepEqual((await s.ada.call("GET", "/projects")).json.projects.map((p) => [p.slug, p.role]), [["fernwood-app", "owner"], ["fernwood-app-2", "owner"]]);
  assert.deepEqual((await s.bob.call("GET", "/projects")).json.projects, [], "only my projects");
  const page = await s.ada.call("GET", "/projects", { headers: HTML });
  assert.match(page.text, /href="\/p\/fernwood-app\/"/);
  assert.match(page.headers.get("content-type"), /^text\/html/);
  assert.equal(page.headers.get("vary"), "Accept");
  assert.equal((await browser(s.deps).call("GET", "/projects")).status, 401);
  assert.equal((await browser(s.deps).call("GET", "/projects", { headers: HTML })).location, "/login");
  const audit = (await s.db.listAudit()).filter((a) => a.action === "project.create");
  assert.deepEqual(audit.map((a) => a.detail), [{ name: "Fernwood app", slug: "fernwood-app" }, { name: "Fernwood app", slug: "fernwood-app-2" }]);
});

test("home is /projects, never /: / redirects there, and signing in, the brand link and the interface land there", async () => {
  // On Vercel "/" is the public site's index.html (static files win over rewrites), so nothing may send people to it.
  const s = await setup();
  assert.equal(HOME, "/projects");
  assert.equal(safeNext(undefined), HOME);
  assert.equal(safeNext("/"), HOME, "a next of / would land on the site's page");
  assert.equal(safeNext("//evil.example"), HOME);
  assert.equal(safeNext("/p/fernwood/runs"), "/p/fernwood/runs");
  for (const b of [s.ada, browser(s.deps)]) {
    const root = await b.call("GET", "/", { headers: HTML });
    assert.equal(root.status, 302);
    assert.equal(root.location, HOME);
  }
  const signin = await browser(s.deps).call("POST", "/login/token", { form: { token: TOKEN } });
  assert.equal(signin.location, HOME, "signing in without a next lands on the projects page");
  const page = await s.ada.call("GET", HOME, { headers: HTML });
  assert.match(page.text, /<a class="brand" href="\/projects">/);
  assert.doesNotMatch(page.text, /href="\/"/);
  for (const p of ["/login", "/login/token"]) assert.doesNotMatch((await browser(s.deps).call("GET", p)).text, /href="\/"|next=%2F"/, p);
  const notFound = await s.ada.call("GET", "/nope");
  assert.match(notFound.text, /href="\/projects">Your projects/);
  // The interface's "All projects" links (src/app/api.js runs in a browser, so it is read as text here).
  const appApi = fs.readFileSync(new URL("../../src/app/api.js", import.meta.url), "utf8");
  assert.match(appApi, /CLOUD_PAGES = \{ projects: "\/projects",/);
});

test("access keys: an owner makes one (the secret once), lists them without secrets, revokes; all audited", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  const made = await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } });
  assert.equal(made.status, 201);
  assert.match(made.json.secret, /^imk_[A-Za-z0-9_-]{43}$/);
  assert.deepEqual(Object.keys(made.json.key).sort(), ["createdAt", "expiresAt", "id", "lastUsedAt", "name", "prefix", "revokedAt"]);
  assert.equal(made.json.key.prefix, made.json.secret.slice(0, 12));

  // The key uploads to this project.
  const body = { clientRunId: "20261112T100000-abc", schemaVersion: 1, run: { schemaVersion: 1, id: "20261112T100000-abc", startedAt: "2026-11-12T10:00:00.000Z", finishedAt: "2026-11-12T10:01:00.000Z", flows: [] }, manifest: { shots: [], problems: [] }, files: [] };
  const push = await handle(new Request(`${PUBLIC_URL}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${made.json.secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }), s.deps);
  assert.equal(push.status, 201);

  const list = await s.ada.call("GET", "/p/fernwood/api/keys");
  assert.equal(list.json.canManage, true);
  assert.equal(list.json.keys.length, 1);
  assert.ok(list.json.keys[0].lastUsedAt, "last used is shown");
  assert.ok(!JSON.stringify(list.json).includes(made.json.secret) && !JSON.stringify(list.json).includes(sha(made.json.secret)), "neither the secret nor its hash is listed");

  const revoked = await s.ada.call("POST", `/p/fernwood/api/keys/${made.json.key.id}/revoke`, { body: {} });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.json.key.revokedAt);
  const after = await handle(new Request(`${PUBLIC_URL}/v1/runs`, { method: "POST", headers: { authorization: `Bearer ${made.json.secret}`, "content-type": "application/json" }, body: JSON.stringify(body) }), s.deps);
  assert.equal(after.status, 401);
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/keys/key_nope/revoke", { body: {} })).status, 404);
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "" } })).status, 400);
  assert.deepEqual((await s.db.listAudit()).filter((a) => a.action.startsWith("key.")).map((a) => [a.action, a.detail.name]), [["key.create", "ci"], ["key.revoke", "ci"]]);
});

test("members: an owner adds people by address (as member or owner), lists and removes them; the last owner stays", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  const project = await s.db.getProjectBySlug("fernwood");

  // Bob has an account; Cy has never signed in.
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "BOB@example.com" } })).status, 201);
  const cy = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "cy@example.com", role: "owner" } });
  assert.equal(cy.status, 201);
  assert.deepEqual({ email: cy.json.member.email, role: cy.json.member.role, you: cy.json.member.you }, { email: "cy@example.com", role: "owner", you: false });

  const list = await s.ada.call("GET", "/p/fernwood/api/members");
  assert.equal(list.json.canManage, true);
  // Ada signed in with the admin token, as the user "admin".
  assert.deepEqual(list.json.members.map((m) => [m.email, m.role]), [["admin", "owner"], ["cy@example.com", "owner"], ["bob@example.com", "member"]]);
  assert.equal(list.json.members.find((m) => m.email === "admin").you, true);

  // Bob is in: he reads the project, and as a member cannot manage people.
  assert.equal((await s.bob.call("GET", "/p/fernwood/api/members")).json.canManage, false);
  assert.equal((await s.bob.call("POST", "/p/fernwood/api/members", { body: { email: "eve@example.com" } })).status, 403);
  assert.equal((await s.db.findUserByEmail("eve@example.com")), null, "a refused add creates nobody");

  // Adding again changes the role; bad input is refused.
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com", role: "owner" } })).status, 200);
  for (const body of [{ email: "not an address" }, { email: "" }, {}, { email: "x@example.com", role: "admin" }]) assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body })).status, 400, JSON.stringify(body));

  // Removing: a member goes; the last owner cannot.
  const bobId = s.bobUser.id;
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/members/${bobId}/remove`, { body: {} })).status, 200);
  assert.equal(await s.db.getMember(project.id, bobId), null);
  assert.equal((await s.bob.call("GET", "/p/fernwood/api/project")).status, 404, "removed means out");
  const cyId = (await s.db.findUserByEmail("cy@example.com")).id;
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/members/${cyId}/remove`, { body: {} })).status, 200);
  const adaId = (await s.db.findUserByEmail("admin")).id;
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/members/${adaId}/remove`, { body: {} })).status, 409, "the last owner stays");
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/members/usr_nope/remove", { body: {} })).status, 404);
  assert.deepEqual((await s.db.listAudit()).filter((a) => /^(member|user\.invite)/.test(a.action)).map((a) => [a.action, a.detail.email]), [
    ["member.add", "bob@example.com"], ["user.invite", "cy@example.com"], ["member.add", "cy@example.com"], ["member.role", "bob@example.com"],
    ["member.remove", "bob@example.com"], ["member.remove", "cy@example.com"],
  ]);

  // Bob, made the only owner, cannot step down to member.
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com", role: "owner" } });
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/members/${adaId}/remove`, { body: {} })).status, 200, "with two owners one can go");
  assert.equal((await s.bob.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com", role: "member" } })).status, 409, "the last owner cannot step down");
});

const DAY = 24 * 60 * 60 * 1000;
const MAX_SENDS_PER_DAY = CAPS.invitation.perSender;
const MAX_PER_ADDRESS_PER_DAY = CAPS.invitation.perAddress;
const mailRows = async (s) => (await s.db.listAudit()).filter((a) => a.action.startsWith("mail."));

test("members: someone newly added is emailed a link to the project; whether they ever signed in decides the wording", async () => {
  const s = await setup();
  const { json: { project } } = await s.ada.call("POST", "/projects", { body: { name: "Fernwood" } });
  const cy = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "Cy@Example.com" } });
  assert.equal(cy.status, 201);
  assert.equal(cy.json.notified, true);
  const [m] = s.mail.transport.sent;
  const cyUser = await s.db.findUserByEmail("cy@example.com");
  const url = `${PUBLIC_URL}/login?next=%2Fp%2Ffernwood%2F`;
  assert.equal(m.to, "cy@example.com");
  assert.equal(m.idempotencyKey, `member-add/${project.id}/${cyUser.id}/${cy.json.member.since}`);
  assert.ok(m.idempotencyKey.length <= 256);
  assert.equal(m.subject, 'Admin added you to "Fernwood" on Imitor Cloud');
  assert.match(m.text, /as a member/);
  assert.ok(m.text.includes(url));
  assert.deepEqual([...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]), [url]);
  assert.match(m.text, /Nothing happens unless you sign in/, "never signed in: they may not expect it");
  assert.deepEqual((await mailRows(s)).map((a) => [a.action, a.userId, a.projectId, a.detail]), [["mail.send", (await s.db.findUserByEmail("admin")).id, project.id, { kind: "invitation", to: "cy@example.com", id: "msg_1" }]]);

  // The link lands on the project: signed out, the sign-in page passes it on (through Google too, see auth.test.mjs);
  // signed in, straight there.
  const fresh = await browser(s.deps).call("GET", "/login?next=%2Fp%2Ffernwood%2F");
  assert.match(fresh.text, /href="\/login\/token\?next=%2Fp%2Ffernwood%2F"/);
  assert.equal((await s.ada.call("GET", "/login?next=%2Fp%2Ffernwood%2F")).location, "/p/fernwood/");

  // Someone who has signed in before is told without the "ignore this" line, as an owner when made one.
  await s.db.addIdentity("google", "google-bob", s.bobUser.id);
  const bob = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com", role: "owner" } });
  assert.equal(bob.json.notified, true);
  assert.equal(s.mail.transport.sent[1].to, "bob@example.com");
  assert.match(s.mail.transport.sent[1].text, /as an owner/);
  assert.doesNotMatch(s.mail.transport.sent[1].text, /ignore/);

  // An address invited by an earlier project but never signed in is still pending in the next one.
  await s.ada.call("POST", "/projects", { body: { name: "Oak" } });
  assert.equal((await s.ada.call("POST", "/p/oak/api/members", { body: { email: "cy@example.com" } })).json.notified, true);
  assert.match(s.mail.transport.sent[2].text, /Nothing happens unless you sign in/);
  assert.ok(s.mail.transport.sent[2].text.includes(`${PUBLIC_URL}/login?next=%2Fp%2Foak%2F`));

  // A role change sends nothing; a remove and re-add is a new membership, with a new key.
  const role = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "cy@example.com", role: "owner" } });
  assert.equal(role.status, 200);
  assert.equal(role.json.notified, false);
  assert.equal(s.mail.transport.sent.length, 3);
  await s.ada.call("POST", `/p/fernwood/api/members/${s.bobUser.id}/remove`, { body: {} });
  s.now.advance(1000);
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com" } })).json.notified, true);
  assert.notEqual(s.mail.transport.sent[3].idempotencyKey, s.mail.transport.sent[1].idempotencyKey);
});

test("members: a refused add sends nothing (not an owner, a turned-off account, not an address)", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com" } });
  const sent = s.mail.transport.sent.length;
  assert.equal((await s.bob.call("POST", "/p/fernwood/api/members", { body: { email: "eve@example.com" } })).status, 403);
  await s.db.createUser({ email: "off@example.com", allowed: false });
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "off@example.com" } })).status, 409);
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "not an address" } })).status, 400);
  assert.equal(s.mail.transport.sent.length, sent);
  assert.equal((await mailRows(s)).length, sent);
});

test("members: when the message cannot be sent the person is still added, and the failure is audited and logged", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  s.mail.transport.fail = "the provider is down";
  const res = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "cy@example.com" } });
  assert.equal(res.status, 201);
  assert.equal(res.json.notified, false);
  assert.equal(res.json.member.email, "cy@example.com");
  assert.deepEqual((await mailRows(s)).map((a) => [a.action, a.detail]), [["mail.fail", { kind: "invitation", to: "cy@example.com", status: 500 }]]);
  assert.equal(s.logged.length, 1);
  assert.match(String(s.logged[0].message), /not sent: the provider is down/);
});

test("members: past an owner's daily cap people are still added, unmailed, until the day moves on", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  for (let i = 0; i < MAX_SENDS_PER_DAY; i++) {
    assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: `p${i}@example.com` } })).json.notified, true);
  }
  const over = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "late@example.com" } });
  assert.equal(over.status, 201);
  assert.equal(over.json.notified, false);
  assert.equal(s.mail.transport.sent.length, MAX_SENDS_PER_DAY);
  assert.deepEqual((await mailRows(s)).filter((a) => a.action === "mail.limit").map((a) => a.detail), [{ kind: "invitation", to: "late@example.com" }]);
  s.now.advance(DAY + 1);
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "later@example.com" } })).json.notified, true);
  assert.equal(s.mail.transport.sent.length, MAX_SENDS_PER_DAY + 1);
});

test("members: one address gets at most perAddress invitations, whoever sends them", async () => {
  const s = await setup();
  for (const name of ["one", "two"]) await s.ada.call("POST", "/projects", { body: { name } });
  for (const name of ["three", "four"]) await s.bob.call("POST", "/projects", { body: { name } });
  const add = (b, slug) => b.call("POST", `/p/${slug}/api/members`, { body: { email: "cy@example.com" } });
  assert.equal(MAX_PER_ADDRESS_PER_DAY, 3);
  assert.equal((await add(s.ada, "one")).json.notified, true);
  assert.equal((await add(s.ada, "two")).json.notified, true);
  assert.equal((await add(s.bob, "three")).json.notified, true);
  const fourth = await add(s.bob, "four");
  assert.equal(fourth.status, 201);
  assert.equal(fourth.json.notified, false);
  assert.equal(s.mail.transport.sent.length, 3);
  assert.deepEqual((await mailRows(s)).filter((a) => a.action === "mail.limit").map((a) => [a.userId, a.detail.to]), [[s.bobUser.id, "cy@example.com"]]);
});

test("members: with mail off nobody is emailed, and nothing about mail is audited", async () => {
  const s = await setup();
  s.deps.mail = { transport: noMail(), from: null, replyTo: null };
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  const res = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "cy@example.com" } });
  assert.equal(res.status, 201);
  assert.equal(res.json.notified, false);
  assert.deepEqual(await mailRows(s), []);
});

/** Fernwood with Ada and Bob as owners and Cy as a member; the invitations this sends are cleared. */
async function twoOwners(opts) {
  const s = await setup(opts);
  const { json: { project } } = await s.ada.call("POST", "/projects", { body: { name: "Fernwood" } });
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com", role: "owner" } });
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "cy@example.com" } });
  s.mail.transport.sent.length = 0;
  return { ...s, project, mailCount: (await mailRows(s)).length };
}
const KEYS_URL = `${PUBLIC_URL}/login?next=%2Fp%2Ffernwood%2Fsettings%23access-keys`;

test("access keys: making one emails the project's other owners (not its maker, not members), never the secret", async () => {
  const s = await twoOwners();
  assert.equal(safeNext("/p/fernwood/settings#access-keys"), "/p/fernwood/settings#access-keys", "the link survives signing in");
  const made = await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } });
  assert.equal(made.status, 201);
  assert.deepEqual(Object.keys(made.json).sort(), ["key", "secret"], "the answer is as before");
  const [m, ...more] = s.mail.transport.sent;
  assert.deepEqual(more, []);
  assert.equal(m.to, "bob@example.com");
  assert.equal(m.idempotencyKey, `key-create/${made.json.key.id}/${s.bobUser.id}`);
  assert.equal(m.subject, 'New access key "ci" for "Fernwood" on Imitor Cloud');
  assert.match(m.text, /^Admin made the access key "ci" for the project "Fernwood"/);
  assert.deepEqual([...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]), [KEYS_URL]);
  const stored = await s.db.getAccessKey(made.json.key.id);
  for (const part of [m.subject, m.text, m.html]) {
    assert.ok(!part.includes(made.json.secret) && !part.includes(sha(made.json.secret)) && !part.includes(made.json.key.prefix), "no secret, hash or prefix");
    for (const v of Object.values(stored)) if (typeof v === "string" && v.length >= 32) assert.ok(!part.includes(v));
  }
  const adaId = (await s.db.findUserByEmail("admin")).id;
  assert.deepEqual((await mailRows(s)).slice(s.mailCount).map((a) => [a.action, a.userId, a.projectId, a.detail]), [["mail.send", adaId, s.project.id, { kind: "accessKey", to: "bob@example.com", id: "msg_1" }]]);

  // Bob makes one: Ada is the other owner, but "admin" is not an address, so nobody is emailed.
  assert.equal((await s.bob.call("POST", "/p/fernwood/api/keys", { body: { name: "bob's" } })).status, 201);
  assert.equal(s.mail.transport.sent.length, 1);
});

test("access keys: revoking emails the other owners once; revoking it again sends nothing", async () => {
  const s = await twoOwners();
  const made = await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } });
  const id = made.json.key.id;
  const revoked = await s.ada.call("POST", `/p/fernwood/api/keys/${id}/revoke`, { body: {} });
  assert.equal(revoked.status, 200);
  assert.deepEqual(Object.keys(revoked.json), ["key"]);
  assert.equal(s.mail.transport.sent.length, 2);
  const m = s.mail.transport.sent[1];
  assert.equal(m.to, "bob@example.com");
  assert.equal(m.idempotencyKey, `key-revoke/${id}/${s.bobUser.id}`);
  assert.equal(m.subject, 'Access key "ci" of "Fernwood" revoked on Imitor Cloud');
  assert.match(m.text, /It can no longer upload runs to the project\./);
  assert.ok(m.text.includes(KEYS_URL));
  for (const part of [m.subject, m.text, m.html]) assert.ok(!part.includes(made.json.secret));
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/keys/${id}/revoke`, { body: {} })).status, 200);
  assert.equal(s.mail.transport.sent.length, 2, "already revoked: no second message");
  assert.deepEqual((await mailRows(s)).slice(s.mailCount).map((a) => a.detail.kind), ["accessKey", "accessKey"]);
});

test("access keys: a sole owner, or a refused attempt, emails nobody", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com" } });
  const before = s.mail.transport.sent.length;
  const made = await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } });
  assert.equal(made.status, 201);
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/keys/${made.json.key.id}/revoke`, { body: {} })).status, 200);
  assert.equal(s.mail.transport.sent.length, before, "the only owner is the one acting; Bob is a member");

  // Two owners, but the member trying is refused, and so is a bad name: nothing sent.
  const t = await twoOwners();
  const key = await t.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } });
  t.mail.transport.sent.length = 0;
  const cy = await t.db.findUserByEmail("cy@example.com");
  const secret = crypto.randomBytes(32).toString("base64url");
  await t.db.createSession({ idHash: sha(secret), userId: cy.id, expiresAt: new Date(t.now().getTime() + 86400e3).toISOString() });
  const cyBrowser = browser(t.deps);
  cyBrowser.jar.set("__Host-imitor_session", secret);
  assert.equal((await cyBrowser.call("POST", "/p/fernwood/api/keys", { body: { name: "mine" } })).status, 403);
  assert.equal((await cyBrowser.call("POST", `/p/fernwood/api/keys/${key.json.key.id}/revoke`, { body: {} })).status, 403);
  assert.equal((await t.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "" } })).status, 400);
  assert.equal((await t.ada.call("POST", "/p/fernwood/api/keys/key_nope/revoke", { body: {} })).status, 404);
  assert.deepEqual(t.mail.transport.sent, []);
});

test("access keys: when the message cannot be sent the key is still made and revoked, and mail.fail is audited", async () => {
  const s = await twoOwners();
  s.mail.transport.fail = "the provider is down";
  const made = await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } });
  assert.equal(made.status, 201);
  assert.match(made.json.secret, /^imk_/);
  const revoked = await s.ada.call("POST", `/p/fernwood/api/keys/${made.json.key.id}/revoke`, { body: {} });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.json.key.revokedAt);
  assert.deepEqual((await mailRows(s)).slice(s.mailCount).map((a) => [a.action, a.detail]), [["mail.fail", { kind: "accessKey", to: "bob@example.com", status: 500 }], ["mail.fail", { kind: "accessKey", to: "bob@example.com", status: 500 }]]);
  assert.equal(s.logged.length, 2);
});

test("a lookup that fails while preparing a message does not fail what was already done: the key's secret is still answered, the person still added", async () => {
  const s = await twoOwners();
  const { listMembers, listIdentities } = s.db;
  s.db.listMembers = async () => { throw new Error("the database went away"); };
  const made = await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } });
  assert.equal(made.status, 201);
  assert.match(made.json.secret, /^imk_/, "the secret is shown once: it must not be lost to a message");
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/keys/${made.json.key.id}/revoke`, { body: {} })).status, 200);
  s.db.listMembers = listMembers;
  s.db.listIdentities = async () => { throw new Error("the database went away"); };
  const added = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "zed@example.com" } });
  s.db.listIdentities = listIdentities;
  assert.equal(added.status, 201);
  assert.equal(added.json.notified, false);
  assert.equal(s.logged.length, 3);
  assert.equal(s.mail.transport.sent.filter((m) => m.to === "zed@example.com").length, 0);
});

test("access keys: with mail off nobody is emailed, and nothing about mail is audited", async () => {
  const s = await twoOwners();
  s.deps.mail = { transport: noMail(), from: null, replyTo: null };
  const before = (await mailRows(s)).length;
  const made = await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } });
  assert.equal(made.status, 201);
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/keys/${made.json.key.id}/revoke`, { body: {} })).status, 200);
  assert.deepEqual(s.mail.transport.sent, []);
  assert.equal((await mailRows(s)).length, before);
});

test("someone an owner added signs in with Google without being in IMITOR_ALLOWED_EMAILS; a stranger still cannot", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "cy@example.com" } });
  assert.ok(!s.deps.allowedEmails.has("cy@example.com"));
  const cy = await admit(s.deps, { sub: "google-cy", email: "Cy@Example.com", email_verified: true, name: "Cy" });
  assert.equal(cy?.email, "cy@example.com");
  assert.equal(cy.name, "Cy", "the name comes from Google on first sign-in");
  assert.equal((await s.db.listUserProjects(cy.id))[0].slug, "fernwood");
  assert.equal((await admit(s.deps, { sub: "google-cy", email: "cy@example.com", email_verified: true })).id, cy.id, "the same account again");
  assert.equal(await admit(s.deps, { sub: "google-mallory", email: "mallory@example.com", email_verified: true }), null);
  assert.equal(await admit(s.deps, { sub: "google-other", email: "cy@example.com", email_verified: true }), null, "another Google account with that address is not Cy");
});

test("an allowed account that was not invited (the admin-token user) never admits a Google sign-in by its address", async () => {
  const s = await setup();
  const admin = await s.db.findUserByEmail("admin");
  await s.db.updateUser(admin.id, { allowed: true });
  const real = await s.db.createUser({ email: "ops@example.com", allowed: true }); // allowed, but by no invitation
  assert.equal(await admit(s.deps, { sub: "google-ops", email: "ops@example.com", email_verified: true }), null);
  assert.equal(real.invitedAt, null);
});

test("an owner cannot turn back on an account the operator turned off; a member can leave; odd ids are refused", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  const off = await s.db.createUser({ email: "off@example.com", allowed: false });
  const refused = await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "off@example.com" } });
  assert.equal(refused.status, 409);
  assert.equal((await s.db.getUser(off.id)).allowed, false, "still off");
  assert.equal(await admit(s.deps, { sub: "google-off", email: "off@example.com", email_verified: true }), null);

  // Bob, a member, leaves; he cannot remove anyone else.
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com" } });
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "cy@example.com" } });
  const cy = await s.db.findUserByEmail("cy@example.com");
  assert.equal((await s.bob.call("POST", `/p/fernwood/api/members/${cy.id}/remove`, { body: {} })).status, 403);
  assert.equal((await s.bob.call("POST", `/p/fernwood/api/members/${s.bobUser.id}/remove`, { body: {} })).status, 200);
  assert.equal((await s.bob.call("GET", "/p/fernwood/api/project")).status, 404);
  const audit = (await s.db.listAudit()).filter((a) => a.action === "member.remove").at(-1);
  assert.deepEqual(audit.detail, { email: "bob@example.com", self: true });

  assert.equal((await s.ada.call("POST", "/p/fernwood/api/members/%E0%A4%A/remove", { body: {} })).status, 400, "a malformed id is a 400, not a crash");
  for (const email of ["ünï@example.com", "a@b", "a b@example.com"]) assert.equal((await s.ada.call("POST", "/p/fernwood/api/members", { body: { email } })).status, 400, email);
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "cy@example.com", role: "owner" } });
  assert.deepEqual((await s.db.listAudit()).filter((a) => a.action === "member.role").at(-1).detail, { email: "cy@example.com", role: "owner", from: "member" });
});

test("membership is checked on every project route: a stranger gets 404, a member reads but cannot manage keys", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  const project = await s.db.getProjectBySlug("fernwood");
  const runId = await readyRun(s, project, "20261112T100000-abc");
  const key = (await s.ada.call("POST", "/p/fernwood/api/keys", { body: { name: "ci" } })).json.key;

  const routes = ["/p/fernwood/api/project", "/p/fernwood/api/runs", `/p/fernwood/api/runs/${runId}`, "/p/fernwood/api/problems", "/p/fernwood/api/captures", "/p/fernwood/api/agents", "/p/fernwood/api/keys", "/p/fernwood/api/me", `/p/fernwood/files/runs/${runId}/screens/a-01-home-iphone-16-light.png`];
  for (const r of routes) {
    const res = await s.bob.call("GET", r);
    assert.equal(res.status, 404, r);
    assert.equal(res.json.error, "no project fernwood");
  }
  assert.equal((await s.bob.call("GET", "/p/fernwood/runs")).status, 404);
  assert.equal((await s.bob.call("POST", "/p/fernwood/api/keys", { body: { name: "mine" } })).status, 404);
  assert.equal((await s.bob.call("GET", "/p/nope/api/runs")).status, 404, "an unknown slug reads the same");

  await s.db.addMember(project.id, s.bobUser.id);
  for (const r of routes) assert.ok([200, 302].includes((await s.bob.call("GET", r)).status), r);
  assert.equal((await s.bob.call("GET", "/p/fernwood/api/keys")).json.canManage, false);
  assert.equal((await s.bob.call("POST", "/p/fernwood/api/keys", { body: { name: "mine" } })).status, 403);
  assert.equal((await s.bob.call("POST", `/p/fernwood/api/keys/${key.id}/revoke`, { body: {} })).status, 403);
  assert.deepEqual((await s.bob.call("GET", "/p/fernwood/api/me")).json, { user: { email: "bob@example.com", name: "Bob" }, project: { name: "fernwood", slug: "fernwood", role: "member" } });

  // Signed out: 401 for the API and files, the sign-in page for the interface.
  const anon = browser(s.deps);
  assert.equal((await anon.call("GET", "/p/fernwood/api/runs")).status, 401);
  assert.equal((await anon.call("GET", `/p/fernwood/files/runs/${runId}/screens/a-01-home-iphone-16-light.png`)).status, 401);
  const page = await anon.call("GET", "/p/fernwood/runs?filter=main");
  assert.equal(page.status, 302);
  assert.equal(page.location, "/login?next=%2Fp%2Ffernwood%2Fruns%3Ffilter%3Dmain");
});

test("files: a 5-minute storage URL for a file of a ready run of the project, 404 for anything else", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  await s.ada.call("POST", "/projects", { body: { name: "other" } });
  const fernwood = await s.db.getProjectBySlug("fernwood");
  const other = await s.db.getProjectBySlug("other");
  const ready = await readyRun(s, fernwood, "a");
  const uploading = await readyRun(s, fernwood, "b", undefined, { status: "uploading" });
  const theirs = await readyRun(s, other, "c");
  const file = "screens/a-01-home-iphone-16-light.png";

  const ok = await s.ada.call("GET", `/p/fernwood/files/runs/${ready}/${file}`);
  assert.equal(ok.status, 302);
  const to = new URL(ok.location);
  assert.equal(to.origin, "https://storage.example", "never served from the app's own origin");
  assert.equal(Number(to.searchParams.get("expires")), s.now().getTime() + 300 * 1000);
  assert.equal(ok.headers.get("cache-control"), "private, no-store");
  const fetched = await s.storage.handle(new Request(ok.location));
  assert.equal(await fetched.text(), "png-a");
  assert.match(fetched.headers.get("content-security-policy"), /sandbox/);

  for (const bad of [`runs/${uploading}/${file}`, `runs/${theirs}/${file}`, `runs/${ready}/screens/other.png`, `runs/${ready}/../${theirs}/${file}`, `runs/${ready}/screens/%2e%2e/x.png`, `${file}`, `runs/${ready}`, "runs/%E0%A4%A"]) {
    assert.equal((await s.ada.call("GET", `/p/fernwood/files/${bad}`)).status, 404, bad);
  }
  assert.equal((await s.ada.call("GET", `/p/other/files/runs/${theirs}/${file}`)).status, 302, "from its own project it is fine");
});

test("the interface: cloud mode under /p/<slug>, a strict CSP with the inline script's hash, its files, every page", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  for (const p of ["/p/fernwood/", "/p/fernwood/runs/run_x/shots", "/p/fernwood/settings"]) {
    const res = await s.ada.call("GET", p);
    assert.equal(res.status, 200, p);
    assert.match(res.headers.get("content-type"), /^text\/html/);
    assert.match(res.text, /<meta name="imitor-mode" content="cloud">/);
    assert.match(res.text, /<meta name="imitor-base" content="\/p\/fernwood">/);
    assert.match(res.text, /<script type="module" src="\/p\/fernwood\/app\.js">/);
    const csp = res.headers.get("content-security-policy");
    const inline = /<script>([\s\S]*?)<\/script>/.exec(res.text)[1];
    assert.ok(csp.includes(`'sha256-${crypto.createHash("sha256").update(inline).digest("base64")}'`), "the theme script is allowed by its hash");
    for (const part of ["default-src 'none'", "frame-ancestors 'none'", "connect-src 'self'", "img-src 'self' https://storage.example data:", "media-src 'self' https://storage.example", "base-uri 'none'", "object-src 'none'"]) assert.ok(csp.includes(part), part);
    assert.doesNotMatch(csp, /script-src[^;]*unsafe/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    assert.equal(res.headers.get("referrer-policy"), "same-origin");
    assert.equal(res.headers.get("x-frame-options"), "DENY");
    assert.match(res.headers.get("strict-transport-security"), /max-age=/);
  }
  const js = await s.ada.call("GET", "/p/fernwood/app.js");
  assert.equal(js.status, 200);
  assert.match(js.headers.get("content-type"), /^text\/javascript/);
  assert.equal((await s.ada.call("GET", "/p/fernwood/pages/settings.js")).status, 200);
  assert.equal((await s.ada.call("GET", "/p/fernwood/nope.js")).status, 404);
  assert.equal((await s.ada.call("GET", "/p/fernwood/..%2f..%2fpackage.json")).status, 404);
  assert.match((await s.ada.call("GET", "/p/fernwood")).text, /imitor-mode" content="cloud"/, "with or without the trailing slash");
  assert.equal((await s.ada.call("GET", "/static/cloud.css")).status, 200);
  const json = await s.ada.call("GET", "/p/fernwood/api/runs");
  assert.match(json.headers.get("content-security-policy"), /^default-src 'none'/);
});

test("seen marks are kept per person on the server, for problems of the project's runs", async () => {
  const s = await setup();
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  const project = await s.db.getProjectBySlug("fernwood");
  await s.db.addMember(project.id, s.bobUser.id);
  const runId = await readyRun(s, project, "a");
  await s.db.updateRun(runId, { manifest: { shots: [], problems: [{ kind: "page-error", message: "TypeError: x is undefined", flow: "a", device: "iphone-16", scheme: "light" }] } });
  const [problem] = (await s.ada.call("GET", "/p/fernwood/api/problems")).json.problems;
  assert.equal(problem.seen, false);
  assert.deepEqual(await s.ada.call("POST", `/p/fernwood/api/problems/${problem.id}/seen`, { body: { seen: true } }).then((r) => r.json), { ok: true });
  assert.equal((await s.ada.call("GET", "/p/fernwood/api/problems")).json.problems[0].seen, true);
  assert.equal((await s.ada.call("GET", `/p/fernwood/api/runs/${runId}`)).json.problems[0].seen, true);
  assert.equal((await s.bob.call("GET", "/p/fernwood/api/problems")).json.problems[0].seen, false, "Bob's marks are his own");
  assert.equal((await s.ada.call("POST", "/p/fernwood/api/problems/p_000000000000/seen", { body: { seen: true } })).status, 404);
  assert.equal((await s.ada.call("POST", `/p/fernwood/api/problems/${problem.id}/seen`, { body: { seen: "yes" } })).status, 400);
  assert.deepEqual((await s.db.listSeen(project.id, (await s.db.findUserByEmail("admin")).id)).map((m) => [m.problemId, m.runId, m.seen]), [[problem.id, runId, true]]);
});

test("scheduled retention: needs CRON_SECRET; prunes every project and drops expired sessions", async () => {
  const off = await setup();
  assert.equal((await handle(new Request(`${PUBLIC_URL}/v1/cron/retention`), off.deps)).status, 404);

  const secret = crypto.randomBytes(32).toString("base64url");
  const s = await setup({ cronSecret: secret });
  await s.ada.call("POST", "/projects", { body: { name: "fernwood" } });
  await s.ada.call("POST", "/projects", { body: { name: "other" } });
  const old = await readyRun(s, await s.db.getProjectBySlug("fernwood"), "old");
  const stale = await readyRun(s, await s.db.getProjectBySlug("other"), "stale", undefined, { status: "uploading" });
  s.now.advance((KEEP_DAYS + 1) * 86400e3);
  const fresh = await readyRun(s, await s.db.getProjectBySlug("other"), "fresh");

  const call = (auth, method = "GET") => handle(new Request(`${PUBLIC_URL}/v1/cron/retention`, { method, headers: auth ? { authorization: auth } : {} }), s.deps);
  assert.equal((await call(null)).status, 401);
  assert.equal((await call(`Bearer ${secret}x`)).status, 401);
  assert.equal((await call(`Bearer ${secret}`, "DELETE")).status, 405);
  const res = await call(`Bearer ${secret}`);
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { projects: 2, pruned: 2, failed: 0, sessions: 2 });
  assert.equal(await s.db.getRun(old), null);
  assert.equal(await s.db.getRun(stale), null);
  assert.ok(await s.db.getRun(fresh));
  assert.equal([...s.storage.objects.keys()].filter((k) => k.includes(old) || k.includes(stale)).length, 0, "their files are deleted");
  assert.equal((await call(`Bearer ${secret}`, "POST")).status, 200, "POST works too");
});

// ---------- run emails: the Settings switch and the unsubscribe link ----------

/** Fernwood (Ada owns it) with Bob, signed in with Google, as a member. */
async function runMailSetup() {
  const s = await setup();
  const { json: { project } } = await s.ada.call("POST", "/projects", { body: { name: "Fernwood" } });
  await s.db.addMember(project.id, s.bobUser.id);
  await s.db.addIdentity("google", "google-bob", s.bobUser.id);
  return { ...s, project };
}
const runMailRows = async (s) => (await s.db.listAudit()).filter((a) => a.action === "member.run-mail").map((a) => [a.userId, a.projectId, a.detail]);

test("run emails in Settings: you read and change only your own choice, per project, audited when it changes", async () => {
  const s = await runMailSetup();
  assert.deepEqual((await s.bob.call("GET", "/p/fernwood/api/notifications")).json, { runProblems: true, available: true }, "on by default");
  // Ada signed in with the admin token: no Google sign-in and no address, so no message could reach her.
  assert.deepEqual((await s.ada.call("GET", "/p/fernwood/api/notifications")).json, { runProblems: true, available: false });

  const off = await s.bob.call("POST", "/p/fernwood/api/notifications", { body: { runProblems: false, userId: (await s.db.findUserByEmail("admin")).id } });
  assert.equal(off.status, 200);
  assert.deepEqual(off.json, { runProblems: false, available: true });
  assert.equal((await s.db.getMember(s.project.id, s.bobUser.id)).notifyRuns, false);
  assert.equal((await s.db.getMember(s.project.id, (await s.db.findUserByEmail("admin")).id)).notifyRuns, true, "a userId in the body is not read");
  assert.equal((await s.bob.call("POST", "/p/fernwood/api/notifications", { body: { runProblems: false } })).status, 200);
  assert.deepEqual(await runMailRows(s), [[s.bobUser.id, s.project.id, { on: false, via: "settings" }]], "audited once: the second changed nothing");
  assert.deepEqual((await s.bob.call("POST", "/p/fernwood/api/notifications", { body: { runProblems: true } })).json, { runProblems: true, available: true });
  assert.equal((await runMailRows(s)).length, 2);

  for (const body of [{}, { runProblems: "no" }, { runProblems: 0 }]) assert.equal((await s.bob.call("POST", "/p/fernwood/api/notifications", { body })).status, 400, JSON.stringify(body));
  assert.equal((await s.bob.call("POST", "/p/fernwood/api/notifications", { body: { runProblems: false }, origin: "https://evil.example" })).status, 403, "the Origin check still applies here");
  // Someone else's project reads as none; a member's choice in one project leaves their others alone.
  const stranger = await s.bob.call("POST", "/projects", { body: { name: "Oak" } });
  assert.equal((await s.ada.call("POST", "/p/oak/api/notifications", { body: { runProblems: false } })).status, 404);
  await s.bob.call("POST", "/p/oak/api/notifications", { body: { runProblems: false } });
  assert.equal((await s.db.getMember(stranger.json.project.id, s.bobUser.id)).notifyRuns, false);
  assert.equal((await s.db.getMember(s.project.id, s.bobUser.id)).notifyRuns, true);

  s.deps.mail = { transport: noMail(), from: null, replyTo: null };
  assert.deepEqual((await s.bob.call("GET", "/p/fernwood/api/notifications")).json, { runProblems: true, available: false }, "this server sends no mail");
});

test("unsubscribe: the link shows the project and changes nothing; its POST, with no cookies and no Origin, turns run emails off", async () => {
  const s = await runMailSetup();
  const token = await s.db.runMailToken(s.project.id, s.bobUser.id);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(await s.db.runMailToken(s.project.id, s.bobUser.id), token, "the same link every time");
  const raw = (method, path, init = {}) => handle(new Request(new URL(path, PUBLIC_URL), { method, ...init }), s.deps);

  for (const path of [`/unsubscribe/?t=${token}`, `/unsubscribe?t=${token}`]) {
    const page = await raw("GET", path, { headers: HTML });
    assert.equal(page.status, 200, path);
    const text = await page.text();
    assert.match(text, /Stop run emails\?/);
    assert.match(text, /“Fernwood”/);
    assert.ok(text.includes(`<form method="post" action="/unsubscribe/?t=${token}">`));
    assert.doesNotMatch(text, /bob@example\.com|<script/);
  }
  assert.equal((await s.db.getMember(s.project.id, s.bobUser.id)).notifyRuns, true, "opening the link turns nothing off");

  // RFC 8058: a mail client POSTs List-Unsubscribe=One-Click, without cookies or Origin.
  const one = await raw("POST", `/unsubscribe/?t=${token}`, { headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" });
  assert.equal(one.status, 200);
  assert.match(await one.text(), /You will not get these emails/);
  assert.equal((await s.db.getMember(s.project.id, s.bobUser.id)).notifyRuns, false);
  assert.ok(!one.headers.getSetCookie().length, "no session is made or touched");
  const again = await raw("POST", `/unsubscribe?t=${token}`, { headers: { origin: "https://mail.example" } });
  assert.equal(again.status, 200, "repeatable, from anywhere");
  assert.deepEqual(await runMailRows(s), [[s.bobUser.id, s.project.id, { on: false, via: "unsubscribe" }]]);
  assert.match(await (await raw("GET", `/unsubscribe/?t=${token}`)).text(), /You will not get these emails[\s\S]*href="\/p\/fernwood\/settings#account"/);
  assert.deepEqual((await s.bob.call("GET", "/p/fernwood/api/notifications")).json, { runProblems: false, available: true }, "Settings shows it off");
  assert.equal((await s.db.getMember(s.project.id, (await s.db.findUserByEmail("admin")).id)).notifyRuns, true, "only that membership");
  assert.equal((await raw("PUT", `/unsubscribe/?t=${token}`)).status, 405);
});

test("unsubscribe: a malformed, unknown or stale token gets one calm 404, and a removed and re-added member starts over", async () => {
  const s = await runMailSetup();
  const token = await s.db.runMailToken(s.project.id, s.bobUser.id);
  const raw = (method, path, headers = {}) => handle(new Request(new URL(path, PUBLIC_URL), { method, headers: { "x-forwarded-for": "203.0.113.9", ...headers } }), s.deps);
  const answers = [];
  for (const path of ["/unsubscribe", "/unsubscribe/?t=", "/unsubscribe/?t=short", `/unsubscribe/?t=${"A".repeat(43)}`, `/unsubscribe/?t=${token}x`, `/unsubscribe/?t=${encodeURIComponent("' or 1=1 --")}`]) {
    for (const method of ["GET", "POST"]) {
      const res = await raw(method, path);
      answers.push([res.status, (await res.text()).replace(/\s+/g, " ")]);
    }
  }
  assert.ok(answers.every(([status, text]) => status === 404 && text === answers[0][1]), "the same page for all of them");
  assert.match(answers[0][1], /This link does not work/);
  assert.equal((await s.db.getMember(s.project.id, s.bobUser.id)).notifyRuns, true);

  // Removed: the old link is dead. Added again: run emails are on, with a new link.
  await s.db.setRunMail(s.project.id, s.bobUser.id, false);
  await s.ada.call("POST", `/p/fernwood/api/members/${s.bobUser.id}/remove`, { body: {} });
  const gone = await raw("GET", `/unsubscribe/?t=${token}`);
  assert.equal(gone.status, 404);
  assert.equal((await gone.text()).replace(/\s+/g, " "), answers[0][1]);
  await s.ada.call("POST", "/p/fernwood/api/members", { body: { email: "bob@example.com" } });
  assert.equal((await s.db.getMember(s.project.id, s.bobUser.id)).notifyRuns, true);
  assert.notEqual(await s.db.runMailToken(s.project.id, s.bobUser.id), token);

  // Past UNSUBSCRIBE_FAILURES links that name nobody, the address waits, even with a good link; others do not.
  for (let i = answers.length + 1; i < UNSUBSCRIBE_FAILURES; i++) await raw("GET", "/unsubscribe/?t=nope");
  const good = await s.db.runMailToken(s.project.id, s.bobUser.id);
  assert.equal((await raw("GET", `/unsubscribe/?t=${good}`)).status, 429);
  assert.equal((await raw("GET", `/unsubscribe/?t=${good}`, { "x-forwarded-for": "198.51.100.1" })).status, 200);
});
