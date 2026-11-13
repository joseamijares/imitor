#!/usr/bin/env node
// Runs in the Vercel build: packs the files the cloud serves from the repository (the review interface, src/app/, and
// the design tokens) into one JSON file, cloud/.build/assets.json, which the functions bundle and assets.mjs reads.
//
// Why not ship src/app/ itself: Vercel compiles the .js files in a function's bundle from ESM to CommonJS (the root
// package.json has no "type": "module"), and the cloud then served those compiled files to browsers, which cannot run
// them: the interface rendered a blank page. JSON is bundled as it is.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { PACK, readAssets } from "../src/assets.mjs";

/** Write the pack to `file`; returns how many interface files it holds. */
export function packAssets(file = PACK) {
  const { app, tokens } = readAssets();
  const pack = { app: Object.fromEntries([...app].map(([rel, bytes]) => [rel, bytes.toString("base64")])), tokens };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(pack));
  return app.size;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(`Imitor Cloud: packed ${packAssets()} interface files into ${path.relative(process.cwd(), PACK)}`);
}
