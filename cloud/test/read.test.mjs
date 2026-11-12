// The interface's API in the cloud gives what the local server gives for the same runs (after redaction): both are
// built with src/derive.mjs, and these tests keep the shapes from drifting apart.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { apiGet } from "../../src/appserver.mjs";
import { loadConfig } from "../../src/config.mjs";
import { buildUpload } from "../../src/push.mjs";
import { recordRun } from "../../src/store.mjs";
import { readRoute } from "../src/read.mjs";
import { browser, cloud } from "./helpers.mjs";

const SECRET = "moss-and-lichen-42";

/**
 * The invented app "fernwood" with two recorded runs: the first passes with a stand-in, the second fails at a fill
 * step that typed a password. Each run has a capture and two lines of agent activity.
 */
function app() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-read-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({
    shims: { "@shopify/react-native-skia": "skia" },
    devices: ["iphone-16"],
    schemes: ["light", "dark"],
    flows: [{ name: "sign-in", start: "/", steps: [{ shot: "01-form" }, { fill: { placeholder: "Password", value: SECRET } }, { tap: "Sign in" }, { shot: "02-garden" }] }],
  }));
  const out = path.join(root, "preview");
  const config = loadConfig(root);
  const runs = [];
  for (const [i, failing] of [[0, false], [1, true]]) {
    fs.rmSync(path.join(out, "screens"), { recursive: true, force: true });
    fs.mkdirSync(path.join(out, "screens"), { recursive: true });
    const shots = ["light", "dark"].flatMap((scheme) => ["01-form", "02-garden"].filter((n) => !failing || scheme === "light" || n === "01-form").map((n) => ({ file: `screens/sign-in-${n}-iphone-16-${scheme}.png`, flow: "sign-in", shot: n, device: "iphone-16", scheme, route: "/", stubs: n === "02-garden" ? ["skia"] : [] })));
    const problems = failing ? [
      { where: "sign-in / iphone-16 / dark", kind: "flow-failed", message: `locator.fill: Timeout 10000ms exceeded. {"value":"${SECRET}"}`, file: "screens/sign-in-FAILED-iphone-16-dark.png", flow: "sign-in", device: "iphone-16", scheme: "dark", step: 2, stepConfig: config.flows[0].steps[1], lastGoodShot: "screens/sign-in-01-form-iphone-16-dark.png", notReached: ["02-garden"] },
      { where: "sign-in / iphone-16 / light", kind: "page-error", message: "TypeError: garden is undefined", flow: "sign-in", device: "iphone-16", scheme: "light" },
    ] : [];
    for (const f of [...shots, ...problems.filter((p) => p.file)]) fs.writeFileSync(path.join(out, f.file), `png bytes of ${f.file}`);
    const run = recordRun(out, { root, config, manifest: { commit: `c0ffee${i}`, shots, problems }, startedAt: `2026-11-1${i}T09:00:00.000Z`, by: { name: "GitHub Actions", kind: "ci" }, env: {} });
    const dir = path.join(out, "runs", run.id);
    fs.mkdirSync(path.join(dir, "captures"), { recursive: true });
    fs.writeFileSync(path.join(dir, "captures", "garden.png"), "png");
    runs.push(run);
  }
  return { root, out, runs };
}

/**
 * The same runs twice: on disk as the local server reads them, and in the cloud's repository, both from the redacted
 * upload body. The cloud's run ids are the run folder names here, so ids and problem ids match.
 */
async function both() {
  const { root, out, runs } = app();
  const c = cloud();
  const owner = await c.db.createUser({ email: "ada@example.com", allowed: true });
  const project = await c.db.createProject({ name: "fernwood", ownerId: owner.id });
  const recent = new Date(Date.now() - 3600e3);
  const captures = [];
  const activity = [];
  for (const [i, run] of runs.entries()) {
    const { body } = buildUpload(root, run.id);
    assert.ok(!JSON.stringify(body).includes(SECRET), "the upload is redacted");
    const dir = path.join(out, "runs", run.id);
    fs.writeFileSync(path.join(dir, "run.json"), JSON.stringify(body.run));
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(body.manifest));
    const by = { name: i ? "Claude Code" : "Cursor", kind: "agent" };
    const capture = { id: `c_${i}`, kind: "screenshot", file: "captures/garden.png", route: "/garden", flow: null, device: "iphone-16", scheme: "light", by, at: new Date(recent.getTime() + i * 60e3).toISOString(), seconds: null, standIns: ["skia"], state: null, seeded: false };
    const lines = [0, 1].map((n) => ({ at: new Date(recent.getTime() + i * 60e3 + n * 1000).toISOString(), by, tool: "imitor_screenshot", text: `took a screenshot of /garden (${i}.${n})`, ok: true }));
    captures.push({ ...capture, file: `runs/${run.id}/${capture.file}` }); // locally, relative to the output folder
    activity.push(...lines);
    await c.db.createRun({ id: run.id, projectId: project.id, clientRunId: body.clientRunId, schemaVersion: 1, run: body.run, manifest: body.manifest, files: body.files.map((f) => ({ ...f, key: `${project.id}/${run.id}/${f.path}` })), lines: { captures: [capture], activity: lines } });
    await c.db.updateRun(run.id, { status: "ready", completedAt: new Date(Date.parse(body.run.finishedAt) + 1000).toISOString() });
  }
  fs.mkdirSync(path.join(out, "captures"), { recursive: true });
  fs.writeFileSync(path.join(out, "captures", "index.jsonl"), captures.map((l) => JSON.stringify(l) + "\n").join(""));
  fs.writeFileSync(path.join(out, "activity.jsonl"), activity.map((l) => JSON.stringify(l) + "\n").join(""));
  return { root, runs, c, project, owner };
}

