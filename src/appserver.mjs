// The local server behind `imitor app`: the review interface (src/app/), a JSON API under /api/,
// the output folder under /files/, and the built web preview under /preview/. Binds to 127.0.0.1 only.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "./agent.mjs";
import { DEVICES, loadConfig, NOT_COVERED } from "./config.mjs";
import { TOOLS } from "./mcp.mjs";
import { agentsData, gitInfo, listCaptures, listProblems, listRuns, readRun, setSeen } from "./store.mjs";

const APP_DIR = fileURLToPath(new URL("./app", import.meta.url));

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

// The preview is built for the site root (its scripts load from /_expo/..., its router reads location.pathname).
// Served under /preview/, its HTML first rewrites the address to the route alone, so the app routes as if at the root.
const PREVIEW_SHIM = `<script>(function(){var p=location.pathname.replace(/^\\/preview(?=\\/|$)/,"")||"/";history.replaceState(history.state,"",p+location.search+location.hash)})()</script>`;

function sendPreview(req, res, appDir, rel) {
  let found = inside(appDir, rel);
  if (found.escaped) return json(res, 403, { error: "path escapes the preview folder" });
  if (!found.file) found = inside(appDir, rel + ".html");
  if (!found.file) found = inside(appDir, path.join(rel, "index.html"));
  if (!found.file && !path.extname(rel)) found = inside(appDir, "index.html"); // single-page fallback
  if (!found.file) return notFound(res, rel ? `no file ${rel} in the preview build` : "no preview build. Run: imitor build");
  if (path.extname(found.file) !== ".html") return sendFile(req, res, found.file);
  const html = fs.readFileSync(found.file, "utf8");
  const patched = /<head[^>]*>/i.test(html) ? html.replace(/<head[^>]*>/i, (m) => m + PREVIEW_SHIM) : PREVIEW_SHIM + html;
  res.writeHead(200, { "content-type": TYPES[".html"], "cache-control": "no-store" });
  res.end(req.method === "HEAD" ? undefined : patched);
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

export function projectData(root) {
  const config = loadConfig(root);
  const info = gitInfo(root);
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
    devices: [...config.devices, ...builtIn].map((d) => ({ name: d.name, width: d.width, height: d.height, platform: d.platform || null })),
    schemes: config.schemes,
    flows: config.flows.map((f) => ({ name: f.name, start: f.start || "/", steps: (f.steps || []).map((step, i) => ({ index: i + 1, action: Object.keys(step)[0], label: stepLabel(step) })) })),
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

async function api(req, res, root, out, route) {
  const get = req.method === "GET" || req.method === "HEAD";
  if (get && route === "/api/project") return json(res, 200, projectData(root));
  if (get && route === "/api/runs") return json(res, 200, { runs: listRuns(out) });
  let m = /^\/api\/runs\/([^/]+)$/.exec(route);
  if (get && m) {
    const run = readRun(out, m[1]);
    return run ? json(res, 200, run) : notFound(res, `no run ${m[1]}`);
  }
  if (get && route === "/api/captures") return json(res, 200, { captures: listCaptures(out) });
  if (get && route === "/api/problems") return json(res, 200, { problems: listProblems(out) });
  if (get && route === "/api/agents") return json(res, 200, agentsData(out, TOOLS));
  m = /^\/api\/problems\/([^/]+)\/seen$/.exec(route);
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

/** Start the app server on `port` (0 for any free port). Returns { url, port, close }. */
export function startAppServer(root, { port = 4173, appDir = APP_DIR } = {}) {
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
      if (route === "/api" || route.startsWith("/api/")) return await api(req, res, root, out, route);
      if (req.method !== "GET" && req.method !== "HEAD") return json(res, 405, { error: "method not allowed" });
      if (route.startsWith("/files/")) {
        const found = inside(out, route.slice("/files/".length));
        if (found.escaped) return json(res, 403, { error: "path escapes the output folder" });
        return found.file ? sendFile(req, res, found.file, { "cache-control": "no-cache" }) : notFound(res);
      }
      const appBuild = path.join(out, "app");
      if (route === "/preview" || route.startsWith("/preview/")) return sendPreview(req, res, appBuild, route.slice("/preview".length).replace(/^\/+/, ""));
      const rel = route.replace(/^\/+/, "");
      // The interface's own files, then the preview build's root-relative assets (/_expo/..., /assets/...), then the interface's page.
      for (const dir of [appDir, appBuild]) {
        if (!rel || path.basename(rel) === "index.html") continue;
        const found = inside(dir, rel);
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
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({ url: `http://127.0.0.1:${actual}`, port: actual, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) });
    });
  });
}
