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

/**
 * Libraries loaded before the app's scripts, keyed by the stand-in kind that needs them. Each is an Emscripten build:
 * a loader script that defines a global init function, and a .wasm file it fetches through locateFile. `ready` runs in
 * the page once the script has loaded and must leave the library where the app's code reads it.
 */
const BOOT = {
  // The expo-sqlite stand-in reads globalThis.__imitor.SQL.
  sqljs: { script: "sql-wasm.js", ready: `initSqlJs({locateFile:f}).then(function(SQL){(globalThis.__imitor=globalThis.__imitor||{}).SQL=SQL})` },
  // React Native Skia's web build reads global.CanvasKit when it is first imported (Skia.web.js) and skips its own
  // LoadSkiaWeb when it is already set.
  canvaskit: { script: "canvaskit.js", ready: `CanvasKitInit({locateFile:f}).then(function(CK){globalThis.CanvasKit=CK})` },
};
export const BOOT_KINDS = Object.keys(BOOT);

/**
 * Set on window by the boot loader when a library or an app script fails to load, so the app never started. The runner
 * (shoot.mjs) reads it and fails the flow instead of taking a shot of a blank page.
 */
export const BOOT_ERROR = "__imitorBootError";

/** Load the boot libraries side by side, then the app's own scripts one after another in their original order. */
function bootLoader(scripts, kinds) {
  const libs = kinds.map((k) => `l("/_imitor/${BOOT[k].script}").then(function(){return ${BOOT[k].ready}})`);
  return `<script>(function(){var q=${JSON.stringify(scripts)};function f(n){return "/_imitor/"+n}function l(u){return new Promise(function(ok,no){var s=document.createElement("script");s.src=u;s.onload=ok;s.onerror=function(){no(new Error("failed to load "+u))};document.head.appendChild(s)})}
Promise.all([${libs.join(",")}]).then(function(){return q.reduce(function(p,u){return p.then(function(){return l(u)})},Promise.resolve())}).catch(function(e){window.${BOOT_ERROR}=String(e&&e.message||e);console.error("[imitor] boot failed",e)})})()</script>`;
}

/** The boot libraries the configured stand-ins need, in a fixed order. */
export const bootKinds = (shims) => BOOT_KINDS.filter((k) => Object.values(shims || {}).includes(k));

/** The folder of package `name` as Node would find it from each of `from` in turn (node_modules up the tree), or null. */
function findPackage(name, from) {
  for (const start of from) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      const pkg = path.join(dir, "node_modules", name);
      if (fs.existsSync(path.join(pkg, "package.json"))) return fs.realpathSync(pkg);
      if (path.dirname(dir) === dir) break;
    }
  }
  return null;
}

/**
 * Where each boot library's files come from. sql.js is Imitor's own dependency. CanvasKit must be the build the app's
 * React Native Skia was made for, so it is resolved from the app: next to @shopify/react-native-skia first, then from
 * the app folder. Throws, saying what to install, when it is missing.
 */
export function bootSources(root, kinds) {
  const sources = {};
  if (kinds.includes("sqljs")) {
    const dist = path.dirname(require.resolve("sql.js/dist/sql-wasm.js"));
    sources["sql-wasm.js"] = path.join(dist, "sql-wasm.js");
    sources["sql-wasm.wasm"] = path.join(dist, "sql-wasm.wasm");
  }
  if (kinds.includes("canvaskit")) {
    const skiaDir = findPackage("@shopify/react-native-skia", [root]);
    let wanted = null;
    try {
      wanted = JSON.parse(fs.readFileSync(path.join(skiaDir, "package.json"), "utf8")).dependencies?.["canvaskit-wasm"] || null;
    } catch {}
    const dir = findPackage("canvaskit-wasm", [skiaDir, root].filter(Boolean));
    const full = dir && path.join(dir, "bin", "full");
    if (!full || !fs.existsSync(path.join(full, "canvaskit.wasm"))) {
      throw new Error(
        `the "canvaskit" kind needs canvaskit-wasm, and it cannot be found from ${path.resolve(root)}. ` +
          (skiaDir
            ? `@shopify/react-native-skia depends on canvaskit-wasm@${wanted || "?"}; reinstall the app's packages (npm install) or add it: npm i -D canvaskit-wasm@${wanted || "<the version Skia wants>"}`
            : `Install @shopify/react-native-skia in the app (it brings canvaskit-wasm), or use the "skia" kind.`)
      );
    }
    // The "full" build, as Skia's own LoadSkiaWeb imports (canvaskit-wasm/bin/full/canvaskit): it includes paragraphs.
    sources["canvaskit.js"] = path.join(full, "canvaskit.js");
    sources["canvaskit.wasm"] = path.join(full, "canvaskit.wasm");
  }
  return sources;
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

/**
 * Add the media override to the top of <head>, and with `boot` (the kinds whose libraries must load first: "sqljs",
 * "canvaskit"; true means ["sqljs"]) put the app's scripts behind the boot loader.
 */
export function patchHtml(html, { boot = true } = {}) {
  let out = html;
  const kinds = boot === true ? ["sqljs"] : (boot || []).filter((k) => BOOT[k]);
  if (kinds.length) {
    const scripts = [];
    const stripped = html.replace(/<script\b[^>]*\bsrc="([^"]+)"[^>]*><\/script>/g, (tag, src) => {
      if (!src.includes("/_expo/")) return tag;
      scripts.push(src);
      return "";
    });
    if (scripts.length) out = stripped.replace("</body>", `${bootLoader(scripts, kinds)}</body>`);
  }
  if (out.includes(MEDIA_MARKER)) return out;
  return /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, (m) => m + MEDIA_OVERRIDE) : MEDIA_OVERRIDE + out;
}

/** Build the web preview. With quiet: true nothing is printed (needed when stdout carries a protocol). */
export function build(root, config, { quiet = false } = {}) {
  const boot = bootKinds(config.shims);
  const sources = bootSources(root, boot); // before the export, so a missing library fails fast
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

  patchBuild(appDir, boot, sources);
  return appDir;
}

/** After the export: copy the boot libraries (from bootSources) into _imitor/ and patch every page. */
export function patchBuild(appDir, boot, sources) {
  if (boot.length) {
    const dest = path.join(appDir, "_imitor");
    fs.mkdirSync(dest, { recursive: true });
    for (const [name, from] of Object.entries(sources)) fs.copyFileSync(from, path.join(dest, name));
  }
  for (const file of htmlFiles(appDir)) fs.writeFileSync(file, patchHtml(fs.readFileSync(file, "utf8"), { boot }));
}
