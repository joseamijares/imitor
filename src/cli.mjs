import fs from "node:fs";
import path from "node:path";
import { build } from "./build.mjs";
import { loadConfig } from "./config.mjs";
import { writeReport } from "./report.mjs";
import { serve } from "./serve.mjs";
import { shoot } from "./shoot.mjs";

const HELP = `imitor: see a React Native / Expo app without a simulator

Usage (run in the app's folder):
  imitor            build the web preview, take screenshots, write the report
  imitor build      only build the web preview into <out>/app
  imitor shoot      only take screenshots from an existing build
  imitor serve      serve an existing build for manual clicking

Config: imitor.config.json   Output: preview/ (index.html, manifest.json, screens/)`;

export async function main(args) {
  const command = args[0] || "all";
  if (["-h", "--help", "help"].includes(command)) return console.log(HELP);
  const root = process.cwd();
  const config = loadConfig(root);
  const appDir = path.join(root, config.out, "app");

  if (command === "build" || command === "all") build(root, config);
  if (command === "build") return;
  if (!fs.existsSync(path.join(appDir, "index.html"))) throw new Error(`no build at ${appDir}. Run: imitor build`);

  const server = await serve(appDir);
  if (command === "serve") return console.log(`Serving ${appDir} at ${server.url} (Ctrl+C to stop)`);
  if (command !== "shoot" && command !== "all") {
    server.close();
    throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
  try {
    const result = await shoot(root, config, server.url);
    writeReport(root, config, result);
    console.log(`imitor: ${result.shots.length} shots, ${result.problems.length} problems -> ${path.join(config.out, "index.html")}`);
    if (result.problems.some((p) => p.kind === "flow-failed")) process.exitCode = 1;
  } finally {
    server.close();
  }
}
