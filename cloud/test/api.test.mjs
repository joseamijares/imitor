// The upload API's contract, against the in-memory database and storage.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import test from "node:test";
import { handle, KEEP_RUNS, MAX_UNFINISHED, UPLOAD_SECONDS } from "../src/api.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { depsFromEnv } from "../src/server.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";

const BASE = "http://cloud.test";
const sha = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

async function setup() {
  let clock = Date.parse("2026-11-12T10:00:00.000Z");
  const now = () => new Date((clock += 1000)); // every call is a second later, so runs have an order
  const db = memoryDb({ now });
  const storage = memoryStorage({ baseUrl: BASE });
  const deps = { db, storage, publicUrl: "https://cloud.example/", minCliVersion: "0.0.1", now };
  const fernwood = await db.createProject({ name: "fernwood" });
  const other = await db.createProject({ name: "other" });
  return {
    db, storage, deps, fernwood, other,
    key: await db.createAccessKey(fernwood.id),
    otherKey: await db.createAccessKey(other.id),
    setClock: (iso) => { clock = Date.parse(iso); },
  };
}

async function call(s, method, route, { key = s.key.secret, body, raw, ua = "imitor/0.0.1" } = {}) {
  const headers = { "user-agent": ua };
  if (key) headers.authorization = `Bearer ${key}`;
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const res = await handle(new Request(BASE + route, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) }), s.deps);
  return { status: res.status, body: await res.json() };
}

/** A run of the invented app "fernwood", with these files' contents. */
function runBody(clientRunId = "20261112T100000-abc1234", contents = DEFAULT_FILES, patch = {}) {
  return {
    clientRunId,
    schemaVersion: 1,
    run: { schemaVersion: 1, id: clientRunId, status: "passed", title: "Larger tap targets", startedAt: "2026-11-12T10:00:00.000Z", finishedAt: "2026-11-12T10:01:00.000Z", flows: [] },
    manifest: { app: "fernwood", shots: [], problems: [] },
    files: Object.entries(contents).map(([path, bytes]) => ({ path, size: Buffer.byteLength(bytes), sha256: sha(bytes), contentType: path.endsWith(".webm") ? "video/webm" : "image/png" })),
    ...patch,
  };
}
const DEFAULT_FILES = { "screens/first-run-01-welcome-iphone-16-light.png": "png-1", "screens/first-run-02-plants-iphone-16-light.png": "png-22", "screens/first-run.webm": "webm-333" };

async function put(s, upload, bytes) {
  const headers = Object.fromEntries(Object.entries(upload.headers).filter(([k]) => k !== "content-length"));
  return s.storage.handle(new Request(upload.url, { method: upload.method, headers, body: bytes }));
}
async function putAll(s, uploads, contents = DEFAULT_FILES) {
  for (const u of uploads) assert.equal((await put(s, u, contents[u.path])).status, 200, u.path);
}

test("happy path: register, upload straight to storage, complete, get the run URL", async () => {
  const s = await setup();
  const created = await call(s, "POST", "/v1/runs", { body: runBody() });
  assert.equal(created.status, 201);
  assert.match(created.body.id, /^run_[0-9a-f]{20}$/);
  assert.equal(created.body.status, "uploading");
  assert.deepEqual(created.body.uploads.map((u) => u.path).sort(), Object.keys(DEFAULT_FILES).sort());
  for (const u of created.body.uploads) {
    assert.equal(u.method, "PUT");
    assert.ok(u.url.startsWith(`${BASE}/__storage/${s.fernwood.id}/${created.body.id}/screens/`), u.url);
  }
  await putAll(s, created.body.uploads);

  const done = await call(s, "POST", `/v1/runs/${created.body.id}/complete`);
  assert.equal(done.status, 200);
  assert.deepEqual(done.body, { id: created.body.id, status: "ready", url: `https://cloud.example/p/fernwood/runs/${created.body.id}` });
  assert.deepEqual([...s.storage.objects.keys()].sort(), Object.keys(DEFAULT_FILES).map((p) => `${s.fernwood.id}/${created.body.id}/${p}`).sort());
  const stored = await s.db.getRun(created.body.id);
  assert.equal(stored.status, "ready");
  assert.equal(stored.projectId, s.fernwood.id);
  assert.equal(stored.clientRunId, "20261112T100000-abc1234");

  assert.deepEqual((await call(s, "POST", `/v1/runs/${created.body.id}/complete`)).body, done.body, "complete is repeatable");
  const audit = await s.db.listAudit();
  assert.deepEqual(audit.map((a) => a.action), ["run.create", "run.complete"]);
  assert.deepEqual(audit.map(({ projectId, userId, keyId, detail }) => ({ projectId, userId, keyId, detail })), [
    { projectId: s.fernwood.id, userId: null, keyId: s.key.id, detail: { runId: created.body.id, clientRunId: "20261112T100000-abc1234" } },
    { projectId: s.fernwood.id, userId: null, keyId: s.key.id, detail: { runId: created.body.id } },
  ], "audit_log columns, with the rest in detail");
  assert.equal(stored.keyId, s.key.id);
});

