// Imitor design kit (Linear-style dark): the tokens and components used to draw the app screens in Paper.
// Kept as the reference for building the same interface in code. `w`, `shot` and `call` come from a local Paper MCP client that is not in this repo.
import { w, shot, call } from "./lib.mjs";
export { w, shot, call };

export const c = {
  bg: "#08090A", panel: "#111214", raised: "#17181B", line: "#1F2124", line2: "#2A2D31",
  t1: "#F7F8F8", t2: "#A0A6AE", t3: "#7F858E",
  acc: "#7C85F5", accBg: "#5E6AD2", accTint: "#14162B", accLine: "#2E3260",
  warn: "#F2994A", warnTint: "#2A1C0E", ok: "#4CB782", okTint: "#0F2219", bad: "#EB5757", badTint: "#2A1213",
};
export const F = "font-family:Geist;";
export const M = "font-family:'Geist Mono';";
// Type scale: 11 mono meta, 12 secondary, 13 body/UI, 14 emphasis, 16 section title, 20 page title, 28 onboarding title.

const P = (d, o = "") => `<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" ${o}>${d}</svg>`;
export const icons = {
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
  video: '<rect x="2" y="4" width="8.5" height="8" rx="2"/><path d="M10.5 7l3.5-2v6l-3.5-2"/>',
  phone: '<rect x="4.5" y="1.8" width="7" height="12.4" rx="2"/><path d="M7.2 12h1.6"/>',
  branch: '<circle cx="4.5" cy="3.8" r="1.5"/><circle cx="4.5" cy="12.2" r="1.5"/><circle cx="11.5" cy="5.8" r="1.5"/><path d="M4.5 5.3v5.4M11.5 7.3c0 2.2-3 2-5.5 2.6"/>',
  search: '<circle cx="7" cy="7" r="4.2"/><path d="M10.2 10.2l3 3"/>',
  plus: '<path d="M8 3.2v9.6M3.2 8h9.6"/>',
  terminal: '<rect x="2" y="3" width="12" height="10" rx="2"/><path d="M5 6.5l2 1.6-2 1.6M8.6 10h2.4"/>',
  play: '<path d="M5 3.5v9l7-4.5z"/>',
  key: '<circle cx="5.5" cy="10.5" r="2.6"/><path d="M7.4 8.6l5.6-5.6M11 5l1.8 1.8M9.4 6.6l1.4 1.4"/>',
};
/** Stroke icon. color is any CSS colour; size in px. */
export const icon = (name, color = c.t2, size = 16) =>
  `<div style="width:${size}px;height:${size}px;flex-shrink:0;display:flex;color:${color}">${P(icons[name], `style="width:${size}px;height:${size}px"`)}</div>`;

/** The Imitor mark: a solid square with a dashed copy behind it. */
export const mark = (size = 18) =>
  `<svg width="${size}" height="${size}" viewBox="0 0 18 18" fill="none" style="flex-shrink:0"><rect x="1" y="1" width="11" height="11" rx="3" fill="${c.t1}"/><rect x="6" y="6" width="11" height="11" rx="3" stroke="${c.acc}" stroke-width="1.5" stroke-dasharray="2.5 2.2"/></svg>`;

