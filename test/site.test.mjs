// The public site (site/) must say only what the README and the code say: every command it shows exists, every MCP
// tool it names is real, and the documentation pages carry the README sections they are built from.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { TOOLS } from "../src/mcp.mjs";
import { CONNECT_COMMANDS } from "../src/store.mjs";
import { buildSite, markdown, PAGES, readmeSections } from "../site/build.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const out = buildSite({ out: fs.mkdtempSync(path.join(os.tmpdir(), "imitor-site-")) });
const landing = fs.readFileSync(path.join(out, "index.html"), "utf8");

test("the site builds every page and every file it links to", () => {
  for (const f of ["index.html", "404.html", "how-to-use/index.html", "agents/index.html", "tokens.css", "site.css", "site.js"]) assert.ok(fs.existsSync(path.join(out, f)), f);
  for (const page of ["index.html", "how-to-use/index.html", "agents/index.html", "404.html"]) {
    const html = fs.readFileSync(path.join(out, page), "utf8");
    assert.doesNotMatch(html, /\{\{\w+\}\}/, `${page} has an unfilled placeholder`);
    for (const [, ref] of html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)) {
      const file = ref.endsWith("/") ? path.join(out, ref, "index.html") : path.join(out, ref);
      assert.ok(fs.existsSync(file), `${page} links to missing ${ref}`);
    }
  }
});

test("every command on the landing page is in the README or the interface's connect commands", () => {
  const known = [README, ...Object.values(CONNECT_COMMANDS)].join("\n");
  const commands = [...landing.matchAll(/<code>([^<]+)<\/code>/g)].map(([, c]) => decode(c).trim()).filter((c) => /^(npx|npm|claude|codex) /.test(c));
  assert.ok(commands.length >= 4, "expected the install and connect commands");
  for (const c of commands) assert.ok(known.includes(c), `not documented: ${c}`);
});

test("the MCP tools named on the site are exactly the server's tools", () => {
  const real = TOOLS.map((t) => t.name).sort();
  const named = [...new Set([...landing.matchAll(/\bimitor_[a-z_]+/g)].map(([n]) => n))].sort();
  assert.deepEqual(named, real);
  const agents = fs.readFileSync(path.join(out, "agents/index.html"), "utf8");
  for (const name of real) assert.ok(agents.includes(name), `For agents page is missing ${name}`);
});

test("the documentation pages carry their README sections", () => {
  const sections = readmeSections(README);
  for (const [key, page] of Object.entries(PAGES)) {
    const html = fs.readFileSync(path.join(out, key, "index.html"), "utf8");
    for (const name of page.sections) {
      assert.ok(name in sections, `README lost "## ${name}"`);
      for (const [, raw] of sections[name].matchAll(/`([^`\n]+)`/g)) { const code = raw.replace(/\\\|/g, "|"); assert.ok(decode(html).includes(code), `${key}: missing \`${code}\``); }
    }
  }
});

test("the markdown renderer handles the README's lists with nested code", () => {
  const html = markdown("1. Install:\n\n   ```bash\n   npm i x\n   ```\n\n2. Run `it`.\n");
  assert.match(html, /<ol><li><p>Install:<\/p>\n<div class="code"><pre><code data-lang="bash">npm i x<\/code><\/pre>/);
  assert.match(html, /<li>Run <code>it<\/code>\.<\/li><\/ol>/);
  assert.match(markdown("| a | b |\n| --- | --- |\n| `x \\| y` | z |"), /<td><code>x \| y<\/code><\/td>/);
});

test("demo material on the landing page is labelled as demo data", () => {
  assert.match(landing, /fernwood, an invented app/);
  assert.match(landing, /Demo data: fernwood is an invented app/);
  assert.doesNotMatch(landing, /(Imitor|it) is a simulator|replaces? (the )?(final )?check on a real phone/i);
});

test("the site builds with an empty environment and never reads it (its Vercel project also holds the cloud's secrets)", () => {
  const run = spawnSync(process.execPath, [path.join(ROOT, "site", "build.mjs")], { cwd: ROOT, env: {}, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  const built = (dir, f) => (dir === "site" && f.startsWith("dist")) || (dir === "demo" && f.startsWith("site"));
  for (const dir of ["site", "demo"]) {
    const files = fs.readdirSync(path.join(ROOT, dir), { recursive: true }).filter((f) => /\.(mjs|cjs|js|html)$/.test(f) && !built(dir, f));
    assert.ok(files.length, dir);
    for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, dir, f), "utf8"), /process\.env/, `${dir}/${f}`);
  }
});
