// What the Vercel functions load: the cloud and the few pure modules of src/ it shares with the CLI, never the CLI
// itself (builds, Playwright, child processes, the local store). The import graph is walked from the root api/ shims
// without running anything, and every module of src/ it reaches must be in vercel.json's includeFiles.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SOURCES } from "../src/assets.mjs";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ENTRIES = ["api/cloud.mjs", "api/cron-retention.mjs"];
const FORBIDDEN_SPECIFIERS = ["child_process", "node:child_process", "playwright", "playwright-core"];
const FORBIDDEN_FILES = ["src/build.mjs", "src/shoot.mjs", "src/init.mjs", "src/appserver.mjs", "src/store.mjs", "src/export.mjs", "src/mcp.mjs", "src/agent.mjs", "src/serve.mjs"];

/** The specifiers a module imports: static imports and re-exports, side-effect imports, and import("...") with a literal. */
export function importsOf(source) {
  const found = [];
  for (const re of [
    /^\s*(?:import|export)\s+[\w*{}\s,$]+?\s+from\s*["']([^"']+)["']/gm,
    /^\s*import\s*["']([^"']+)["']/gm,
    /\bimport\(\s*["']([^"']+)["']\s*\)/g,
  ]) for (const [, spec] of source.matchAll(re)) found.push(spec);
  return found;
}

/** Every module reachable from `entries` (paths relative to ROOT): { files: Set(rel path), bare: Set(specifier), edges }. */
function walk(entries) {
  const files = new Set();
  const bare = new Set();
  const via = new Map();
  const queue = [...entries];
  while (queue.length) {
    const rel = queue.shift();
    if (files.has(rel)) continue;
    files.add(rel);
    for (const spec of importsOf(fs.readFileSync(path.join(ROOT, rel), "utf8"))) {
      if (!spec.startsWith(".")) {
        bare.add(spec);
        if (!via.has(spec)) via.set(spec, rel);
        continue;
      }
      const next = path.relative(ROOT, path.resolve(ROOT, path.dirname(rel), spec)).split(path.sep).join("/");
      if (!via.has(next)) via.set(next, rel);
      queue.push(next);
    }
  }
  return { files, bare, via };
}

/** vercel.json's includeFiles ("{a,b/**}") as a test for a path relative to the repository root. */
function includeMatcher(glob) {
  const parts = /^\{(.*)\}$/.test(glob) ? glob.slice(1, -1).split(",") : [glob];
  const res = parts.map((p) => new RegExp(`^${p.split("**").map((s) => s.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join("[^/]*")).join(".*")}$`));
  return (rel) => res.some((re) => re.test(rel));
}

test("importsOf finds static, re-exported, side-effect and dynamic imports", () => {
  const src = 'import a from "./a.mjs";\nimport {\n  b,\n  c as d,\n} from "./b.mjs";\nexport { e } from "./e.mjs";\nimport "./side.mjs";\nconst pg = await import("pg");\nexport const x = 1;\n';
  assert.deepEqual(importsOf(src).sort(), ["./a.mjs", "./b.mjs", "./e.mjs", "./side.mjs", "pg"]);
});

test("the functions never load the CLI: no child_process, Playwright, build, shoot, init, appserver or store", () => {
  const { files, bare, via } = walk(ENTRIES);
  const trail = (x) => {
    const steps = [x];
    while (via.has(steps[0]) && !ENTRIES.includes(steps[0])) steps.unshift(via.get(steps[0]));
    return steps.join(" -> ");
  };
  assert.ok(files.has("cloud/src/vercel.mjs") && files.has("cloud/src/web.mjs") && files.has("src/derive.mjs"), "the walk follows the shims into the cloud");
  for (const spec of FORBIDDEN_SPECIFIERS) assert.ok(!bare.has(spec), `${trail(spec)}`);
  for (const f of FORBIDDEN_FILES) assert.ok(!files.has(f), `${trail(f)}`);
  // pg, and @vercel/blob for a deployment that keeps its files in Vercel Blob (storage/blob.mjs loads it on first use).
  for (const spec of bare) assert.ok(spec.startsWith("node:") || spec === "pg" || spec === "@vercel/blob", `an unexpected package: ${trail(spec)}`);
});

test("every module of src/ the functions reach, and every file they read, is in includeFiles", () => {
  const v = JSON.parse(fs.readFileSync(path.join(ROOT, "vercel.json"), "utf8"));
  const glob = v.functions["api/*.mjs"].includeFiles;
  const included = includeMatcher(glob);
  assert.ok(!included("src/build.mjs") && !included("src/store.mjs") && !included("src/mcp.mjs"), "includeFiles names modules, not all of src/");
  const { files } = walk(ENTRIES);
  const shared = [...files].filter((f) => f.startsWith("src/")).sort();
  assert.deepEqual(shared, ["src/app-index.mjs", "src/config.mjs", "src/derive.mjs", "src/redact.mjs", "src/secrets.mjs", "src/state.mjs", "src/tools.mjs", "src/upload.mjs"]);
  for (const f of files) if (!f.startsWith("api/")) assert.ok(included(f), `${f} is loaded by the functions but not in includeFiles`);
  // Read from disk at run time (assets.mjs): the interface and the design tokens.
  for (const f of fs.readdirSync(SOURCES.app, { recursive: true })) {
    const rel = path.relative(ROOT, path.join(SOURCES.app, f)).split(path.sep).join("/");
    if (fs.statSync(path.join(ROOT, rel)).isFile()) assert.ok(included(rel), rel);
  }
  assert.ok(included(path.relative(ROOT, SOURCES.tokens).split(path.sep).join("/")));
});
