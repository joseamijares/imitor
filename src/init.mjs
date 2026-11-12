// `imitor init`: set Imitor up in an Expo app's folder. It plans every change first, prints each as a diff,
// and writes only when nothing stops it. It never installs anything.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { bootSources } from "./build.mjs";

const TABLE = JSON.parse(fs.readFileSync(new URL("./standins.json", import.meta.url), "utf8")).packages;
export const DEFAULT_OUT = "preview";
// Folders an Expo project usually ignores already, tried in order when .gitignore must not be edited.
const IGNORED_CANDIDATES = ["dist", "web-build", ".expo"];
// Until imitor is on npm, installs come from GitHub. Remove this once `npm publish` has run (see RELEASING.md).
export const UNPUBLISHED_NOTE = "imitor is not on npm yet: until it is, install it with github:joseamijares/imitor in place of imitor.";

const WRAP = 'require("imitor/metro").withImitor';
const METRO_MANUAL = `Wrap what your Metro config exports, keeping everything else as it is:\n  module.exports = require("imitor/metro").withImitor(config);\nFor an ES module config: import imitor from "imitor/metro"; export default imitor.withImitor(config);`;
const NEW_METRO = `// Learn more https://docs.expo.dev/guides/customizing-metro
const { getDefaultConfig } = require("expo/metro-config");

const config = getDefaultConfig(__dirname);

// Imitor swaps native-only modules for web stand-ins, only when it runs the build (IMITOR=1).
module.exports = ${WRAP}(config);
`;

const read = (file) => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null);
const readJson = (file) => {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
};

// ---------------------------------------------------------------- project and Expo config