/** Buttons. kind: primary | secondary | ghost. */
export const btn = (label, kind = "secondary", iconName) => {
  const s = { primary: `color:#FFFFFF;background:${c.accBg}`, secondary: `color:${c.t1};background:${c.panel};border:1px solid ${c.line2}`, ghost: `color:${c.t2}` }[kind];
  return `<div style="display:flex;align-items:center;gap:6px;font-size:13px;font-weight:500;padding:${kind === "secondary" ? "5px 11px" : "6px 12px"};border-radius:6px;${s};flex-shrink:0">${iconName ? icon(iconName, kind === "primary" ? "#FFFFFF" : c.t2, 14) : ""}${label}</div>`;
};
/** Small status pill. tone: acc | ok | warn | bad | neutral. */
export const pill = (label, tone = "neutral") => {
  const t = { acc: [c.acc, c.accTint, c.accLine], ok: [c.ok, c.okTint, "#1C4030"], warn: [c.warn, c.warnTint, "#4A3216"], bad: [c.bad, c.badTint, "#4A2022"], neutral: [c.t2, c.panel, c.line2] }[tone];
  return `<div style="font-size:11px;font-weight:500;color:${t[0]};background:${t[1]};border:1px solid ${t[2]};padding:2px 7px;border-radius:10px;flex-shrink:0;white-space:nowrap">${label}</div>`;
};
/** Status dot icons used in lists: ok (green check), warn (dashed orange square = stand-in), bad (red), off (grey), run (indigo ring = in progress). */
export const status = (k) => ({
  ok: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" fill="${c.ok}"/><path d="M4.3 7.2l1.8 1.8 3.6-3.9" stroke="${c.bg}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>`,
  warn: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><rect x="1.5" y="1.5" width="11" height="11" rx="3" stroke="${c.warn}" stroke-width="1.5" stroke-dasharray="2.6 2"/></svg>`,
  bad: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="6" fill="${c.bad}"/><path d="M4.8 4.8l4.4 4.4M9.2 4.8L4.8 9.2" stroke="${c.bg}" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  off: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.25" stroke="${c.t3}" stroke-width="1.5"/><path d="M4.5 7h5" stroke="${c.t3}" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  run: `<svg width="14" height="14" viewBox="0 0 14 14" fill="none"><circle cx="7" cy="7" r="5.25" stroke="${c.line2}" stroke-width="1.5"/><path d="M7 1.75A5.25 5.25 0 0112.25 7" stroke="${c.acc}" stroke-width="1.5" stroke-linecap="round"/></svg>`,
}[k]);
/** Mono chip for a commit hash, a key, or a short command. */
export const chip = (text) => `<div style="${M}font-size:11px;color:${c.t2};padding:2px 6px;background:${c.panel};border:1px solid ${c.line};border-radius:5px;flex-shrink:0;white-space:nowrap">${text}</div>`;
/** Code block. lines: array of strings; a line may contain <span> colouring. Shows a copy icon. */
export const code = (lines, opts = {}) =>
  `<div layer-name="Code" style="display:flex;align-items:flex-start;justify-content:space-between;gap:12px;background:${c.panel};border:1px solid ${c.line};border-radius:8px;padding:12px 14px;${opts.style || ""}"><div style="display:flex;flex-direction:column;gap:2px">${lines.map((l) => `<div style="${M}font-size:12px;line-height:20px;color:${c.t1};white-space:pre">${l}</div>`).join("")}</div>${icon("copy", c.t3, 14)}</div>`;
