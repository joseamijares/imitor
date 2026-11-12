// publish-shots against local bare repositories standing in for GitHub. No network.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { publishShots } from "../src/publish.mjs";

const ids = { GIT_AUTHOR_NAME: "Fern Tester", GIT_AUTHOR_EMAIL: "fern@example.invalid", GIT_COMMITTER_NAME: "Fern Tester", GIT_COMMITTER_EMAIL: "fern@example.invalid" };
const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, ...ids }, stdio: ["ignore", "pipe", "pipe"] }).trim();
const env = { GITHUB_ACTIONS: "true", GITHUB_REPOSITORY: "fern/fernwood" };

function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-publish-"));
  const remote = path.join(dir, "origin.git");
  git(dir, "init", "--quiet", "--bare", "-b", "main", remote);
  const ws = path.join(dir, "workspace");
  git(dir, "clone", "--quiet", remote, ws);
  fs.writeFileSync(path.join(ws, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(ws, "imitor.config.json"), JSON.stringify({ out: "preview" }));
  fs.writeFileSync(path.join(ws, ".gitignore"), "preview/\n");
  git(ws, "add", ".");
  git(ws, "commit", "--quiet", "-m", "fernwood app");
  git(ws, "push", "--quiet", "origin", "HEAD:main");
  return { dir, remote, ws };
}

/** A run in the workspace's output folder: two shots and a failure screenshot. */
function writeRun(ws, tag) {
  const out = path.join(ws, "preview");
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "screens"), { recursive: true });
  const shots = ["water-today", "water-logged"].map((n) => ({ file: `screens/${n}-iphone-16-light.png`, flow: "water", shot: n, device: "iphone-16", scheme: "light", stubs: [] }));
  for (const s of shots) fs.writeFileSync(path.join(out, s.file), `png ${s.shot} ${tag}`);
  fs.writeFileSync(path.join(out, "screens", "repot-FAILED-iphone-16-light.png"), `png failed ${tag}`);
  fs.writeFileSync(path.join(out, "screens", "stray.png"), "not in the manifest");
  const problems = [{ kind: "flow-failed", flow: "repot", file: "screens/repot-FAILED-iphone-16-light.png" }, { kind: "flow-failed", flow: "x", file: "../../etc/passwd" }];
  fs.writeFileSync(path.join(out, "manifest.json"), JSON.stringify({ commit: tag, shots, problems }));
}

const tree = (remote, branch = "imitor-shots") => git(remote, "ls-tree", "-r", "--name-only", branch).split("\n").filter(Boolean).sort();
const sha = (n) => n.repeat(40).slice(0, 40);

test("publishes to an orphan branch, prunes old commits, squashes history, leaves the working branch alone", () => {
  const { remote, ws } = setup();
  const mainBefore = git(remote, "rev-parse", "main");
  const headBefore = git(ws, "rev-parse", "HEAD");

  writeRun(ws, "one");
  const first = publishShots(ws, { remote, pr: 7, sha: sha("a") }, env);
  assert.equal(first.baseUrl, "https://github.com/fern/fernwood/blob/imitor-shots/pr-7/aaaaaaa/?raw=true");
  assert.deepEqual(first.files.sort(), ["manifest.json", "screens/repot-FAILED-iphone-16-light.png", "screens/water-logged-iphone-16-light.png", "screens/water-today-iphone-16-light.png"]);
  assert.deepEqual(tree(remote), ["README.md", "imitor-shots.json", "pr-7/aaaaaaa/manifest.json", "pr-7/aaaaaaa/screens/repot-FAILED-iphone-16-light.png", "pr-7/aaaaaaa/screens/water-logged-iphone-16-light.png", "pr-7/aaaaaaa/screens/water-today-iphone-16-light.png"]);
  assert.equal(git(remote, "show", "imitor-shots:pr-7/aaaaaaa/screens/water-today-iphone-16-light.png"), "png water-today one");

  writeRun(ws, "two");
  publishShots(ws, { remote, pr: 7, sha: sha("b") }, env);
  writeRun(ws, "other");
  publishShots(ws, { remote, pr: 12, sha: sha("c") }, env);
  const folders = () => [...new Set(tree(remote).filter((f) => f.startsWith("pr-")).map((f) => f.split("/").slice(0, 2).join("/")))];
  assert.deepEqual(folders(), ["pr-12/ccccccc", "pr-7/aaaaaaa", "pr-7/bbbbbbb"]);

  // keep 2: a third commit on pr-7 drops the oldest pr-7 folder only
  writeRun(ws, "three");
  const third = publishShots(ws, { remote, pr: 7, sha: sha("d"), keep: 2 }, env);
  assert.deepEqual(third.removed, ["pr-7/aaaaaaa"]);
  assert.deepEqual(folders(), ["pr-12/ccccccc", "pr-7/bbbbbbb", "pr-7/ddddddd"]);
  // republishing the same commit replaces its folder
  writeRun(ws, "three-again");
  publishShots(ws, { remote, pr: 7, sha: sha("d"), keep: 2 }, env);
  assert.deepEqual(folders(), ["pr-12/ccccccc", "pr-7/bbbbbbb", "pr-7/ddddddd"]);
  assert.equal(git(remote, "show", "imitor-shots:pr-7/ddddddd/screens/water-today-iphone-16-light.png"), "png water-today three-again");

  // one commit, no parents, no history kept
  assert.equal(git(remote, "rev-list", "--count", "imitor-shots"), "1");
  assert.equal(git(remote, "rev-list", "--parents", "-n", "1", "imitor-shots").split(" ").length, 1);
  // the working branch, the checkout and its status are untouched
  assert.equal(git(remote, "rev-parse", "main"), mainBefore);
  assert.equal(git(ws, "rev-parse", "HEAD"), headBefore);
  assert.equal(git(ws, "rev-parse", "--abbrev-ref", "HEAD"), "main");
  assert.equal(git(ws, "status", "--porcelain"), "");
  assert.deepEqual(git(remote, "for-each-ref", "--format=%(refname)").split("\n").sort(), ["refs/heads/imitor-shots", "refs/heads/main"]);
});

