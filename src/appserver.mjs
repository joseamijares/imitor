// The local server behind `imitor app`: the review interface (src/app/), a JSON API under /api/ and the output folder
// under /files/. The built web preview gets a second server on its own port (GET /api/project names it as previewUrl),
// so it lives at the root of its own origin like the real app, and its router and reloads work inside the live
// preview's <iframe>. Both bind to 127.0.0.1 only.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "./agent.mjs";
import { MEDIA_MARKER } from "./build.mjs";
import { DEVICES, loadConfig, NOT_COVERED } from "./config.mjs";
import { TOOLS } from "./mcp.mjs";
import { serve } from "./serve.mjs";
import { agentsData, gitInfo, listCaptures, listProblems, listRuns, readRun, setSeen } from "./store.mjs";

export const APP_DIR = fileURLToPath(new URL("./app", import.meta.url));

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".jsonl": "application/jsonl", ".wasm": "application/wasm", ".png": "image/png",
  ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
  ".ttf": "font/ttf", ".otf": "font/otf", ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon",
  ".map": "application/json", ".webm": "video/webm", ".mp4": "video/mp4", ".txt": "text/plain; charset=utf-8",
};
const PLACEHOLDER = `<!doctype html><meta charset="utf-8"><title>Imitor</title><p>The Imitor app is not built yet: src/app/index.html is missing. The API is at /api/runs.</p>`;

const json = (res, status, value) => {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
};
const notFound = (res, what = "not found") => json(res, 404, { error: what });

/** The file `rel` inside `dir`, or null if it escapes `dir` or is not a file. */
function inside(dir, rel) {
  const base = path.resolve(dir);
  const file = path.resolve(base, "." + path.sep + rel);
  if (file !== base && !file.startsWith(base + path.sep)) return { escaped: true };
  try {
    return fs.statSync(file).isFile() ? { file } : {};
  } catch {
    return {};
  }
}