/** Segmented control. */
export const seg = (items, sel) => `<div style="display:flex;gap:2px;padding:2px;background:${c.panel};border:1px solid ${c.line};border-radius:7px">${items.map((t) => `<div style="text-align:center;font-size:12px;font-weight:500;padding:4px 12px;border-radius:5px;${t === sel ? `color:${c.t1};background:${c.line2}` : `color:${c.t2}`}">${t}</div>`).join("")}</div>`;
/** A small rendered app screen placeholder for thumbnails (light app screen with blocks). w,h in px. variant 0..3 varies the content. standIn adds the dashed orange box. */
export const thumb = (wd, ht, variant = 0, standIn = false) => {
  const r = Math.round(wd * 0.11), u = wd / 100;
  const bar = (wp, hh, col, mt) => `<div style="width:${wp}%;height:${Math.max(2, Math.round(hh * u))}px;border-radius:${Math.round(1.5 * u)}px;background:${col};margin-top:${Math.round(mt * u)}px;flex-shrink:0"></div>`;
  const blocks = [
    bar(34, 5, "#1D2A1F", 14) + bar(52, 3, "#B9C2B5", 4) + `<div style="width:100%;height:${Math.round(38 * u)}px;border-radius:${Math.round(6 * u)}px;background:#FFFFFF;margin-top:${Math.round(8 * u)}px;flex-shrink:0"></div>` + (standIn ? `<div style="width:100%;height:${Math.round(24 * u)}px;border-radius:${Math.round(5 * u)}px;border:1px dashed #F2994A;margin-top:${Math.round(7 * u)}px;flex-shrink:0"></div>` : bar(100, 22, "#DDE6D6", 7)) + bar(100, 11, "#2F6B45", 8),
    `<div style="width:${Math.round(34 * u)}px;height:${Math.round(34 * u)}px;border-radius:50%;background:#9CC5A1;margin-top:${Math.round(34 * u)}px;align-self:center;flex-shrink:0"></div>` + `<div style="align-self:center;display:flex;flex-direction:column;align-items:center;width:100%">${bar(62, 6, "#1D2A1F", 12)}${bar(78, 3, "#B9C2B5", 6)}${bar(54, 3, "#B9C2B5", 3)}</div>` + `<div style="margin-top:auto;width:100%">${bar(100, 11, "#2F6B45", 0)}</div>`,
    bar(46, 5, "#1D2A1F", 14) + [0, 1, 2, 3].map(() => `<div style="width:100%;height:${Math.round(13 * u)}px;border-radius:${Math.round(4 * u)}px;background:#FFFFFF;margin-top:${Math.round(5 * u)}px;flex-shrink:0"></div>`).join("") + `<div style="margin-top:auto;width:100%">${bar(100, 11, "#2F6B45", 0)}</div>`,
    bar(40, 5, "#1D2A1F", 14) + bar(70, 3, "#B9C2B5", 4) + `<div style="width:100%;height:${Math.round(52 * u)}px;border-radius:${Math.round(6 * u)}px;background:#DDE6D6;margin-top:${Math.round(8 * u)}px;flex-shrink:0"></div>` + bar(100, 11, "#FFFFFF", 7) + bar(100, 11, "#FFFFFF", 4),
  ][variant % 4];
  return `<div layer-name="Screen thumb" style="width:${wd}px;height:${ht}px;border-radius:${r}px;background:#F5F7EF;box-shadow:0 0 0 1px ${c.line2};overflow:hidden;display:flex;flex-direction:column;padding:${Math.round(7 * u)}px ${Math.round(8 * u)}px ${Math.round(8 * u)}px;flex-shrink:0">${blocks}</div>`;
};

const NAV = [["runs", "Runs"], ["captures", "Captures"], ["problems", "Problems"], ["agents", "Agents"]];
/**
 * App frame for normal pages: left sidebar + page header. The artboard must be 1440x900 with flex-direction:row.
 * active: runs | captures | problems | agents | settings. header: { title, meta (html, optional), actions (html, optional) }.
 * Returns the id of the empty content column (flex column, 1220px wide) to write the page into.
 */
