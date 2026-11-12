// A small MCP server over stdio so coding agents can use Imitor without the interface.
// Protocol: newline-delimited JSON-RPC 2.0 (Model Context Protocol, stdio transport). No dependencies.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { describe, readProblems, recordVideo, runFlow, screenshot } from "./agent.mjs";
import { build } from "./build.mjs";
import { formatInit, init } from "./init.mjs";
import { loadConfig } from "./config.mjs";
import { scrubForRoot } from "./secrets.mjs";
import { serve } from "./serve.mjs";
import { appendActivity, recordCaptures, resolveBy } from "./store.mjs";
import { TOOLS } from "./tools.mjs";

export { TOOLS };

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function createServer(root) {
  let preview = null;
  let clientName = null; // from initialize clientInfo.name; names who made each capture and call
  const by = () => resolveBy({ clientName, root });
  const out = () => path.resolve(root, loadConfig(root).out);
  const text = (value) => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
  // Each handler returns { content, summary }: the MCP result and a short plain-words line for the activity log.
  const handlers = {
    imitor_describe: async () => {
      const d = describe(root);
      return { content: [text(d)], summary: `read the setup: ${plural(d.flows.length, "flow")}, ${d.built ? "built" : "not built yet"}` };
    },
    imitor_build: async () => {
      const started = Date.now();
      const dir = build(root, loadConfig(root), { quiet: true });
      const seconds = Math.round((Date.now() - started) / 1000);
      return { content: [text({ built: path.relative(root, dir), seconds })], summary: `built the preview in ${seconds} s` };
    },
    imitor_screenshot: async (args) => {
      const result = await screenshot(root, { ...args, scale: 1 });
      recordCaptures(out(), root, "screenshot", { ...result, flow: args.flow || null }, by());
      const image = fs.readFileSync(path.join(root, result.file)).toString("base64");
      return { content: [text(result), { type: "image", data: image, mimeType: "image/png" }], summary: `took a screenshot of ${result.route} on ${result.device}${result.failedAt !== null ? `, but ${result.failedIn ? `step ${result.failedAt} of ${result.failedIn}` : `step ${result.failedAt}`} failed on the way` : ""}` };
    },
    imitor_run_flow: async (args) => {
      const result = await runFlow(root, args);
      recordCaptures(out(), root, "flow", result, by());
      const total = (loadConfig(root).flows.find((f) => f.name === result.flow)?.steps || []).length;
      const passed = result.steps.filter((s) => s.ok && !s.after).length;
      return { content: [text(result)], summary: `ran ${result.flow}, ${passed} of ${plural(total, "step")} passed${result.failedAt !== null ? `; failed at step ${result.failedAt}${result.failedIn && result.failedIn !== result.flow ? ` of ${result.failedIn}, which it runs after` : ""}` : ""}${result.seedErrors?.length ? `; ${plural(result.seedErrors.length, "seed problem")}` : ""}` };
    },
    imitor_record_video: async (args) => {
      const result = await recordVideo(root, args);
      recordCaptures(out(), root, "record", result, by());
      return { content: [text(result)], summary: `recorded ${result.flow} (${result.seconds} s)${result.passed ? "" : result.failedAt !== null ? `; failed at step ${result.failedAt}${result.failedIn && result.failedIn !== result.flow ? ` of ${result.failedIn}` : ""}` : "; the seed had problems"}` };
    },
    imitor_read_problems: async () => {
      const result = readProblems(root);
      return { content: [text(result)], summary: `read the last run: ${plural(result.problems.length, "problem")}, ${plural(result.standInsSeen.length, "stand-in")}` };
    },
    imitor_init: async (args) => {
      const dryRun = args.dryRun !== false;
      const result = init(root, { dryRun, force: args.force === true });
      const { changes, conflict, ...rest } = result;
      const files = (changes || []).map((c) => c.file);
      const summary = result.stop ? `could not set up Imitor: ${String(result.stop).split(".")[0]}` : dryRun ? `planned the Imitor setup: ${plural(files.length, "change")}` : `set up Imitor: changed ${files.join(", ") || "nothing"}`;
      // A dry run writes nothing, not even the activity log; nor does a setup that stopped.
      return { content: [text(formatInit(result)), text({ ...rest, changes: files })], summary, noLog: dryRun || Boolean(result.stop) };
    },
    imitor_open_preview: async (args) => {
      const config = loadConfig(root);
      const dir = path.resolve(root, config.out, "app");
      if (!fs.existsSync(path.join(dir, "index.html"))) throw new Error("no preview build. Call imitor_build first.");
      preview ||= await serve(dir);
      return { content: [text({ url: preview.url + (args.route || "/"), note: "Local to this machine. State starts empty; it is an imitation rendered on the web, not a phone." })], summary: `opened the preview at ${args.route || "/"}` };
    },
  };
  const FAILED = { imitor_describe: "read the setup", imitor_build: "build the preview", imitor_screenshot: "take a screenshot", imitor_run_flow: "run a flow", imitor_record_video: "record a video", imitor_read_problems: "read problems", imitor_init: "set up Imitor", imitor_open_preview: "open the preview" };

  // The activity log is for the app; never let writing it break a tool call.
  function log(tool, summary, ok) {
    try {
      appendActivity(out(), { by: by(), tool, text: summary, ok });
    } catch {}
  }

  async function handle(message) {
    const { id, method, params } = message;
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") {
      if (params?.clientInfo?.name) clientName = String(params.clientInfo.name);
      return reply({ protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "imitor", version: VERSION }, instructions: "Imitor renders a React Native / Expo app on the web so you can look at its UI without a simulator. It is an imitation: check `standIns` in results for parts that are not drawn like the real app. Start with imitor_describe, build with imitor_build, then take screenshots or run flows." });
    }
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS });
    if (method === "tools/call") {
      const fn = handlers[params?.name];
      if (!fn) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
      try {
        const { content, summary, noLog } = await fn(params.arguments || {});
        if (!noLog) log(params.name, summary, true);
        return reply({ content });
      } catch (error) {
        const message = scrubForRoot(root, String(error.message));
        const reason = message.split("\n")[0].slice(0, 160);
        if (params.name !== "imitor_init") log(params.name, `tried to ${FAILED[params.name]}: ${reason}`, false);
        return reply({ content: [text(message)], isError: true });
      }
    }
    if (id === undefined) return null; // a notification we do not act on
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `method not found: ${method}` } };
  }
  return { handle, close: () => preview?.close() };
}

export function runStdio(root) {
  const server = createServer(root);
  const rl = readline.createInterface({ input: process.stdin });
  let queue = Promise.resolve();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "parse error" } }) + "\n");
        return;
      }
      const response = await server.handle(message);
      if (response) process.stdout.write(JSON.stringify(response) + "\n");
    });
  });
  // Let stdout drain before leaving; process.exit() here would cut a large reply (a screenshot) short.
  rl.on("close", () => queue.then(() => server.close()));
}
