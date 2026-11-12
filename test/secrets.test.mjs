// Values from the environment ({ "env": "NAME" } in a fill step) and hidden fill values. The end-to-end test runs a flow
// that types random marker values, then looks for them in everything Imitor writes, returns or publishes.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { describe, readProblems, recordVideo, runFlow, screenshot } from "../src/agent.mjs";
import { apiGet, projectData } from "../src/appserver.mjs";
import { buildComment } from "../src/comment.mjs";
import { loadConfig } from "../src/config.mjs";
import { exportSite } from "../src/export.mjs";
import { evaluate, formatMarkdown, formatText, reportToGitHub } from "../src/gate.mjs";
import { createServer } from "../src/mcp.mjs";
import { publishShots } from "../src/publish.mjs";
import { writeReport } from "../src/report.mjs";
import { HIDDEN, checkSecrets, publicStep, refuseSecretRefs, resolveValue, scrub, scrubForRoot, secretValues, secretsUsed } from "../src/secrets.mjs";
import { serve } from "../src/serve.mjs";
import { shoot } from "../src/shoot.mjs";
import { recordCaptures, recordRun } from "../src/store.mjs";

const require = createRequire(import.meta.url);
let hasPlaywright = true;
try { require("playwright"); } catch { hasPlaywright = false; }
const browser = { skip: hasPlaywright ? false : "playwright is not installed" };

// ---------- units ----------

test("config: secrets is a list of names, and every { env } fill names one of them", () => {
  const flow = (value) => [{ name: "login", steps: [{ fill: { placeholder: "Password", value } }] }];
  assert.deepEqual(checkSecrets({ secrets: ["TEST_PASSWORD"] }, flow({ env: "TEST_PASSWORD" })), ["TEST_PASSWORD"]);
  assert.deepEqual(checkSecrets({}, flow("plain text")), []);
  assert.throws(() => checkSecrets({ secrets: "TEST_PASSWORD" }, []), /must be a list of environment variable names/);
  assert.throws(() => checkSecrets({ secrets: ["not a name"] }, []), /must be a list of environment variable names/);
  assert.throws(() => checkSecrets({ secrets: [] }, flow({ env: "TEST_PASSWORD" })), /flow "login" step 1: "TEST_PASSWORD" is not listed in "secrets"/);
  assert.throws(() => checkSecrets({ secrets: ["A"] }, flow({ env: "A", extra: 1 })), /must be text or \{ "env": "NAME" \}/);
});

test("resolveValue: literals as text; a listed, set variable's value; otherwise an error that names the variable only", () => {
  assert.equal(resolveValue("Ada"), "Ada");
  assert.equal(resolveValue(42), "42");
  assert.equal(resolveValue({ env: "PW" }, ["PW"], { PW: "s3cret-value" }), "s3cret-value");
  assert.throws(() => resolveValue({ env: "PW" }, [], { PW: "s3cret-value" }), (e) => /"PW" is not listed/.test(e.message) && !e.message.includes("s3cret"));
  assert.throws(() => resolveValue({ env: "PW" }, ["PW"], {}), /environment variable PW is not set/);
  assert.throws(() => resolveValue({ env: "PW" }, ["PW"], { PW: "" }), /PW is not set/);
  assert.throws(() => resolveValue({ nope: 1 }, ["PW"], {}), /must be text/);
  assert.throws(() => resolveValue({ env: "PIN" }, ["PIN"], { PIN: "123" }), (e) => /PIN is shorter than 4 characters/.test(e.message) && !e.message.includes("123"));
});