test("the storage URL only takes the declared bytes", async () => {
  const s = await setup();
  const { body } = await call(s, "POST", "/v1/runs", { body: runBody() });
  const u = body.uploads.find((x) => x.path.endsWith("01-welcome-iphone-16-light.png"));
  assert.equal((await put(s, u, "PNG-1")).status, 400, "same size, other bytes");
  assert.equal((await put(s, u, "png-1-and-more")).status, 400, "other size");
  assert.equal((await put(s, { ...u, headers: { ...u.headers, "content-type": "text/html" } }, "png-1")).status, 403, "other type");
  assert.equal((await put(s, { ...u, url: u.url.replace("01-welcome", "01-welcomf") }, "png-1")).status, 403, "other key");
  assert.equal((await put(s, u, "png-1")).status, 200);
});

test("pushing the same run again returns the same id, and only the files not yet uploaded", async () => {
  const s = await setup();
  const first = await call(s, "POST", "/v1/runs", { body: runBody() });
  const one = first.body.uploads.find((u) => u.path === "screens/first-run.webm");
  await putAll(s, [one]);

  const early = await call(s, "POST", `/v1/runs/${first.body.id}/complete`);
  assert.equal(early.status, 409);
  assert.match(early.body.error, /^2 files not uploaded yet/);
  assert.deepEqual(early.body.missing.sort(), ["screens/first-run-01-welcome-iphone-16-light.png", "screens/first-run-02-plants-iphone-16-light.png"]);

  // A truncated object counts as missing.
  const welcome = `${s.fernwood.id}/${first.body.id}/screens/first-run-01-welcome-iphone-16-light.png`;
  s.storage.objects.set(welcome, { body: Buffer.from("png"), contentType: "image/png" });

  const again = await call(s, "POST", "/v1/runs", { body: runBody() });
  assert.equal(again.status, 200);
  assert.equal(again.body.id, first.body.id);
  assert.deepEqual(again.body.uploads.map((u) => u.path).sort(), ["screens/first-run-01-welcome-iphone-16-light.png", "screens/first-run-02-plants-iphone-16-light.png"]);
  assert.ok(!s.storage.objects.has(welcome), "the cut-off object is deleted before a new URL is signed, for a store that refuses overwrites");
  await putAll(s, again.body.uploads);
  assert.equal((await call(s, "POST", `/v1/runs/${first.body.id}/complete`)).status, 200);

  const after = await call(s, "POST", "/v1/runs", { body: runBody() });
  assert.equal(after.status, 200);
  assert.deepEqual({ id: after.body.id, status: after.body.status, uploads: after.body.uploads, url: after.body.url }, { id: first.body.id, status: "ready", uploads: [], url: `https://cloud.example/p/fernwood/runs/${first.body.id}` });

  const changed = await call(s, "POST", "/v1/runs", { body: runBody(undefined, { "screens/first-run.webm": "other" }) });
  assert.equal(changed.status, 409);
  assert.match(changed.body.error, /already pushed to this project with different files/);
});

