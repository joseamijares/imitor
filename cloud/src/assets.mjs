// The files the cloud serves from this repository rather than from storage: the review interface (src/app/) and the
// design tokens, read once. On Vercel they come from cloud/.build/assets.json, which the build writes
// (scripts/pack-assets.mjs) and the function bundle carries (includeFiles in the root vercel.json): Vercel compiles
// bundled .js files to CommonJS, which browsers cannot run, so src/app/ itself is not shipped. Elsewhere they are read
// from the repository.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const SOURCES = { app: path.join(ROOT, "src", "app"), tokens: path.join(ROOT, "design", "tokens.css") };
export const PACK = path.join(ROOT, "cloud", ".build", "assets.json");

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

/** The same, from a pack written by scripts/pack-assets.mjs. */
export function readPack(file = PACK) {
  const pack = JSON.parse(fs.readFileSync(file, "utf8"));
  return { app: new Map(Object.entries(pack.app).map(([rel, b64]) => [rel, Buffer.from(b64, "base64")])), tokens: pack.tokens };
}

let cached = null;
/** On Vercel the pack (its bundle has no src/app/); anywhere else the repository's files, so a stale pack never hides an edit. */
export async function loadAssets() {
  if (cached) return cached;
  if (process.env.VERCEL) {
    // The bundle has no src/app/ (excludeFiles); without the pack there is nothing right to serve.
    if (!fs.existsSync(PACK)) throw new Error(`the interface pack ${PACK} is missing: the build must run cloud/scripts/pack-assets.mjs`);
    return (cached = readPack());
  }
  return (cached = readAssets());
}
