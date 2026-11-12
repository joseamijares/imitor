import fs from "node:fs";
import path from "node:path";

// Values a flow types, and keeping them out of what Imitor writes and returns.
//
// A `fill` step's value is either a literal ("Ada") or a reference to an environment variable ({ "env": "TEST_PASSWORD" })
// whose name is listed in the config's top-level "secrets". The reference is resolved only at the moment the field is
// filled; the step object itself is never changed, so manifests, results and logs hold the reference, not the value.
//
// What leaves Imitor (manifests, the runs store, MCP and CLI results, gate text, the pull-request comment) carries steps
// through publicStep(), which replaces every fill value: a literal with "•••", a reference with the reference. Free text
// that could echo a typed value (error messages, page errors, dialogs) goes through scrub(), which replaces any secret
// value it contains.

export const HIDDEN = "•••";
const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
// Shorter secrets are not scrubbed from free text: replacing every "ab" in an error message helps no one.
const MIN_SCRUB = 4;

/** True for { "env": "NAME" } and nothing else. */
export const isSecretRef = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v) && Object.keys(v).length === 1 && typeof v.env === "string";

/** Check the config's "secrets" list and every fill value that refers to one. Throws with the place named, never a value. */
export function checkSecrets(raw, flows) {
  const secrets = raw.secrets ?? [];
  if (!Array.isArray(secrets) || secrets.some((n) => typeof n !== "string" || !NAME.test(n))) {
    throw new Error(`imitor.config.json: "secrets" must be a list of environment variable names, such as ["TEST_EMAIL", "TEST_PASSWORD"]`);
  }
  for (const f of flows) {
    for (const [i, step] of (f.steps || []).entries()) {
      if (!step || !step.fill || typeof step.fill !== "object") continue;
      const v = step.fill.value;
      if (v === undefined || typeof v === "string" || typeof v === "number") continue;
      if (!isSecretRef(v)) throw new Error(`flow "${f.name}" step ${i + 1}: a fill "value" must be text or { "env": "NAME" }`);
      if (!secrets.includes(v.env)) throw new Error(`flow "${f.name}" step ${i + 1}: "${v.env}" is not listed in "secrets" in imitor.config.json`);
    }
  }
  return secrets;
}

/** Throw if any of these steps (from an agent or the command line, not the config) refers to the environment. */
export function refuseSecretRefs(steps) {
  for (const [i, step] of (steps || []).entries()) {
    if (step && step.fill && typeof step.fill === "object" && step.fill.value !== undefined && typeof step.fill.value === "object") {
      throw new Error(`step ${i + 1}: values from the environment can only be used in flows in imitor.config.json, not in steps passed to a command or tool`);
    }
  }
}

/** The text to type for a fill value. `secrets` is the config's list; `env` defaults to process.env. */
export function resolveValue(value, secrets = [], env = process.env) {
  if (!isSecretRef(value)) {
    if (value !== null && typeof value === "object") throw new Error(`a fill "value" must be text or { "env": "NAME" }`);
    return String(value);
  }
  if (!secrets.includes(value.env)) throw new Error(`"${value.env}" is not listed in "secrets" in imitor.config.json`);
  const text = env[value.env];
  if (text === undefined || text === "") throw new Error(`the environment variable ${value.env} is not set (it is listed in "secrets"; run Imitor with it set, for example under op run)`);
  return text;
}

/** The values of the listed secrets that are set, for scrub(). */
export function secretValues(secrets = [], env = process.env) {
  return secrets.map((n) => env[n]).filter((v) => typeof v === "string" && v.length >= MIN_SCRUB);
}

/** A step as it may appear in output: every fill value replaced (a literal by "•••", a reference by the reference). */
export function publicStep(step) {
  if (!step || typeof step !== "object" || !step.fill || typeof step.fill !== "object" || !("value" in step.fill)) return step;
  const v = step.fill.value;
  return { ...step, fill: { ...step.fill, value: isSecretRef(v) ? { env: v.env } : HIDDEN } };
}

/** The names of the environment variables these steps fill from. */
export function secretsUsed(steps) {
  return [...new Set((steps || []).filter((s) => s && s.fill && isSecretRef(s.fill.value)).map((s) => s.fill.value.env))];
}

/** Replace every secret value inside a string, or inside every string of an object or array (returns a copy). */
export function scrub(value, values) {
  if (!values || !values.length) return value;
  if (typeof value === "string") {
    let out = value;
    for (const v of values) out = out.split(v).join(HIDDEN);
    return out;
  }
  if (Array.isArray(value)) return value.map((x) => scrub(x, values));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, scrub(x, values)]));
  return value;
}

/**
 * Replace the secret values of the app at `root` inside `text`, reading the names straight from imitor.config.json (for
 * error paths, where the config may be what failed). Never throws.
 */
export function scrubForRoot(root, text, env = process.env) {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(root, "imitor.config.json"), "utf8"));
    const names = Array.isArray(raw.secrets) ? raw.secrets.filter((n) => typeof n === "string") : [];
    return scrub(text, secretValues(names, env));
  } catch {
    return text;
  }
}
