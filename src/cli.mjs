import fs from "node:fs";
import path from "node:path";
import { describe, readProblems, recordVideo, runFlow, screenshot } from "./agent.mjs";
import { build } from "./build.mjs";
import { loadConfig } from "./config.mjs";
import { writeReport } from "./report.mjs";
import { serve } from "./serve.mjs";
import { shoot } from "./shoot.mjs";
import { recordCaptures, recordRun, resolveBy } from "./store.mjs";

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
  imitor app [--port n]     open the review interface on this machine (runs, captures, problems, agents)

For agents and scripts (each prints JSON):
  imitor describe           flows, devices and stand-ins configured for this app
  imitor screenshot         one screenshot: --route /x | --flow name  [--device d] [--scheme light|dark] [--full-page] [--name n]
  imitor flow               run one flow and report each step: --flow name [--device d] [--scheme s]
  imitor record             record a .webm video of a flow: --flow name [--device d] [--scheme s]
  imitor problems           problems and stand-ins from the last full run
  imitor mcp                MCP server on stdio, exposing all of the above as tools

Config: imitor.config.json   Output: preview/ (index.html, manifest.json, screens/, captures/, runs/)`;

export async function main(args) {
  const command = args[0] || "all";
  if (["-h", "--help", "help"].includes(command)) return console.log(HELP);
  const root = process.cwd();
  if (command === "mcp") return (await import("./mcp.mjs")).runStdio(root);
  const print = (value) => console.log(JSON.stringify(value, null, 2));
  const opts = flags(args.slice(1));
  if (command === "app") {
    const port = opts.port === undefined ? 4173 : Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port needs a number, got "${opts.port}"`);
    const { startAppServer } = await import("./appserver.mjs");
    const server = await startAppServer(root, { port }).catch((error) => {
      throw error.code === "EADDRINUSE" ? new Error(`port ${port} is in use. Try: imitor app --port ${port + 1}`) : error;
    });
    return console.log(`Imitor app at ${server.url} (this machine only; Ctrl+C to stop)`);
  }
  if (command === "describe") return print(describe(root));
  if (command === "problems") return print(readProblems(root));
  const out = () => path.join(root, loadConfig(root).out);
  if (command === "screenshot") {
    const result = await screenshot(root, opts);
    recordCaptures(out(), root, "screenshot", { ...result, flow: opts.flow || null }, resolveBy({ root }));
    return print(result);
  }
  if (command === "flow" || command === "record") {
    if (!opts.flow) throw new Error(`${command} needs --flow <name>`);
    const result = command === "flow" ? await runFlow(root, opts) : await recordVideo(root, opts);
    recordCaptures(out(), root, command, result, resolveBy({ root }));
    print(result);
    if (!result.passed) process.exitCode = 1;
    return;
  }
  const config = loadConfig(root);
  const appDir = path.join(root, config.out, "app");
  const startedAt = new Date().toISOString();

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
    const manifest = writeReport(root, config, result);
    recordRun(path.join(root, config.out), { root, config, manifest, startedAt, by: resolveBy({ root }) });
    console.log(`imitor: ${result.shots.length} shots, ${result.problems.length} problems -> ${path.join(config.out, "index.html")}`);
    if (result.problems.some((p) => p.kind === "flow-failed")) process.exitCode = 1;
  } finally {
    server.close();
  }
}
