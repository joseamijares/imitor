// The GitHub Action's publish and comment steps: they must only ever show the run this job made.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const here = path.dirname(new URL(import.meta.url).pathname);
const action = fs.readFileSync(path.join(here, "..", "action.yml"), "utf8");
const cli = path.join(here, "..", "bin", "imitor.mjs");

/** One step of action.yml by name: its `if:` and its `run: |` script (indentation removed). */
function step(name) {
  const lines = action.split("\n");
  const start = lines.findIndex((l) => l === `    - name: ${name}`);
  assert.notEqual(start, -1, `no step "${name}" in action.yml`);
  let end = lines.findIndex((l, i) => i > start && /^ {4}- /.test(l));
  if (end === -1) end = lines.length;
  const body = lines.slice(start, end);
  const cond = (body.find((l) => /^ {6}if: /.test(l)) || "").replace(/^ {6}if: /, "");
  const runAt = body.findIndex((l) => l === "      run: |");
  const run = runAt === -1 ? "" : body.slice(runAt + 1).filter((l) => l === "" || l.startsWith("        ")).map((l) => l.slice(8)).join("\n");
  return { cond, run };
}

test("action: publishing and uploading need this run's report; commenting needs only that the gate ran", () => {
  assert.match(step("Publish the shots for the comment").cond, /steps\.gate\.outputs\.report != ''/);
  assert.match(step("Upload the report").cond, /steps\.gate\.outputs\.report != ''/);
  const comment = step("Comment on the pull request").cond;
  assert.match(comment, /steps\.gate\.outcome != 'skipped'/);
  assert.doesNotMatch(comment, /outputs\.report/); // a blocked gate and a failed build both comment
});

/** Run the comment step's script with stand-in `npx` and `gh` commands that record what they were asked. */
function runCommentStep(env) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-action-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const log = path.join(dir, "calls.log");
  fs.writeFileSync(path.join(bin, "npx"), `#!/bin/bash\necho "npx $*" >> "${log}"\nprintf '<!-- imitor-comment -->\\n### current run\\n'\n`, { mode: 0o755 });
  // gh: listing comments finds none; posting copies the body file next to the log.
  fs.writeFileSync(path.join(bin, "gh"), `#!/bin/bash\necho "gh $*" >> "${log}"\nfor a in "$@"; do case "$a" in body=@*) cp "\${a#body=@}" "${dir}/posted.md";; esac; done\n`, { mode: 0o755 });
  const result = spawnSync("bash", ["-e", "-o", "pipefail", "-c", step("Comment on the pull request").run], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: `${bin}:${process.env.PATH}`, GITHUB_REPOSITORY: "fernwood/app", IMITOR_FAIL_ON: "flows", IMITOR_MAX_SHOTS: "12", IMITOR_IMAGE_BASE: "", IMITOR_PR: "7", IMITOR_SHA: "abcdef1234567890", IMITOR_RUN_URL: "https://github.com/fernwood/app/actions/runs/1", ...env },
  });
  const read = (f) => (fs.existsSync(path.join(dir, f)) ? fs.readFileSync(path.join(dir, f), "utf8") : "");
  return { status: result.status, stdout: result.stdout, calls: read("calls.log"), posted: read("posted.md") };
}

test("action: with no report from this run, the comment says so and never runs imitor comment on an old manifest", { skip: process.platform === "win32" }, () => {
  const r = runCommentStep({ IMITOR_REPORT: "" });
  assert.equal(r.status, 0, r.stdout);
  assert.doesNotMatch(r.calls, /^npx/m);
  assert.match(r.calls, /^gh api --silent -X POST repos\/fernwood\/app\/issues\/7\/comments/m);
  assert.ok(r.posted.startsWith("<!-- imitor-comment -->\n"), r.posted);
  assert.match(r.posted, /Imitor gate: no report/);
  assert.match(r.posted, /commit `abcdef1`/);
  assert.match(r.posted, /\(https:\/\/github\.com\/fernwood\/app\/actions\/runs\/1\)/);
});

test("action: with this run's report, the comment is imitor comment's", { skip: process.platform === "win32" }, () => {
  const r = runCommentStep({ IMITOR_REPORT: "preview/index.html" });
  assert.equal(r.status, 0, r.stdout);
  assert.match(r.calls, /^npx imitor comment --fail-on flows --max-shots 12 --report-url /m);
  assert.match(r.posted, /### current run/);
});

test("imitor gate that stops before its report sets no report output, even with an old manifest in the output folder", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-action-gate-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ flows: [{ name: "home", start: "/", steps: [{ shot: "home" }] }] }));
  fs.mkdirSync(path.join(root, "preview"));
  fs.writeFileSync(path.join(root, "preview", "manifest.json"), JSON.stringify({ shots: [{ flow: "home", shot: "home", file: "screens/old.png", stubs: [] }], problems: [] }));
  const output = path.join(root, "github-output.txt");
  fs.writeFileSync(output, "");
  // --no-build with no build: the gate stops before it runs anything, as it does when the build fails.
  const r = spawnSync("node", [cli, "gate", "--no-build"], { cwd: root, encoding: "utf8", env: { ...process.env, GITHUB_ACTIONS: "true", GITHUB_OUTPUT: output } });
  assert.notEqual(r.status, 0);
  assert.doesNotMatch(fs.readFileSync(output, "utf8"), /^report=/m);
});