test("refuses file types, sizes and paths it does not take, before storing anything", async () => {
  const s = await setup();
  const file = (path, contentType, size = 10) => ({ path, size, sha256: "a".repeat(64), contentType });
  const cases = [
    [{ files: [file("screens/x.svg", "image/svg+xml")] }, /must end in/],
    [{ files: [file("screens/x.png", "image/svg+xml")] }, /content type "image\/svg\+xml" is not accepted/],
    [{ files: [file("index.html", "text/html")] }, /must end in/],
    [{ files: [file("screens/app.js", "application/javascript")] }, /must end in/],
    [{ files: [file("screens/x.png", "image/jpeg")] }, /does not match its extension/],
    [{ files: [file("screens/x.png", "image/png", 25 * 1024 * 1024 + 1)] }, /the limit is 25 MB per file/],
    [{ files: Array.from({ length: 13 }, (_, i) => file(`screens/${i}.webm`, "video/webm", 25 * 1024 * 1024)) }, /the limit is 300 MB per run/],
    [{ files: [file("../other-project/x.png", "image/png")] }, /"\.\."/],
    [{ files: [file("screens/../../x.png", "image/png")] }, /"\.\."/],
    [{ files: [file("/etc/x.png", "image/png")] }, /relative/],
    [{ files: [{ ...file("screens/x.png", "image/png"), key: "prj_other/run_1/x.png" }] }, /unknown field "key"/],
    [{ projectId: "prj_other" }, /unknown field "projectId"/],
    [{ schemaVersion: 2 }, /schemaVersion 2 is newer/],
  ];
  for (const [patch, error] of cases) {
    const res = await call(s, "POST", "/v1/runs", { body: runBody(undefined, {}, patch) });
    assert.equal(res.status, 400, JSON.stringify(patch).slice(0, 120));
    assert.match(res.body.error, error);
  }
  assert.deepEqual(await call(s, "POST", "/v1/runs", { raw: "{not json" }), { status: 400, body: { error: "the body must be JSON" } });
  const huge = await call(s, "POST", "/v1/runs", { raw: JSON.stringify(runBody(undefined, {}, { manifest: { shots: [], problems: [], pad: "x".repeat(9 * 1024 * 1024) } })) });
  assert.equal(huge.status, 413);
  assert.deepEqual(await s.db.listRuns(s.fernwood.id), []);
  assert.equal(s.storage.objects.size, 0);
});

test("keys: missing or unknown is 401, other routes are 403, another project's run is 404", async () => {
  const s = await setup();
  assert.equal((await call(s, "POST", "/v1/runs", { key: null, body: runBody() })).status, 401);
  assert.equal((await call(s, "POST", "/v1/runs", { key: "imk_not-a-real-key", body: runBody() })).status, 401);
  assert.equal((await call(s, "POST", "/v1/runs", { key: s.key.secret.replace("imk_", "xyz_"), body: runBody() })).status, 401);

  const created = await call(s, "POST", "/v1/runs", { body: runBody() });
  await putAll(s, created.body.uploads);
  const stolen = await call(s, "POST", `/v1/runs/${created.body.id}/complete`, { key: s.otherKey.secret });
  assert.equal(stolen.status, 404);
  assert.ok(stolen.body.error.startsWith(`no run ${created.body.id} in this project `), stolen.body.error);
  assert.equal((await call(s, "POST", "/v1/runs/run_00000000000000000000/complete")).status, 404);

  // The same client run id in another project is another run.
  const theirs = await call(s, "POST", "/v1/runs", { key: s.otherKey.secret, body: runBody() });
  assert.equal(theirs.status, 201);
  assert.notEqual(theirs.body.id, created.body.id);
  assert.ok(theirs.body.uploads.every((u) => u.url.includes(`/__storage/${s.other.id}/${theirs.body.id}/`)));

  for (const [method, route] of [["GET", "/v1/runs"], ["GET", `/v1/runs/${created.body.id}`], ["DELETE", `/v1/runs/${created.body.id}`], ["POST", "/v1/projects"], ["GET", `/v1/runs/${created.body.id}/complete`]]) {
    const res = await call(s, method, route);
    assert.equal(res.status, 403, `${method} ${route}`);
    assert.match(res.body.error, /can only upload runs/);
  }
  assert.equal((await call(s, "GET", "/v1/runs", { key: null })).status, 401);
  assert.equal((await handle(new Request(BASE + "/index.html", { headers: { authorization: `Bearer ${s.key.secret}` } }), s.deps)).status, 404, "a key opens no page");

  await s.db.revokeAccessKey(s.key.id);
  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody("20261112T110000-abc1234") })).status, 401, "a revoked key");
});

