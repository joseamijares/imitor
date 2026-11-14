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
import { buildSite, markdown, PAGES, readmeSections, SHARE_IMAGE, SITE, SITEMAP } from "../site/build.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const README = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
const decode = (s) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");

const out = buildSite({ out: fs.mkdtempSync(path.join(os.tmpdir(), "imitor-site-")) });
const landing = fs.readFileSync(path.join(out, "index.html"), "utf8");

test("the site builds every page and every file it links to", () => {
  for (const f of ["index.html", "404.html", "pricing/index.html", "how-to-use/index.html", "agents/index.html", "tokens.css", "site.css", "site.js"]) assert.ok(fs.existsSync(path.join(out, f)), f);
  for (const page of ["index.html", "pricing/index.html", "how-to-use/index.html", "agents/index.html", "404.html"]) {
    // The waitlist function is not a file of the site: Vercel serves it from api/waitlist.mjs.
    const served = (ref) => ref === "/api/waitlist/" && fs.existsSync(path.join(ROOT, "api", "waitlist.mjs"));
    const html = fs.readFileSync(path.join(out, page), "utf8");
    assert.doesNotMatch(html, /\{\{\w+\}\}/, `${page} has an unfilled placeholder`);
    for (const [, ref] of html.matchAll(/(?:src|href)="(\/[^"#]*)"/g)) {
      const file = ref.endsWith("/") ? path.join(out, ref, "index.html") : path.join(out, ref);
      assert.ok(served(ref) || fs.existsSync(file), `${page} links to missing ${ref}`);
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

test("every link in the documentation pages goes somewhere: sections on the site, repository paths on GitHub", () => {
  const ids = {};
  for (const key of Object.keys(PAGES)) ids[key] = new Set([...fs.readFileSync(path.join(out, key, "index.html"), "utf8").matchAll(/id="([^"]+)"/g)].map(([, id]) => id));
  for (const key of Object.keys(PAGES)) {
    const html = fs.readFileSync(path.join(out, key, "index.html"), "utf8");
    for (const [, href] of html.matchAll(/href="([^"]+)"/g)) {
      const local = href.match(/^(?:\/([a-z-]+)\/)?#(.+)$/);
      if (local) assert.ok(ids[local[1] || key]?.has(local[2]), `${key}: ${href} has no section`);
      else assert.match(href, /^(\/|https?:|mailto:)/, `${key}: relative link ${href}`);
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

test("the privacy and terms pages are built, linked from every page, and match what the code keeps", async () => {
  const { KEEP_RUNS } = await import("../src/store.mjs");
  for (const key of ["privacy", "terms"]) {
    const html = fs.readFileSync(path.join(out, key, "index.html"), "utf8");
    assert.doesNotMatch(html, /\{\{\w+\}\}/, `${key} has an unfilled placeholder`);
    assert.match(html, /mailto:/, `${key} gives a contact address`);
    assert.doesNotMatch(html, /class="source"/, `${key} does not claim to come from the README`);
  }
  for (const page of ["index.html", "pricing/index.html", "how-to-use/index.html", "agents/index.html", "404.html", "privacy/index.html"]) {
    const html = fs.readFileSync(path.join(out, page), "utf8");
    assert.match(html, /href="\/privacy\/"/, `${page} links to the privacy page`);
    assert.match(html, /href="\/terms\/"/, `${page} links to the terms`);
  }
  const privacy = decode(fs.readFileSync(path.join(out, "privacy", "index.html"), "utf8"));
  assert.match(privacy, new RegExp(`newest ${KEEP_RUNS} per project`), "the retention stated matches KEEP_RUNS");
  assert.match(privacy, /openid.*email.*profile/s, "the Google scopes stated match the sign-in");
  assert.match(privacy, /Resend sends the service's email/, "the mail provider the cloud uses is named");
});

test("the pricing page offers a waitlist, not a price: the form posts to the function, and the privacy page covers it", async () => {
  const { JOINED, NOT_JOINED } = await import("../cloud/src/waitlist.mjs");
  const html = fs.readFileSync(path.join(out, "pricing", "index.html"), "utf8");
  const form = html.match(/<form action="([^"]+)" method="post">([\s\S]*?)<\/form>/);
  assert.ok(form, "a form that works without script");
  assert.equal(form[1], "/api/waitlist/", "with trailingSlash the function answers at /api/waitlist/; the bare path is a 308");
  assert.match(form[2], /<input[^>]+name="email"[^>]+type="email"[^>]+required/);
  assert.match(form[2], /<input[^>]+name="website"/, "the field the function treats as a trap");
  // Where the function sends a plain form post back to: both targets are on the page.
  for (const target of [JOINED, NOT_JOINED]) {
    const [page, id] = target.split("#");
    assert.equal(page, "/pricing/");
    assert.match(html, new RegExp(`id="${id}"`), target);
  }
  // What it offers, and nothing it cannot keep: no price figure but the free plan's, and the unbuilt part says so.
  for (const offer of ["Hosting", "Agent use", "Emails"]) assert.match(html, new RegExp(`<h3>${offer}</h3>`));
  assert.match(html, /<h3>Emails<\/h3>[\s\S]*?<span class="pill warn">Planned<\/span>/, "emails are not built yet, and the page says so");
  assert.deepEqual([...html.matchAll(/[$€£]\s?\d+/g)].map(([m]) => m), ["$0"]);
  assert.doesNotMatch(html, /free trial|log in|sign up/i);
  assert.match(html, /href="\/privacy\/#the-waitlist"/);
  const privacy = fs.readFileSync(path.join(out, "privacy", "index.html"), "utf8");
  assert.match(privacy, /id="the-waitlist"/);
  // Every page's navigation and the landing page lead to it.
  for (const page of ["index.html", "how-to-use/index.html", "agents/index.html", "404.html"]) assert.match(fs.readFileSync(path.join(out, page), "utf8"), /href="\/pricing\/"/, page);
  assert.match(landing, /href="\/pricing\/#waitlist"/);
});

test("every page says what a shared link shows, and the sitemap lists every page", () => {
  // The share image is a real PNG of the size the tags declare (width and height are bytes 16 to 24 of a PNG).
  const png = fs.readFileSync(path.join(out, SHARE_IMAGE.path));
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [SHARE_IMAGE.width, SHARE_IMAGE.height]);
  assert.ok(png.length < 300 * 1024, "small enough for every crawler");
  for (const pathname of SITEMAP.filter((p) => p !== "/demo/")) {
    const html = fs.readFileSync(path.join(out, pathname, "index.html"), "utf8");
    const head = html.slice(0, html.indexOf("</head>"));
    const url = SITE + pathname;
    assert.ok(head.includes(`<link rel="canonical" href="${url}">`), pathname);
    assert.ok(head.includes(`<meta property="og:url" content="${url}">`), pathname);
    assert.ok(head.includes(`<meta property="og:image" content="${SITE}${SHARE_IMAGE.path}">`), `${pathname}: an absolute image address`);
    assert.ok(head.includes('<meta name="twitter:card" content="summary_large_image">'), pathname);
    for (const own of ["og:title", "og:description"]) assert.equal(head.split(`property="${own}"`).length, 2, `${pathname} has one ${own}`);
  }
  assert.doesNotMatch(fs.readFileSync(path.join(out, "404.html"), "utf8"), /rel="canonical"/, "the 404 page has no address of its own");
  // The sitemap: every page that is built, by its absolute address, and robots.txt points at it.
  const xml = fs.readFileSync(path.join(out, "sitemap.xml"), "utf8");
  const listed = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map(([, loc]) => loc);
  assert.deepEqual(listed, SITEMAP.map((p) => SITE + p));
  for (const p of SITEMAP) assert.ok(fs.existsSync(path.join(out, p, "index.html")), `${p} is in the sitemap and is built`);
  for (const key of [...Object.keys(PAGES), "pricing", "privacy", "terms"]) assert.ok(SITEMAP.includes(`/${key}/`), `/${key}/ is built and is in the sitemap`);
  assert.match(fs.readFileSync(path.join(out, "robots.txt"), "utf8"), new RegExp(`^Sitemap: ${SITE}/sitemap\\.xml$`, "m"));
});