test("a push rejected because another job pushed first is retried on top of that job's folders", () => {
  const { dir, remote, ws } = setup();
  writeRun(ws, "base");
  publishShots(ws, { remote, pr: 3, sha: sha("1") }, env);

  // Another job's workspace, publishing for a different pull request in between our fetch and our push.
  const other = path.join(dir, "other");
  git(dir, "clone", "--quiet", remote, other);
  writeRun(other, "theirs");
  let raced = 0;
  writeRun(ws, "ours");
  const result = publishShots(ws, {
    remote, pr: 4, sha: sha("2"), retryDelayMs: 0,
    beforePush: (attempt) => {
      if (attempt === 1) {
        raced++;
        publishShots(other, { remote, pr: 5, sha: sha("3") }, env);
      }
    },
  }, env);
  assert.equal(raced, 1);
  assert.equal(result.attempts, 2);
  const folders = [...new Set(tree(remote).filter((f) => f.startsWith("pr-")).map((f) => f.split("/").slice(0, 2).join("/")))];
  assert.deepEqual(folders, ["pr-3/1111111", "pr-4/2222222", "pr-5/3333333"]);
  assert.equal(git(remote, "rev-list", "--count", "imitor-shots"), "1");

  // and gives up after the configured number of attempts
  assert.throws(() => publishShots(ws, { remote, pr: 4, sha: sha("2"), attempts: 2, retryDelayMs: 0, beforePush: () => publishShots(other, { remote, pr: 5, sha: sha("3") }, env) }, env), /git push .* failed/);
});

test("refuses outside GitHub Actions, on the working branch, and without a pull request", () => {
  const { remote, ws } = setup();
  writeRun(ws, "x");
  assert.throws(() => publishShots(ws, { remote, pr: 1, sha: sha("a") }, {}), /runs in GitHub Actions only\. Pass --force/);
  assert.equal(publishShots(ws, { remote, pr: 1, sha: sha("a"), force: true, repo: "fern/fernwood" }, {}).folder, "pr-1/aaaaaaa");
  assert.throws(() => publishShots(ws, { remote, pr: 1, sha: sha("a"), branch: "main" }, env), /refusing to publish to "main"/);
  assert.throws(() => publishShots(ws, { remote, pr: 1, sha: sha("a"), branch: "feature/x" }, { ...env, GITHUB_HEAD_REF: "feature/x" }), /refusing/);
  assert.throws(() => publishShots(ws, { remote, sha: sha("a") }, env), /no pull request number/);
  assert.throws(() => publishShots(ws, { remote, pr: 1, sha: sha("a"), branch: "bad..name" }, env), /not a valid branch name/);
  assert.equal(git(remote, "rev-list", "--count", "main"), "1");
});

test("reads the pull request and head commit from the GitHub event; the CLI prints the image base", () => {
  const { dir, remote, ws } = setup();
  writeRun(ws, "event");
  const eventPath = path.join(dir, "event.json");
  fs.writeFileSync(eventPath, JSON.stringify({ number: 42, pull_request: { number: 42, head: { sha: sha("e") } } }));
  const output = path.join(dir, "output.txt");
  const cli = path.join(path.dirname(new URL(import.meta.url).pathname), "..", "bin", "imitor.mjs");
  const r = spawnSync("node", [cli, "publish-shots", "--remote", remote, "--branch", "shots/imitor"], {
    cwd: ws, encoding: "utf8", env: { ...process.env, ...env, GITHUB_EVENT_PATH: eventPath, GITHUB_OUTPUT: output, GITHUB_SERVER_URL: "https://ghe.example.invalid" },
  });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), "https://ghe.example.invalid/fern/fernwood/blob/shots/imitor/pr-42/eeeeeee/?raw=true");
  assert.match(r.stderr, /Published 4 files to shots\/imitor:pr-42\/eeeeeee/);
  assert.match(fs.readFileSync(output, "utf8"), /^image-base=https:\/\/ghe.example.invalid\/.*\?raw=true$/m);
  assert.ok(tree(remote, "shots/imitor").includes("pr-42/eeeeeee/manifest.json"));
});
