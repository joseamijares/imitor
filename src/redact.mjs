// Blanks what a flow typed before a run leaves this machine. A fill step's value (often a password or an email) shows
// up wherever a step is copied: a failed step's stepConfig in manifest.json, inline steps, the config itself. Every
// { fill: { ..., value } } anywhere in the value gets its value replaced, and the typed values (plus any `secrets`
// passed in, e.g. every fill value in imitor.config.json) are also blanked inside free-text fields such as error
// messages and routes, where a page may have echoed them.
export const BLANK = "•••";
// Text that may echo what was typed. Paths, ids and names are left alone so files still match their records.
const TEXT_KEYS = new Set(["message", "text", "title", "route", "subject"]);
const MIN_SECRET = 4; // shorter values ("1", "yes") would blank ordinary words

/** Every fill value in `value` (a config, a manifest, a step list), as strings. */
export function fillValues(value, found = new Set()) {
  if (Array.isArray(value)) value.forEach((v) => fillValues(v, found));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      if (k === "fill" && v && typeof v === "object" && !Array.isArray(v) && v.value != null) found.add(String(v.value));
      fillValues(v, found);
    }
  }
  return found;
}

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A deep copy of `value` with fill values blanked. opts: { secrets: extra strings to blank inside free text }. */
export function redact(value, { secrets = [] } = {}) {
  const words = [...new Set([...fillValues(value), ...secrets].map(String))].filter((s) => s.length >= MIN_SECRET && s !== BLANK);
  const pattern = words.length ? new RegExp(words.sort((a, b) => b.length - a.length).map(escape).join("|"), "g") : null;
  const scrub = (s) => (pattern ? s.replace(pattern, BLANK) : s);
  const walk = (v, key) => {
    if (typeof v === "string") return TEXT_KEYS.has(key) ? scrub(v) : v;
    if (Array.isArray(v)) return v.map((x) => walk(x, key));
    if (!v || typeof v !== "object") return v;
    const out = {};
    for (const [k, x] of Object.entries(v)) {
      out[k] = k === "fill" && x && typeof x === "object" && !Array.isArray(x) && "value" in x ? { ...walk(x, k), value: BLANK } : walk(x, k);
    }
    return out;
  };
  return walk(value, null);
}
