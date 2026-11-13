// Builds the public site (landing page, pricing, How to use, For agents) into site/dist/:
//   node site/build.mjs        (or: npm run site)
// The landing page is hand-written HTML. The two documentation pages are generated from README.md at build time, and
// the agent connect commands come from src/store.mjs, so the site and the README cannot drift. Node only, no
// dependencies, so it runs on a static host's build machine. Shots are copied from demo/assets (the invented app), and
// the demo of the review interface is exported into /demo/ of the same site.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECT_COMMANDS } from "../src/store.mjs";
import { buildDemo } from "../demo/build.mjs";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = path.join(HERE, "..");

const SHOTS = ["welcome", "your-space", "add-plant", "plant-details", "schedule", "reminders", "all-set", "today-standin", "today"]
  .flatMap((s) => [`${s}-dark`, `${s}-light`]);

// The README sections each documentation page is made of, in order.
export const PAGES = {
  "how-to-use": { title: "How to use", description: "Set up Imitor in a React Native / Expo app: install, wrap Metro, describe flows, start them from a state or a test account, choose stand-ins, review and publish a run, and gate native builds.",
    sections: ["What you get", "Set up", "Flow steps", "Start a flow from a state", "Sign in with a test account", "Stand-ins", "The app", "Publish a run", "Gate your native builds", "Use Imitor Cloud (in development, invite-only)", "What it does not show"] },
  agents: { title: "For agents", description: "Connect Imitor to Claude Code, Cursor, Codex or any MCP client: the command, the eight tools, and the same operations as JSON commands for CI.",
    sections: ["For agents"] },
};

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

/** Inline markdown: code spans, bold, links. Everything else is escaped. */
function inline(text) {
  // A link's text may itself hold code spans ([`cloud/`](cloud/)); a code span outside a link is never searched for links.
  const token = /\[((?:`[^`]*`|[^\]`])+)\]\(([^)\s]+)\)|`[^`]+`/g;
  const plain = (s) => esc(s).replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  let out = "", last = 0;
  for (const m of text.matchAll(token)) {
    out += plain(text.slice(last, m.index));
    out += m[2] ? `<a href="${esc(m[2])}">${inline(m[1])}</a>` : `<code>${esc(m[0].slice(1, -1))}</code>`;
    last = m.index + m[0].length;
  }
  return out + plain(text.slice(last));
}

const cells = (row) => row.trim().replace(/^\||\|$/g, "").split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));

/** A small markdown renderer for the README's own subset: headings, paragraphs, fences, tables, lists (with nested blocks). */
export function markdown(src, { headingOffset = 0 } = {}) {
  const lines = src.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^```(\w*)/);
    if (fence) {
      const body = [];
      for (i++; i < lines.length && !lines[i].startsWith("```"); i++) body.push(lines[i]);
      i++;
      out.push(`<div class="code"><pre><code${fence[1] ? ` data-lang="${fence[1]}"` : ""}>${esc(body.join("\n"))}</code></pre><button class="copy" type="button" aria-label="Copy">${COPY_ICON}</button></div>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)/);
    if (h) {
      const level = Math.min(6, h[1].length + headingOffset);
      out.push(`<h${level} id="${slug(h[2])}">${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }
    if (line.trim().startsWith("|") && lines[i + 1] && /^\s*\|?\s*:?-{3,}/.test(lines[i + 1])) {
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && lines[i].trim().startsWith("|"); i++) rows.push(cells(lines[i]));
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const indent = li[1].length;
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)/);
        if (!m || m[1].length !== indent) break;
        const body = [m[3]];
        const pad = m[1].length + m[2].length + 1;
        for (i++; i < lines.length; i++) {
          const next = lines[i];
          if (!next.trim()) { body.push(""); continue; }
          const lead = next.match(/^\s*/)[0].length;
          if (lead < pad) break;
          body.push(next.slice(pad));
        }
        while (body.length && !body[body.length - 1].trim()) body.pop();
        const blocks = body.slice(1).some((l) => l.trim());
        items.push(blocks ? markdown(body.join("\n"), { headingOffset }) : inline(body[0]));
      }
      out.push(`<${ordered ? "ol" : "ul"}>${items.map((x) => `<li>${x}</li>`).join("")}</${ordered ? "ol" : "ul"}>`);
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,4}\s|\s*\||\s*([-*]|\d+\.)\s)/.test(lines[i])) para.push(lines[i++].trim());
    if (!para.length) { out.push(`<p>${inline(lines[i++].trim())}</p>`); continue; }
    out.push(`<p>${inline(para.join(" "))}</p>`);
  }
  return out.join("\n");
}