test("complete prunes the project to the newest 50 ready runs and deletes their files", async () => {
  const s = await setup();
  const ids = [];
  for (let i = 0; i < KEEP_RUNS + 2; i++) {
    const contents = i < 2 ? { "screens/x.png": `png-${i}` } : {};
    const created = await call(s, "POST", "/v1/runs", { body: runBody(`20261112T1000${String(i).padStart(2, "0")}-abc`, contents) });
    await putAll(s, created.body.uploads, contents);
    assert.equal((await call(s, "POST", `/v1/runs/${created.body.id}/complete`)).status, 200);
    ids.push(created.body.id);
  }
  const left = await s.db.listRuns(s.fernwood.id);
  assert.equal(left.length, KEEP_RUNS);
  assert.deepEqual(left.map((r) => r.id), ids.slice(2).reverse());
  assert.equal(s.storage.objects.size, 0, "the pruned runs' files are deleted");

  // An unfinished upload is not counted and not pruned while it is recent.
  const pending = await call(s, "POST", "/v1/runs", { body: runBody("20261112T120000-pending", {}) });
  const one = await call(s, "POST", "/v1/runs", { body: runBody("20261112T120001-abc", {}) });
  await call(s, "POST", `/v1/runs/${one.body.id}/complete`);
  assert.ok(await s.db.getRun(pending.body.id));
  assert.equal((await s.db.listRuns(s.fernwood.id, { status: "ready" })).length, KEEP_RUNS);
});

test("complete also drops runs older than 30 days", async () => {
  const s = await setup();
  s.setClock("2026-10-01T10:00:00.000Z");
  const old = await call(s, "POST", "/v1/runs", { body: runBody("20261001T100000-old", {}) });
  await call(s, "POST", `/v1/runs/${old.body.id}/complete`);
  s.setClock("2026-11-12T10:00:00.000Z");
  const fresh = await call(s, "POST", "/v1/runs", { body: runBody("20261112T100000-new", {}) });
  await call(s, "POST", `/v1/runs/${fresh.body.id}/complete`);
  assert.deepEqual((await s.db.listRuns(s.fernwood.id)).map((r) => r.id), [fresh.body.id]);
});

test("an imitor older than MIN_CLI_VERSION gets 426 with the version to update to", async () => {
  const s = await setup();
  s.deps.minCliVersion = "0.2.0";
  const res = await call(s, "POST", "/v1/runs", { body: runBody(), ua: "imitor/0.1.9" });
  assert.equal(res.status, 426);
  assert.deepEqual(res.body, { error: "this imitor (0.1.9) is too old for this server; update to 0.2.0 or newer", minVersion: "0.2.0" });
  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody(), ua: "imitor/0.1.9", key: null })).status, 426, "before the key check");
  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody(), ua: "imitor/0.2.0" })).status, 201);
  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody("20261112T100000-curl", {}), ua: "curl/8.5.0" })).status, 201, "other clients are not versioned");
});

test("the server blanks fill values a client forgot to redact", async () => {
  const s = await setup();
  const problems = [{ kind: "flow-failed", step: 2, stepConfig: { fill: { placeholder: "Password", value: "hunter2-hunter2" } } }];
  const created = await call(s, "POST", "/v1/runs", { body: runBody(undefined, {}, { manifest: { shots: [], problems }, activity: [{ at: "2026-11-12T10:00:30.000Z", tool: "imitor_run_flow", text: "ran sign-in" }] }) });
  const stored = await s.db.getRun(created.body.id);
  assert.equal(stored.manifest.problems[0].stepConfig.fill.value, "•••");
  assert.ok(!JSON.stringify(stored).includes("hunter2-hunter2"));
  assert.deepEqual(await s.db.listLines("activity", created.body.id), [{ at: "2026-11-12T10:00:30.000Z", tool: "imitor_run_flow", text: "ran sign-in" }]);
});

test("a project has at most 5 unfinished uploads; a re-push of one of them is still answered", async () => {
  const s = await setup();
  const ids = [];
  for (let i = 0; i < MAX_UNFINISHED; i++) ids.push((await call(s, "POST", "/v1/runs", { body: runBody(`20261112T10000${i}-open`, {}) })).body.id);
  const sixth = await call(s, "POST", "/v1/runs", { body: runBody("20261112T100009-sixth", {}) });
  assert.equal(sixth.status, 429);
  assert.match(sixth.body.error, /already has 5 unfinished uploads; push one of them again to finish it, or wait: an upload not completed within 24 hours is dropped/);
  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody("20261112T100000-open", {}) })).body.id, ids[0], "the same run again is not a new upload");
  assert.equal((await call(s, "POST", "/v1/runs", { key: s.otherKey.secret, body: runBody("20261112T100009-sixth", {}) })).status, 201, "another project has its own limit");
  assert.equal((await call(s, "POST", `/v1/runs/${ids[0]}/complete`)).status, 200);
  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody("20261112T100009-sixth", {}) })).status, 201);
});

