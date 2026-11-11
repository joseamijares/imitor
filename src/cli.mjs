import fs from "node:fs";
import path from "node:path";
import { describe, readProblems, recordVideo, runFlow, screenshot } from "./agent.mjs";
import { build } from "./build.mjs";
import { loadConfig } from "./config.mjs";
import { writeReport } from "./report.mjs";
import { serve } from "./serve.mjs";
import { shoot } from "./shoot.mjs";

// --key value and --flag pairs into an object.
function flags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    if (!args[i].startsWith("--")) continue;
    const key = args[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    out[key] = args[i + 1] && !args[i + 1].startsWith("--") ? args[++i] : true;
  }
  return out;
}

const HELP = `imitor: see a React Native / Expo app without a simulator

Usage (run in the app's folder):
  imitor                    build the web preview, run every flow, write the report
  imitor build              only build the web preview into <out>/app
  imitor shoot              only run the flows from an existing build
  imitor serve              serve an existing build for manual clicking

For agents and scripts (each prints JSON):
  imitor describe           flows, devices and stand-ins configured for this app
  imitor screenshot         one screenshot: --route /x | --flow name  [--device d] [--scheme light|dark] [--full-page] [--name n]
  imitor flow               run one flow and report each step: --flow name [--device d] [--scheme s]
  imitor record             record a .webm video of a flow: --flow name [--device d] [--scheme s]
  imitor problems           problems and stand-ins from the last full run
  imitor mcp                MCP server on stdio, exposing all of the above as tools

Config: imitor.config.json   Output: preview/ (index.html, manifest.json, screens/, captures/)`;

export async function main(args) {
  const command = args[0] || "all";
  if (["-h", "--help", "help"].includes(command)) return console.log(HELP);
  const root = process.cwd();
  if (command === "mcp") return (await import("./mcp.mjs")).runStdio(root);
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  const opts = flags(args.slice(1));
  if (command === "describe") return print(describe(root));
  if (command === "problems") return print(readProblems(root));
  if (command === "screenshot") return print(await screenshot(root, opts));
  if (command === "flow" || command === "record") {
    if (!opts.flow) throw new Error(`${command} needs --flow <name>`);
    const result = command === "flow" ? await runFlow(root, opts) : await recordVideo(root, opts);
    print(result);
    if (!result.passed) process.exitCode = 1;
    return;
  }
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
