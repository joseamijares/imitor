// Metro plugin: when IMITOR=1, swap native-only modules for web stand-ins.
// Usage in the app's metro.config.js:
//   module.exports = require("imitor/metro").withImitor(config);
const fs = require("fs");
const path = require("path");

const SHIM_DIR = fs.realpathSync(path.join(__dirname, "shims"));
const BUILT_IN = {
  sqljs: path.join(SHIM_DIR, "expo-sqlite.js"),
  inert: path.join(SHIM_DIR, "inert.js"),
  skia: path.join(SHIM_DIR, "skia.js"),
  // The real @shopify/react-native-skia, whose web build draws with CanvasKit. Nothing is redirected: `imitor build`
  // loads CanvasKit and sets global.CanvasKit before the bundle runs. CanvasKit's loader is only bundled if the app
  // imports LoadSkiaWeb itself, and its require("fs") / require("path") then resolve to empty modules (Expo does that
  // for Node built-ins on web).
  canvaskit: null,
};

function loadConfig(projectRoot) {
  const file = path.join(projectRoot, "imitor.config.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function shimPath(projectRoot, value) {
  if (Object.hasOwn(BUILT_IN, value)) return BUILT_IN[value];
  return path.resolve(projectRoot, value); // app-provided stand-in
}

function withImitor(config, options = {}) {
  if (process.env.IMITOR !== "1") return config;
  const projectRoot = options.projectRoot || config.projectRoot || process.cwd();
  const shims = { ...(loadConfig(projectRoot).shims || {}), ...(options.shims || {}) };
  // imitor build loads sql.js and CanvasKit for the kinds in imitor.config.json only; set here, the app would never start.
  const unbooted = Object.keys(options.shims || {}).filter((n) => ["sqljs", "canvaskit"].includes(shims[n]) && (loadConfig(projectRoot).shims || {})[n] !== shims[n]);
  if (unbooted.length) throw new Error(`withImitor: set ${unbooted.map((n) => `"${n}": "${shims[n]}"`).join(", ")} in imitor.config.json "shims", not in withImitor's options: imitor build loads that library only for kinds listed there.`);
  const names = Object.keys(shims);
  const previous = config.resolver && config.resolver.resolveRequest;
  const anchor = path.join(projectRoot, "package.json");

  const resolveRequest = (context, moduleName, platform) => {
    const next = previous || context.resolveRequest;
    if (platform === "web") {
      const hit = names.find((n) => moduleName === n || moduleName.startsWith(n + "/"));
      const filePath = hit && shimPath(projectRoot, shims[hit]);
      // A stand-in that imports the module it replaces (to wrap or re-export parts of it) gets the real one.
      if (filePath && context.originModulePath !== filePath) return { type: "sourceFile", filePath };
    }
    // Stand-ins live outside the app; resolve their imports as if from the app.
    if (!moduleName.startsWith(".") && context.originModulePath && context.originModulePath.startsWith(SHIM_DIR)) {
      return next({ ...context, originModulePath: anchor }, moduleName, platform);
    }
    return next(context, moduleName, platform);
  };

  return {
    ...config,
    watchFolders: [...(config.watchFolders || []), SHIM_DIR],
    resolver: { ...config.resolver, resolveRequest },
  };
}

module.exports = { withImitor };
