// `imitor push` end to end: the real CLI against cloud/src/server.mjs on a free port, with memory adapters.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { loadConfig } from "../../src/config.mjs";
import { push, USER_AGENT } from "../../src/push.mjs";
import { recordRun } from "../../src/store.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { startServer } from "../src/server.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";

const BIN = fileURLToPath(new URL("../../bin/imitor.mjs", import.meta.url));
const PASSWORD = "moss-and-lichen-42";

/** The invented app "fernwood" with one recorded run whose sign-in flow typed a password and then failed. */
function app() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-push-"));
  const config = {
    devices: ["iphone-16"],
    schemes: ["light", "dark"],
    flows: [{ name: "sign-in", start: "/", steps: [{ shot: "01-form" }, { fill: { placeholder: "Password", value: PASSWORD } }, { tap: "Sign in" }, { shot: "02-garden" }] }],
  };
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify(config));
  const out = path.join(root, "preview");
  fs.mkdirSync(path.join(out, "screens"), { recursive: true });
  const shots = ["light", "dark"].flatMap((scheme) => ["01-form", "02-garden"].filter((n) => scheme === "light" || n === "01-form").map((n) => ({ file: `screens/sign-in-${n}-iphone-16-${scheme}.png`, flow: "sign-in", shot: n, device: "iphone-16", scheme, route: "/", stubs: [] })));
  const problems = [
    { where: "sign-in / iphone-16 / dark", kind: "flow-failed", message: "locator.click: Timeout 10000ms exceeded.", file: "screens/sign-in-FAILED-iphone-16-dark.png", flow: "sign-in", device: "iphone-16", scheme: "dark", step: 2, stepConfig: config.flows[0].steps[1], lastGoodShot: "screens/sign-in-01-form-iphone-16-dark.png", notReached: ["02-garden"] },
    { where: "sign-in / iphone-16 / dark", kind: "dialog", message: `Signed in with ${PASSWORD}?`, flow: "sign-in", device: "iphone-16", scheme: "dark", step: 2 },
  ];
  for (const f of [...shots, problems[0]]) fs.writeFileSync(path.join(out, f.file), `png bytes of ${f.file}`);
  fs.writeFileSync(path.join(out, "screens", "notes.txt"), "not an image");
  const run = recordRun(out, { root, config: loadConfig(root), manifest: { commit: null, shots, problems }, startedAt: "2026-11-12T09:00:00.000Z", by: { name: "Ada", kind: "person" }, env: {} });
  return { root, out, run, dir: path.join(out, "runs", run.id) };
}

async function cloud({ minCliVersion = null } = {}) {
  const deps = { db: memoryDb(), storage: memoryStorage(), minCliVersion };
  const server = await startServer({ deps });
  const project = await deps.db.createProject({ name: "fernwood" });
  const key = await deps.db.createAccessKey(project.id);
  return { ...server, deps, project, key };
}

/** Run the CLI in `cwd`; resolves { code, stdout, stderr } whatever the exit code. */
async function cli(cwd, args, env) {
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith("IMITOR_")));
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, [BIN, ...args], { cwd, env: { ...clean, ...env } });
    return { code: 0, stdout, stderr };
  } catch (error) {
    return { code: error.code, stdout: error.stdout, stderr: error.stderr };
  }
}

test("imitor push uploads the newest run, redacted, and prints its URL; pushing again uploads nothing", async (t) => {
  const a = app();
  const c = await cloud();
  t.after(() => c.close());
  const env = { IMITOR_CLOUD_URL: c.url, IMITOR_TOKEN: c.key.secret };

  const first = await cli(a.root, ["push"], env);
  assert.equal(first.code, 0, first.stderr);
  const [run] = await c.deps.db.listRuns(c.project.id);
  assert.equal(run.status, "ready");
  assert.equal(run.clientRunId, a.run.id);
  assert.equal(first.stdout.split("\n")[0], `Pushed run ${a.run.id} (4 files): ${c.url}/runs/${run.id}`);
  assert.match(first.stdout, /Left out 1 file of a type the cloud does not take, e\.g\. screens\/notes\.txt/);

  // Every file arrived byte for byte, under the server's key.
  const files = fs.readdirSync(path.join(a.dir, "screens")).filter((f) => f.endsWith(".png")).map((f) => `screens/${f}`).sort();
  assert.deepEqual(run.files.map((f) => f.path), files);
  for (const f of files) assert.deepEqual(c.deps.storage.objects.get(`${c.project.id}/${run.id}/${f}`).body, fs.readFileSync(path.join(a.dir, f)));

  // The password is in the run on disk, and nowhere in the cloud.
  assert.ok(fs.readFileSync(path.join(a.dir, "manifest.json"), "utf8").includes(PASSWORD));
  assert.ok(!JSON.stringify(run).includes(PASSWORD));
  assert.equal(run.manifest.problems[0].stepConfig.fill.value, "•••");
  assert.equal(run.manifest.problems[1].message, "Signed in with •••?");

  const again = await cli(a.root, ["push", "--run", a.run.id], env);
  assert.equal(again.code, 0, again.stderr);
  assert.equal(again.stdout.split("\n")[0], `Pushed run ${a.run.id} (0 of 4 files; the rest were already there): ${c.url}/runs/${run.id}`);
  assert.equal((await c.deps.db.listRuns(c.project.id)).length, 1);
});

