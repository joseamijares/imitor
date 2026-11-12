// Display helpers: times, device and scheme names, flow and step labels.

/** "1 min", "22 min", "1 h", "3 d". */
export function ago(iso, now = Date.now()) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const s = Math.max(0, (now - t) / 1000);
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86400) return `${Math.floor(s / 3600)} h`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d`;
  return new Date(t).toLocaleDateString(undefined, { day: "numeric", month: "short" });
}

/** Today | Yesterday | Earlier, by local calendar day. */
export function dayGroup(iso, now = new Date()) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "Earlier";
  const start = new Date(now); start.setHours(0, 0, 0, 0);
  if (t >= start) return "Today";
  const y = new Date(start); y.setDate(y.getDate() - 1);
  return t >= y ? "Yesterday" : "Earlier";
}

const DEVICE_NAMES = { "iphone-16": "iPhone 16", "iphone-se": "iPhone SE", "pixel-9": "Pixel 9", "small-android": "Small Android" };
/** iphone-16 -> iPhone 16. Unknown names are title-cased word by word. */
export function deviceName(d) {
  if (!d) return "";
  if (DEVICE_NAMES[d]) return DEVICE_NAMES[d];
  return String(d).split(/[-_]/).map((w) => (/^iphone$/i.test(w) ? "iPhone" : /^(se|xl|xr|pro)$/i.test(w) ? w.toUpperCase() : w.charAt(0).toUpperCase() + w.slice(1))).join(" ");
}
export const schemeName = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");

/** first-run -> First run */
export function humanize(name) {
  const s = String(name || "").replace(/[-_]+/g, " ").trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "08-today" -> { num: "08", label: "Today" }; falls back to the step index. */
export function stepLabel(step) {
  const m = String(step.name || "").match(/^(\d+)[-_ ]*(.*)$/);
  if (m) return { num: m[1].padStart(2, "0"), label: humanize(m[2] || step.name) };
  return { num: String(step.index ?? "").padStart(2, "0"), label: humanize(step.name) };
}

export const isMainBranch = (b) => b === "main" || b === "master";
export const plural = (n, one, many = one + "s") => `${n} ${n === 1 ? one : many}`;