/** Stream a file, honouring a single byte Range so videos can seek. */
function sendFile(req, res, file, extraHeaders = {}) {
  const size = fs.statSync(file).size;
  const headers = { "content-type": TYPES[path.extname(file).toLowerCase()] || "application/octet-stream", "accept-ranges": "bytes", ...extraHeaders };
  const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || "");
  if (range && (range[1] || range[2])) {
    let start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
    let end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start > end || start >= size) {
      res.writeHead(416, { "content-range": `bytes */${size}` }).end();
      return;
    }
    res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${size}`, "content-length": end - start + 1 });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...headers, "content-length": size });
  if (req.method === "HEAD") return res.end();
  fs.createReadStream(file).pipe(res);
}

const DRIVER = fs.readFileSync(fileURLToPath(new URL("./live-driver.js", import.meta.url)), "utf8");
export const DRIVER_PATH = "/__imitor_live/driver.js";

/** Every preview page gets the live preview's driver, which obeys only the interface's own origins. */
function withDriver(parents) {
  const tag = `<script>window.__imitorLive=${JSON.stringify({ parents }).replace(/</g, "\\u003c")}</script><script src="${DRIVER_PATH}" defer></script>`;
  return (html) => (/<\/head>/i.test(html) ? html.replace(/<\/head>/i, (m) => tag + m) : html + tag);
}

/** When the preview was built, and whether its pages carry the scheme and motion override (builds before it do not). */
function previewInfo(out) {
  const index = path.join(out, "app", "index.html");
  try {
    const stat = fs.statSync(index);
    return { builtAt: stat.mtime.toISOString(), previewAppearance: fs.readFileSync(index, "utf8").includes(MEDIA_MARKER) };
  } catch {
    return { builtAt: null, previewAppearance: false };
  }
}

function stepLabel(step) {
  const action = Object.keys(step)[0];
  const value = step[action];
  if (action === "shot") return value;
  if (action === "wait") return `${value} ms`;
  if (action === "scroll") return `${value} px`;
  if (typeof value === "string") return value;
  if (value && typeof value === "object") return String(value.label ?? value.text ?? value.placeholder ?? value.testId ?? value.css ?? JSON.stringify(value));
  return String(value);
}

/** `git` ({ branch, commit }) replaces reading the checkout, for data assembled elsewhere (the demo). */
export function projectData(root, { previewUrl = null, git = null } = {}) {
  const config = loadConfig(root);
  const info = git || gitInfo(root);
  let name = path.basename(root);
  try {
    name = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).name || name;
  } catch {}
  const builtIn = Object.entries(DEVICES).filter(([n]) => !config.devices.some((d) => d.name === n)).map(([n, d]) => ({ name: n, ...d }));
  return {
    name,
    branch: info.branch,
    commit: info.commit,
    built: describe(root).built,
    previewUrl,
    ...previewInfo(path.join(root, config.out)),
    devices: [...config.devices, ...builtIn].map((d) => ({ name: d.name, width: d.width, height: d.height, platform: d.platform || null })),
    schemes: config.schemes,
    flows: config.flows.map((f) => ({ name: f.name, start: f.start || "/", steps: (f.steps || []).map((step, i) => ({ index: i + 1, action: Object.keys(step)[0], label: stepLabel(step), step })) })),
    standIns: Object.entries(config.shims).map(([module, kind]) => ({ module, kind, fidelity: kind === "sqljs" ? "genuine" : "stand-in" })),
    notCovered: NOT_COVERED,
  };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

/**
 * The body of a GET API route, shared by the server and `imitor export` so the two cannot drift.
 * Returns { status: 200, body } , { status: 404, body: { error } } for an unknown id, or null for no such endpoint.
 * opts: { previewUrl, git } for /api/project.
 */
export function apiGet(root, route, opts = {}) {
  const out = path.join(root, loadConfig(root).out);
  if (route === "/api/project") return { status: 200, body: projectData(root, opts) };
  if (route === "/api/runs") return { status: 200, body: { runs: listRuns(out) } };
  const m = /^\/api\/runs\/([^/]+)$/.exec(route);
  if (m) {
    const run = readRun(out, m[1]);
    return run ? { status: 200, body: run } : { status: 404, body: { error: `no run ${m[1]}` } };
  }
  if (route === "/api/captures") return { status: 200, body: { captures: listCaptures(out) } };
  if (route === "/api/problems") return { status: 200, body: { problems: listProblems(out) } };
  if (route === "/api/agents") return { status: 200, body: agentsData(out, TOOLS) };
  return null;
}

async function api(req, res, root, out, route, previewUrl) {
  const get = req.method === "GET" || req.method === "HEAD";
  const answer = get ? apiGet(root, route, { previewUrl }) : null;
  if (answer) return json(res, answer.status, answer.body);
  const m = /^\/api\/problems\/([^/]+)\/seen$/.exec(route);
  if (req.method === "POST" && m) {
    let body;
    try {
      body = JSON.parse((await readBody(req)) || "{}");
    } catch {
      return json(res, 400, { error: "body must be JSON like {\"seen\": true}" });
    }
    if (typeof body.seen !== "boolean") return json(res, 400, { error: "body must be JSON like {\"seen\": true}" });
    if (!listProblems(out).some((p) => p.id === m[1])) return notFound(res, `no problem ${m[1]}`);
    setSeen(out, m[1], body.seen);
    return json(res, 200, { ok: true });
  }
  return notFound(res, `no endpoint ${req.method} ${route}`);
}

/**
 * Start the app server on `port` (0 for any free port), and the preview server on any free port.
 * Returns { url, port, previewUrl, close }.
 */
export async function startAppServer(root, { port = 4173, appDir = APP_DIR } = {}) {
  let previewUrl = null;
  const server = http.createServer(async (req, res) => {
    try {
      // Decode without normalising, so "/files/..%2f.." is seen for what it is and rejected.
      const raw = req.url.split("?")[0].split("#")[0];
      let route;
      try {
        route = decodeURIComponent(raw);
      } catch {
        return json(res, 400, { error: "bad url" });
      }
      if (route.includes("\0")) return json(res, 400, { error: "bad url" });
      const out = path.join(root, loadConfig(root).out);
      if (route === "/api" || route.startsWith("/api/")) return await api(req, res, root, out, route, previewUrl);
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
      if (route.startsWith("/files/")) {
        const found = inside(out, route.slice("/files/".length));
        if (found.escaped) return json(res, 403, { error: "path escapes the output folder" });
        return found.file ? sendFile(req, res, found.file, { "cache-control": "no-cache" }) : notFound(res);
      }
      const rel = route.replace(/^\/+/, "");
      // The interface's own files, then its page for every other path (the interface routes with the History API).
      if (rel && path.basename(rel) !== "index.html") {
        const found = inside(appDir, rel);
        if (found.escaped) return json(res, 403, { error: "path escapes the folder" });
        if (found.file) return sendFile(req, res, found.file);
      }
      if (path.extname(rel) && !rel.endsWith(".html")) return notFound(res);
      const index = path.join(appDir, "index.html");
      if (fs.existsSync(index)) return sendFile(req, res, index, { "cache-control": "no-cache" });
      res.writeHead(200, { "content-type": TYPES[".html"] }).end(PLACEHOLDER);
    } catch (error) {
      if (!res.headersSent) json(res, 500, { error: String(error.message) });
      else res.destroy();
    }
  });
  const actual = await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server.address().port));
  });
  const closeApp = () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); });
  let preview;
  try {
    const parents = [`http://127.0.0.1:${actual}`, `http://localhost:${actual}`];
    preview = await serve(path.join(root, loadConfig(root).out, "app"), { html: withDriver(parents), files: { [DRIVER_PATH]: { type: "text/javascript", body: DRIVER } } });
  } catch (error) {
    await closeApp();
    throw error;
  }
  previewUrl = preview.url;
  return { url: `http://127.0.0.1:${actual}`, port: actual, previewUrl, close: () => Promise.all([closeApp(), preview.close()]).then(() => {}) };
}