function readExpoConfig(root) {
  const dynamic = ["app.config.ts", "app.config.js", "app.config.cjs", "app.config.mjs"].find((f) => fs.existsSync(path.join(root, f)));
  const fromJson = () => {
    const raw = readJson(path.join(root, "app.json"));
    return raw ? raw.expo || raw : null;
  };
  if (!dynamic) return { config: fromJson() || {}, source: fs.existsSync(path.join(root, "app.json")) ? "app.json" : "none", dynamic: null };
  // Evaluate it with the app's own Expo CLI, never one fetched from the network.
  let cli;
  try {
    cli = createRequire(path.join(root, "package.json")).resolve("expo/bin/cli");
  } catch {
    return { config: fromJson() || {}, source: "app.json", dynamic, note: `could not evaluate ${dynamic}: expo is not installed here, so read ${fs.existsSync(path.join(root, "app.json")) ? "app.json" : "nothing"} instead` };
  }
  const result = spawnSync(process.execPath, [cli, "config", "--json", "--type", "public"], { cwd: root, encoding: "utf8", timeout: 60000, env: { ...process.env, EXPO_NO_TELEMETRY: "1", CI: "1" } });
  const text = result.stdout || "";
  try {
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${(result.stderr || "").replace(/\x1b\[[0-9;]*m/g, "").trim().split("\n").pop() || "no message"}; exit ${result.status}`);
    return { config: JSON.parse(text.slice(text.indexOf("{"))), source: dynamic, dynamic };
  } catch (error) {
    return { config: fromJson() || {}, source: "app.json", dynamic, note: `could not evaluate ${dynamic} (${String(error.message).slice(0, 160)}), so read ${fs.existsSync(path.join(root, "app.json")) ? "app.json" : "nothing"} instead` };
  }
}

function usesFingerprint(root, expo, dynamic) {
  const reasons = [];
  const policy = (v) => v && typeof v === "object" && v.policy === "fingerprint";
  if (policy(expo.runtimeVersion) || policy(expo.ios?.runtimeVersion) || policy(expo.android?.runtimeVersion)) reasons.push('"runtimeVersion": { "policy": "fingerprint" }');
  // An app config we could not evaluate may still set it.
  else if (dynamic && /policy\s*:\s*["']fingerprint["']/.test(read(path.join(root, dynamic)) || "")) reasons.push(`"policy": "fingerprint" in ${dynamic}`);
  const fp = ["fingerprint.config.js", "fingerprint.config.cjs", "fingerprint.config.mjs", "fingerprint.config.ts"].find((f) => fs.existsSync(path.join(root, f)));
  if (fp) reasons.push(fp);
  return reasons;
}

export function detectPackageManager(root, pkg = readJson(path.join(root, "package.json")) || {}) {
  const field = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : null;
  const locks = [["bun.lock", "bun"], ["bun.lockb", "bun"], ["pnpm-lock.yaml", "pnpm"], ["yarn.lock", "yarn"], ["package-lock.json", "npm"]].filter(([f]) => fs.existsSync(path.join(root, f))).map(([, pm]) => pm);
  if (field && ["npm", "yarn", "pnpm", "bun"].includes(field) && (!locks.length || locks.includes(field))) return field;
  return locks[0] || field || "npm";
}

function installCommands(pm, missing) {
  const add = { npm: "npm i -D", yarn: "yarn add -D", pnpm: "pnpm add -D", bun: "bun add -d" }[pm];
  const exec = { npm: "npx", yarn: "yarn", pnpm: "pnpm exec", bun: "bunx" }[pm];
  return { install: missing.length ? `${add} ${missing.join(" ")}` : null, browser: `${exec} playwright install chromium` };
}

// ---------------------------------------------------------------- Metro

/** Find the expression assigned by the one `module.exports =` statement: { start, end } offsets, or a reason it can't. */
export function findExportExpression(src) {
  const re = /(^|[\s;])module\.exports\s*=(?!=)\s*/g;
  const hits = [];
  for (let m; (m = re.exec(src)); ) if (!inCommentOrString(src, m.index + m[1].length)) hits.push(m);
  if (hits.length === 0) return { reason: "it has no `module.exports =`" };
  if (hits.length > 1) return { reason: "it assigns `module.exports` more than once" };
  const start = hits[0].index + hits[0][0].length;
  let depth = 0;
  let lastCode = -1;
  for (let i = start; i < src.length; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); if (i < 0) break; i--; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0) return { reason: "a comment is not closed" }; i = e + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { const e = skipString(src, i); if (e < 0) return { reason: "a string is not closed" }; i = e; lastCode = i; continue; }
    if ("([{".includes(c)) depth++;
    else if (")]}".includes(c)) { depth--; if (depth < 0) break; }
    else if (depth === 0 && c === ";") break;
    else if (depth === 0 && c === "\n" && lastCode >= 0) {
      const prev = src[lastCode];
      const next = src.slice(i).match(/^\s*(\S)/)?.[1];
      if (!".,(=+-*/?:&|".includes(prev) && !(next && ".?)".includes(next))) break;
    }
    if (!/\s/.test(c)) lastCode = i;
  }
  if (depth !== 0) return { reason: "its brackets do not balance" };
  if (lastCode < start) return { reason: "`module.exports =` has nothing after it" };
  return { start, end: lastCode + 1 };
}

function skipString(src, i) {
  const q = src[i];
  for (let j = i + 1, depth = 0; j < src.length; j++) {
    if (src[j] === "\\") { j++; continue; }
    if (q === "`" && src[j] === "$" && src[j + 1] === "{") { depth++; j++; continue; }
    if (q === "`" && depth && src[j] === "}") { depth--; continue; }
    if (src[j] === q && !depth) return j;
    if (q !== "`" && src[j] === "\n") return -1;
  }
  return -1;
}

// Rough check that a position is not inside a comment or a string, scanning from the top of the file.
function inCommentOrString(src, pos) {
  for (let i = 0; i < pos; i++) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { const e = src.indexOf("\n", i); if (e < 0 || e >= pos) return true; i = e; continue; }
    if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); if (e < 0 || e >= pos) return true; i = e + 1; continue; }
    if (c === '"' || c === "'" || c === "`") { const e = skipString(src, i); if (e < 0 || e >= pos) return true; i = e; }
  }
  return false;
}

