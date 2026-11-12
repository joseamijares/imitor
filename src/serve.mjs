import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml", ".ttf": "font/ttf", ".otf": "font/otf",
  ".woff": "font/woff", ".woff2": "font/woff2", ".ico": "image/x-icon", ".map": "application/json", ".txt": "text/plain; charset=utf-8",
};

/**
 * Static server with single-page fallback, so deep links like /settings work. Binds to 127.0.0.1.
 * opts.port: port to listen on (0, the default, picks a free one).
 * opts.html(html, file): rewrite every HTML page on its way out (used by the app server's live preview).
 * opts.files: { "/url/path": { type, body } } extra files served before the build's own.
 */
export function serve(dir, { port = 0, html, files = {} } = {}) {
  const root = path.resolve(dir);
  const server = http.createServer((req, res) => {
    let url;
    try {
      url = decodeURIComponent(new URL(req.url, "http://x").pathname);
    } catch {
      res.writeHead(400).end("bad url");
      return;
    }
    if (files[url]) {
      res.writeHead(200, { "content-type": files[url].type, "cache-control": "no-store" });
      res.end(files[url].body);
      return;
    }
    const safe = path.normalize(url).replace(/^(\.\.[/\\])+/, "");
    const candidates = [path.join(root, safe), path.join(root, safe + ".html"), path.join(root, safe, "index.html")];
    let file = candidates.find((f) => (f === root || f.startsWith(root + path.sep)) && fs.existsSync(f) && fs.statSync(f).isFile());
    if (!file && !path.extname(safe)) file = path.join(root, "index.html");
    if (!file || !fs.existsSync(file)) {
      res.writeHead(404, { "content-type": TYPES[".txt"] }).end(fs.existsSync(root) ? "not found" : "no preview build yet. Run: imitor build");
      return;
    }
    const type = TYPES[path.extname(file).toLowerCase()] || "application/octet-stream";
    if (html && path.extname(file) === ".html") {
      res.writeHead(200, { "content-type": type, "cache-control": "no-store" });
      res.end(html(fs.readFileSync(file, "utf8"), file));
      return;
    }
    res.writeHead(200, { "content-type": type });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const actual = server.address().port;
      resolve({ url: `http://127.0.0.1:${actual}`, port: actual, close: () => new Promise((done) => { server.closeAllConnections?.(); server.close(() => done()); }) });
    });
  });
}
