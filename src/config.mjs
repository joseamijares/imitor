import fs from "node:fs";
import path from "node:path";

export const DEVICES = {
  "iphone-16": { width: 393, height: 852, scale: 2, platform: "ios" },
  "iphone-se": { width: 375, height: 667, scale: 2, platform: "ios" },
  "pixel-9": { width: 412, height: 915, scale: 2, platform: "android" },
  "small-android": { width: 360, height: 640, scale: 2, platform: "android" },
};

export const NOT_COVERED = [
  "Native navigation chrome, transitions and gestures",
  "Keyboard behaviour",
  "Exact font rendering of the phone",
  "Entering/layout animations (web lays these out differently)",
  "Anything replaced by a stand-in (listed per shot)",
  "iOS widgets, Live Activities, watch, Android widgets and notifications",
];

export function loadConfig(root) {
  const file = path.join(root, "imitor.config.json");
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const devices = (raw.devices || ["iphone-16"]).map((d) => {
    if (typeof d !== "string") return { scale: 2, ...d };
    if (!DEVICES[d]) throw new Error(`unknown device "${d}". Known: ${Object.keys(DEVICES).join(", ")}`);
    return { name: d, ...DEVICES[d] };
  });
  return {
    shims: raw.shims || {},
    devices,
    schemes: raw.schemes || ["light", "dark"],
    locale: raw.locale || "en-US",
    timezone: raw.timezone || "UTC",
    settleMs: raw.settleMs ?? 600,
    reducedMotion: raw.reducedMotion ?? true,
    flows: raw.flows || [{ name: "home", start: "/", steps: [{ shot: "home" }] }],
    out: raw.out || "preview",
  };
}
