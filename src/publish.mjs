// `imitor publish-shots`: push a run's screenshots to a dedicated orphan branch of the same repository, so a
// pull-request comment can show them as images without any third-party host or secret. It works in a temporary
// repository of its own (never the checkout), keeps only the newest few commits' folders per pull request, and
// squashes the branch to a single commit on every push so its history does not grow.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "./config.mjs";

export const SHOTS_BRANCH = "imitor-shots";
const INDEX = "imitor-shots.json";
const README = `# Imitor shots

Screenshots from Imitor runs on pull requests, pushed by CI so the pull-request comment can show them.
Folders are \`pr-<number>/<short commit>/\`. Only the newest few commits per pull request are kept, and the
branch is rewritten as a single commit on every push. Do not base work on this branch.

They are web imitations of the app (react-native-web in headless Chromium), not the native build.
`;

const sleep = (ms) => ms > 0 && Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

class GitError extends Error {
  constructor(args, error) {
    const stderr = String(error.stderr || "").trim();
    super(`git ${args.filter((a) => !a.startsWith("http.")).join(" ")} failed: ${stderr || error.message}`);
    this.stderr = stderr;
  }
}

function git(cwd, args, { input, env, auth = [] } = {}) {
  try {
    return execFileSync("git", [...auth, ...args], { cwd, input, env, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 }).trim();
  } catch (error) {
    throw new GitError(args, error);
  }
}

function readEvent(env) {
  try {
    return env.GITHUB_EVENT_PATH ? JSON.parse(fs.readFileSync(env.GITHUB_EVENT_PATH, "utf8")) : {};
  } catch {
    return {};
  }
}

