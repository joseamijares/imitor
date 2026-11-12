// Projects and their keys for signed-in people, membership on every project route, files, the interface in cloud
// mode, security headers and scheduled retention.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { handle, KEEP_DAYS } from "../src/api.mjs";
import { browser, cloud, PUBLIC_URL } from "./helpers.mjs";

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
  const page = await s.ada.call("GET", "/");
  assert.match(page.text, /href="\/p\/fernwood-app\/"/);
  assert.equal((await browser(s.deps).call("GET", "/projects")).status, 401);
  assert.equal((await browser(s.deps).call("GET", "/")).location, "/login");
  const audit = (await s.db.listAudit()).filter((a) => a.action === "project.create");
  assert.deepEqual(audit.map((a) => a.detail), [{ name: "Fernwood app", slug: "fernwood-app" }, { name: "Fernwood app", slug: "fernwood-app-2" }]);
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
