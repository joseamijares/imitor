// The files the cloud serves from this repository rather than from storage: the review interface (src/app/) and the
// design tokens, read from the repository once. On Vercel the function bundle carries them (includeFiles in the root
// vercel.json).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SOURCES = { app: path.join(ROOT, "src", "app"), tokens: path.join(ROOT, "design", "tokens.css") };

export const TYPES = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json; charset=utf-8", ".md": "text/plain; charset=utf-8",
};
export const typeOf = (rel) => TYPES[path.extname(rel).toLowerCase()] || "application/octet-stream";

/** { app: Map(rel path with / -> Buffer), tokens: string } read from the repository. */
export function readAssets() {
  const app = new Map();
  for (const e of fs.readdirSync(SOURCES.app, { withFileTypes: true, recursive: true })) {
    if (!e.isFile()) continue;
    const file = path.join(e.parentPath ?? e.path, e.name);
    app.set(path.relative(SOURCES.app, file).split(path.sep).join("/"), fs.readFileSync(file));
  }
  return { app, tokens: fs.readFileSync(SOURCES.tokens, "utf8") };
}

let cached = null;
export async function loadAssets() {
  return (cached ||= readAssets());
}