test("an upload not completed within 24 hours is dropped with its files, on create and on complete", async () => {
  const s = await setup();
  const files = (id) => [...s.storage.objects.keys()].filter((k) => k.includes(`/${id}/`));
  const stale = await call(s, "POST", "/v1/runs", { body: runBody("20261112T100000-stale") });
  await putAll(s, stale.body.uploads.slice(0, 1));
  assert.equal(files(stale.body.id).length, 1);

  s.setClock("2026-11-13T09:59:00.000Z"); // 23 hours and 59 minutes later: still there
  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody("20261113T095900-other", {}) })).status, 201);
  assert.ok(await s.db.getRun(stale.body.id));

  s.setClock("2026-11-13T10:01:00.000Z");
  const late = await call(s, "POST", `/v1/runs/${stale.body.id}/complete`);
  assert.equal(late.status, 404);
  assert.match(late.body.error, /not completed within 24 hours is dropped; push it again/);
  assert.equal(await s.db.getRun(stale.body.id), null);
  assert.deepEqual(files(stale.body.id), []);

  // On create: the run registered at 09:59 expires when a later push arrives, and no longer counts toward the limit.
  assert.deepEqual((await s.db.listRuns(s.fernwood.id)).map((r) => r.clientRunId), ["20261113T095900-other"]);
  s.setClock("2026-11-14T10:00:00.000Z");
  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody("20261114T100000-next", {}) })).status, 201);
  assert.deepEqual((await s.db.listRuns(s.fernwood.id)).map((r) => r.clientRunId), ["20261114T100000-next"]);
  const pruned = (await s.db.listAudit()).filter((a) => a.action === "run.prune").map((a) => a.detail.reason);
  assert.deepEqual(pruned, ["unfinished", "unfinished"]);

  // Pushing the dropped run again starts it afresh.
  const again = await call(s, "POST", "/v1/runs", { body: runBody("20261112T100000-stale") });
  assert.equal(again.status, 201);
  assert.notEqual(again.body.id, stale.body.id);
  assert.equal(again.body.uploads.length, 3);
});

test("complete checks each file's size, content type and SHA-256, and drops one that does not match", async () => {
  const s = await setup();
  const created = await call(s, "POST", "/v1/runs", { body: runBody() });
  await putAll(s, created.body.uploads);
  const at = (p) => `${s.fernwood.id}/${created.body.id}/${p}`;
  const welcome = "screens/first-run-01-welcome-iphone-16-light.png";
  const clip = "screens/first-run.webm";
  // Written around the signed URLs (a store that ignored the checksum, or a bug): same size, other bytes or type.
  s.storage.objects.set(at(welcome), { body: Buffer.from("PNG-1"), contentType: "image/png" });
  s.storage.objects.set(at(clip), { body: Buffer.from("webm-333"), contentType: "text/html" });

  const done = await call(s, "POST", `/v1/runs/${created.body.id}/complete`);
  assert.equal(done.status, 409);
  assert.match(done.body.error, /^2 files not uploaded yet \(or not with the declared size, type and checksum\)/);
  assert.deepEqual(done.body.missing.sort(), [welcome, clip].sort());
  assert.ok(!s.storage.objects.has(at(welcome)) && !s.storage.objects.has(at(clip)), "dropped, so a push uploads them again");
  assert.equal((await s.db.getRun(created.body.id)).status, "uploading");

  const again = await call(s, "POST", "/v1/runs", { body: runBody() });
  assert.deepEqual(again.body.uploads.map((u) => u.path).sort(), [welcome, clip].sort());
  await putAll(s, again.body.uploads);
  assert.equal((await call(s, "POST", `/v1/runs/${created.body.id}/complete`)).status, 200);
});