/** A cloud body with its file URLs written as the local server writes them. */
const asLocal = (value, slug) => JSON.parse(JSON.stringify(value).replaceAll(`"/p/${slug}/files/`, '"/files/'));

/** Assert that a and b have the same keys all the way down, arrays by their first element, and leaves of one type (null fits any). */
function sameShape(a, b, at = "") {
  if (a === null || b === null) return;
  if (Array.isArray(a) || Array.isArray(b)) {
    assert.ok(Array.isArray(a) && Array.isArray(b), `${at} is a list in one and not the other`);
    if (a.length && b.length) sameShape(a[0], b[0], `${at}[0]`);
    return;
  }
  assert.equal(typeof a, typeof b, at);
  if (typeof a !== "object") return;
  assert.deepEqual(Object.keys(a), Object.keys(b), at || "top");
  for (const k of Object.keys(a)) sameShape(a[k], b[k], `${at}.${k}`);
}

test("runs, a run, problems, captures and agents: the cloud answers exactly what the local server does", async () => {
  const { root, runs, c, project, owner } = await both();
  const routes = ["/api/runs", ...runs.map((r) => `/api/runs/${r.id}`), "/api/problems", "/api/captures", "/api/agents"];
  for (const route of routes) {
    const local = apiGet(root, route);
    const remote = await readRoute(c.db, project, owner.id, route, { now: new Date() });
    assert.equal(remote.status, 200, route);
    assert.equal(local.status, 200, route);
    assert.deepEqual(asLocal(remote.body, project.slug), local.body, route);
  }
  // Something real was compared, file URLs included.
  const failed = (await readRoute(c.db, project, owner.id, `/api/runs/${runs[1].id}`)).body;
  assert.equal(failed.run.status, "failed");
  assert.equal(failed.flows.find((f) => f.scheme === "dark").steps[0].shot, `/p/fernwood/files/runs/${runs[1].id}/screens/sign-in-01-form-iphone-16-dark.png`);
  const problems = (await readRoute(c.db, project, owner.id, "/api/problems")).body.problems;
  assert.deepEqual(problems.map((p) => p.kind).sort(), ["flow-failed", "page-error", "stand-in", "stand-in"]);
  assert.equal(problems.find((p) => p.kind === "flow-failed").detail.stepConfig.fill.value, "•••");
  assert.equal((await readRoute(c.db, project, owner.id, "/api/captures")).body.captures[0].file, `/p/fernwood/files/runs/${runs[1].id}/captures/garden.png`);
  assert.equal((await readRoute(c.db, project, owner.id, "/api/agents")).body.connections.length, 2);
  assert.deepEqual(await readRoute(c.db, project, owner.id, "/api/runs/run_nope"), { status: 404, body: { error: "no run run_nope" } });
  assert.equal(await readRoute(c.db, project, owner.id, "/api/nope"), null);
});

test("project: the same shape as the local one, from the newest run, with no preview", async () => {
  const { root, c, project, owner } = await both();
  const local = apiGet(root, "/api/project").body;
  const remote = (await readRoute(c.db, project, owner.id, "/api/project")).body;
  const flow = (f) => ({ ...f, steps: f.steps.slice(0, 1) }); // a local flow's steps include taps and fills
  sameShape(remote, { ...local, flows: local.flows.map(flow) });
  assert.deepEqual({ name: remote.name, branch: remote.branch, commit: remote.commit, built: remote.built, previewUrl: remote.previewUrl }, { name: "fernwood", branch: null, commit: "c0ffee1", built: false, previewUrl: null });
  assert.deepEqual(remote.devices, [{ name: "iphone-16", width: 393, height: 852, platform: "ios" }]);
  assert.deepEqual(remote.schemes, ["light", "dark"]);
  assert.deepEqual(remote.flows.map((f) => [f.name, f.steps.map((s) => s.label)]), [["sign-in", ["01-form", "02-garden"]]]);
  assert.deepEqual(remote.notCovered, local.notCovered);
});

test("over HTTP: /p/<slug>/api/* answers the same bodies, only ready runs, newest first", async () => {
  const { runs, c, project, owner } = await both();
  const b = browser(c.deps);
  const secret = "s".repeat(43);
  await c.db.createSession({ idHash: (await import("node:crypto")).createHash("sha256").update(secret).digest("hex"), userId: owner.id, expiresAt: "2099-01-01T00:00:00.000Z" });
  b.jar.set("__Host-imitor_session", secret);
  const res = await b.call("GET", "/p/fernwood/api/runs");
  assert.equal(res.status, 200);
  assert.deepEqual(res.json, (await readRoute(c.db, project, owner.id, "/api/runs")).body);
  assert.deepEqual(res.json.runs.map((r) => r.id), [runs[1].id, runs[0].id]);
  await c.db.updateRun(runs[1].id, { status: "uploading", completedAt: null });
  assert.deepEqual((await b.call("GET", "/p/fernwood/api/runs")).json.runs.map((r) => r.id), [runs[0].id], "an unfinished upload is not shown");
  assert.equal((await b.call("GET", `/p/fernwood/api/runs/${runs[1].id}`)).status, 404);
});