export function appShell(artboard, active, header) {
  const item = (k, label, extra = "") => `<div layer-name="Nav ${label}" style="display:flex;align-items:center;gap:9px;height:30px;padding:0 8px;border-radius:6px;${k === active ? `background:${c.line}` : ""}">${icon(k, k === active ? c.t1 : c.t2)}<div style="flex:1;font-size:13px;font-weight:${k === active ? 500 : 400};color:${k === active ? c.t1 : c.t2}">${label}</div>${extra}</div>`;
  const side = w(artboard, `<div layer-name="Sidebar" style="${F}width:220px;flex-shrink:0;border-right:1px solid ${c.line};padding:12px 8px;display:flex;flex-direction:column;gap:1px">
    <div layer-name="Workspace" style="display:flex;align-items:center;gap:9px;height:32px;padding:0 8px;margin-bottom:10px">${mark(18)}<div style="flex:1;font-size:14px;font-weight:600;color:${c.t1};letter-spacing:-0.01em">Imitor</div>${icon("search", c.t3, 14)}</div>
    <div layer-name="Project" style="display:flex;align-items:center;gap:8px;height:30px;padding:0 8px;margin-bottom:8px;background:${c.panel};border:1px solid ${c.line};border-radius:6px"><div style="width:14px;height:14px;border-radius:4px;background:#2F6B45;flex-shrink:0"></div><div style="flex:1;font-size:13px;font-weight:500;color:${c.t1}">fernwood</div>${icon("down", c.t3, 12)}</div>
  </div>`);
  w(side, NAV.map(([k, l]) => item(k, l, k === "problems" ? `<div style="${M}font-size:11px;color:${c.t3}">2</div>` : "")).join(""));
  w(side, `<div layer-name="Sidebar foot" style="margin-top:auto;display:flex;flex-direction:column;gap:1px">${item("settings", "Settings")}${item("docs", "Docs")}</div>`);
  const main = w(artboard, `<div layer-name="Main" style="${F}flex:1;min-width:0;display:flex;flex-direction:column"></div>`);
  w(main, `<div layer-name="Page header" style="display:flex;align-items:center;justify-content:space-between;height:48px;padding:0 24px;border-bottom:1px solid ${c.line};flex-shrink:0"><div style="display:flex;align-items:center;gap:10px"><div style="font-size:14px;font-weight:600;color:${c.t1};letter-spacing:-0.01em">${header.title}</div>${header.meta || ""}</div><div style="display:flex;align-items:center;gap:8px">${header.actions || ""}</div></div>`);
  return w(main, `<div layer-name="Content" style="flex:1;min-height:0;display:flex;flex-direction:column"></div>`);
}
/**
 * Frame for onboarding: no sidebar, a slim top bar with the mark and a 3-step indicator, and a centred column.
 * step: 1..3. Returns the id of the empty centred column (560px wide, flex column, starts 96px below the bar).
 */
export function onboardShell(artboard, step, width = 560) {
  const names = ["Add Imitor", "Stand-ins", "First run"];
  const steps = names.map((n, i) => { const s = i + 1 < step ? "done" : i + 1 === step ? "now" : "next"; return `<div style="display:flex;align-items:center;gap:7px"><div style="width:18px;height:18px;border-radius:50%;display:flex;align-items:center;justify-content:center;${M}font-size:11px;${s === "done" ? `background:${c.ok};color:${c.bg}` : s === "now" ? `background:${c.t1};color:${c.bg}` : `border:1px solid ${c.line2};color:${c.t3}`}">${s === "done" ? "✓" : i + 1}</div><div style="font-size:13px;font-weight:${s === "now" ? 500 : 400};color:${s === "next" ? c.t3 : c.t1}">${n}</div></div>${i < 2 ? `<div style="width:28px;height:1px;background:${c.line2}"></div>` : ""}`; }).join("");
  const col = w(artboard, `<div layer-name="Onboarding" style="${F}flex:1;display:flex;flex-direction:column"></div>`);
  w(col, `<div layer-name="Top bar" style="display:flex;align-items:center;justify-content:space-between;height:56px;padding:0 24px;flex-shrink:0"><div style="display:flex;align-items:center;gap:9px;width:200px">${mark(18)}<div style="font-size:14px;font-weight:600;color:${c.t1};letter-spacing:-0.01em">Imitor</div></div><div layer-name="Steps" style="display:flex;align-items:center;gap:10px">${steps}</div><div style="width:200px;display:flex;justify-content:flex-end;font-size:13px;color:${c.t2}">Skip setup</div></div>`);
  const wrap = w(col, `<div layer-name="Centre" style="flex:1;display:flex;justify-content:center;padding-top:72px"></div>`);
  return w(wrap, `<div layer-name="Column" style="width:${width}px;display:flex;flex-direction:column"></div>`);
}
