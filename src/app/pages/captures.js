// Captures: screenshots and videos taken by agents, CI and people, grouped Today / Yesterday / Earlier.
// Filters (All / Screenshots / Videos, Device, Captured by, Scheme) work on the loaded list.
import { api } from "../api.js";
import { html, raw, icon, seg, pill, avatar, codeBlock, safeUrl, skeletonRows, errorState, madeMark, secretsMark } from "../components.js";
import { dayGroup, deviceName, schemeName, humanize } from "../format.js";
import { pageHeader } from "./common.js";
import { withBase } from "../base.js";

const KINDS = [{ value: "all", label: "All" }, { value: "screenshot", label: "Screenshots" }, { value: "video", label: "Videos" }];

export async function mount(ctx) {
  const { main } = ctx;
  document.title = "Captures · Imitor";
  const q = ctx.url.searchParams;
  const f = {
    kind: KINDS.some((k) => k.value === q.get("kind")) ? q.get("kind") : "all",
    device: q.get("device") || "",
    by: q.get("by") || "",
    scheme: q.get("scheme") || "",
  };

  main.innerHTML = String(html`${pageHeader(html`<h1>Captures</h1>`)}<div class="content">${skeletonRows(6)}</div>`);
  let captures;
  try { ({ captures } = await api.captures()); } catch (e) {
    if (!ctx.isCurrent()) return;
    main.querySelector(".content").innerHTML = String(errorState("captures", e));
    return;
  }
  if (!ctx.isCurrent()) return;

  if (!captures.length) {
    main.innerHTML = String(html`${pageHeader(html`<h1>Captures</h1>`)}<div class="content"><div class="state">
      <h2>No captures yet</h2>
      <p>Screenshots and videos that agents, CI and people take with Imitor show up here. Ask an agent for one, or take one yourself:</p>
      ${codeBlock(["npx imitor screenshot --route /"])}
    </div></div>`);
    return;
  }

  // Filter options come from the data. Keep a value from the URL even if no capture has it, so the empty result explains itself.
  const uniq = (arr) => [...new Set(arr.filter(Boolean))];
  const devices = uniq(captures.map((c) => c.device));
  const schemes = uniq(captures.map((c) => c.scheme));
  const people = uniq(captures.map((c) => c.by?.name));

  const matches = (c) => (f.kind === "all" || c.kind === f.kind) && (!f.device || c.device === f.device)
    && (!f.by || c.by?.name === f.by) && (!f.scheme || c.scheme === f.scheme);

  function syncUrl() {
    const u = new URLSearchParams();
    if (f.kind !== "all") u.set("kind", f.kind);
    for (const k of ["device", "by", "scheme"]) if (f[k]) u.set(k, f[k]);
    const s = u.toString();
    history.replaceState(null, "", withBase(`/captures${s ? "?" + s : ""}`));
  }

  const select = (key, label, anyLabel, values, show) => html`<label class="select-box"><span>${label}</span><select data-filter="${key}">
      <option value="">${anyLabel}</option>${values.map((v) => html`<option value="${v}"${v === f[key] ? raw(" selected") : ""}>${show(v)}</option>`)}</select></label>`;

  function render() {
    const shown = captures.filter(matches);
    const groups = new Map();
    for (const c of shown) {
      const g = dayGroup(c.at);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(c);
    }
    main.innerHTML = String(html`
      ${pageHeader(html`<h1>Captures</h1><span class="mono t3">${shown.length}</span>`)}
      <div class="toolbar">
        ${seg("kind", KINDS, f.kind, "Show captures")}
        <div class="toolbar-group">
          ${select("device", "Device", "Any", devices, deviceName)}
          ${select("by", "Captured by", "Anyone", people, (v) => v)}
          ${select("scheme", "Scheme", "Any", schemes, schemeName)}
        </div>
      </div>
      <div class="content">${shown.length ? html`<div class="cap-groups">${[...groups].map(([name, list]) => html`
        <section class="cap-group" aria-label="${name}">
          <h2 class="cap-group-head"><span>${name}</span><span class="mono t3">${list.length}</span></h2>
          <div class="cap-grid">${list.map((c) => tile(c, name))}</div>
        </section>`)}</div>`
        : html`<p class="placeholder-page">No captures match these filters.</p>`}</div>`);
  }

  main.addEventListener("click", (e) => {
    const b = e.target.closest("[data-seg=kind] button");
    if (!b) return;
    f.kind = b.dataset.value;
    syncUrl(); render();
    main.querySelector("[data-seg=kind] [aria-pressed=true]")?.focus();
  });
  main.addEventListener("change", (e) => {
    const key = e.target.dataset?.filter;
    if (!key) return;
    f[key] = e.target.value;
    syncUrl(); render();
    main.querySelector(`[data-filter=${key}]`)?.focus();
  });
  render();
}

function clock(iso, group) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
  if (group !== "Earlier") return time;
  return `${d.toLocaleDateString(undefined, { day: "numeric", month: "short" })}, ${time}`;
}

// Recordings start on a blank page while the app loads, so the tile shows the frame at 1 s (or half way through a shorter video).
const posterTime = (s) => (Number(s) > 0 ? Math.min(1, Number(s) / 2) : 0.1);

const duration = (s) => {
  const n = Math.max(0, Math.round(Number(s) || 0));
  return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, "0")}`;
};

function tile(c, group) {
  const url = safeUrl(c.file);
  const video = c.kind === "video";
  const title = video ? humanize(c.flow || "Video") : c.route || humanize(c.flow || "Screenshot");
  const where = [deviceName(c.device), schemeName(c.scheme)].filter(Boolean).join(", ");
  const alt = `${video ? `Video of ${title}` : title}${where ? ` on ${where}` : ""}`;
  const standIns = Array.isArray(c.standIns) ? c.standIns : [];
  const by = c.by || { name: "Unknown", kind: "person" };
  const media = !url
    ? html`<div class="thumb is-missing">No file</div>`
    : video
      ? html`<button type="button" class="thumb cap-thumb" data-open-shot="${url}" data-video="1" data-copy-link data-alt="${alt}" aria-label="Play ${alt}">
          <video src="${url}#t=${posterTime(c.seconds)}" preload="metadata" muted playsinline tabindex="-1" aria-hidden="true"></video>
          ${c.seconds != null ? html`<span class="cap-duration">${icon("play", 10)}${duration(c.seconds)}</span>` : html`<span class="cap-duration">${icon("play", 10)}</span>`}
        </button>`
      : html`<button type="button" class="thumb cap-thumb" data-open-shot="${url}" data-copy-link data-alt="${alt}" aria-label="Open ${alt} full size"><img src="${url}" alt="" loading="lazy"></button>`;
  return html`<figure class="cap-tile">
    <div class="cap-media">${media}${standIns.length || c.state || c.seeded || c.secrets?.length ? html`<span class="cap-standin">${standIns.length ? html`<span title="${`Stand-in: ${standIns.join(", ")}. This part is not drawn like the real app.`}">${pill("Stand-in", "warn")}</span>` : ""}${madeMark(c)}${secretsMark(c)}</span>` : ""}</div>
    <figcaption>
      <span class="cap-title${video || !c.route ? "" : " mono"}" title="${alt}">${title}</span>
      <span class="cap-meta">${avatar(by)}<span class="cap-who" title="${`${by.name}${by.kind === "person" ? "" : ` (${by.kind})`}`}">${by.name}</span><span aria-hidden="true">·</span><time datetime="${c.at}">${clock(c.at, group)}</time></span>
    </figcaption>
  </figure>`;
}