test("an interrupted push resumes with only the files that did not arrive", async (t) => {
  const a = app();
  const c = await cloud();
  t.after(() => c.close());
  const agents = [];
  let puts = 0;
  const flaky = async (url, init) => {
    agents.push(init.headers["user-agent"]);
    if (init.method === "PUT" && ++puts === 3) throw new Error("connection reset");
    return fetch(url, init);
  };
  await assert.rejects(push(a.root, { cloudUrl: c.url, token: c.key.secret, fetch: flaky }), /uploading screens\/.+ failed: connection reset/);
  assert.equal((await c.deps.db.listRuns(c.project.id))[0].status, "uploading");
  assert.equal(c.deps.storage.objects.size, 2);
  assert.equal(agents[0], USER_AGENT);
  assert.match(USER_AGENT, /^imitor\/\d+\.\d+\.\d+$/);

  const resumed = await push(a.root, { cloudUrl: c.url, token: c.key.secret });
  assert.equal(resumed.uploaded, 2);
  assert.equal(resumed.files, 4);
  assert.equal(c.deps.storage.objects.size, 4);
  assert.equal((await c.deps.db.getRun(resumed.id)).status, "ready");
});

test("imitor push fails with a plain message and a non-zero exit", async (t) => {
  const a = app();
  const c = await cloud();
  t.after(() => c.close());

  const noUrl = await cli(a.root, ["push"], { IMITOR_TOKEN: c.key.secret });
  assert.equal(noUrl.code, 1);
  assert.match(noUrl.stderr, /^imitor: IMITOR_CLOUD_URL is not set\./);
  const noToken = await cli(a.root, ["push"], { IMITOR_CLOUD_URL: c.url });
  assert.equal(noToken.code, 1);
  assert.match(noToken.stderr, /^imitor: IMITOR_TOKEN is not set\./);

  const badKey = await cli(a.root, ["push"], { IMITOR_CLOUD_URL: c.url, IMITOR_TOKEN: "imk_revoked-or-made-up" });
  assert.equal(badKey.code, 1);
  assert.match(badKey.stderr, /refused the push \(401\): this key is not valid/);

  const noRun = await cli(a.root, ["push", "--run", "20200101T000000-nope"], { IMITOR_CLOUD_URL: c.url, IMITOR_TOKEN: c.key.secret });
  assert.equal(noRun.code, 1);
  assert.match(noRun.stderr, /no run "20200101T000000-nope" in preview\/runs\. Runs: \d{8}T/);

  const down = await cli(a.root, ["push"], { IMITOR_CLOUD_URL: "http://127.0.0.1:1", IMITOR_TOKEN: c.key.secret });
  assert.equal(down.code, 1);
  assert.match(down.stderr, /could not reach http:\/\/127\.0\.0\.1:1/);
  assert.equal((await c.deps.db.listRuns(c.project.id)).length, 0);
});

test("a server that needs a newer imitor says which version", async (t) => {
  const a = app();
  const c = await cloud({ minCliVersion: "99.0.0" });
  t.after(() => c.close());
  const old = await cli(a.root, ["push"], { IMITOR_CLOUD_URL: c.url, IMITOR_TOKEN: c.key.secret });
  assert.equal(old.code, 1);
  assert.match(old.stderr, /refused the push \(426\): this imitor \(\d+\.\d+\.\d+\) is too old for this server; update to 99\.0\.0 or newer/);
});
