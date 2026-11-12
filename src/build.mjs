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
l("/_imitor/sql-wasm.js").then(function(){return initSqlJs({locateFile:function(f){return "/_imitor/"+f}})}).then(function(SQL){globalThis.__imitor=Object.assign(globalThis.__imitor||{},{SQL:SQL});return q.reduce(function(p,u){return p.then(function(){return l(u)})},Promise.resolve())}).catch(function(e){console.error("[imitor] boot failed",e)})})()</script>`;
}

/**
 * Colour scheme and motion overrides, run before any of the app's scripts. With ?imitor-scheme=dark|light or
 * ?imitor-motion=reduce|no-preference in the address (kept in sessionStorage, so reloads and in-app navigation keep it;
 * "auto" clears it), window.matchMedia answers prefers-color-scheme and prefers-reduced-motion queries accordingly,
 * and those answers never change, so their change listeners never fire. The parameters are removed from the address
 * before the app reads it. window.__imitorMedia says what is in force. The live preview in `imitor app` relies on it.
 */
export const MEDIA_MARKER = "__imitorMedia";
export const MEDIA_OVERRIDE = `<script>(function(){var P={"imitor-scheme":["dark","light"],"imitor-motion":["reduce","no-preference"]},u=new URL(location.href),v={},k,s=null;try{s=window.sessionStorage}catch(e){}
for(k in P){var x=u.searchParams.get(k);if(x!==null){u.searchParams.delete(k);try{if(P[k].indexOf(x)>=0)s.setItem(k,x);else s.removeItem(k)}catch(e){}if(P[k].indexOf(x)>=0)v[k]=x}if(!v[k]){try{x=s.getItem(k)}catch(e){x=null}if(P[k].indexOf(x)>=0)v[k]=x}}
if(u.href!==location.href)try{history.replaceState(history.state,"",u.pathname+u.search+u.hash)}catch(e){}
var scheme=v["imitor-scheme"]||null,motion=v["imitor-motion"]||null;window.__imitorMedia={version:1,scheme:scheme,motion:motion};if(!scheme&&!motion||!window.matchMedia)return;
var real=window.matchMedia.bind(window);function fixed(media,matches){var l=function(){};return{media:media,matches:matches,onchange:null,addListener:l,removeListener:l,addEventListener:l,removeEventListener:l,dispatchEvent:function(){return false}}}
window.matchMedia=function(query){var q=String(query).toLowerCase().replace(/\\s+/g,""),m;
if(scheme&&(m=/^\\(prefers-color-scheme:(dark|light)\\)$/.exec(q)))return fixed(String(query),m[1]===scheme);
if(motion&&(m=/^\\(prefers-reduced-motion(?::(reduce|no-preference))?\\)$/.exec(q)))return fixed(String(query),(m[1]||"reduce")===motion);
return real(query)}})()</script>`;

/** Add the media override to the top of <head>, and with `boot` (the sqljs stand-in) put the app's scripts behind the boot loader. */
export function patchHtml(html, { boot = true } = {}) {
  let out = html;
  if (boot) {
    const scripts = [];
    const stripped = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
      if (!src.includes("/_expo/")) return tag;
      scripts.push(src);
      return "";
    });
    if (scripts.length) out = stripped.replace("</body>", `${bootLoader(scripts)}</body>`);
  }
  if (out.includes(MEDIA_MARKER)) return out;
  return /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + MEDIA_OVERRIDE) : MEDIA_OVERRIDE + out;
}

/** Build the web preview. With quiet: true nothing is printed (needed when stdout carries a protocol). */
export function build(root, config, { quiet = false } = {}) {
  const appDir = path.resolve(root, config.out, "app");
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

  const boot = Object.values(config.shims).includes("sqljs");
  if (boot) {
    const dist = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
    const dest = path.join(appDir, "_imitor");
    fs.mkdirSync(dest, { recursive: true });
    for (const f of ["sql-wasm.js", "sql-wasm.wasm"]) fs.copyFileSync(path.join(dist, f), path.join(dest, f));
  }
  for (const file of htmlFiles(appDir)) fs.writeFileSync(file, patchHtml(fs.readFileSync(file, "utf8"), { boot }));
  return appDir;
}
