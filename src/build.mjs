import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

function htmlFiles(dir, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) htmlFiles(full, acc);
    else if (entry.name.endsWith(".html")) acc.push(full);
  }
  return acc;
}

// Load sql.js first, then the app's own scripts in their original order.
function bootLoader(scripts) {
  return `<script>(function(){var q=${JSON.stringify(scripts)};function l(u){return new Promise(function(ok,no){var s=document.createElement("script");s.src=u;s.onload=ok;s.onerror=function(){no(new Error("failed to load "+u))};document.head.appendChild(s)})}
l("/_imitor/sql-wasm.js").then(function(){return initSqlJs({locateFile:function(f){return "/_imitor/"+f}})}).then(function(SQL){globalThis.__imitor={SQL:SQL};return q.reduce(function(p,u){return p.then(function(){return l(u)})},Promise.resolve())}).catch(function(e){console.error("[imitor] boot failed",e)})})()</script>`;
}

export function patchHtml(html) {
  const scripts = [];
  const stripped = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
    if (!src.includes("/_expo/")) return tag;
    scripts.push(src);
    return "";
  });
  if (!scripts.length) return html;
  return stripped.replace("</body>", `${bootLoader(scripts)}</body>`);
}

/** Build the web preview. With quiet: true nothing is printed (needed when stdout carries a protocol). */
export function build(root, config, { quiet = false } = {}) {
  const appDir = path.join(root, config.out, "app");
  fs.rmSync(appDir, { recursive: true, force: true });
  const result = spawnSync("npx", ["expo", "export", "--platform", "web", "--output-dir", appDir], {
    cwd: root,
    stdio: quiet ? ["ignore", "pipe", "pipe"] : "inherit",
    env: { ...process.env, IMITOR: "1", CI: "1", EXPO_NO_TELEMETRY: "1" },
  });
  if (result.status !== 0) {
    const tail = quiet ? `${result.stdout || ""}${result.stderr || ""}`.replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").slice(-25).join("\n") : "";
    throw new Error(quiet ? `expo export failed:\n${tail}` : "expo export failed (see output above)");
  }

  if (Object.values(config.shims).includes("sqljs")) {
    const dist = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
    const dest = path.join(appDir, "_imitor");
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ["sql-wasm.js", "sql-wasm.wasm"]) fs.copyFileSync(path.join(dist, f), path.join(dest, f));
    for (const file of htmlFiles(appDir)) fs.writeFileSync(file, patchHtml(fs.readFileSync(file, "utf8")));
  }
  return appDir;
}