test("publicStep hides every fill value; scrub removes secret values from any text; inline steps cannot use env", () => {
  assert.deepEqual(publicStep({ fill: { placeholder: "Name", value: "Ada" } }), { fill: { placeholder: "Name", value: HIDDEN } });
  assert.deepEqual(publicStep({ fill: { label: "Password", value: { env: "PW" } } }), { fill: { label: "Password", value: { env: "PW" } } });
  assert.deepEqual(publicStep({ tap: "Continue" }), { tap: "Continue" });
  assert.equal(publicStep(null), null);
  assert.deepEqual(secretsUsed([{ fill: { value: { env: "A" } } }, { fill: { value: "b" } }, { fill: { value: { env: "A" } } }, { tap: "x" }]), ["A"]);
  const values = secretValues(["A", "B", "SHORT"], { A: "alpha-secret", B: "beta-secret", SHORT: "ab" });
  assert.deepEqual(values, ["alpha-secret", "beta-secret"], "values shorter than 4 characters are not scrubbed");
  assert.deepEqual(scrub({ m: "x alpha-secret y", list: ["beta-secret"], n: 3 }, values), { m: `x ${HIDDEN} y`, list: [HIDDEN], n: 3 });
  assert.equal(scrub(JSON.stringify({ password: 'ab"cd-ef' }), ['ab"cd-ef']), `{"password":"${HIDDEN}"}`, "JSON-escaped forms too");
  assert.deepEqual(scrub({ file: "screens/alpha-secret.png", route: "/u/alpha-secret" }, values), { file: "screens/alpha-secret.png", route: `/u/${HIDDEN}` }, "paths stay valid");
  assert.deepEqual(scrub({ fill: { value: { env: "A" } } }, values), { fill: { value: { env: "A" } } }, "a reference is kept");
  assert.throws(() => refuseSecretRefs([{ tap: "x" }, { fill: { placeholder: "P", value: { env: "PW" } } }]), /step 2: values from the environment can only be used in flows in imitor.config.json/);
  refuseSecretRefs([{ fill: { placeholder: "P", value: "literal" } }]);
  refuseSecretRefs(undefined);
});

test("scrubForRoot reads the names from imitor.config.json and never throws", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-secrets-"));
  assert.equal(scrubForRoot(root, "no config here"), "no config here");
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ secrets: ["PW"] }));
  assert.equal(scrubForRoot(root, "failed with hunter22", { PW: "hunter22" }), `failed with ${HIDDEN}`);
  fs.writeFileSync(path.join(root, "imitor.config.json"), "{ broken");
  assert.equal(scrubForRoot(root, "kept", { PW: "kept" }), "kept");
});

// ---------- end to end ----------

const tag = crypto.randomBytes(6).toString("hex");
const EMAIL = `canary-${tag}@example.invalid`;
const PASSWORD = `pw-canary-${tag}`;
const LITERAL = `literal-canary-${tag}`;
const CANARIES = [EMAIL, PASSWORD, LITERAL];

/** Every form a canary could take in text: as is, base64, URL-encoded, JSON-escaped. */
const forms = (s) => [s, Buffer.from(s).toString("base64"), encodeURIComponent(s), JSON.stringify(s).slice(1, -1)];

function findCanaries(text, where) {
  for (const c of CANARIES) for (const f of forms(c)) assert.ok(!text.includes(f), `${where} contains a value that was typed (${c === LITERAL ? "literal" : "secret"})`);
  // Every canary carries the tag; part of one (a value cut in half by a truncation) still has its first 8 characters.
  assert.ok(!text.includes(tag.slice(0, 8)), `${where} contains part of a value that was typed`);
}

function scanDir(dir, skip = new Set()) {
  let files = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (skip.has(entry.name)) continue;
    if (entry.isDirectory()) files += scanDir(full, skip);
    else {
      findCanaries(fs.readFileSync(full).toString("latin1"), full);
      files++;
    }
  }
  return files;
}

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "T", GIT_AUTHOR_EMAIL: "t@example.invalid", GIT_COMMITTER_NAME: "T", GIT_COMMITTER_EMAIL: "t@example.invalid" }, stdio: ["ignore", "pipe", "pipe"] }).trim();