test("a store without checksums is refused unless unverified uploads are allowed; upload URLs last 15 minutes", async () => {
  const s = await setup();
  const head = s.storage.head;
  s.storage.head = async (key) => ({ ...(await head(key)), sha256: null }); // what S3 answers with S3_CHECKSUMS=off
  const created = await call(s, "POST", "/v1/runs", { body: runBody() });
  assert.equal(UPLOAD_SECONDS, 900);
  for (const u of created.body.uploads) {
    const left = Number(new URL(u.url).searchParams.get("expires")) - Date.now();
    assert.ok(left > 14 * 60 * 1000 && left <= UPLOAD_SECONDS * 1000, String(left));
  }
  await putAll(s, created.body.uploads);
  assert.equal((await call(s, "POST", `/v1/runs/${created.body.id}/complete`)).status, 409, "no checksum to compare is not a match");
  s.deps.allowUnverified = true;
  await putAll(s, (await call(s, "POST", "/v1/runs", { body: runBody() })).body.uploads);
  assert.equal((await call(s, "POST", `/v1/runs/${created.body.id}/complete`)).status, 200);

  const env = { S3_BUCKET: "runs", S3_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE", S3_SECRET_ACCESS_KEY: "secret", S3_ENDPOINT: "http://127.0.0.1:9000" };
  assert.equal(depsFromEnv(env).allowUnverified, false);
  assert.throws(() => depsFromEnv({ ...env, S3_CHECKSUMS: "off" }), /S3_CHECKSUMS=off .* set IMITOR_ALLOW_UNVERIFIED_UPLOADS=1 to accept unverified files \(unsafe\)/);
  assert.equal(depsFromEnv({ ...env, S3_CHECKSUMS: "off", IMITOR_ALLOW_UNVERIFIED_UPLOADS: "1" }).allowUnverified, true);
});

test("a storage delete that fails during pruning is logged, complete still answers 200, and a later call retries it", async () => {
  const s = await setup();
  const logged = [];
  s.deps.log = (error) => logged.push(error.message);
  const del = s.storage.delete;
  let failures = 0;
  s.storage.delete = async (keys) => {
    if (failures-- > 0) throw new Error("storage DELETE answered 503");
    return del(keys);
  };
  s.setClock("2026-09-29T10:00:00.000Z");
  const old = await call(s, "POST", "/v1/runs", { body: runBody("20260929T100000-old") });
  await putAll(s, old.body.uploads);
  assert.equal((await call(s, "POST", `/v1/runs/${old.body.id}/complete`)).status, 200);

  s.setClock("2026-10-29T09:00:00.000Z");
  const fresh = await call(s, "POST", "/v1/runs", { body: runBody("20261029T090000-new", {}) });
  assert.ok(await s.db.getRun(old.body.id), "not 30 days old yet");
  s.setClock("2026-10-29T12:00:00.000Z"); // now it is, and complete prunes it
  failures = 1;
  const done = await call(s, "POST", `/v1/runs/${fresh.body.id}/complete`);
  assert.equal(done.status, 200);
  assert.equal(done.body.status, "ready");
  assert.deepEqual(logged, ["storage DELETE answered 503"]);
  assert.equal(await s.db.getRun(old.body.id), null, "the run is gone from listings at once");
  assert.equal(s.storage.objects.size, 3, "its files are still in storage");
  assert.equal((await s.db.listPendingDeletions(s.fernwood.id)).length, 3);

  assert.equal((await call(s, "POST", "/v1/runs", { body: runBody("20261029T120000-next", {}) })).status, 201);
  assert.equal(s.storage.objects.size, 0, "retried on the next create");
  assert.deepEqual(await s.db.listPendingDeletions(s.fernwood.id), []);
});

test("finding missing files takes one listing, and checking them at most 16 HEADs at a time", async () => {
  const s = await setup();
  const contents = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`screens/shot-${String(i).padStart(2, "0")}.png`, `png-${i}`]));
  const calls = { list: 0, head: 0 };
  let inFlight = 0;
  let most = 0;
  const { list, head } = s.storage;
  s.storage.list = async (prefix) => (calls.list++, list(prefix));
  s.storage.head = async (key) => {
    calls.head++;
    most = Math.max(most, ++inFlight);
    await new Promise((r) => setTimeout(r, 1));
    inFlight--;
    return head(key);
  };
  const created = await call(s, "POST", "/v1/runs", { body: runBody(undefined, contents) });
  await putAll(s, created.body.uploads.slice(0, 30), contents);
  const again = await call(s, "POST", "/v1/runs", { body: runBody(undefined, contents) });
  assert.equal(again.body.uploads.length, 10);
  assert.deepEqual(calls, { list: 1, head: 0 }, "a re-push lists the run's prefix once");
  assert.equal((await call(s, "POST", `/v1/runs/${created.body.id}/complete`)).status, 409);
  assert.deepEqual(calls, { list: 2, head: 30 }, "only files that are there are checked one by one");
  await putAll(s, again.body.uploads, contents);
  assert.equal((await call(s, "POST", `/v1/runs/${created.body.id}/complete`)).status, 200);
  assert.equal(calls.head, 70);
  assert.equal(most, 16);
});