/** README.md split into its `## ` sections, keyed by heading. */
export function readmeSections(text = fs.readFileSync(path.join(ROOT, "README.md"), "utf8")) {
  const sections = {};
  let current = null;
  for (const line of text.split("\n")) {
    const h = line.match(/^## (.*)/);
    if (h) { current = h[1].trim(); sections[current] = []; continue; }
    if (current) sections[current].push(line);
  }
  return Object.fromEntries(Object.entries(sections).map(([k, v]) => [k, v.join("\n").trim()]));
}

const COPY_ICON = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V4A1.5 1.5 0 0 0 9 2.5H4A1.5 1.5 0 0 0 2.5 4v5A1.5 1.5 0 0 0 4 10.5h1.5"/></svg>';

const AGENT_MARK = { "Claude Code": "claude", Cursor: "cursor", CI: "githubactions" };
const CONNECT_NOTE = {
  "Claude Code": "Run in the app’s folder.",
  Cursor: "Paste as the server command in Cursor’s MCP settings, with the app’s folder as the working directory.",
  Codex: "Run in the app’s folder.",
  Other: "Any MCP client: the command, over stdio, from the app’s folder.",
  CI: "In CI, run the whole set of flows and publish the result.",
};

function connectBlock() {
  const rows = Object.entries(CONNECT_COMMANDS).map(([who, cmd]) => {
    const mark = AGENT_MARK[who];
    const tile = mark ? `<span class="agent-tile" data-agent="${mark}"><img src="/assets/agents/${mark}.svg" alt=""></span>` : (who === "Other" ? `<span class="agent-tile"><svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5l2 1.6-2 1.6M8.6 10h2.4"/></svg></span>` : `<span class="agent-tile">${esc(who[0])}</span>`);
    const name = who === "Other" ? "Any MCP client" : who === "CI" ? "CI (GitHub Actions and others)" : who;
    return `<div class="connect-row"><div class="who">${tile}<span>${esc(name)}</span></div><div class="cmd"><span class="p">$</span><code>${esc(cmd)}</code><button class="copy" type="button" aria-label="Copy command">${COPY_ICON}</button></div><p>${esc(CONNECT_NOTE[who] || "")}</p></div>`;
  });
  return `<h2 id="connect">Connect your agent</h2>\n<div class="connect">${rows.join("")}</div>`;
}

export const REPO = "https://github.com/joseamijares/imitor";

/** The heading ids each documentation page ends up with, so a README link to a section on the other page can follow it. */
function pageIds(sections) {
  const ids = {};
  for (const [key, page] of Object.entries(PAGES)) {
    ids[key] = new Set(key === "agents" ? ["connect", "tools"] : []);
    for (const name of page.sections) {
      if (key !== "agents") ids[key].add(slug(name));
      for (const [, h] of (sections[name] || "").matchAll(/^#{1,4}\s+(.*)$/gm)) ids[key].add(slug(h));
    }
  }
  return ids;
}

/** README links written for GitHub, made to work on the site: `#section` on the page that has it, repository paths on GitHub. */
function fixLinks(html, key, ids) {
  return html.replace(/href="([^"]+)"/g, (all, href) => {
    if (href.startsWith("#")) {
      if (ids[key].has(href.slice(1))) return all;
      const other = Object.keys(ids).find((k) => ids[k].has(href.slice(1)));
      if (!other) throw new Error(`README link ${href} on ${key} has no section on the site`);
      return `href="/${other}/${href}"`;
    }
    if (/^(\/|https?:|mailto:)/.test(href)) return all;
    const p = href.replace(/^\.\//, "");
    return `href="${REPO}/${/\.[a-z0-9]+(#.*)?$/i.test(p) ? "blob" : "tree"}/main/${p}"`;
  });
}

function docPage(key, sections, template) {
  const page = PAGES[key];
  const parts = page.sections.map((name) => {
    if (!(name in sections)) throw new Error(`README.md has no "## ${name}" section (needed by ${key})`);
    const body = markdown(sections[name], { headingOffset: 1 });
    return key === "agents" ? body : `<h2 id="${slug(name)}">${esc(name)}</h2>\n${body}`;
  });
  let body = fixLinks(parts.join("\n"), key, pageIds(sections));
  if (key === "agents") body = connectBlock() + "\n<h2 id=\"tools\">The tools</h2>\n" + body;
  const toc = [...body.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(([, id, t]) => `<a href="#${id}">${t.replace(/<[^>]+>/g, "")}</a>`).join("");
  return template
    .replaceAll("{{title}}", esc(page.title))
    .replaceAll("{{description}}", esc(page.description))
    .replaceAll(`data-page="${key}"`, `data-page="${key}" aria-current="page"`)
    .replace("{{toc}}", toc)
    .replace("{{body}}", body);
}

// Who runs the site and the hosted cloud, and where people write to. Shown on /privacy/ and /terms/.
export const LEGAL = { operator: "The Imitor maintainer", contact: "hello@jamaklab.com" };
export const LEGAL_PAGES = {
  privacy: { title: "Privacy", description: "What imitor.dev and Imitor Cloud collect, where it goes and how long it stays." },
  terms: { title: "Terms", description: "The terms for imitor.dev and Imitor Cloud while it is in development." },
};

/** A legal page from site/legal/<key>.md, in the documentation layout. */
function legalPage(key, template) {
  const page = LEGAL_PAGES[key];
  const contact = `[${LEGAL.contact}](mailto:${LEGAL.contact})`;
  const text = fs.readFileSync(path.join(HERE, "legal", `${key}.md`), "utf8").replaceAll("{{operator}}", LEGAL.operator).replaceAll("{{contact}}", contact);
  const body = markdown(text);
  const toc = [...body.matchAll(/<h2 id="([^"]+)">(.*?)<\/h2>/g)].map(([, id, t]) => `<a href="#${id}">${t.replace(/<[^>]+>/g, "")}</a>`).join("");
  return template
    .replaceAll("{{title}}", esc(page.title))
    .replaceAll("{{description}}", esc(page.description))
    .replace(/\s*<p class="source">[\s\S]*?<\/p>/, "")
    .replace("{{toc}}", toc)
    .replace("{{body}}", body);
}

export function buildSite({ out = path.join(HERE, "dist") } = {}) {
  fs.rmSync(out, { recursive: true, force: true });
  fs.mkdirSync(path.join(out, "assets", "shots"), { recursive: true });
  fs.mkdirSync(path.join(out, "assets", "agents"), { recursive: true });
  for (const f of ["index.html", "404.html", "site.css", "site.js", "robots.txt"]) fs.copyFileSync(path.join(HERE, f), path.join(out, f));
  fs.copyFileSync(path.join(ROOT, "design", "tokens.css"), path.join(out, "tokens.css"));
  for (const f of ["imitor-icon-120.svg", "imitor-icon-32.svg", "imitor-icon-16.svg"]) fs.copyFileSync(path.join(ROOT, "design", "logo", f), path.join(out, "assets", f));
  for (const f of fs.readdirSync(path.join(ROOT, "assets", "agents")).filter((f) => f.endsWith(".svg"))) fs.copyFileSync(path.join(ROOT, "assets", "agents", f), path.join(out, "assets", "agents", f));
  for (const s of SHOTS) fs.copyFileSync(path.join(ROOT, "demo", "assets", "shots", `${s}.png`), path.join(out, "assets", "shots", `${s}.png`));
  const sections = readmeSections();
  const template = fs.readFileSync(path.join(HERE, "docs.html"), "utf8");
  for (const key of Object.keys(PAGES)) {
    fs.mkdirSync(path.join(out, key), { recursive: true });
    fs.writeFileSync(path.join(out, key, "index.html"), docPage(key, sections, template));
  }
  for (const key of Object.keys(LEGAL_PAGES)) {
    fs.mkdirSync(path.join(out, key), { recursive: true });
    fs.writeFileSync(path.join(out, key, "index.html"), legalPage(key, template));
  }
  // Pricing: hand-written like the landing page; only the contact address is filled in.
  fs.mkdirSync(path.join(out, "pricing"), { recursive: true });
  fs.writeFileSync(path.join(out, "pricing", "index.html"), fs.readFileSync(path.join(HERE, "pricing.html"), "utf8").replaceAll("{{contact}}", LEGAL.contact));
  // The demo: a read-only export with invented data, served under /demo/. The site's own vercel.json and 404.html
  // cover it, so the export's per-folder fallbacks are dropped.
  buildDemo({ out: path.join(out, "demo"), base: "/demo" });
  for (const f of ["vercel.json", "_redirects", "404.html"]) fs.rmSync(path.join(out, "demo", f), { force: true });
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = buildSite();
  console.log(`Site written to ${path.relative(process.cwd(), out) || out}`);
}
