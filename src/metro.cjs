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
};

function loadConfig(projectRoot) {
  const file = path.join(projectRoot, "imitor.config.json");
  if (!fs.existsSync(file)) return {};
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function shimPath(projectRoot, value) {
  if (BUILT_IN[value]) return BUILT_IN[value];
  return path.resolve(projectRoot, value); // app-provided stand-in
}

function withImitor(config, options = {}) {
  if (process.env.IMITOR !== "1") return config;
  const projectRoot = options.projectRoot || config.projectRoot || process.cwd();
  const shims = { ...(loadConfig(projectRoot).shims || {}), ...(options.shims || {}) };
  const names = Object.keys(shims);
  const previous = config.resolver && config.resolver.resolveRequest;
  const anchor = path.join(projectRoot, "package.json");

  const resolveRequest = (context, moduleName, platform) => {
    const next = previous || context.resolveRequest;
    if (platform === "web") {
      const hit = names.find((n) => moduleName === n || moduleName.startsWith(n + "/"));
      const filePath = hit && shimPath(projectRoot, shims[hit]);
      // A stand-in that imports the module it replaces (to wrap or re-export parts of it) gets the real one.
      if (hit && context.originModulePath !== filePath) return { type: "sourceFile", filePath };
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
