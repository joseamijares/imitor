// Blanks what a flow typed before a run leaves this machine. A fill step's value (often a password or an email) shows
// up wherever a step is copied: a failed step's stepConfig in manifest.json, inline steps, the config itself, and in
// any text a step's failure produced ("cannot locate {"value":"..."}"). Every { fill: { ..., value } } anywhere in the
// value gets its value replaced, and every other string is scrubbed of the typed values (plus any `secrets` passed in,
// e.g. every fill value in imitor.config.json), except under the keys in KEEP.
export const BLANK = "•••";
// Paths, ids, names and times, left alone so files still match their records and runs still sort. Everything else is
// text that a page or an error may have echoed a typed value into (message, error, route, url, state, tap, target...).
const KEEP = new Set([
  "file", "path", "id", "clientRunId", "sha256", "contentType", "shot", "lastGoodShot", "failureShot",
  "flow", "name", "device", "devices", "scheme", "schemes", "platform", "where", "after", "app", "commit", "branch",
  "kind", "status", "tool", "stubs", "standIns", "standIn",
  "at", "startedAt", "finishedAt", "generatedAt", "clock",
]);
const MIN_SECRET = 4; // shorter values ("1", "yes") would blank ordinary words inside text; they are blanked only whole

const isFill = (key, v) => key === "fill" && v && typeof v === "object" && !Array.isArray(v) && "value" in v;

// Visits [value, key it sits under] depth first, without recursion, so a deeply nested value cannot overflow the stack.
function* entries(value) {
  const stack = [[value, null]];
  while (stack.length) {
    const [v, key] = stack.pop();
    yield [v, key];
    if (Array.isArray(v)) for (let i = v.length - 1; i >= 0; i--) stack.push([v[i], key]);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v).reverse()) stack.push([x, k]);
  }
}

/** Every fill value in `value` (a config, a manifest, a step list), as strings. */
export function fillValues(value, found = new Set()) {
  for (const [v, key] of entries(value)) if (isFill(key, v) && v.value != null && typeof v.value !== "object") found.add(String(v.value)); // { env } is a reference, not a value
  return found;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// A plain own property, even for "__proto__", which an assignment would treat as the prototype.
const define = (o, k, v) => Object.defineProperty(o, k, { value: v, enumerable: true, writable: true, configurable: true });

/** A deep copy of `value` with fill values blanked. opts: { secrets: extra strings to blank inside free text }. */
export function redact(value, { secrets = [] } = {}) {
  const exact = new Set([...fillValues(value), ...secrets].map(String).filter((s) => s && s !== BLANK));
  // Also as JSON writes them inside a string, since errors quote steps with JSON.stringify ({"value":"say \"hi\""}).
  const words = [...new Set([...exact].filter((s) => s.length >= MIN_SECRET).flatMap((s) => [s, JSON.stringify(s).slice(1, -1)]))].sort((a, b) => b.length - a.length);
  const pattern = words.length ? new RegExp(words.map(escape).join("|"), "g") : null;
  const scrub = (s, key) => (KEEP.has(key) ? s : exact.has(s) ? BLANK : pattern ? s.replace(pattern, BLANK) : s);

  // Copies iteratively for the same reason as entries(): each stack item fills one slot of a copy made earlier.
  const root = {};
  const stack = [[value, null, root, "value"]];
  while (stack.length) {
    const [v, key, into, slot] = stack.pop();
    if (Array.isArray(v)) {
      const out = define(into, slot, new Array(v.length))[slot];
      v.forEach((x, i) => stack.push([x, key, out, i]));
    } else if (v && typeof v === "object") {
      const out = define(into, slot, {})[slot];
      const fill = isFill(key, v);
      for (const [k, x] of Object.entries(v)) {
        define(out, k, undefined); // keeps the key order of the original
        stack.push([fill && k === "value" ? BLANK : x, k, out, k]);
      }
    } else define(into, slot, typeof v === "string" ? scrub(v, key) : v);
  }
  return root.value;
}
