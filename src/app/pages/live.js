// Live preview: the built app itself, running in an <iframe> inside Imitor's device frame, with the flows rail on the
// left and the fidelity inspector and controls on the right. Full width, no sidebar.
// The preview is served on its own origin (GET /api/project previewUrl). Every page of it loads a small driver
// (src/live-driver.js) that this page talks to with postMessage: it performs flow steps inside the frame, clears the
// app's stored state, and reports the route and the stand-ins on screen.
import { api, isCloud, isRemote, isDemo, LIVE_UNAVAILABLE } from "../api.js";
import { html, raw, icon, logo, statusMark, chip, pill, switchEl, loadingLine, errorState, codeBlock, demoPill } from "../components.js";
import { ago, deviceName, humanize, stepLabel, plural } from "../format.js";
import { withBase } from "../base.js";

const STRIP = { ios: 47, android: 28 }; // status bar drawn above the app (device px); the app's viewport stays the device's size
const BEZEL = 10; // screen px
const STEP_TIMEOUT = 25000;
const READY_TIMEOUT = 20000;
const RUN_STATUS = { passed: "Passed", "stand-ins": "Passed with stand-ins", failed: "Failed" };

export async function mount(ctx) {
  const { main, params } = ctx;
  const runId = params.id || null;
  document.title = "Live preview · Imitor";
  main.classList.add("live-main");
  main.innerHTML = String(html`${topBar({ runId })}<div class="live-body">${loadingLine("Loading the preview…")}</div>`);

  let project, detail = null;
  try {
    [project, detail] = await Promise.all([api.project(), runId ? api.run(runId) : Promise.resolve(null)]);
  } catch (e) {
    if (!ctx.isCurrent()) return;
    main.querySelector(".live-body").innerHTML = String(errorState(runId ? `run ${runId}` : "the project", e));
    return;
  }
  if (!ctx.isCurrent()) return;
  const live = createLive(ctx, project, detail);
  live.start();
}

function topBar({ runId, project, run, problems, shots, builtAt }) {
  const base = runId ? withBase(`/runs/${encodeURIComponent(runId)}`) : null;
  const title = run ? `${run.pr != null ? `#${run.pr} ` : ""}${run.title || run.id}` : runId ? runId : "Latest build";
  return html`<header class="live-bar">
    <div class="live-crumbs">
      <a class="live-brand" href="${withBase(`/runs`)}" title="Runs">${logo(24)}<span class="wordmark">Imitor</span></a>
      <span class="sep" aria-hidden="true">/</span>
      <a class="crumb-project" href="${withBase(`/runs`)}">${project?.name || "…"}</a>
      <span class="sep" aria-hidden="true">/</span>
      ${base ? html`<a class="crumb-run" href="${base}" title="${title}">${title}</a>` : html`<span class="crumb-run t2">${title}</span>`}
      ${run?.commit ? chip(run.commit) : ""}
    </div>
    ${base ? html`<nav class="tabs live-tabs" aria-label="Run">
      <a class="tab" href="${base}/live" aria-current="page">Live</a>
      <a class="tab" href="${base}">Shots${shots != null ? html`<span class="count">${shots}</span>` : ""}</a>
      <a class="tab" href="${base}/problems">Problems${problems != null ? html`<span class="count${problems.open ? " bad" : ""}">${problems.total}</span>` : ""}</a>
    </nav>` : html`<span></span>`}
    <div class="live-actions">
      ${isDemo ? demoPill() : ""}
      ${builtAt ? html`<span class="built" title="${new Date(builtAt).toLocaleString()}"><span class="dot" aria-hidden="true"></span>Built ${ago(builtAt) === "now" ? "just now" : `${ago(builtAt)} ago`}</span>` : ""}
      <button type="button" class="btn btn-secondary" data-live-copy data-copy="${location.href}" data-copy-toast="Link copied">${icon("copy", 14)}Copy link</button>
    </div>
  </header>`;
}