/** Wrap a CommonJS Metro config's export with withImitor. Returns { text } (unchanged when already wrapped) or { reason }. */
export function wrapMetroConfig(src) {
  if (/imitor\/metro["']\s*\)\s*\.withImitor\s*\(|withImitor\s*\(/.test(src) && src.includes("imitor/metro")) return { text: src, already: true };
  if (/^\s*export\s+(default|const|\{)/m.test(src) || /^\s*import\s.+from\s/m.test(src)) return { reason: "it is an ES module (import/export)" };
  const found = findExportExpression(src);
  if (found.reason) return found;
  const expr = src.slice(found.start, found.end);
  // The shapes we know: an identifier, or a call (getDefaultConfig(__dirname), someWrapper(config), a.b(c)(d)).
  const ident = /^[A-Za-z_$][\w$]*$/.test(expr);
  const call = /^[A-Za-z_$][\w$]*(\s*\.\s*[A-Za-z_$][\w$]*)*\s*\(/.test(expr) && expr.endsWith(")");
  if (!ident && !call) return { reason: `it exports \`${expr.length > 40 ? expr.slice(0, 40) + "..." : expr}\`, which is not a config variable or a call that returns one` };
  return { text: src.slice(0, found.start) + `${WRAP}(${expr})` + src.slice(found.end) };
}

function planMetro(root, pkg, plan) {
  const name = ["metro.config.js", "metro.config.cjs", "metro.config.mjs", "metro.config.ts", "metro.config.json"].find((f) => fs.existsSync(path.join(root, f)));
  if (!name) {
    // In a "type": "module" package a .js file is an ES module; Metro also reads metro.config.cjs.
    const file = pkg.type === "module" ? "metro.config.cjs" : "metro.config.js";
    plan.changes.push({ file, before: null, after: NEW_METRO, why: "no Metro config yet: the standard Expo one, already wrapped" });
    return;
  }
  const esm = name.endsWith(".mjs") || name.endsWith(".ts") || (name === "metro.config.js" && pkg.type === "module");
  const src = read(path.join(root, name));
  if (src.includes("imitor/metro") && src.includes("withImitor")) return plan.unchanged.push(`${name} already uses withImitor`);
  if (esm || name.endsWith(".json")) return plan.manual.push({ file: name, reason: `${name} is ${name.endsWith(".json") ? "JSON" : "an ES module"}, which init does not edit`, how: METRO_MANUAL });
  const result = wrapMetroConfig(src);
  if (result.reason) return plan.manual.push({ file: name, reason: `init did not recognise the shape of ${name}: ${result.reason}`, how: METRO_MANUAL });
  plan.changes.push({ file: name, before: src, after: result.text, why: "wrap the exported config with withImitor (it does nothing unless Imitor runs the build)" });
}

// ---------------------------------------------------------------- stand-ins

function walkFiles(dir, acc = [], depth = 0) {
  if (depth > 5) return acc;
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {}
  for (const e of entries) {
    if (e.name === "node_modules" || e.name.startsWith(".") || ["ios", "android", "__tests__", "__mocks__"].includes(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(full, acc, depth + 1);
    else acc.push(full);
  }
  return acc;
}

/** What a package folder says about web support: { native, webSignal, nativeLoad }. */
export function inspectPackage(dir) {
  const native = ["ios", "android"].filter((d) => fs.existsSync(path.join(dir, d)));
  const pkg = readJson(path.join(dir, "package.json")) || {};
  const files = walkFiles(dir).map((f) => path.relative(dir, f));
  const set = new Set(files);
  let webSignal = null;
  if (pkg.browser) webSignal = "a browser field";
  if (!webSignal && (readJson(path.join(dir, "expo-module.config.json"))?.platforms || []).includes("web")) webSignal = "web in expo-module.config.json";
  if (!webSignal) {
    const web = files.find((f) => /\.web\.[cm]?[jt]sx?$/.test(f) && !f.endsWith(".d.ts"));
    if (web) webSignal = web;
  }
  if (!webSignal) {
    for (const f of files) {
      const m = /^(.*)\.(native|ios|android)\.([cm]?[jt]sx?)$/.exec(f);
      if (m && !f.endsWith(".d.ts") && ["js", "ts", "tsx", "jsx"].some((x) => set.has(`${m[1]}.${x}`))) {
        webSignal = `${m[1]}.${m[3]} next to ${path.basename(f)}`;
        break;
      }
    }
  }
  // A native module loaded at import time, outside a try block, throws on web.
  let nativeLoad = null;
  if (!webSignal) {
    for (const f of files.filter((x) => /\.[cm]?[jt]sx?$/.test(x) && !/\.d\.ts$|\.test\.|\.spec\./.test(x))) {
      const src = read(path.join(dir, f)) || "";
      const re = /\b(requireNativeModule|requireNativeViewManager|requireNativeView|TurboModuleRegistry\.getEnforcing)\s*\(/g;
      for (let m; (m = re.exec(src)); ) {
        const before = src.slice(Math.max(0, m.index - 300), m.index);
        const tryAt = before.lastIndexOf("try");
        if (tryAt >= 0 && !before.slice(tryAt).includes("catch")) continue;
        nativeLoad = `${m[1]} in ${f}`;
        break;
      }
      if (nativeLoad) break;
    }
  }
  return { native, webSignal, nativeLoad };
}

function packageDir(root, name) {
  try {
    return path.dirname(createRequire(path.join(root, "package.json")).resolve(`${name}/package.json`));
  } catch {
    const dir = path.join(root, "node_modules", name);
    return fs.existsSync(path.join(dir, "package.json")) ? dir : null;
  }
}

function localModules(root, pkg) {
  const configured = pkg.expo?.autolinking?.nativeModulesDir;
  const dir = path.resolve(root, configured || "modules");
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isDirectory() && (fs.existsSync(path.join(dir, e.name, "expo-module.config.json")) || fs.existsSync(path.join(dir, e.name, "package.json"))))
    .map((e) => ({ name: readJson(path.join(dir, e.name, "package.json"))?.name || e.name, dir: path.join(dir, e.name), rel: path.relative(root, path.join(dir, e.name)) }));
}

// The packages every Expo web build has; nothing to propose or check.
const CORE = new Set(["expo", "react", "react-dom", "react-native", "react-native-web", "@expo/metro-runtime"]);

/**
 * The kind to propose for a table entry. An entry with `fallback` (React Native Skia) names a kind that needs a library
 * from the app (canvaskit needs canvaskit-wasm): it is proposed when the build would find that library, the same way
 * `imitor build` looks for it (bootSources), and the fallback otherwise, saying why.
 */
function chooseKind(root, known) {
  if (!known.fallback) return { kind: known.kind, why: known.why };
  try {
    const sources = bootSources(root, [known.kind]);
    const found = Object.values(sources)[0];
    return { kind: known.kind, why: `${known.why} Found ${path.relative(root, path.dirname(found)) || "."}, so it draws for real.` };
  } catch (error) {
    return { kind: known.fallback, why: `${known.fallbackWhy} Not "${known.kind}", which draws for real, because ${String(error.message).replace(/\.?$/, ".")} Once it is installed, change it to "${known.kind}".` };
  }
}

export function proposeStandIns(root, pkg) {
  const shims = {};
  const proposed = [];
  const noneNeeded = [];
  const mayNeed = [];
  const notInstalled = [];
  for (const name of Object.keys(pkg.dependencies || {}).sort()) {
    if (CORE.has(name)) continue;
    const known = TABLE[name];
    if (known) {
      if (known.kind === "none") noneNeeded.push(name);
      else {
        const pick = chooseKind(root, known);
        shims[name] = pick.kind;
        proposed.push({ package: name, standIn: pick.kind, why: pick.why });
      }
      continue;
    }
    const dir = packageDir(root, name);
    if (!dir) {
      notInstalled.push(name);
      continue;
    }
    const info = inspectPackage(dir);
    if (info.native.length && !info.webSignal) mayNeed.push({ package: name, why: `has ${info.native.join(" and ")} code and no web entry${info.nativeLoad ? `; calls ${info.nativeLoad}` : ""}` });
  }
  for (const mod of localModules(root, pkg)) {
    const info = inspectPackage(mod.dir);
    if (info.webSignal) continue;
    if (info.nativeLoad) mayNeed.push({ package: mod.name, local: mod.rel, why: `local module that calls ${info.nativeLoad} at import, which throws on web` });
    else if (info.native.length) noneNeeded.push(`${mod.name} (${mod.rel}: loads its native module optionally or inside try)`);
  }
  return { shims, proposed, noneNeeded, mayNeed, notInstalled };
}

// ---------------------------------------------------------------- ignore files

function globToRegex(glob) {
  return new RegExp("^" + glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\?/g, "[^/]").replace(/\u0000/g, ".*") + "$");
}

/** Whether an ignore file (gitignore syntax, simplified) ignores the folder `dir` (relative, no trailing slash). */
export function ignores(text, dir) {
  if (!text) return false;
  const parts = dir.split("/");
  const prefixes = parts.map((_, i) => parts.slice(0, i + 1).join("/"));
  let ignored = false;
  for (let line of text.split("\n")) {
    line = line.trim();
    if (!line || line.startsWith("#")) continue;
    const negate = line.startsWith("!");
    if (negate) line = line.slice(1);
    const anchored = line.startsWith("/") || line.replace(/\/$/, "").includes("/");
    const pattern = line.replace(/^\//, "").replace(/\/\*\*$/, "").replace(/\/$/, "");
    if (!pattern) continue;
    const re = globToRegex(pattern);
    const hit = prefixes.some((p) => re.test(p) || (!anchored && re.test(p.split("/").pop())));
    if (hit) ignored = !negate;
  }
  return ignored;
}

function planIgnores(root, fingerprint, plan) {
  const gitignore = read(path.join(root, ".gitignore"));
  const easignore = read(path.join(root, ".easignore"));
  let out = DEFAULT_OUT;
  if (fingerprint.length) {
    if (!ignores(gitignore, DEFAULT_OUT)) {
      const parent = IGNORED_CANDIDATES.find((d) => ignores(gitignore, `${d}/imitor`));
      if (parent) {
        out = `${parent}/imitor`;
        plan.notes.push(`This app uses Expo's fingerprint for its runtime version (${fingerprint.join(", ")}), which hashes .gitignore: editing it would change the runtime version and force new store builds. So init leaves .gitignore alone and writes Imitor's output to ${out}/, which .gitignore already ignores through ${parent}/.${parent === "dist" ? " `expo export` writes to dist/ by default and replaces it, which also removes Imitor's output and run history; Imitor rebuilds its part on the next run." : ""}`);
      } else {
        plan.notes.push(`This app uses Expo's fingerprint for its runtime version (${fingerprint.join(", ")}), which hashes .gitignore, so init did not edit it. No folder it already ignores fits, so the output stays in ${DEFAULT_OUT}/: add ${DEFAULT_OUT}/ to .gitignore together with your next native change, or set "out" in imitor.config.json to a folder that is ignored.`);
      }
    }
    if (easignore !== null && !ignores(easignore, out)) plan.notes.push(`.easignore does not ignore ${out}/, so EAS would upload it with your project. init did not edit .easignore (fingerprint project); add ${out}/ to it when you next change native code.`);
  } else {
    const append = (file, text) => {
      const lines = `${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}# Imitor output\n${DEFAULT_OUT}/\n`;
      plan.changes.push({ file, before: text, after: (text || "") + lines, why: `keep Imitor's output (${DEFAULT_OUT}/) out of ${file === ".gitignore" ? "git" : "EAS uploads"}` });
    };
    if (!ignores(gitignore, DEFAULT_OUT)) append(".gitignore", gitignore);
    else plan.unchanged.push(`.gitignore already ignores ${DEFAULT_OUT}/`);
    if (easignore !== null && !ignores(easignore, DEFAULT_OUT)) append(".easignore", easignore);
  }
  // ESLint flat config: tell, do not edit.
  const eslint = ["eslint.config.js", "eslint.config.mjs", "eslint.config.cjs", "eslint.config.ts"].find((f) => fs.existsSync(path.join(root, f)));
  if (eslint) {
    const src = read(path.join(root, eslint));
    const top = out.split("/")[0].replace(/[.]/g, "\\.");
    const listed = new RegExp(`["'\`](\\./)?${top}(["'\`/*]|$)`).test(src) && /globalIgnores|ignores\s*:/.test(src);
    if (!listed) plan.notes.push(`${eslint} does not ignore ${out}/, so \`eslint .\` would lint the built preview. Add "${out}/**" to its ignores yourself${/globalIgnores/.test(src) ? ", in globalIgnores([...])" : ""} (init does not edit lint config).`);
  }
  return out;
}

// ---------------------------------------------------------------- the plan

/**
 * Work out every change `imitor init` would make in `root`. Writes nothing.
 * Returns { ok, stop?, app, packageManager, changes[{file, before, after, why}], unchanged[], manual[], notes[], standIns, config, install, nextSteps }.
 */
export function planInit(root, { force = false } = {}) {
  const pkgFile = path.join(root, "package.json");
  if (!fs.existsSync(pkgFile)) return { ok: false, stop: `no package.json in ${root}. Run imitor init in the app's folder.` };
  const pkg = readJson(pkgFile);
  if (!pkg) return { ok: false, stop: "package.json is not valid JSON." };
  const deps = { ...pkg.devDependencies, ...pkg.dependencies };
  if (!deps.expo) {
    if (deps["react-native"]) {
      return { ok: false, stop: "This is a React Native app without Expo (no `expo` in package.json). Imitor builds the web preview with `expo export --platform web`, so it supports Expo apps only, including Expo apps with their own ios/ and android/ folders. Bare React Native is on the roadmap. If you add Expo to this app (npx install-expo-modules, then react-native-web and react-dom), run imitor init again." };
    }
    return { ok: false, stop: "No `expo` in package.json: this does not look like an Expo app. Imitor works with Expo apps (React Native with Expo)." };
  }

  const plan = { ok: true, changes: [], unchanged: [], manual: [], notes: [] };
  const expo = readExpoConfig(root);
  if (expo.note) plan.notes.push(expo.note);
  const app = expo.config;
  plan.app = { name: app.name || pkg.name || path.basename(root), configFrom: expo.source };
  plan.packageManager = detectPackageManager(root, pkg);

  planMetro(root, pkg, plan);
  plan.standIns = proposeStandIns(root, pkg);
  const out = planIgnores(root, usesFingerprint(root, app, expo.dynamic), plan);

  const style = app.userInterfaceStyle || app.ios?.userInterfaceStyle || app.android?.userInterfaceStyle;
  const schemes = style === "dark" ? ["dark"] : style === "automatic" ? ["light", "dark"] : ["light"];
  if (!style) plan.notes.push('No userInterfaceStyle in the Expo config, and Expo then defaults to "light", so only light shots are set up. Add "dark" to "schemes" if the app follows the system appearance.');
  const landscape = /^landscape/.test(app.orientation || "");
  const device = landscape ? { name: "iphone-16-landscape", width: 852, height: 393, scale: 2, platform: "ios" } : "iphone-16";

  const config = {
    ...(out !== DEFAULT_OUT ? { out } : {}),
    shims: plan.standIns.shims,
    devices: [device],
    schemes,
    flows: [{ name: "home", start: "/", steps: [{ shot: "home" }] }],
  };
  plan.config = config;
  const configText = JSON.stringify(config, null, 2) + "\n";
  const existing = read(path.join(root, "imitor.config.json"));
  if (existing === null) plan.changes.push({ file: "imitor.config.json", before: null, after: configText, why: "stand-ins, one device, the app's colour schemes and a first flow that opens / and takes one shot" });
  else if (existing === configText) plan.unchanged.push("imitor.config.json is already what init would write");
  else if (force) plan.changes.push({ file: "imitor.config.json", before: existing, after: configText, why: "--force: replace the existing config" });
  else {
    plan.ok = false;
    plan.stop = "imitor.config.json already exists and differs from what init would write (diff below). Nothing was written. Keep yours, or run imitor init --force to replace it.";
    plan.conflict = { file: "imitor.config.json", before: existing, after: configText };
  }

  const missing = ["imitor", "playwright"].filter((p) => !deps[p]);
  plan.install = { ...installCommands(plan.packageManager, missing), missing };
  if (!deps["react-native-web"] || !deps["react-dom"]) plan.notes.push("react-native-web and react-dom are not in package.json; `expo export --platform web` needs them: npx expo install react-native-web react-dom @expo/metro-runtime");
  plan.nextSteps = [
    ...(plan.install.install ? [plan.install.install] : []),
    plan.install.browser,
    "npx imitor                 # build the web preview, run the flow, write the report",
    "npx imitor app             # look at it in the review interface",
    "claude mcp add imitor -- npx imitor mcp   # connect your coding agent (any MCP client: npx imitor mcp)",
  ];
  return plan;
}

/** Apply a plan's changes. */
export function applyPlan(root, plan) {
  for (const change of plan.changes) fs.writeFileSync(path.join(root, change.file), change.after);
}

/** Plan and, unless dryRun or something stops it, write. */
export function init(root, { dryRun = false, force = false } = {}) {
  const plan = planInit(root, { force });
  const blocked = !plan.ok || plan.stop;
  if (!blocked && !dryRun) applyPlan(root, plan);
  return { ...plan, dryRun, written: !blocked && !dryRun ? plan.changes.map((c) => c.file) : [] };
}

// ---------------------------------------------------------------- printing

/** A unified diff of two texts (line based, LCS). */
export function diff(file, before, after) {
  const a = before === null ? [] : before.split("\n");
  const b = after.split("\n");
  if (a.length && a[a.length - 1] === "") a.pop();
  if (b.length && b[b.length - 1] === "") b.pop();
  const n = a.length;
  const m = b.length;
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) ops.push([" ", a[i++], j++]);
    else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) ops.push(["-", a[i++]]);
    else ops.push(["+", b[j++]]);
  }
  const lines = [`--- ${before === null ? "/dev/null" : `a/${file}`}`, `+++ b/${file}`];
  const changed = ops.map((o, k) => (o[0] !== " " ? k : -1)).filter((k) => k >= 0);
  if (!changed.length) return "";
  // Group changes into hunks with three lines of context.
  let k = 0;
  while (k < changed.length) {
    let from = Math.max(0, changed[k] - 3);
    let to = changed[k];
    while (k < changed.length && changed[k] - to <= 7) to = changed[k++];
    to = Math.min(ops.length - 1, to + 3);
    const slice = ops.slice(from, to + 1);
    const aStart = ops.slice(0, from).filter((o) => o[0] !== "+").length + 1;
    const bStart = ops.slice(0, from).filter((o) => o[0] !== "-").length + 1;
    const aLen = slice.filter((o) => o[0] !== "+").length;
    const bLen = slice.filter((o) => o[0] !== "-").length;
    lines.push(`@@ -${aLen ? aStart : aStart - 1},${aLen} +${bLen ? bStart : bStart - 1},${bLen} @@`);
    for (const o of slice) lines.push(o[0] + o[1]);
  }
  return lines.join("\n");
}

export function formatInit(result) {
  const out = [];
  if (!result.ok && !result.changes) return `imitor init: ${result.stop}`;
  out.push(`imitor init${result.dryRun ? " --dry-run" : ""}: ${result.app.name} (Expo config from ${result.app.configFrom}, ${result.packageManager})`);
  const s = result.standIns;
  out.push("", "Stand-ins:");
  if (s.proposed.length) for (const p of s.proposed) out.push(`  ${p.package}: ${p.standIn}. ${p.why}`);
  else out.push("  none of the app's dependencies needs a built-in stand-in");
  if (s.noneNeeded.length) out.push(`  ${s.noneNeeded.length} native package${s.noneNeeded.length === 1 ? "" : "s"} checked that work on web as they are: ${s.noneNeeded.join(", ")}`);
  for (const p of s.mayNeed) out.push(`  may need a stand-in: ${p.package}${p.local ? ` (${p.local})` : ""}, ${p.why}. If the build or a screen fails on it, add "${p.package}": "inert" (or your own file) to "shims".`);
  if (s.notInstalled.length) out.push(`  not installed, so not checked: ${s.notInstalled.join(", ")}`);
  const changes = result.conflict ? [...result.changes, result.conflict] : result.changes;
  if (changes.length) {
    out.push("", result.written?.length ? "Changed:" : result.stop ? "Would change (nothing written):" : "Would change:");
    for (const c of changes) {
      out.push("", `${c.file}${c.why ? `: ${c.why}` : ""}`);
      out.push(diff(c.file, c.before, c.after));
    }
  }
  if (result.unchanged.length) out.push("", "Already done:", ...result.unchanged.map((u) => `  ${u}`));
  if (result.manual.length) {
    out.push("", "Do this by hand:");
    for (const m of result.manual) out.push(`  ${m.reason}.`, ...m.how.split("\n").map((l) => `  ${l}`));
  }
  if (result.notes.length) out.push("", "Notes:", ...result.notes.map((n) => `  - ${n}`));
  if (result.stop) {
    out.push("", result.stop);
    return out.join("\n");
  }
  out.push("", 'Add steps to the "home" flow in imitor.config.json to go further, e.g. { "tap": "Continue" }, then { "shot": "next" }. Steps: tap, fill, goto, waitFor, wait, scroll, shot (README, Flow steps).');
  out.push("", "Next:", ...result.nextSteps.map((n, i) => `  ${i + 1}. ${n}`));
  if (result.install.missing.includes("imitor")) out.push(`  (${UNPUBLISHED_NOTE})`);
  if (result.dryRun) out.push("", "Dry run: nothing was written. Run imitor init to apply.");
  return out.join("\n");
}
