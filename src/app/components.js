// Components from the design's component sheet. Each returns an HTML string built with `html`,
// which escapes every interpolated value unless it was produced by `html` or wrapped in `raw`.
import { withBase } from "./base.js";

class Safe {
  constructor(s) { this.s = s; }
  toString() { return this.s; }
}
/** Mark a string as trusted markup. Only for markup written in this codebase, never for API data. */
export const raw = (s) => new Safe(String(s));

export function esc(s) {
  return String(s).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
}

function render(v) {
  if (v == null || v === false || v === true) return "";
  if (v instanceof Safe) return v.s;
  if (Array.isArray(v)) return v.map(render).join("");
  return esc(v);
}

/** Tagged template: `html\`<b>${name}</b>\`` escapes `name`. Returns a Safe value. */
export function html(strings, ...values) {
  let out = strings[0];
  for (let i = 0; i < values.length; i++) out += render(values[i]) + strings[i + 1];
  return new Safe(out);
}

/** Turn an html result into a DOM node (first element). */
export function toNode(markup) {
  const t = document.createElement("template");
  t.innerHTML = String(markup).trim();
  return t.content.firstElementChild;
}

/** Only same-origin absolute paths and http(s) URLs may become src/href values. */
export function safeUrl(u) {
  if (typeof u !== "string") return null;
  if (u.startsWith("/") && !u.startsWith("//")) return u;
  if (/^https?:\/\//i.test(u)) return u;
  return null;
}

/* ---------- Icons (16px stroke icons from design/paper-kit.mjs) ---------- */
const ICONS = {
  runs: '<path d="M3 4h10M3 8h10M3 12h6"/>',
  captures: '<rect x="2" y="3.5" width="12" height="9" rx="2"/><path d="M6.8 6.2v3.6L10 8z"/>',
  problems: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 7v2.6"/><circle cx="8" cy="11.3" r=".4"/>',
  agents: '<rect x="3" y="5" width="10" height="8" rx="2.5"/><path d="M8 5V2.8M6.2 8.6v1M9.8 8.6v1"/>',
  settings: '<circle cx="8" cy="8" r="2.2"/><path d="M8 1.8v1.8M8 12.4v1.8M1.8 8h1.8M12.4 8h1.8M3.6 3.6l1.3 1.3M11.1 11.1l1.3 1.3M3.6 12.4l1.3-1.3M11.1 4.9l1.3-1.3"/>',
  docs: '<path d="M4 2.5h5.5L12 5v8.5H4z"/><path d="M9.5 2.5V5H12"/>',
  check: '<path d="M3.5 8.3l3 3 6-6.6"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  down: '<path d="M4 6l4 4 4-4"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.8"/><path d="M10.5 5.5V4a1.5 1.5 0 00-1.5-1.5H4A1.5 1.5 0 002.5 4v5A1.5 1.5 0 004 10.5h1.5"/>',
  image: '<rect x="2" y="3" width="12" height="10" rx="2"/><circle cx="6" cy="6.8" r="1.1"/><path d="M2.5 11.5l3.2-3 2.6 2.4 2-1.8 3.2 2.9"/>',
  branch: '<circle cx="4.5" cy="3.8" r="1.5"/><circle cx="4.5" cy="12.2" r="1.5"/><circle cx="11.5" cy="5.8" r="1.5"/><path d="M4.5 5.3v5.4M11.5 7.3c0 2.2-3 2-5.5 2.6"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3 3"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5l2 1.6-2 1.6M8.6 10h2.4"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  external: '<path d="M9 2.5h4.5V7M13.5 2.5L7.5 8.5M11.5 9.5v3a1 1 0 01-1 1h-7a1 1 0 01-1-1v-7a1 1 0 011-1h3"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  retry: '<path d="M13 8a5 5 0 11-1.5-3.5"/><path d="M13 2.5v3h-3"/>',
  warn: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 7v2.6"/><circle cx="8" cy="11.3" r=".4"/>',
  sun: '<circle cx="8" cy="8" r="2.8"/><path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1"/>',
  moon: '<path d="M13 9.5A5.5 5.5 0 016.5 3a5.5 5.5 0 106.5 6.5z"/>',
  auto: '<circle cx="8" cy="8" r="5.5"/><path d="M8 2.5v11" /><path d="M8 2.5a5.5 5.5 0 010 11z" fill="currentColor" stroke="none"/>',
  // Phone layouts: the "more" control, the device button and back / previous.
  more: '<circle cx="3.5" cy="8" r=".6" fill="currentColor"/><circle cx="8" cy="8" r=".6" fill="currentColor"/><circle cx="12.5" cy="8" r=".6" fill="currentColor"/>',
  phone: '<rect x="4.5" y="1.8" width="7" height="12.4" rx="2"/><path d="M7.2 12h1.6"/>',
  back: '<path d="M10 4L6 8l4 4"/>',
};
export function icon(name, size = 16) {
  return raw(`<svg width="${size}" height="${size}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ""}</svg>`);
}

/* ---------- Logo ---------- */
let logoId = 0;
/** The Echo app icon rendered at its final size (the dashed line is 3% of the width, per design/logo/logos.mjs). */
export function logo(px = 24) {
  const id = `echo-g${logoId++}`;
  const iso = (dy, body) => `<g transform="translate(60 ${dy}) matrix(0.866 0.5 -0.866 0.5 0 0)">${body}</g>`;
  const sw = Math.max(1.2, px * 0.03).toFixed(2), da = `${(px * 0.0625).toFixed(2)} ${(px * 0.052).toFixed(2)}`;
  return raw(`<svg width="${px}" height="${px}" viewBox="0 0 120 120" fill="none" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Imitor"><defs><linearGradient id="${id}" x1="60" y1="0" x2="60" y2="120" gradientUnits="userSpaceOnUse"><stop stop-color="#222225"/><stop offset="1" stop-color="#0B0B0C"/></linearGradient></defs><rect x="1" y="1" width="118" height="118" rx="28" fill="url(#${id})"/><rect x="1.75" y="1.75" width="116.5" height="116.5" rx="27.25" stroke="#34343A" stroke-opacity="0.9" stroke-width="1.5"/>${iso(84, '<rect x="-30" y="-30" width="60" height="60" rx="13" fill="#8E8E88"/>')}${iso(75, '<rect x="-30" y="-30" width="60" height="60" rx="13" fill="#F5F5F2"/>')}${iso(75, '<rect x="-11" y="19" width="22" height="4.5" rx="2.25" fill="#8E8E88"/>')}${iso(44, `<rect x="-30" y="-30" width="60" height="60" rx="13" stroke="#FFD60A" stroke-width="${sw}" stroke-dasharray="${da}" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`)}</svg>`);
}

/* ---------- Status mark (14 x 14) ---------- */
// ok: passed or genuine. standin: stand-in. failed. progress: in progress. off: not shown, seen.
const MARKS = {
  ok: '<circle cx="7" cy="7" r="6" fill="var(--color-ok)"/><path d="M4.3 7.2l1.8 1.8 3.6-3.9" stroke="var(--color-bg)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  standin: '<rect x="1.5" y="1.5" width="11" height="11" rx="3" stroke="var(--color-warn)" stroke-width="1.5" stroke-dasharray="2.6 2"/>',
  failed: '<circle cx="7" cy="7" r="6" fill="var(--color-bad)"/><path d="M4.8 4.8l4.4 4.4M9.2 4.8L4.8 9.2" stroke="var(--color-bg)" stroke-width="1.5" stroke-linecap="round"/>',
  off: '<circle cx="7" cy="7" r="5.25" stroke="var(--color-t-3)" stroke-width="1.5"/><path d="M4.5 7h5" stroke="var(--color-t-3)" stroke-width="1.5" stroke-linecap="round"/>',
  progress: '<circle cx="7" cy="7" r="5.25" stroke="var(--color-line-2)" stroke-width="1.5"/><path d="M7 1.75A5.25 5.25 0 0112.25 7" stroke="var(--color-acc)" stroke-width="1.5" stroke-linecap="round"/>',
};
const MARK_LABEL = { ok: "Passed", standin: "Stand-in", failed: "Failed", off: "Seen", progress: "In progress" };
const MARK_ALIAS = { passed: "ok", genuine: "ok", "stand-in": "standin", "stand-ins": "standin", warn: "standin", bad: "failed", running: "progress", "in-progress": "progress", seen: "off" };
export function statusMark(kind, label) {
  const k = MARKS[kind] ? kind : MARK_ALIAS[kind] || "off";
  return raw(`<svg class="mark" width="14" height="14" viewBox="0 0 14 14" fill="none" role="img" aria-label="${esc(label || MARK_LABEL[k])}">${MARKS[k]}</svg>`);
}

/* ---------- Small pieces ---------- */
/** tone: neutral | ok | warn | bad | acc */
export const pill = (label, tone = "neutral") => html`<span class="pill pill-${raw(tone)}">${label}</span>`;
/** Shown in the shell of the public demo (imitor export --demo), so its invented data is not mistaken for a project. */
export const demoPill = () => html`<span class="demo-pill" title="This is a demo: the app, runs and shots are invented.">${pill("Demo data")}</span>`;
/** A quiet marker for a shot that shows invented data: a state label for the stand-ins, or a seed. "" when neither. */
export function madeMark(item) {
  if (!item || !(item.state || item.seeded)) return "";
  const label = item.state && item.seeded ? `${item.state} · seeded` : item.state || "Seeded";
  const what = [item.state ? `the state "${item.state}" handed to the stand-ins` : "", item.seeded ? "seeded data" : ""].filter(Boolean).join(" and ");
  return html`<span class="made-mark" title="${`Started from ${what}. Invented data, not the real app’s.`}">${pill(label)}</span>`;
}
export const chip = (text, title) => html`<span class="chip"${title ? html` title="${title}"` : ""}>${text}</span>`;

/** kind: primary | secondary | ghost. opts: { icon, attrs (trusted string), disabled, href, title } */
export function button(label, kind = "secondary", opts = {}) {
  const inner = html`${opts.icon ? icon(opts.icon, 14) : ""}${label}`;
  const attrs = raw(opts.attrs || "");
  const title = opts.title ? html` title="${opts.title}"` : "";
  if (opts.href) return html`<a class="btn btn-${raw(kind)}" href="${withBase(opts.href)}"${title} ${attrs}>${inner}</a>`;
  return html`<button type="button" class="btn btn-${raw(kind)}"${opts.disabled ? raw(" disabled") : ""}${title} ${attrs}>${inner}</button>`;
}

/** Segmented control. items: [{ value, label }]. name identifies it for event handling. */
export function seg(name, items, selected, ariaLabel) {
  return html`<div class="seg" role="group" aria-label="${ariaLabel || name}" data-seg="${name}">${items.map((it) =>
    html`<button type="button" data-value="${it.value}" aria-pressed="${it.value === selected ? "true" : "false"}">${it.label}</button>`)}</div>`;
}

/** Switch, 30 x 18. */
export const switchEl = (on, label, attrs = "") =>
  html`<button type="button" class="switch" role="switch" aria-checked="${on ? "true" : "false"}" aria-label="${label}" ${raw(attrs)}></button>`;

/** Text field. */
export const field = (value, opts = {}) =>
  html`<input class="field${opts.mono ? " mono" : ""}" value="${value}" aria-label="${opts.label || ""}"${opts.placeholder ? html` placeholder="${opts.placeholder}"` : ""}>`;

/**
 * Code block with a working copy button. lines: array of strings or { text, tone: "dim" | "bad" }.
 * `copyText` defaults to the plain text of the lines.
 */
export function codeBlock(lines, copyText) {
  const list = lines.map((l) => (typeof l === "string" ? { text: l } : l));
  const text = copyText ?? list.map((l) => l.text).join("\n");
  // The text sits in its own element so that, on a phone, it can scroll sideways while the copy button stays put.
  return html`<pre class="code"><code class="code-text">${list.map((l, i) => html`${i ? "\n" : ""}${l.tone ? html`<span class="c-${raw(l.tone)}">${l.text}</span>` : l.text}`)}</code><button type="button" class="copy-btn" data-copy="${text}" aria-label="Copy" title="Copy">${icon("copy", 14)}</button></pre>`;
}

/** Sidebar navigation item. */
export function navItem({ href, iconName, label, active, count, external }) {
  return html`<a class="nav-item${active ? " is-active" : ""}" href="${withBase(href)}"${active ? raw(' aria-current="page"') : ""}${external ? raw(' target="_blank" rel="noopener"') : ""} title="${label}">${icon(iconName)}<span class="nav-label">${label}</span>${count ? html`<span class="nav-count">${count}</span>` : ""}</a>`;
}

/* ---------- Agent avatar ---------- */
const AGENT_FILES = { "Claude Code": "claude", Claude: "claude", Cursor: "cursor", "GitHub Actions": "githubactions" };
/**
 * Pass the `by` object ({ name, kind }). Official logo on a neutral tile for Claude Code, Cursor and
 * GitHub Actions, but only when kind is "agent" or "ci": a person named "Claude" gets an initial.
 * A bare name string is treated as an agent (for client pickers that name an agent directly).
 */
export function avatar(by, size = 16) {
  const isObj = by != null && typeof by === "object";
  const n = String((isObj ? by.name : by) || "?");
  const kind = isObj ? by.kind : "agent";
  const file = kind === "agent" || kind === "ci" ? AGENT_FILES[n] : null;
  const cls = size >= 24 ? "avatar lg" : "avatar";
  if (file === "cursor") return html`<span class="${cls}" aria-hidden="true"><span class="glyph-mask" style="--glyph:url(${withBase("/assets/agents/cursor.svg")})"></span></span>`;
  if (file) return html`<span class="${cls}" aria-hidden="true"><img src="${withBase(`/assets/agents/${file}.svg`)}" alt=""></span>`;
  return html`<span class="${cls}" aria-hidden="true">${n.trim().charAt(0).toUpperCase() || "?"}</span>`;
}
export const who = (by) => html`<span class="who">${avatar(by || {})}<span>${by?.name || "Unknown"}</span></span>`;

/* ---------- Screen thumbnail ---------- */
/**
 * status: ok | stand-in | failed | not-reached. A shot with an image is a button that opens it full size.
 * opts: { small, alt, attrs }
 */
export function thumb(src, status, opts = {}) {
  const url = safeUrl(src);
  const size = opts.small ? " sm" : "";
  if (status === "not-reached" || !url) {
    return html`<div class="thumb is-missing${raw(size)}">${status === "not-reached" ? "Not reached" : "No shot"}</div>`;
  }
  const failed = status === "failed" ? " is-failed" : "";
  return html`<button type="button" class="thumb${raw(size + failed)}" data-open-shot="${url}" data-alt="${opts.alt || ""}" aria-label="Open ${opts.alt || "shot"} full size"><img src="${url}" alt="${opts.alt || ""}" loading="lazy"></button>`;
}

/* ---------- States ---------- */
export const loadingLine = (what = "Loading…") => html`<div class="loading-line" role="status">${what}</div>`;
export const skeletonRows = (n = 6) => html`<div class="skeleton" role="status" aria-label="Loading">${Array.from({ length: n }, (_, i) =>
  html`<div class="skeleton-row"><span class="skeleton-bar" style="width:14px"></span><span class="skeleton-bar" style="width:${raw(180 + ((i * 53) % 160))}px"></span><span class="skeleton-bar" style="width:120px;margin-left:auto"></span></div>`)}</div>`;
export function errorState(what, err) {
  return html`<div class="state state-error" role="alert"><h2>${statusMark("failed", "Error")}Couldn’t load ${what}</h2><p>${err?.message || String(err)}</p>${button("Retry", "secondary", { icon: "retry", attrs: "data-action=retry" })}</div>`;
}
