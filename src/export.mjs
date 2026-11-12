// `imitor export`: the review interface as plain static files, for any static host. The folder holds a copy of
// src/app/, every GET endpoint of the API as a .json file at the same path (built by the same apiGet the server uses),
// the files those responses point to under files/, and a <meta name="imitor-mode"> marker in index.html that tells the
// interface to read the .json files and keep what it writes (problems marked seen) in the browser.
// The site uses absolute paths: serve it at the root of its origin, or pass `base` ("/demo") to serve it under that
// path. With a base, index.html carries <meta name="imitor-base">, its asset paths and every /files/ URL in the JSON
// are prefixed, and the single-page fallbacks only cover that path.
import fs from "node:fs";
import path from "node:path";
import { APP_DIR, apiGet } from "./appserver.mjs";
import { loadConfig } from "./config.mjs";

export const MODE_META = "imitor-mode";
export const BASE_META = "imitor-base";
// Every path without a dot in it (the interface's History API routes) gets index.html; files are served as they are.
export const SPA_REWRITE = { source: "/((?!api/|files/|assets/)[^.]*)", destination: "/index.html" };
const MARK_FILE = ".imitor-export";

/** Every string in `value` that starts with /files/. */
function fileUrls(value, found = new Set()) {
  if (typeof value === "string") {
    if (value.startsWith("/files/")) found.add(value);
  } else if (Array.isArray(value)) value.forEach((v) => fileUrls(v, found));
  else if (value && typeof value === "object") Object.values(value).forEach((v) => fileUrls(v, found));
  return found;
}

/** "/demo/" or "demo" -> "/demo"; "" or "/" -> "". Only plain path segments are allowed. */
export function normalizeBase(base) {
  if (base == null) return "";
  const b = "/" + String(base).trim().replace(/^\/+|\/+$/g, "");
  if (b === "/") return "";
  if (!/^(\/[A-Za-z0-9._~-]+)+$/.test(b) || b.split("/").some((seg) => seg === "." || seg === "..")) throw new Error(`--base needs a path like /demo, got "${base}"`);
  return b;
}

/** A copy of `value` with every /files/ string prefixed with `base`. */
function prefixFiles(value, base) {
  if (!base) return value;
  if (typeof value === "string") return value.startsWith("/files/") ? base + value : value;
  if (Array.isArray(value)) return value.map((v) => prefixFiles(v, base));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, prefixFiles(v, base)]));
  return value;
}

/** The single-page rewrite for a site served under `base`. */
export const spaRewrite = (base = "") => (base ? { source: `${base}/((?!api/|files/|assets/)[^.]*)`, destination: `${base}/index.html` } : SPA_REWRITE);

const writeJson = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
};

