// A small MCP server over stdio so coding agents can use Imitor without the interface.
// Protocol: newline-delimited JSON-RPC 2.0 (Model Context Protocol, stdio transport). No dependencies.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { describe, readProblems, recordVideo, runFlow, screenshot } from "./agent.mjs";
import { build } from "./build.mjs";
import { loadConfig } from "./config.mjs";
import { serve } from "./serve.mjs";

const VERSION = JSON.parse(fs.readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const target = { device: { type: "string", description: "Device name, e.g. iphone-16, iphone-se, pixel-9. Defaults to the first device in imitor.config.json." }, scheme: { type: "string", enum: ["light", "dark"], description: "Colour scheme. Defaults to the first scheme in the config." } };

export const TOOLS = [
  { name: "imitor_describe", description: "List the flows, devices and stand-ins configured for this app, and whether a preview build exists. Call this first.", inputSchema: { type: "object", properties: {} } },
  { name: "imitor_build", description: "Build the web preview of the app as it is on disk now. Takes about a minute. Needed before any other tool, and again after code changes.", inputSchema: { type: "object", properties: {} } },
  { name: "imitor_screenshot", description: "Take one screenshot and return it as an image. Reach the screen with `route` (deep link), with `flow` (runs that flow's steps first), with inline `steps`, or a combination. Each call starts from a fresh, empty app state. The result lists stand-ins visible in the shot: parts that are NOT rendered like the real app.", inputSchema: { type: "object", properties: { route: { type: "string", description: "Path to open, e.g. /settings" }, flow: { type: "string", description: "Name of a configured flow to run before the shot" }, steps: { type: "array", description: 'Extra steps to run before the shot, e.g. [{"tap":"Continue"},{"fill":{"placeholder":"Name","value":"Ada"}}]', items: { type: "object" } }, ...target, fullPage: { type: "boolean", description: "Capture the whole scroll height" }, name: { type: "string", description: "File name for the capture, without extension" } } } },
  { name: "imitor_run_flow", description: "Run one configured flow step by step. Returns each step's result, the shots it took, and where it failed if it did (with a screenshot of that moment).", inputSchema: { type: "object", properties: { flow: { type: "string" }, ...target }, required: ["flow"] } },
  { name: "imitor_record_video", description: "Record a .webm video of one configured flow as it plays, with animations on. Returns the file path.", inputSchema: { type: "object", properties: { flow: { type: "string" }, ...target }, required: ["flow"] } },
  { name: "imitor_read_problems", description: "Read the problems (failed steps, page errors), stand-ins seen and coverage limits from the last full run.", inputSchema: { type: "object", properties: {} } },
  { name: "imitor_open_preview", description: "Serve the built preview locally and return a URL a person can open to click around. The server stays up while this MCP server runs.", inputSchema: { type: "object", properties: { route: { type: "string", description: "Path to open, e.g. /settings" } } } },
];

export function createServer(root) {
  let preview = null;
  const text = (value) => ({ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) });
  const handlers = {
    imitor_describe: async () => [text(describe(root))],
    imitor_build: async () => {
      const started = Date.now();
      const dir = build(root, loadConfig(root), { quiet: true });
      return [text({ built: path.relative(root, dir), seconds: Math.round((Date.now() - started) / 1000) })];
    },
    imitor_screenshot: async (args) => {
      const result = await screenshot(root, { ...args, scale: 1 });
      const image = fs.readFileSync(path.join(root, result.file)).toString("base64");
      return [text(result), { type: "image", data: image, mimeType: "image/png" }];
    },
    imitor_run_flow: async (args) => [text(await runFlow(root, args))],
    imitor_record_video: async (args) => [text(await recordVideo(root, args))],
    imitor_read_problems: async () => [text(readProblems(root))],
    imitor_open_preview: async (args) => {
      const config = loadConfig(root);
      const dir = path.join(root, config.out, "app");
      if (!fs.existsSync(path.join(dir, "index.html"))) throw new Error("no preview build. Call imitor_build first.");
      preview ||= await serve(dir);
      return [text({ url: preview.url + (args.route || "/"), note: "Local to this machine. State starts empty; it is an imitation rendered on the web, not a phone." })];
    },
  };

  async function handle(message) {
    const { id, method, params } = message;
    const reply = (result) => ({ jsonrpc: "2.0", id, result });
    if (method === "initialize") return reply({ protocolVersion: params?.protocolVersion || "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "imitor", version: VERSION }, instructions: "Imitor renders a React Native / Expo app on the web so you can look at its UI without a simulator. It is an imitation: check `standIns` in results for parts that are not drawn like the real app. Start with imitor_describe, build with imitor_build, then take screenshots or run flows." });
    if (method === "ping") return reply({});
    if (method === "tools/list") return reply({ tools: TOOLS });
    if (method === "tools/call") {
      const fn = handlers[params?.name];
      if (!fn) return { jsonrpc: "2.0", id, error: { code: -32602, message: `unknown tool ${params?.name}` } };
      try {
        return reply({ content: await fn(params.arguments || {}) });
      } catch (error) {
        return reply({ content: [text(String(error.message))], isError: true });
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
