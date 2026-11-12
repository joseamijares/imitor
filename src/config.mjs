import fs from "node:fs";
import path from "node:path";
import { checkSecrets } from "./secrets.mjs";

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

/** Built-in kinds that run the real library on the web, so what they show is genuine; every other kind is a stand-in. */
export const GENUINE_KINDS = ["sqljs", "canvaskit"];
export const fidelityOf = (kind) => (GENUINE_KINDS.includes(kind) ? "genuine" : "stand-in");

export function loadConfig(root) {
  const file = path.join(root, "imitor.config.json");
  const raw = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  const devices = (raw.devices || ["iphone-16"]).map((d) => {
    if (typeof d !== "string") return { scale: 2, ...d };
    if (!DEVICES[d]) throw new Error(`unknown device "${d}". Known: ${Object.keys(DEVICES).join(", ")}`);
    return { name: d, ...DEVICES[d] };
  });
  const shims = raw.shims || {};
  // Names of environment variables flows may fill from ({ "env": "NAME" }); checked against every flow's fill steps.
  const secrets = checkSecrets(raw, raw.flows || []);
  return {
    shims,
    devices,
    schemes: raw.schemes || ["light", "dark"],
    locale: raw.locale || "en-US",
    timezone: raw.timezone || "UTC",
    settleMs: raw.settleMs ?? 600,
    reducedMotion: raw.reducedMotion ?? true,
    flows: resolveFlows(raw, root, shims),
    // The top-level state settings, for screenshots taken without a flow.
    defaults: { after: raw.after ?? null, state: raw.state ?? null, seed: normaliseSeed(raw.seed ?? null, root), clock: raw.clock ? new Date(raw.clock).toISOString() : null },
    out: raw.out || "preview",
    secrets,
  };
}

const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const quoted = (names) => names.map((n) => `"${n}"`).join(" -> ");

/**
 * An ISO 8601 date-time that names one instant: date, time (seconds and fractions optional) and "Z" or "±HH:MM". Without
 * a zone it would depend on the machine's, and Date.parse would quietly roll a date like 2026-02-30 over to March.
 */
export function isClock(value) {
  if (typeof value !== "string") return false;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?(?:Z|[+-](\d{2}):(\d{2}))$/.exec(value);
  if (!m) return false;
  const [year, month, day, hour, minute, second = 0, offH = 0, offM = 0] = m.slice(1).map((n) => (n === undefined ? undefined : Number(n)));
  const days = new Date(Date.UTC(year, month, 0)).getUTCDate(); // days in that month (day 0 of the next one)
  return month >= 1 && month <= 12 && day >= 1 && day <= days && hour <= 23 && minute <= 59 && second <= 59 && offH <= 23 && offM <= 59;
}

function checkSetup(value, where, root, shims) {
  const { after = null, state = null, seed = null, clock = null } = value;
  if (after !== null && typeof after !== "string") throw new Error(`${where}: "after" must be the name of a flow`);
  if (state !== null && typeof state !== "string") throw new Error(`${where}: "state" must be a string (a label your stand-ins read as globalThis.__imitor.state)`);
  if (clock !== null && !isClock(clock)) throw new Error(`${where}: "clock" must be an ISO date-time with "Z" or an offset, such as "2026-03-14T09:30:00Z" or "2026-03-02T15:00:00-06:00"; got ${JSON.stringify(clock)}`);
  if (seed === null) return;
  if (typeof seed !== "object" || Array.isArray(seed)) throw new Error(`${where}: "seed" must be an object with "storage" and/or "sql"`);
  for (const k of Object.keys(seed)) if (!["storage", "sql", "database"].includes(k)) throw new Error(`${where}: unknown key "seed.${k}" (known: storage, sql, database)`);
  if (seed.storage !== undefined) {
    if (!seed.storage || typeof seed.storage !== "object" || Array.isArray(seed.storage)) throw new Error(`${where}: "seed.storage" must be an object of key to string`);
    for (const [k, v] of Object.entries(seed.storage)) if (typeof v !== "string") throw new Error(`${where}: "seed.storage" value for "${k}" must be a string (JSON.stringify objects yourself, as AsyncStorage callers do)`);
  }
  if (seed.sql !== undefined) {
    if (!Object.values(shims).includes("sqljs")) throw new Error(`${where}: "seed.sql" needs the sqljs stand-in ("shims": { "expo-sqlite": "sqljs" })`);
    if (typeof seed.sql === "string") {
      const file = path.resolve(root, seed.sql);
      if (!fs.existsSync(file)) throw new Error(`${where}: "seed.sql" file ${seed.sql} does not exist (paths are relative to the app folder)`);
    } else if (!Array.isArray(seed.sql) || seed.sql.some((s) => typeof s !== "string")) throw new Error(`${where}: "seed.sql" must be an array of SQL statements or the path of a .sql file`);
  }
  if (seed.database !== undefined && typeof seed.database !== "string") throw new Error(`${where}: "seed.database" must be a database file name`);
}

/** A seed as the page needs it: storage entries, SQL texts (a .sql file read now), and the database they go in. */
function normaliseSeed(seed, root) {
  if (!seed) return null;
  const sql = seed.sql === undefined ? null : typeof seed.sql === "string" ? [fs.readFileSync(path.resolve(root, seed.sql), "utf8")] : seed.sql;
  return { storage: seed.storage || null, sql, sqlFile: typeof seed.sql === "string" ? seed.sql : null, database: seed.database || null };
}

/**
 * Flows with their state settings resolved: "after", "state", "seed" and "clock" from the flow, else from the top level
 * (a flow's value wins, and an explicit null opts out). The top-level "after" does not apply to the flow it names, nor to
 * the flows that one runs after. Unknown names and cycles are errors here, when the config loads.
 */
function resolveFlows(raw, root, shims) {
  const flows = raw.flows || [{ name: "home", start: "/", steps: [{ shot: "home" }] }];
  checkSetup(raw, "imitor.config.json", root, shims);
  for (const f of flows) checkSetup(f, `flow "${f.name}"`, root, shims);
  const byName = new Map(flows.map((f) => [f.name, f]));
  const top = raw.after ?? null;
  if (top !== null && !byName.has(top)) throw new Error(`imitor.config.json: "after": "${top}" names no flow. Flows: ${[...byName.keys()].join(", ")}`);
  const exempt = new Set();
  for (let name = top; name && !exempt.has(name); name = own(byName.get(name), "after") ? byName.get(name).after : null) exempt.add(name);
  const resolved = flows.map((f) => {
    const pick = (k) => (own(f, k) ? f[k] ?? null : raw[k] ?? null);
    const after = own(f, "after") ? f.after ?? null : exempt.has(f.name) ? null : top;
    if (after !== null && !byName.has(after)) throw new Error(`flow "${f.name}" runs after "${after}", which is not a flow in imitor.config.json`);
    const clock = pick("clock");
    return { ...f, after, state: pick("state"), seed: normaliseSeed(pick("seed"), root), clock: clock && new Date(clock).toISOString() };
  });
  const after = new Map(resolved.map((f) => [f.name, f.after]));
  for (const f of resolved) {
    const seen = [f.name];
    for (let n = f.after; n; n = after.get(n)) {
      if (seen.includes(n)) throw new Error(`flows ${quoted([...seen.slice(seen.indexOf(n)), n])} run after each other in a cycle`);
      seen.push(n);
    }
  }
  return resolved;
}