/**
 * A tiny sign-in page that echoes what was typed everywhere it can: a console error and an alert carry the password, and
 * the page shows the email after signing in. The app folder is a git clone of a bare remote, for publish-shots.
 */
function signInApp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-secrets-"));
  const remote = path.join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  const root = path.join(dir, "app");
  git(dir, "clone", "--quiet", remote, root);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "signin" }));
  fs.writeFileSync(path.join(root, ".gitignore"), "preview/\n");
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({
    secrets: ["IMITOR_TEST_EMAIL", "IMITOR_TEST_PASSWORD"],
    devices: ["iphone-16"],
    schemes: ["light"],
    settleMs: 50,
    flows: [
      { name: "login", start: "/", steps: [
        { fill: { placeholder: "Email", value: { env: "IMITOR_TEST_EMAIL" } } },
        { fill: { placeholder: "Password", value: { env: "IMITOR_TEST_PASSWORD" } } },
        { shot: "filled" },
        { tap: "Sign in" },
        { shot: "home" },
      ] },
      // Fails in its own step, after the secrets were typed in the flow it runs after.
      { name: "stuck", after: "login", steps: [{ tap: "Not there" }] },
      // Fails right after typing a literal.
      // Types a literal, which the app then echoes (console error, alert, address), and fails.
      { name: "literal", start: "/", steps: [{ fill: { placeholder: "Email", value: LITERAL } }, { tap: "Sign in" }, { tap: "Missing" }] },
    ],
  }));
  git(root, "add", ".");
  git(root, "commit", "--quiet", "-m", "app");
  git(root, "push", "--quiet", "origin", "HEAD:main");
  const app = path.join(root, "preview", "app");
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(path.join(app, "index.html"), `<!doctype html><html><head><meta name="viewport" content="width=device-width">
<style>body{margin:0;font:16px sans-serif;background:#fff}input{display:block;width:300px;height:40px;margin:20px;border:1px solid #888;background:#fff}</style></head><body>
<input id="email" placeholder="Email"><input id="pw" type="password" placeholder="Password"><button id="go">Sign in</button><div id="out"></div>
<script>document.getElementById("go").onclick=function(){var e=document.getElementById("email").value,p=document.getElementById("pw").value;
console.error("sign-in failed for "+e+" with "+p);alert("Wrong password "+p);alert("y".repeat(275)+p);
history.pushState(null,"","/u/"+e);document.getElementById("out").textContent="Signed in";};</script></body></html>`);
  return { root, remote, dir };
}

/** How many pure magenta pixels (Playwright's mask colour) a PNG has. */
async function maskedPixels(page, file) {
  const data = fs.readFileSync(file).toString("base64");
  return page.evaluate(async (src) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0);
    const px = ctx.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] === 255 && px[i + 1] === 0 && px[i + 2] === 255) n++;
    return n;
  }, `data:image/png;base64,${data}`);
}

