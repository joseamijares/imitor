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
  imitor init               set Imitor up in this Expo app: Metro wrap, imitor.config.json with stand-ins, ignores.
                            Prints every change as a diff; installs nothing. [--dry-run] [--force] [--yes]
  imitor                    build the web preview, run every flow, write the report
  imitor build              only build the web preview into <out>/app
  imitor shoot              only run the flows from an existing build
  imitor serve              serve an existing build for manual clicking
  imitor gate               build, run every flow, and exit non-zero if the run should block a native build:
                            [--fail-on flows|errors|stand-ins] [--no-build] [--json]
  imitor comment            print the pull-request comment for the last run (verdict, failed flows, shots):
                            [--image-base url] [--max-shots n] [--device d] [--scheme s] [--fail-on f] [--report-url url] [--sha commit] [--json]
  imitor publish-shots      push the last run's screenshots to a branch of this repository (GitHub Actions only),
                            print the --image-base for imitor comment: [--branch imitor-shots] [--keep 3] [--pr n] [--force] [--json]
  imitor app [--port n]     open the review interface on this machine (runs, captures, problems, agents)
  imitor export             write the interface and its data as a read-only static site:
                            [--out dir] (default <out>/site) [--preview-url url] [--base /path] [--demo]
  imitor push [--run id]    upload a run (default the newest) to an Imitor Cloud instance (in development);
                            needs IMITOR_CLOUD_URL and IMITOR_TOKEN

For agents and scripts (each prints JSON):
  imitor describe           flows, devices and stand-ins configured for this app
  imitor screenshot         one screenshot: --route /x | --flow name  [--device d] [--scheme light|dark] [--full-page] [--name n] [--state s]
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
  if (command === "init") {
    // --yes is accepted and is the default: init never asks questions, so agents can run it.
    const { init, formatInit } = await import("./init.mjs");
    const result = init(root, { dryRun: opts.dryRun === true, force: opts.force === true });
    console.log(formatInit(result));
    if (result.stop) process.exitCode = 1;
    return;
  }
  if (command === "app") {
    const port = opts.port === undefined ? 4173 : Number(opts.port);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`--port needs a number, got "${opts.port}"`);
    const { startAppServer } = await import("./appserver.mjs");
    const server = await startAppServer(root, { port }).catch((error) => {
      throw error.code === "EADDRINUSE" ? new Error(`port ${port} is in use. Try: imitor app --port ${port + 1}`) : error;
    });
    return console.log(`Imitor app at ${server.url} (this machine only; Ctrl+C to stop)`);
  }
  if (command === "export") {
    for (const k of ["out", "previewUrl", "base"]) if (opts[k] === true) throw new Error(`--${k === "previewUrl" ? "preview-url" : k} needs a value`);
    const { exportSite } = await import("./export.mjs");
    const site = exportSite(root, { out: opts.out || null, previewUrl: opts.previewUrl || null, demo: opts.demo === true, base: opts.base || "" });
    const mb = (site.bytes / 1024 / 1024).toFixed(1);
    console.log(`Exported ${site.runs} run${site.runs === 1 ? "" : "s"} and ${site.files} file${site.files === 1 ? "" : "s"} (${mb} MB) to ${path.relative(root, site.dir).startsWith("..") ? site.dir : path.relative(root, site.dir)}`);
    if (site.missing.length) console.log(`${site.missing.length} referenced file${site.missing.length === 1 ? " is" : "s are"} no longer on disk and will not load, e.g. ${site.missing[0]}`);
    console.log(`It is read-only and holds this project's screenshots: publish it only where they may be seen. ${site.base ? `Serve it at ${site.base}/ on its domain.` : "Serve it at the root of a domain."}`);
    return;
  }
  if (command === "push") {
    if (opts.run === true) throw new Error("--run needs a run id");
    const { push } = await import("./push.mjs");
    const result = await push(root, { run: opts.run || null, cloudUrl: process.env.IMITOR_CLOUD_URL, token: process.env.IMITOR_TOKEN });
    const sent = result.uploaded === result.files ? `${result.files} file${result.files === 1 ? "" : "s"}` : `${result.uploaded} of ${result.files} files; the rest were already there`;
    console.log(`Pushed run ${result.clientRunId} (${sent}): ${result.url}`);
    if (result.skipped.length) console.log(`Left out ${result.skipped.length} file${result.skipped.length === 1 ? "" : "s"} of a type the cloud does not take, e.g. ${result.skipped[0]}`);
    return;
  }
  if (command === "comment") {
    for (const k of ["imageBase", "maxShots", "device", "scheme", "failOn", "reportUrl", "sha"]) if (opts[k] === true) throw new Error(`--${k.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)} needs a value`);
    const { commentFor, formatComment } = await import("./comment.mjs");
    const data = commentFor(root, opts);
    return opts.json === true ? print(data) : process.stdout.write(formatComment(data));
  }
  if (command === "publish-shots") {
    for (const k of ["branch", "keep", "pr", "sha", "repo", "remote"]) if (opts[k] === true) throw new Error(`--${k} needs a value`);
    const { publishShots } = await import("./publish.mjs");
    const result = publishShots(root, { ...opts, force: opts.force === true });
    if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `image-base=${result.baseUrl}\n`);
    console.error(`Published ${result.files.length} files to ${result.branch}:${result.folder}${result.removed.length ? `; removed ${result.removed.join(", ")}` : ""}`);
    return opts.json === true ? print(result) : console.log(result.baseUrl);
  }
  if (command === "describe") return print(describe(root));
  if (command === "problems") return print(readProblems(root));
  const out = () => path.resolve(root, loadConfig(root).out);
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
  const appDir = path.resolve(root, config.out, "app");
  const startedAt = new Date().toISOString();

  const gate = command === "gate";
  if (gate) {
    // Check the policy before the build, not a minute later.
    const { FAIL_ON } = await import("./gate.mjs");
    if (opts.failOn !== undefined && !FAIL_ON.includes(opts.failOn)) throw new Error(`--fail-on must be one of ${FAIL_ON.join(", ")}`);
  }
  if (command === "build" || command === "all" || (gate && !opts.noBuild)) build(root, config, { quiet: gate && opts.json === true });
  if (command === "build") return;
  if (!fs.existsSync(path.join(appDir, "index.html"))) throw new Error(`no build at ${appDir}. Run: imitor build`);

  const server = await serve(appDir);
  if (command === "serve") return console.log(`Serving ${appDir} at ${server.url} (Ctrl+C to stop)`);
  if (command !== "shoot" && command !== "all" && !gate) {
    server.close();
    throw new Error(`unknown command "${command}"\n\n${HELP}`);
  }
  try {
    const result = await shoot(root, config, server.url);
    const manifest = writeReport(root, config, result);
    recordRun(path.resolve(root, config.out), { root, config, manifest, startedAt, by: resolveBy({ root }) });
    const report = path.join(config.out, "index.html");
    if (gate) {
      const { evaluate, formatText, reportToGitHub } = await import("./gate.mjs");
      const verdict = evaluate(manifest, { failOn: opts.failOn || "flows" });
      console.log(opts.json === true ? JSON.stringify({ ...verdict, report }, null, 2) : formatText(verdict, report));
      reportToGitHub(verdict, report);
      if (!verdict.passed) process.exitCode = 1;
      return;
    }
    console.log(`imitor: ${result.shots.length} shots, ${result.problems.length} problems -> ${report}`);
    if (result.problems.some((p) => p.kind === "flow-failed" || p.kind === "seed-failed")) process.exitCode = 1;
  } finally {
    server.close();
  }
}