/** index.html with the mode marker (and the base marker, with root paths prefixed, when `base` is set) after <meta charset>. */
export function markIndex(html, mode, base = "") {
  let tag = `<meta name="${MODE_META}" content="${mode}">`;
  if (base) {
    tag += `\n  <meta name="${BASE_META}" content="${base}">`;
    html = html.replace(/\b(href|src)="\/(?!\/)/g, `$1="${base}/`);
  }
  return /<meta charset[^>]*>/i.test(html) ? html.replace(/<meta charset[^>]*>/i, (m) => `${m}\n  ${tag}`) : html.replace(/<head[^>]*>/i, (m) => `${m}\n  ${tag}`);
}

function folderSize(dir) {
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) if (e.isFile()) n += fs.statSync(path.join(e.parentPath ?? e.path, e.name)).size;
  return n;
}

/**
 * Write the static site for the project at `root`.
 * opts: { out: folder (default <config.out>/site), previewUrl: a running preview to embed (default none), demo: mark it
 * as invented data, git: { branch, commit } instead of reading the checkout, appDir: the interface to copy }.
 * Returns { dir, runs, files, missing: [file URLs referenced but not on disk], bytes }.
 */
export function exportSite(root, { out = null, previewUrl = null, demo = false, git = null, appDir = APP_DIR, base = "" } = {}) {
  base = normalizeBase(base);
  const config = loadConfig(root);
  const outDir = path.resolve(root, config.out);
  const dir = path.resolve(root, out || path.join(config.out, "site"));
  if (previewUrl != null) {
    try {
      previewUrl = new URL(previewUrl).href.replace(/\/$/, "");
    } catch {
      throw new Error(`--preview-url needs a full URL like https://preview.example.com, got "${previewUrl}"`);
    }
  }
  if (!fs.existsSync(path.join(appDir, "index.html"))) throw new Error(`the interface is missing: no ${path.join(appDir, "index.html")}`);
  const inner = (a, b) => a === b || b.startsWith(a + path.sep);
  if (inner(dir, outDir) || inner(dir, root) || inner(dir, path.resolve(appDir)) || inner(path.resolve(appDir), dir)) {
    throw new Error(`refusing to export into ${dir}: it holds the project, its output folder or the interface. Pick an empty folder.`);
  }
  // Only replace a folder that is empty or an earlier export, never anything else someone pointed --out at.
  if (fs.existsSync(dir) && fs.readdirSync(dir).length && !fs.existsSync(path.join(dir, MARK_FILE))) {
    throw new Error(`${dir} is not empty and is not an earlier Imitor export. Pick an empty folder.`);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(appDir, dir, { recursive: true });

  const get = (route) => {
    const answer = apiGet(root, route, { previewUrl, git });
    if (!answer || answer.status !== 200) throw new Error(`export: ${route} gave ${answer ? answer.status : "no answer"}`);
    return answer.body;
  };
  const responses = new Map();
  responses.set("/api/project", get("/api/project"));
  const { runs } = get("/api/runs");
  responses.set("/api/runs", { runs });
  for (const r of runs) responses.set(`/api/runs/${r.id}`, get(`/api/runs/${r.id}`));
  for (const route of ["/api/captures", "/api/problems", "/api/agents"]) responses.set(route, get(route));
  for (const [route, body] of responses) writeJson(path.join(dir, route.slice(1) + ".json"), prefixFiles(body, base));

  // The files those responses point to, and nothing else from the output folder.
  const urls = fileUrls([...responses.values()]);
  const missing = [];
  let files = 0;
  for (const url of urls) {
    let rel;
    try {
      rel = decodeURIComponent(url.slice("/files/".length));
    } catch {
      missing.push(url);
      continue;
    }
    const src = path.resolve(outDir, rel);
    if (!src.startsWith(outDir + path.sep) || !fs.existsSync(src) || !fs.statSync(src).isFile()) {
      missing.push(url);
      continue;
    }
    const dest = path.join(dir, "files", path.relative(outDir, src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    files++;
  }

  // The marker, and single-page fallbacks for static hosts: 404.html (GitHub Pages and most hosts), vercel.json, _redirects (Netlify).
  // With a base, these fallbacks describe that path; a host serving the folder as part of a larger site uses them as a template.
  const index = markIndex(fs.readFileSync(path.join(appDir, "index.html"), "utf8"), demo ? "static demo" : "static", base);
  fs.writeFileSync(path.join(dir, "index.html"), index);
  fs.writeFileSync(path.join(dir, "404.html"), index);
  writeJson(path.join(dir, "vercel.json"), { rewrites: [spaRewrite(base)] });
  fs.writeFileSync(path.join(dir, "_redirects"), `${base}/api/*  ${base}/404.html  404\n${base}/files/*  ${base}/404.html  404\n${base}/*  ${base}/index.html  200\n`);
  fs.writeFileSync(path.join(dir, MARK_FILE), "Written by imitor export. The whole folder is replaced on the next export.\n");
  return { dir, base, runs: runs.length, files, missing, bytes: folderSize(dir) };
}