/** The run's files to publish: shots, failure screenshots and the manifest, as paths relative to the output folder. */
export function filesToPublish(outDir) {
  const manifestFile = path.join(outDir, "manifest.json");
  if (!fs.existsSync(manifestFile)) throw new Error(`no run found at ${manifestFile}. Run: imitor gate (or imitor)`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8"));
  const wanted = ["manifest.json", ...(manifest.shots || []).map((s) => s.file), ...(manifest.problems || []).map((p) => p.file)];
  const files = [];
  for (const rel of new Set(wanted.filter(Boolean).map(String))) {
    const abs = path.resolve(outDir, rel);
    if (path.relative(outDir, abs).startsWith("..") || path.isAbsolute(path.relative(outDir, abs))) continue; // stay inside the output folder
    if (fs.existsSync(abs) && fs.statSync(abs).isFile()) files.push(path.relative(outDir, abs).split(path.sep).join("/"));
  }
  return files;
}

/**
 * Publish the last run's screenshots. Returns { baseUrl, branch, folder, files, kept, removed, commit, attempts }.
 * opts: branch, keep (newest commits per pull request, default 3), pr, sha, repo ("owner/name"), remote (git URL or path;
 *       default the GitHub repository), force (run outside GitHub Actions), attempts (default 4), retryDelayMs,
 *       beforePush(attempt) (tests: simulate another job pushing first).
 */
export function publishShots(root, opts = {}, env = process.env) {
  if (env.GITHUB_ACTIONS !== "true" && !opts.force) throw new Error("publish-shots pushes screenshots to a branch of this repository and runs in GitHub Actions only. Pass --force to run it elsewhere.");
  const branch = opts.branch || SHOTS_BRANCH;
  const keep = opts.keep === undefined ? 3 : Number(opts.keep);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`--keep needs a whole number of 1 or more, got "${opts.keep}"`);
  try {
    git(root, ["check-ref-format", "--branch", branch]);
  } catch {
    throw new Error(`"${branch}" is not a valid branch name`);
  }
  let working = null;
  try {
    working = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  } catch {}
  const protectedRefs = [working, env.GITHUB_HEAD_REF, env.GITHUB_BASE_REF, env.GITHUB_REF_NAME].filter((r) => r && r !== "HEAD");
  if (protectedRefs.includes(branch)) throw new Error(`refusing to publish to "${branch}": it is a working branch of this job. Use a dedicated branch such as ${SHOTS_BRANCH}.`);

  const event = readEvent(env);
  const pr = Number(opts.pr ?? event.pull_request?.number ?? event.number);
  if (!Number.isInteger(pr) || pr < 1) throw new Error("no pull request number: run this on a pull_request event, or pass --pr <number>");
  let sha = opts.sha ?? event.pull_request?.head?.sha ?? null;
  if (!sha) {
    try {
      sha = git(root, ["rev-parse", "HEAD"]);
    } catch {
      sha = env.GITHUB_SHA || null;
    }
  }
  if (!/^[0-9a-f]{7,64}$/i.test(sha || "")) throw new Error(`no commit to file the shots under (got "${sha}"); pass --sha <commit>`);
  const short = sha.slice(0, 7).toLowerCase();
  const repo = opts.repo || env.GITHUB_REPOSITORY;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("no repository: set GITHUB_REPOSITORY or pass --repo owner/name");
  const server = (env.GITHUB_SERVER_URL || "https://github.com").replace(/\/$/, "");
  const remote = opts.remote || `${server}/${repo}.git`;
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  const auth = token && /^https?:/.test(remote) ? ["-c", `http.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`] : [];

  const outDir = path.resolve(root, loadConfig(root).out);
  const files = filesToPublish(outDir);
  const folder = `pr-${pr}/${short}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-shots-"));
  const gitEnv = {
    ...process.env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_INDEX_FILE: path.join(tmp, ".git", "imitor-index"),
    GIT_AUTHOR_NAME: "github-actions[bot]",
    GIT_AUTHOR_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "github-actions[bot]",
    GIT_COMMITTER_EMAIL: "41898282+github-actions[bot]@users.noreply.github.com",
  };
  const run = (args, more = {}) => git(tmp, args, { env: gitEnv, ...more });
  const attempts = opts.attempts ?? 4;
  try {
    run(["init", "--quiet"]);
    run(["remote", "add", "origin", remote]);
    // Store the files once; each attempt only rebuilds the tree around them.
    const blobs = run(["hash-object", "-w", "--stdin-paths"], { input: files.map((f) => path.join(outDir, f)).join("\n") + "\n" }).split("\n");
    for (let attempt = 1; ; attempt++) {
      const heads = run(["ls-remote", "--heads", "origin", `refs/heads/${branch}`], { auth });
      let base = null;
      if (heads) {
        run(["fetch", "--quiet", "--no-tags", "--depth=1", "origin", `+refs/heads/${branch}:refs/imitor/base`], { auth });
        base = run(["rev-parse", "refs/imitor/base"]);
        run(["read-tree", "refs/imitor/base"]);
      } else run(["read-tree", "--empty"]);

      let index = {};
      if (base) {
        // Every push rewrites the branch as one new commit. A branch without Imitor's index is someone's work, not ours:
        // replacing it would destroy its history, so stop before anything is pushed.
        let text = null;
        try {
          text = run(["show", `${base}:${INDEX}`]);
        } catch {}
        try {
          index = JSON.parse(text);
        } catch {}
        if (text === null || !index || typeof index !== "object" || Array.isArray(index)) {
          throw new Error(`refusing to publish to "${branch}": the branch already exists and has no readable ${INDEX}, so it was not made by Imitor, and publishing would replace its history with a single commit. Use a dedicated branch that does not exist yet (--branch, or the action's shots-branch input), such as ${branch === SHOTS_BRANCH ? `${SHOTS_BRANCH}-preview` : SHOTS_BRANCH}.`);
        }
      }
      const key = `pr-${pr}`;
      const entries = (index[key] || []).filter((e) => e && e.sha !== short);
      entries.push({ sha: short, commit: sha, at: new Date().toISOString() });
      const removed = entries.slice(0, Math.max(0, entries.length - keep)).map((e) => `${key}/${e.sha}`);
      index[key] = entries.slice(-keep);
      for (const dir of [...removed, folder]) run(["rm", "-r", "-q", "--cached", "--ignore-unmatch", "--", dir]);

      const meta = [
        [INDEX, run(["hash-object", "-w", "--stdin"], { input: JSON.stringify(index, null, 2) + "\n" })],
        ["README.md", run(["hash-object", "-w", "--stdin"], { input: README })],
      ];
      const lines = [...meta, ...files.map((f, i) => [`${folder}/${f}`, blobs[i]])].map(([p, oid]) => `100644 ${oid}\t${p}`);
      run(["update-index", "--add", "--index-info"], { input: lines.join("\n") + "\n" });
      const tree = run(["write-tree"]);
      const kept = Object.values(index).reduce((n, list) => n + list.length, 0);
      const commit = run(["commit-tree", tree, "-m", `Imitor shots for ${folder}\n\nSquashed: holds ${kept} commit folder${kept === 1 ? "" : "s"}. Rewritten on every push.`]);

      if (opts.beforePush) opts.beforePush(attempt);
      try {
        // Not a fast-forward (the branch is squashed each time), so force, but only over the commit we started from.
        run(["push", "--quiet", "--no-verify", `--force-with-lease=refs/heads/${branch}:${base || ""}`, "origin", `${commit}:refs/heads/${branch}`], { auth });
      } catch (error) {
        const msg = error.stderr || error.message;
        if (/\b403\b|denied|Permission to|not allowed|write access/i.test(msg)) throw new Error(`cannot push to ${branch}: the token has no write access. The workflow needs "permissions: contents: write". (${msg.split("\n").pop()})`);
        if (attempt < attempts && /stale info|rejected|fetch first|non-fast-forward|failed to (update|lock) ref|cannot lock|remote ref|unable to update/i.test(msg)) {
          sleep(opts.retryDelayMs ?? 500 + Math.floor(Math.random() * 1500) * attempt);
          continue;
        }
        throw error;
      }
      const encodedBranch = branch.split("/").map(encodeURIComponent).join("/");
      return { baseUrl: `${server}/${repo}/blob/${encodedBranch}/${folder}/?raw=true`, branch, folder, files, kept: index[key].map((e) => `${key}/${e.sha}`), removed, commit, attempts: attempt };
    }
  } catch (error) {
    if (token) error.message = error.message.split(token).join("***");
    throw error;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