test("no value a flow types reaches a file, a result, a log, the comment, the export or the shots branch", browser, async (t) => {
  const { root, remote } = signInApp();
  const saved = { email: process.env.IMITOR_TEST_EMAIL, pw: process.env.IMITOR_TEST_PASSWORD };
  process.env.IMITOR_TEST_EMAIL = EMAIL;
  process.env.IMITOR_TEST_PASSWORD = PASSWORD;
  t.after(() => {
    for (const [k, v] of [["IMITOR_TEST_EMAIL", saved.email], ["IMITOR_TEST_PASSWORD", saved.pw]]) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  });
  const said = []; // every result and text Imitor hands back, as JSON

  // A full run, its report, the runs store, the gate's text, summary, annotations and the pull-request comment.
  const config = loadConfig(root);
  const server = await serve(path.join(root, "preview", "app"));
  let result;
  try {
    result = await shoot(root, config, server.url);
  } finally {
    await server.close();
  }
  const kinds = result.problems.map((p) => `${p.flow}:${p.kind}`).sort();
  assert.ok(kinds.includes("stuck:flow-failed") && kinds.includes("literal:flow-failed"), JSON.stringify(kinds));
  assert.ok(kinds.includes("login:page-error") && kinds.includes("login:dialog"), "the app echoed the password in a console error and an alert");
  assert.ok(result.problems.some((p) => p.kind === "dialog" && p.message.includes(HIDDEN)), "and those were scrubbed, not dropped");
  const literalFail = result.problems.find((p) => p.flow === "literal" && p.kind === "flow-failed");
  assert.equal(literalFail.stepConfig.tap, "Missing");
  assert.ok(result.problems.some((p) => p.flow === "literal" && p.kind === "page-error" && p.message.includes(HIDDEN)), "a literal the app echoed is scrubbed too");
  assert.equal(result.shots.find((s) => s.shot === "home").route, `/u/${HIDDEN}`, "an address that holds a typed value is scrubbed");
  assert.ok(result.problems.some((p) => p.kind === "dialog" && /^alert: y{275}•••$/.test(p.message)), "a value is hidden before a dialog is cut to 300 characters");
  const manifest = writeReport(root, config, result);
  assert.deepEqual(manifest.shots.find((s) => s.shot === "home").secrets, ["IMITOR_TEST_EMAIL", "IMITOR_TEST_PASSWORD"], "shots say which secrets their flow used");
  assert.equal(manifest.shots.find((s) => s.flow === "literal"), undefined);
  recordRun(path.join(root, "preview"), { root, config, manifest, startedAt: new Date().toISOString(), by: { name: "test", kind: "ci" }, env: {} });
  const verdict = evaluate(manifest);
  const ghDir = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-gh-"));
  const ghEnv = { GITHUB_ACTIONS: "true", GITHUB_STEP_SUMMARY: path.join(ghDir, "summary.md"), GITHUB_OUTPUT: path.join(ghDir, "output") };
  const annotations = [];
  reportToGitHub(verdict, "preview/index.html", ghEnv, (s) => annotations.push(s));
  said.push(formatText(verdict), formatMarkdown(verdict), annotations.join(""), JSON.stringify(buildComment(manifest, {})));
  assert.match(formatText(verdict), /filling \{"placeholder":"Email","value":"•••"\}|tapping "Missing"/);

  // The agent operations, directly and through the MCP server (which also writes captures and the activity log).
  const flowRun = await runFlow(root, { flow: "login" });
  assert.equal(flowRun.passed, true, JSON.stringify(flowRun.steps));
  assert.deepEqual(flowRun.secrets, ["IMITOR_TEST_EMAIL", "IMITOR_TEST_PASSWORD"]);
  assert.deepEqual(flowRun.steps[1].target, { placeholder: "Password", value: { env: "IMITOR_TEST_PASSWORD" } });
  recordCaptures(path.join(root, "preview"), root, "flow", flowRun, { name: "test", kind: "agent" });
  const filled = path.join(root, flowRun.shots.find((s) => s.shot === "filled").file);
  const literalRun = await runFlow(root, { flow: "literal" });
  assert.deepEqual(literalRun.steps[0].target, { placeholder: "Email", value: HIDDEN });
  const shotOfFlow = await screenshot(root, { flow: "login" });
  said.push(JSON.stringify(flowRun), JSON.stringify(literalRun), JSON.stringify(shotOfFlow), JSON.stringify(describe(root)), JSON.stringify(readProblems(root)));
  assert.deepEqual(describe(root).flows.find((f) => f.name === "stuck").secrets, ["IMITOR_TEST_EMAIL", "IMITOR_TEST_PASSWORD"]);

  const mcp = createServer(root);
  t.after(() => mcp.close());
  let id = 10;
  const call = async (name, args = {}) => {
    const r = await mcp.handle({ jsonrpc: "2.0", id: id++, method: "tools/call", params: { name, arguments: args } });
    said.push(JSON.stringify({ ...r, result: { ...r.result, content: r.result.content.filter((c) => c.type === "text") } }));
    return r.result;
  };
  const stuck = JSON.parse((await call("imitor_run_flow", { flow: "stuck" })).content[0].text);
  assert.equal(stuck.passed, false);
  assert.equal(stuck.failedIn, "stuck");
  await call("imitor_screenshot", { flow: "login" });
  await call("imitor_read_problems");
  await call("imitor_describe");
  const inline = await call("imitor_screenshot", { steps: [{ fill: { placeholder: "Email", value: { env: "IMITOR_TEST_EMAIL" } } }] });
  assert.equal(inline.isError, true);
  assert.match(inline.content[0].text, /values from the environment can only be used in flows in imitor.config.json/);
  const video = await call("imitor_record_video", { flow: "stuck" });
  assert.equal(video.isError, true, "a flow that runs after one with secrets is not recorded either");
  await assert.rejects(recordVideo(root, { flow: "login" }), /fills values from the environment \(IMITOR_TEST_EMAIL, IMITOR_TEST_PASSWORD\), and Imitor does not record videos/);

  // The review interface's data, the exported site and the shots branch.
  const project = projectData(root);
  assert.deepEqual(project.flows.find((f) => f.name === "login").steps[0].step, { fill: { placeholder: "Email", value: { env: "IMITOR_TEST_EMAIL" } } }, "the interface gets the reference, never the value");
  for (const route of ["/api/project", "/api/runs", "/api/captures", "/api/problems", "/api/agents"]) said.push(JSON.stringify(apiGet(root, route)?.body ?? null));
  const site = path.join(path.dirname(root), "site");
  exportSite(root, { out: site });
  publishShots(root, { remote, pr: 1, sha: "a".repeat(40), force: true }, { GITHUB_REPOSITORY: "t/signin" });
  const branchFiles = git(remote, "ls-tree", "-r", "--name-only", "imitor-shots").split("\n").filter(Boolean);
  assert.ok(branchFiles.some((f) => f.endsWith("manifest.json")), branchFiles.join());

  // Look for the values everywhere. The literal is in imitor.config.json (and so in the app's own git history): that
  // file is the user's; it is the one place it may be.
  findCanaries(said.join("\n"), "a result or text Imitor returned");
  findCanaries(fs.readFileSync(ghEnv.GITHUB_STEP_SUMMARY, "utf8") + fs.readFileSync(ghEnv.GITHUB_OUTPUT, "utf8"), "the GitHub job summary or outputs");
  const scanned = scanDir(path.join(root, "preview"), new Set(["app"])) + scanDir(site);
  assert.ok(scanned > 10, `scanned ${scanned} files`);
  for (const f of branchFiles) findCanaries(git(remote, "show", `imitor-shots:${f}`), `imitor-shots:${f}`);
  findCanaries(git(remote, "log", "-p", "imitor-shots"), "the shots branch history");

  // Both fields were filled from secrets and are masked, the password field too ("show password" could reveal it).
  const { chromium } = require("playwright");
  const b = await chromium.launch();
  t.after(() => b.close());
  const page = await b.newPage();
  const n = await maskedPixels(page, filled);
  const field = 300 * 40 * 4; // a 300 x 40 field at device scale 2
  assert.ok(n > 2 * field * 0.9, `both fields are masked (${n} magenta pixels)`);
  assert.ok(n < 2 * field * 1.3, `only the two fields are masked (${n} magenta pixels)`);
});

test("a listed secret that is not set fails the step with the variable's name", browser, async (t) => {
  const { root } = signInApp();
  const saved = process.env.IMITOR_TEST_EMAIL;
  delete process.env.IMITOR_TEST_EMAIL;
  t.after(() => { if (saved !== undefined) process.env.IMITOR_TEST_EMAIL = saved; });
  const run = await runFlow(root, { flow: "login" });
  assert.equal(run.passed, false);
  assert.match(run.steps[0].error, /environment variable IMITOR_TEST_EMAIL is not set/);
});