function createLive(ctx, project, detail) {
  const { main } = ctx;
  const run = detail?.run || null;
  const runId = ctx.params.id || null;
  const q = ctx.url.searchParams;
  const devices = project.devices || [];
  const schemes = project.schemes?.length ? project.schemes : ["light", "dark"];
  const flows = (project.flows || []).map((f) => ({ ...f, shots: f.steps.filter((s) => s.action === "shot") }));
  const previewOrigin = project.previewUrl ? new URL(project.previewUrl).origin : null;

  const st = {
    device: devices.find((d) => d.name === q.get("device")) || devices.find((d) => d.name === detail?.devices?.[0]) || devices[0],
    scheme: ["light", "dark"].includes(q.get("scheme")) ? q.get("scheme") : schemes[0],
    motion: q.get("motion") !== "full", // reduced by default, as in runs
    current: null, // { flow, index } of the shot step on screen
    route: null,
    standIns: [],
    setup: undefined, // what the frame reports: { flow, state, seedErrors }, or null for a page without flow state
    media: undefined, // what the frame reports: null = this build has no scheme override
    appearance: project.previewAppearance !== false,
    busy: null, // { flow, target, done, total, label }
    error: null, // { flow, index, message }
    scale: 1,
  };
  const want = { flow: q.get("flow"), step: Number(q.get("step")) || null };
  if (st.current == null && flows[0]) {
    const first = flows[0].steps.find((s) => s.action !== "shot" && s.action !== "wait");
    const firstShot = flows[0].shots[0];
    if (firstShot && !flows[0].chain?.before?.length && (!first || first.index > firstShot.index)) st.current = { flow: flows[0].name, index: firstShot.index };
  }

  const shotsCount = detail ? (detail.run?.shots ?? detail.flows.reduce((n, f) => n + f.steps.filter((s) => s.shot).length, 0)) : null;
  const failures = detail ? detail.problems.filter((p) => p.kind !== "stand-in") : [];
  const problems = detail ? { total: failures.length, open: failures.filter((p) => !p.seen).length } : null;
  document.title = `${run ? `${run.pr != null ? `#${run.pr} ` : ""}${run.title || run.id}` : "Latest build"} · Live · Imitor`;
  main.innerHTML = String(html`${topBar({ runId, project, run, problems, shots: shotsCount, builtAt: project.builtAt })}
    <div class="live-body">
      <nav class="live-rail" aria-label="Flows and shots"></nav>
      <section class="live-stage" aria-label="Preview">
        <div class="stage-fit"></div>
        <div class="stage-status" role="status" aria-live="polite"></div>
        <p class="stage-caption mono"></p>
      </section>
      <aside class="live-inspector" aria-label="Fidelity and controls"></aside>
      <div class="live-phone"></div>
      <div class="live-sheet-backdrop" data-live="sheet-close" hidden></div>
    </div>`);
  // Phone layout (app.css, below 700px): a step bar in place of the rail, a fidelity row that opens the inspector as a
  // sheet, and a bar with the device and appearance. The preview fills the width without the device frame.
  const phoneEl = main.querySelector(".live-phone");
  const backdrop = main.querySelector(".live-sheet-backdrop");
  const isPhone = () => matchMedia("(max-width: 700px)").matches;
  const rail = main.querySelector(".live-rail");
  const stage = main.querySelector(".live-stage");
  const fit = main.querySelector(".stage-fit");
  const status = main.querySelector(".stage-status");
  const caption = main.querySelector(".stage-caption");
  const inspector = main.querySelector(".live-inspector");
  let frame = null;

  /* ---------- Talking to the frame ---------- */
  let seq = 0;
  const pending = new Map(); // id -> { resolve, reject, timer }
  let readyWaiters = [];
  function onMessage(e) {
    if (!frame || e.source !== frame.contentWindow || e.origin !== previewOrigin) return;
    const m = e.data || {};
    if (m.imitor === "ready") {
      st.media = m.media ?? null;
      if (m.media === null || m.media === undefined) st.appearance = false;
      st.route = m.route; st.standIns = m.standIns || []; st.setup = m.setup ?? null;
      readyWaiters.forEach((w) => w()); readyWaiters = [];
      renderCaption(); renderInspector();
    } else if (m.imitor === "route") { st.route = m.route; renderCaption(); }
    else if (m.imitor === "stand-ins") { st.standIns = m.standIns || []; renderInspector(); }
    else if ((m.imitor === "step-done" || m.imitor === "reset-done") && pending.has(m.id)) {
      const p = pending.get(m.id); pending.delete(m.id); clearTimeout(p.timer); p.resolve(m);
    }
  }
  addEventListener("message", onMessage);
  const alive = () => ctx.isCurrent() && document.contains(main);
  const cleanup = setInterval(() => { if (!alive()) { removeEventListener("message", onMessage); clearInterval(cleanup); ro?.disconnect(); } }, 1000);

  function send(message, timeout) {
    const id = ++seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error("the preview did not answer")); }, timeout);
      pending.set(id, { resolve, reject, timer });
      frame.contentWindow.postMessage({ ...message, id }, previewOrigin);
    });
  }
  function nextReady(timeout = READY_TIMEOUT) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`the preview did not load within ${timeout / 1000} s. Is \`imitor app\` still running?`)), timeout);
      readyWaiters.push(() => { clearTimeout(timer); resolve(); });
    });
  }
  /** `flow`: the flow whose state, seed and clock the page starts with ("" for none); undefined keeps the tab's. */
  function frameUrl(route, flow) {
    const u = new URL(route || "/", project.previewUrl);
    if (flow !== undefined) u.searchParams.set("imitor-flow", flow || "");
    if (st.appearance) {
      u.searchParams.set("imitor-scheme", st.scheme);
      u.searchParams.set("imitor-motion", st.motion ? "reduce" : "no-preference");
    }
    return u.href;
  }
  /** Load `route` in the frame, after clearing what the app stored when `reset`, starting `flow`'s state. Resolves once the driver is up. */
  async function openApp(route, { reset = false, flow } = {}) {
    if (reset && st.media !== undefined) await send({ imitor: "reset" }, 4000).catch(() => {});
    const ready = nextReady();
    frame.src = frameUrl(route, flow);
    await ready;
  }
  // Where a flow really starts (after the flows it runs after, if any), for projects from before "after" too.
  const startOf = (f) => (f ? f.chain?.start ?? f.start ?? "/" : "/");
  const madeUp = (f) => Boolean(f && (f.state || f.seeded));

  /* ---------- Replay ---------- */
  let token = 0;
  async function replay(flowName, target) {
    const flow = flows.find((f) => f.name === flowName);
    if (!flow) return;
    const mine = ++token;
    const before = [...(flow.chain?.before || []), ...flow.steps.filter((s) => s.index < target)];
    st.error = null;
    st.current = { flow: flow.name, index: target };
    st.busy = { flow: flow.name, target, done: 0, total: before.length, label: madeUp(flow) ? "Starting from the flow’s state" : "Starting from an empty state" };
    renderRail(); renderStatus(); syncUrl();
    try {
      await openApp(startOf(flow), { reset: true, flow: flow.name });
      for (const s of before) {
        if (mine !== token || !alive()) return;
        st.busy = { ...st.busy, label: describeStep(s) };
        renderStatus();
        if (s.action === "goto") await openApp(s.step.goto);
        else if (s.action === "fill" && s.step.fill && (typeof s.step.fill.value === "object" || s.step.fill.value === "\u2022\u2022\u2022")) {
          // Secrets stay with the command line and CI, and an exported site has no typed values: the replay stops here.
          const fromEnv = s.step.fill.value !== null && typeof s.step.fill.value === "object";
          st.error = { flow: flow.name, index: s.index, in: s.flow && s.flow !== flow.name ? s.flow : null, message: fromEnv ? `it fills ${s.step.fill.value.env || "a value"} from the environment, which the live preview does not replay. Runs and the command line do.` : "an exported site does not include the values flows type, so the replay stops here. imitor app replays it.", step: s };
          break;
        } else if (s.action !== "shot") {
          const r = await send({ imitor: "step", step: s.step }, STEP_TIMEOUT).catch((e) => ({ ok: false, error: e.message }));
          if (mine !== token) return;
          if (!r.ok) { st.error = { flow: flow.name, index: s.index, in: s.flow && s.flow !== flow.name ? s.flow : null, message: r.error, step: s }; break; }
        }
        st.busy = { ...st.busy, done: st.busy.done + 1 };
        renderStatus();
      }
      if (mine === token && !st.error) await new Promise((ok) => setTimeout(ok, 300));
    } catch (e) {
      if (mine === token) st.error = { flow: flow.name, index: null, message: e.message };
    }
    if (mine !== token) return;
    st.busy = null;
    renderRail(); renderStatus(); renderInspector();
  }
  const lowerFirst = (t) => t.charAt(0).toLowerCase() + t.slice(1);
  function describeStep(s) {
    const v = s.label;
    return { tap: `Tapping “${v}”`, fill: `Filling “${v}”`, goto: `Opening ${v}`, wait: `Waiting ${v}`, waitFor: `Waiting for “${v}”`, scroll: `Scrolling ${v}` }[s.action] || `Step ${s.index}`;
  }

  /* ---------- Rendering ---------- */
  function runFlowFor(name) {
    if (!detail) return null;
    const list = detail.flows.filter((f) => f.name === name);
    return list.find((f) => f.device === st.device?.name && f.scheme === st.scheme) || list.find((f) => f.scheme === st.scheme) || list[0] || null;
  }
  function renderRail() {
    renderPhone();
    if (!flows.length) { rail.innerHTML = String(html`<p class="rail-empty">No flows in imitor.config.json.</p>`); return; }
    rail.innerHTML = String(html`${flows.map((f) => {
      const rf = runFlowFor(f.name);
      return html`<div class="rail-flow">
        <div class="rail-head"><span>${humanize(f.name)}</span><span class="mono t3">${f.shots.length}</span></div>
        ${f.shots.map((s) => {
          const rs = rf?.steps.find((x) => x.index === s.index);
          const { num, label: named } = stepLabel({ name: s.label, index: s.index });
          const label = named === num ? `Shot ${num}` : named; // a shot named only by its number
          const isCurrent = st.current?.flow === f.name && st.current.index === s.index;
          const busy = st.busy && st.busy.flow === f.name && st.busy.target === s.index;
          const failedHere = st.error && st.error.flow === f.name && st.current?.index === s.index;
          const cls = [isCurrent ? "is-current" : "", rs?.status === "failed" ? "is-failed" : "", rs?.status === "not-reached" ? "is-missing" : ""].filter(Boolean).join(" ");
          const note = rs ? { ok: "passed in this run", "stand-in": `contains a stand-in${rs.standIns?.length ? `: ${rs.standIns.join(", ")}` : ""}`, failed: "the run failed here", "not-reached": "not reached in this run" }[rs.status] : "";
          return html`<button type="button" class="rail-step ${cls}" data-flow="${f.name}" data-index="${s.index}"${isCurrent ? raw(' aria-current="step"') : ""} title="Bring the app to ${label}${note ? ` (${note})` : ""}">
            <span class="num mono">${num}</span><span class="label">${label}</span>
            ${busy ? statusMark("progress", "Replaying") : failedHere ? statusMark("failed", "Could not reach") : rs?.status === "failed" ? statusMark("failed", "Failed in this run") : rs?.status === "stand-in" ? html`<span class="standin-dot" role="img" aria-label="Contains a stand-in"></span>` : ""}
          </button>`;
        })}
      </div>`;
    })}
    ${detail ? html`<p class="rail-note">${statusMark(run.status, RUN_STATUS[run.status] || run.status)}<span>Statuses from this run on ${deviceName(runFlowFor(flows[0]?.name)?.device || st.device?.name)}, ${runFlowFor(flows[0]?.name)?.scheme || st.scheme}.</span></p>` : ""}`);
  }

  function renderStatus() {
    if (st.busy) {
      const b = st.busy;
      status.innerHTML = String(html`<div class="replay">${statusMark("progress", "Replaying")}<span>${b.label}</span><span class="mono t3">${b.done} / ${b.total}</span>
        <span class="bar" aria-hidden="true"><span style="width:${raw(b.total ? Math.round((b.done / b.total) * 100) : 100)}%"></span></span></div>`);
      return;
    }
    if (st.error) {
      const e = st.error;
      status.innerHTML = String(html`<div class="replay is-error" role="alert">${statusMark("failed", "Could not replay")}
        <span>${e.index ? html`Couldn’t perform step <span class="mono">${String(e.index).padStart(2, "0")}</span> of ${humanize(e.in || e.flow)}${e.in ? html`, which ${humanize(e.flow)} runs after` : ""}${e.step ? html` (${lowerFirst(describeStep(e.step))})` : ""}: ` : e.step ? html`Couldn’t open ${e.step.label}${e.in ? html` in ${humanize(e.in)}, which ${humanize(e.flow)} runs after` : ""}: ` : "Couldn’t open the preview: "}${e.message}</span>
        <button type="button" class="btn btn-ghost" data-live="dismiss">Dismiss</button></div>`);
      return;
    }
    status.innerHTML = "";
  }

  function renderCaption() {
    const d = st.device;
    if (st.viewH) {
      // Phone: the route, the app's size (and how much of its height is in view) and the run's commit.
      const size = st.viewH < d.height ? `${d.width} × ${st.viewH} of ${d.height}` : `${d.width} × ${d.height}`;
      caption.innerHTML = String(html`<span class="route" title="${st.route || "/"}">${st.route || "/"}</span><span class="dim">·</span><span>${size}</span>${run?.commit ? html`<span class="dim">·</span><span>${run.commit}</span>` : ""}`);
      return;
    }
    caption.innerHTML = String(html`<span>${st.route || "/"}</span><span class="dim">·</span><span>${d.width} × ${d.height}</span><span class="dim">·</span><span>${Math.round(st.scale * 100)}%</span>`);
  }

  function renderInspector() {
    const visible = new Map(st.standIns.map((s) => [s.kind, s.count]));
    const standIns = project.standIns || [];
    const onScreen = st.standIns.length
      ? html`On this screen: ${st.standIns.map((s, i) => html`${i ? ", " : ""}<span class="mono">${s.kind}</span>${s.count > 1 ? ` ×${s.count}` : ""}`)}`
      : isRemote && !project.previewUrl ? "" : st.media === undefined ? "Waiting for the preview…" : "No stand-ins on this screen.";
    const d = st.device;
    const appearanceNote = st.appearance || (isRemote && !project.previewUrl) ? "" : html`<p class="control-note">This preview was built before Imitor could switch its appearance and motion. Rebuild it to use these: <span class="mono">npx imitor build</span>. Until then the app follows this computer’s settings.</p>`;
    inspector.innerHTML = String(html`
      <section class="insp-section">
        <div class="insp-head"><h2>Fidelity</h2>${pill("Web imitation", "acc")}<button type="button" class="m-icon-btn live-sheet-close" data-live="sheet-close" aria-label="Close">${icon("close", 16)}</button></div>
        <ul class="fidelity">
          ${standIns.map((s) => {
            const n = visible.get(s.kind);
            return html`<li>${statusMark(s.fidelity === "genuine" ? "ok" : "standin", s.fidelity === "genuine" ? "Genuine" : "Stand-in")}<span class="what mono" title="${s.module}">${s.module}</span>
              <span class="${s.fidelity === "genuine" ? "how t3" : "how warn"}">${s.fidelity === "genuine" ? "Genuine" : "Stand-in"} · ${s.kind}${n ? html`<span class="on-screen"> · on screen</span>` : ""}</span></li>`;
          })}
          ${(project.notCovered || []).map((t) => html`<li>${statusMark("off", "Not shown")}<span class="what">${t}</span><span class="how t3">Not shown</span></li>`)}
        </ul>
        <p class="on-screen-line">${onScreen}</p>
      </section>
      ${stateSection()}
      <section class="insp-section controls">
        <div class="control control-device"><div class="control-label"><span>Device</span><span class="mono t3">${d.width} × ${d.height}</span></div>
          <select class="field" data-live="device" aria-label="Device">${devices.map((x) => html`<option value="${x.name}"${x.name === d.name ? raw(" selected") : ""}>${deviceName(x.name)}</option>`)}</select></div>
        <div class="control row control-appearance"><span class="control-label">Appearance</span>
          <div class="seg" role="group" aria-label="Appearance" data-seg="appearance">${["light", "dark"].map((s) => html`<button type="button" data-value="${s}" aria-pressed="${st.scheme === s ? "true" : "false"}"${st.appearance ? "" : raw(" disabled")}>${s === "light" ? "Light" : "Dark"}</button>`)}</div></div>
        <div class="control row"><span class="control-label">Reduce motion</span>${switchEl(st.motion, "Reduce motion", `data-live="motion"${st.appearance ? "" : " disabled"}`)}</div>
        ${appearanceNote}
        <div class="control row"><span class="control-label">Reload<span class="t3 control-sub">${madeUp(flows[0]) ? "Start again from the first flow’s state" : "Start again from an empty state"}</span></span>
          <button type="button" class="btn btn-secondary" data-live="reload"${st.busy ? raw(" disabled") : ""}>${icon("retry", 14)}Reload</button></div>
      </section>`);
    renderPhone();
  }

  /** The state the page started from: the flow it runs after, its state label, seeded data and clock. */
  function stateSection() {
    const f = st.setup?.flow ? flows.find((x) => x.name === st.setup.flow) : null;
    const errors = st.setup?.seedErrors || [];
    if (!f || !(f.after || f.state || f.seeded || f.clock || errors.length)) return "";
    const when = f.clock ? new Date(f.clock).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short", timeZone: "UTC" }) + " UTC" : null;
    return html`<section class="insp-section">
      <div class="insp-head"><h2>Flow state</h2><span class="t3">${humanize(f.name)}</span></div>
      <ul class="fidelity">
        ${f.after ? html`<li>${statusMark("off", "Runs after")}<span class="what">Runs after ${humanize(f.after)}</span><span class="how t3">its steps first</span></li>` : ""}
        ${f.state ? html`<li>${statusMark("standin", "Invented")}<span class="what">State <span class="mono">${f.state}</span></span><span class="how warn">Invented</span></li>` : ""}
        ${f.seeded ? html`<li>${statusMark("standin", "Invented")}<span class="what">Seeded data</span><span class="how warn">Invented</span></li>` : ""}
        ${when ? html`<li>${statusMark("off", "Clock")}<span class="what">Clock from ${when}</span><span class="how t3">Date only</span></li>` : ""}
      </ul>
      ${f.state || f.seeded ? html`<p class="control-note">The stand-ins and seed supply this data. It is not the real app’s.</p>` : ""}
      ${when ? html`<p class="control-note">Here only <span class="mono">Date</span> is moved to the clock; timers and animations run as usual. Runs use Playwright’s clock.</p>` : ""}
      ${errors.length ? html`<p class="control-note warn">${plural(errors.length, "seed statement")} failed: ${errors.map((e, i) => html`${i ? "; " : ""}<span class="mono">${String(e.statement).slice(0, 80)}</span> (${e.error})`)}</p>` : ""}
    </section>`;
  }

  /** Phone: the step bar (previous, the shot on screen, next), the fidelity row and the device and appearance bar. */
  function renderPhone() {
    const all = flows.flatMap((f) => f.shots.map((s, i) => ({ flow: f, shot: s, pos: i + 1 })));
    const at = st.current ? all.findIndex((x) => x.flow.name === st.current.flow && x.shot.index === st.current.index) : -1;
    const cur = all[at] || null;
    const prev = at > 0 ? all[at - 1] : null;
    const next = at + 1 < all.length ? all[at + 1] : null;
    const name = (x) => { const { num, label } = stepLabel({ name: x.shot.label, index: x.shot.index }); return { num, label: label === num ? `Shot ${num}` : label }; };
    const go = (x, dir) => x
      ? html`<button type="button" class="m-icon-btn" data-live="step" data-dir="${dir}" data-flow="${x.flow.name}" data-index="${x.shot.index}" aria-label="${dir === "prev" ? "Previous" : "Next"} shot: ${name(x).num} ${name(x).label}">${icon(dir === "prev" ? "back" : "chevron", 16)}</button>`
      : html`<button type="button" class="m-icon-btn" disabled aria-label="${dir === "prev" ? "No previous shot" : "No next shot"}">${icon(dir === "prev" ? "back" : "chevron", 16)}</button>`;
    let middle;
    if (cur) {
      const { num, label } = name(cur);
      const rs = runFlowFor(cur.flow.name)?.steps.find((x) => x.index === cur.shot.index);
      const busy = st.busy && st.busy.flow === cur.flow.name && st.busy.target === cur.shot.index;
      const mark = busy ? statusMark("progress", "Replaying") : st.error ? statusMark("failed", "Could not reach") : rs?.status === "failed" ? statusMark("failed", "Failed in this run") : rs?.status === "stand-in" ? html`<span class="standin-dot" role="img" aria-label="Contains a stand-in"></span>` : "";
      middle = html`<span class="m-step-num mono">${num}</span><span class="m-step-label">${label}</span>${mark}<span class="m-step-of">${humanize(cur.flow.name)} · ${cur.pos} of ${cur.flow.shots.length}</span>`;
    } else {
      middle = all.length ? html`<span class="m-step-label">Start</span><span class="m-step-of">${humanize(all[0].flow.name)} · before shot 1</span>` : html`<span class="m-step-of">No flows in imitor.config.json</span>`;
    }
    const standIns = (project.standIns || []).filter((s) => s.fidelity !== "genuine").length;
    const notShown = (project.notCovered || []).length;
    const summary = [standIns ? plural(standIns, "stand-in") : "No stand-ins", notShown ? `${notShown} ${notShown === 1 ? "thing" : "things"} not shown` : null].filter(Boolean).join(" · ");
    const d = st.device;
    const dark = st.scheme === "dark";
    phoneEl.innerHTML = String(html`
      <div class="m-steps" role="group" aria-label="Shots">${go(prev, "prev")}<div class="m-step" aria-live="polite">${middle}</div>${go(next, "next")}</div>
      <button type="button" class="m-fidelity" data-live="fidelity" aria-haspopup="dialog">${statusMark(standIns ? "standin" : "ok", standIns ? "Stand-ins in this preview" : "Genuine")}<span class="m-fid-title">Fidelity</span><span class="m-fid-sum">${summary}</span>${icon("chevron", 16)}</button>
      <div class="m-live-bar">
        ${d ? html`<label class="btn btn-secondary m-device">${icon("phone", 16)}<span>Device · ${deviceName(d.name)}</span>
          <select data-live="device" aria-label="Device">${devices.map((x) => html`<option value="${x.name}"${x.name === d.name ? raw(" selected") : ""}>${deviceName(x.name)} (${x.width} × ${x.height})</option>`)}</select></label>` : ""}
        <button type="button" class="btn btn-secondary" data-live="scheme-toggle"${st.appearance ? "" : raw(' disabled title="This preview was built before Imitor could switch its appearance"')} aria-label="Appearance: ${dark ? "Dark" : "Light"}. Switch to ${dark ? "light" : "dark"}">${icon(dark ? "moon" : "sun", 16)}${dark ? "Dark" : "Light"}</button>
      </div>`);
  }

  function setSheet(open) {
    inspector.classList.toggle("is-open", open);
    backdrop.hidden = !open;
    if (open) inspector.querySelector(".live-sheet-close")?.focus();
    else phoneEl.querySelector(".m-fidelity")?.focus();
  }

  function layout() {
    if (!st.device) return;
    const d = st.device;
    if (isPhone()) return layoutPhone(d);
    st.viewH = null;
    const strip = STRIP[d.platform] ?? STRIP.ios;
    const r = stage.getBoundingClientRect();
    const availH = r.height - 40 /* top */ - 64 /* caption; the replay status floats over the stage */;
    const availW = r.width - 64 - 20 /* ghost offset */;
    const s = Math.max(0.3, Math.min(1, (availH - 2 * BEZEL) / (d.height + strip), (availW - 2 * BEZEL) / d.width));
    st.scale = Math.floor(s * 100) / 100;
    const sw = Math.round(d.width * st.scale), sh = Math.round((d.height + strip) * st.scale);
    fit.style.setProperty("--sw", `${sw}px`);
    fit.style.setProperty("--sh", `${sh}px`);
    fit.style.setProperty("--strip", `${Math.round(strip * st.scale)}px`);
    fit.style.setProperty("--k", st.scale);
    fit.style.setProperty("--radius", `${Math.round((d.platform === "android" ? 34 : 55) * st.scale) + BEZEL}px`);
    if (frame) {
      frame.style.width = `${d.width}px`;
      frame.style.height = `${d.height}px`;
      frame.style.transform = `scale(${st.scale})`;
    }
    renderCaption();
  }

  // Phone: no device frame. The app keeps the device's width, scaled to fill the stage's width; its viewport is as tall
  // as the space allows (up to the device's height), so the app lays itself out for the screen that is visible.
  function layoutPhone(d) {
    const pad = 16, captionH = 34;
    const availW = stage.clientWidth - 2 * pad;
    const availH = stage.clientHeight - captionH;
    if (availW <= 0 || availH <= 0) return;
    st.scale = Math.min(1, availW / d.width);
    st.viewH = Math.max(1, Math.min(d.height, Math.floor(availH / st.scale)));
    fit.style.setProperty("--sw", `${Math.round(d.width * st.scale)}px`);
    fit.style.setProperty("--sh", `${Math.round(st.viewH * st.scale)}px`);
    if (frame) {
      frame.style.width = `${d.width}px`;
      frame.style.height = `${st.viewH}px`;
      frame.style.transform = `scale(${st.scale})`;
    }
    renderCaption();
  }

  function renderStage() {
    // An exported site has no preview server unless it was exported with --preview-url; Imitor Cloud has none.
    if (isRemote && !project.previewUrl) {
      const shots = withBase(runId ? `/runs/${encodeURIComponent(runId)}` : "/runs");
      fit.innerHTML = String(html`<div class="state stage-state"><h2>${isCloud ? "No live preview in Imitor Cloud" : "No live preview on this site"}</h2><p>${LIVE_UNAVAILABLE} <a href="${shots}" style="text-decoration:underline">${runId ? "See this run’s shots" : "See the runs and their shots"}</a> instead.</p></div>`);
      return false;
    }
    if (!project.built) {
      fit.innerHTML = String(html`<div class="state stage-state"><h2>No preview build yet</h2><p>Build the web preview of ${project.name} first. The live preview shows that build.</p>${codeBlock(["npx imitor build"])}</div>`);
      return false;
    }
    if (!project.previewUrl) {
      fit.innerHTML = String(html`<div class="state stage-state"><h2>The preview server is not running</h2><p>Restart <span class="mono">imitor app</span> to serve the preview.</p></div>`);
      return false;
    }
    const d = st.device;
    const platform = d.platform === "android" ? "android" : "ios";
    fit.innerHTML = String(html`<div class="device-wrap ${platform}">
      <div class="ghost" aria-hidden="true"></div>
      <div class="device">
        <div class="statusbar" aria-hidden="true"><span class="time">9:41</span><span class="island"></span><span class="cam"></span><span class="batt"><span></span></span></div>
        <div class="screen"><iframe title="${project.name}, live" referrerpolicy="no-referrer"></iframe></div>
      </div>
    </div>`);
    frame = fit.querySelector("iframe");
    layout();
    return true;
  }

  function syncUrl() {
    const u = new URL(location.href);
    const set = (k, v, dflt) => (v == null || v === dflt ? u.searchParams.delete(k) : u.searchParams.set(k, v));
    set("device", st.device?.name, devices[0]?.name);
    set("scheme", st.scheme, schemes[0]);
    set("motion", st.motion ? null : "full", null);
    set("flow", st.current && !(st.current.flow === flows[0]?.name && st.current.index === flows[0]?.shots[0]?.index) ? st.current.flow : null, null);
    set("step", u.searchParams.has("flow") ? String(st.current.index) : null, null);
    history.replaceState(null, "", u);
    main.querySelector("[data-live-copy]")?.setAttribute("data-copy", location.href);
  }

  /** Reload in place: replay to the current step when there is one, else reopen the route on screen. */
  function refresh() {
    if (st.current && (st.current.flow !== flows[0]?.name || st.current.index !== flows[0]?.shots[0]?.index)) return replay(st.current.flow, st.current.index);
    return openApp(st.route || startOf(flows[0])).catch((e) => { st.error = { message: e.message }; renderStatus(); });
  }

  /* ---------- Events ---------- */
  main.addEventListener("click", (e) => {
    const step = e.target.closest(".rail-step");
    if (step) { replay(step.dataset.flow, Number(step.dataset.index)); return; }
    const segBtn = e.target.closest("[data-seg=appearance] button");
    if (segBtn && !segBtn.disabled) {
      if (segBtn.dataset.value === st.scheme) return;
      st.scheme = segBtn.dataset.value;
      syncUrl(); renderInspector(); renderRail(); refresh();
      return;
    }
    const actEl = e.target.closest("[data-live]");
    const act = actEl?.dataset.live;
    // Phone controls: the step bar, the fidelity sheet and the appearance button.
    if (act === "step" && !actEl.disabled) {
      const dir = actEl.dataset.dir;
      replay(actEl.dataset.flow, Number(actEl.dataset.index));
      (phoneEl.querySelector(`[data-dir=${dir}]`) || phoneEl.querySelector("[data-dir]"))?.focus();
      return;
    }
    if (act === "fidelity") { setSheet(true); return; }
    if (act === "sheet-close") { setSheet(false); return; }
    if (act === "scheme-toggle" && st.appearance) {
      st.scheme = st.scheme === "dark" ? "light" : "dark";
      syncUrl(); renderInspector(); renderRail(); refresh();
      phoneEl.querySelector("[data-live=scheme-toggle]")?.focus();
      return;
    }
    if (act === "motion" && st.appearance) { st.motion = !st.motion; syncUrl(); renderInspector(); refresh(); }
    else if (act === "reload") {
      token++; st.error = null; st.busy = null;
      const f = flows[0];
      st.current = f && f.shots[0] && !f.chain?.before?.length && !f.steps.some((s) => s.index < f.shots[0].index && s.action !== "wait") ? { flow: f.name, index: f.shots[0].index } : null;
      syncUrl(); renderRail(); renderStatus();
      openApp(startOf(f), { reset: true, flow: f?.name || "" }).catch((err) => { st.error = { message: err.message }; renderStatus(); });
    } else if (act === "dismiss") { st.error = null; renderStatus(); renderRail(); }
  });
  main.addEventListener("change", (e) => {
    if (e.target.matches("[data-live=device]")) {
      st.device = devices.find((d) => d.name === e.target.value) || st.device;
      const wrap = fit.querySelector(".device-wrap");
      if (wrap) wrap.className = `device-wrap ${st.device.platform === "android" ? "android" : "ios"}`;
      syncUrl(); layout(); renderInspector(); renderRail();
    }
  });
  main.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && inspector.classList.contains("is-open")) { e.stopPropagation(); setSheet(false); }
  });
  let ro = null;

  return {
    start() {
      renderRail(); renderInspector(); renderStatus();
      if (!renderStage()) { caption.textContent = ""; return; }
      ro = new ResizeObserver(() => layout());
      ro.observe(stage);
      const target = want.flow && flows.find((f) => f.name === want.flow)?.shots.find((s) => s.index === want.step);
      if (target) replay(want.flow, want.step);
      else openApp(startOf(flows[0]), { flow: flows[0]?.name || "" }).catch((e) => { st.error = { message: e.message }; renderStatus(); });
      syncUrl();
    },
  };
}
