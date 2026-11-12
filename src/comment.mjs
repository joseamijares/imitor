// The pull-request comment: the gate's verdict and the run's shots as small images, in Markdown GitHub renders.
// `imitor comment` prints it; the GitHub Action posts it (and updates it in place, found by MARKER).
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { evaluate } from "./gate.mjs";

export const MARKER = "<!-- imitor-comment -->";
export const BODY_LIMIT = 65536; // GitHub rejects comment bodies longer than this
const BUDGET = BODY_LIMIT - 1536; // room for anything a workflow appends
const THUMB = 160; // px: four to a row on desktop, still readable on a phone
const PER_ROW = 4;
const MAX_FAILURES = 10;

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const clip = (s, n = 120) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
/** Text placed in HTML (element content or a quoted attribute). "@" gets a word joiner so names never mention anyone. */
const escAttr = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
export const escHtml = (s) => escAttr(s).replace(/@/g, "@\u2060");
const escText = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]).replace(/@/g, "@\u2060");
/** Text placed in Markdown prose: neutralise emphasis, links, code, headings, tables and raw HTML, on one line. */
export const escMd = (s) => escText(String(s).replace(/\r?\n/g, " ").replace(/[\\`*_[\]#|~]/g, "\\$&").replace(/^([-+>]|\d+[.)])/, "\\$1"));
/** A file path as code inside a Markdown table cell. */
const codeCell = (s) => `\`${String(s).replace(/`/g, "'").replace(/\|/g, "\\|").replace(/\r?\n/g, " ")}\``;
/** Text inside a Markdown table cell. */
const cell = (s) => escMd(s);

/**
 * Where an image lives. `base` is prepended to the shot's path; a base with a query string
 * (".../blob/branch/dir/?raw=true") gets the path before the query; a base with "{path}" gets it substituted.
 */
export function imageUrl(base, file) {
  const encoded = String(file).split("/").map(encodeURIComponent).join("/");
  if (base.includes("{path}")) return base.replace("{path}", encoded);
  const q = base.indexOf("?");
  const [head, query] = q === -1 ? [base, ""] : [base.slice(0, q), base.slice(q)];
  return `${head}${head.endsWith("/") || !head ? "" : "/"}${encoded}${query}`;
}

/** The last run's manifest from the app's output folder. */
export function readManifest(root) {
  const file = path.join(path.resolve(root, loadConfig(root).out), "manifest.json");
  if (!fs.existsSync(file)) throw new Error(`no run found at ${file}. Run: imitor gate (or imitor)`);
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

/**
 * Everything the comment shows, as data (`imitor comment --json`).
 * opts: failOn, device, scheme (default: the first configured that has shots), maxShots (per flow, default 12),
 *       imageBase (null: list file paths instead of images), reportUrl, configured ({ devices, schemes } names).
 */
export function buildComment(manifest, opts = {}) {
  const maxShots = opts.maxShots === undefined ? 12 : Number(opts.maxShots);
  if (!Number.isInteger(maxShots) || maxShots < 1) throw new Error(`--max-shots needs a whole number of 1 or more, got "${opts.maxShots}"`);
  const verdict = evaluate(manifest, { failOn: opts.failOn || "flows" });
  const shots = manifest.shots || [];
  const present = (key) => [...new Set(shots.map((s) => s[key]))];
  const pick = (key, wanted, configured = []) => {
    if (wanted) return wanted;
    return configured.find((c) => present(key).includes(c)) ?? present(key)[0] ?? null;
  };
  const device = pick("device", opts.device, opts.configured?.devices);
  const scheme = pick("scheme", opts.scheme, opts.configured?.schemes);

  const flows = [];
  const byFlow = new Map();
  for (const [i, s] of shots.entries()) {
    if (!byFlow.has(s.flow)) {
      byFlow.set(s.flow, { name: s.flow, shots: [], total: 0, elsewhere: 0, more: 0 });
      flows.push(byFlow.get(s.flow));
    }
    const flow = byFlow.get(s.flow);
    if (s.device === device && s.scheme === scheme) flow.shots.push({ ...s, order: s.step ?? i, at: i });
    else flow.elsewhere++;
    flow.total++;
  }
  for (const flow of flows) {
    flow.shots.sort((a, b) => a.order - b.order || a.at - b.at);
    flow.more = Math.max(0, flow.shots.length - maxShots);
    flow.shots = flow.shots.slice(0, maxShots).map(({ order, at, ...s }) => ({
      file: s.file, step: s.shot, stepIndex: s.step ?? null, standIns: s.stubs || [], url: opts.imageBase ? imageUrl(opts.imageBase, s.file) : null,
    }));
  }
  const failures = verdict.failedFlows.map((f) => ({ ...f, url: f.shot && opts.imageBase ? imageUrl(opts.imageBase, f.shot) : null }));
  return {
    marker: MARKER,
    app: manifest.app || null,
    commit: manifest.commit || null,
    verdict: { passed: verdict.passed, reasons: verdict.reasons, failOn: verdict.failOn },
    counts: { shots: verdict.shots, flows: flows.length, failedFlows: verdict.failedFlows.length, pageErrors: verdict.pageErrors.length, shotsWithStandIns: verdict.shotsWithStandIns, standIns: verdict.standIns },
    showing: { device, scheme, maxShots, devices: present("device"), schemes: present("scheme") },
    failures,
    flows,
    imageBase: opts.imageBase || null,
    reportUrl: opts.reportUrl || null,
  };
}

function thumb(url, alt, width = THUMB) {
  const u = escAttr(url);
  return `<a href="${u}"><img src="${u}" width="${width}" alt="${escHtml(alt)}"></a>`;
}

function flowSection(flow, data, cap) {
  const shown = flow.shots.slice(0, cap);
  const hidden = flow.shots.length - shown.length + flow.more;
  const out = [`#### ${escMd(clip(flow.name))}`, ""];
  if (!shown.length && !flow.total) return out;
  if (!shown.length) out.push(`No shots on ${escMd(data.showing.device)}, ${escMd(data.showing.scheme)}.`, "");
  else if (data.imageBase) {
    const rows = ["<table>"];
    for (let i = 0; i < shown.length; i += PER_ROW) {
      rows.push("<tr>");
      for (const s of shown.slice(i, i + PER_ROW)) {
        const note = s.standIns.length ? `<br><sub>⚠︎ stand-in: ${escHtml(s.standIns.join(", "))}</sub>` : "";
        rows.push(`<td valign="top">${thumb(s.url, `${clip(flow.name, 60)}: ${clip(s.step, 60)}`)}<br><sub>${escHtml(clip(s.step, 60))}</sub>${note}</td>`);
      }
      rows.push("</tr>");
    }
    rows.push("</table>");
    out.push(rows.join(""), "");
  } else {
    out.push("| Step | Shot | Stand-in |", "| --- | --- | --- |");
    for (const s of shown) out.push(`| ${cell(clip(s.step, 60))} | ${codeCell(s.file)} | ${s.standIns.length ? cell(s.standIns.join(", ")) : ""} |`);
    out.push("");
  }
  const notes = [];
  if (hidden) notes.push(`${plural(hidden, "more shot")} on ${data.showing.device}, ${data.showing.scheme}`);
  if (flow.elsewhere) notes.push(`${plural(flow.elsewhere, "shot")} on other devices or schemes`);
  if (notes.length) out.push(`<sub>Not shown: ${escHtml(notes.join("; "))}. They are in the full report.</sub>`, "");
  return out;
}

function render(data, cap, flowLimit, failureLimit) {
  const v = data.verdict;
  const c = data.counts;
  const out = [data.marker];
  out.push(v.passed ? "### ✅ Imitor gate: passed" : `### ❌ Imitor gate: blocked: ${escMd(v.reasons.join("; "))}`);
  const counts = [
    plural(c.shots, "shot"),
    plural(c.flows, "flow"),
    plural(c.failedFlows, "failed flow"),
    plural(c.pageErrors, "page error"),
    c.standIns.length ? `stand-ins in ${plural(c.shotsWithStandIns, "shot")} (${escMd(c.standIns.join(", "))})` : "no stand-ins",
  ];
  if (data.commit) counts.push(`commit \`${String(data.commit).replace(/`/g, "")}\``);
  out.push(counts.join(" · "), "");

  if (data.failures.length) {
    out.push("**Failed flows**", "");
    for (const f of data.failures.slice(0, failureLimit)) {
      out.push(`- **${escMd(clip(f.where))}**: stopped at step ${f.step ?? "?"} while ${escMd(clip(f.doing))}. ${escMd(clip(f.message, 300))}`);
      if (f.shot) out.push(f.url ? `  <br>${thumb(f.url, `Where ${clip(f.where, 60)} stopped`)}` : `  Screenshot: \`${String(f.shot).replace(/`/g, "'")}\``);
    }
    if (data.failures.length > failureLimit) out.push(`- …and ${plural(data.failures.length - failureLimit, "more failed flow")} in the full report.`);
    out.push("");
  }

  if (data.flows.length) {
    out.push(`**Shots** on ${escMd(data.showing.device)}, ${escMd(data.showing.scheme)}${data.imageBase ? " (tap one for full size)" : ""}`, "");
    for (const flow of data.flows.slice(0, flowLimit)) out.push(...flowSection(flow, data, cap));
    if (data.flows.length > flowLimit) out.push(`…and ${plural(data.flows.length - flowLimit, "more flow")} in the full report.`, "");
  }
  if (data.reportUrl) out.push(`Full report: [the workflow run](${data.reportUrl.replace(/[()\s]/g, encodeURIComponent)}) (artifact).`, "");
  out.push("<sub>Imitor renders a web imitation of the app (react-native-web in headless Chromium), not the native build. Check on a real phone before release.</sub>");
  return out.join("\n") + "\n";
}

/** Markdown for the comment, kept under GitHub's size limit by showing fewer shots, then fewer flows. */
export function formatComment(data) {
  const cap = Math.max(1, ...data.flows.map((f) => f.shots.length));
  let body = render(data, cap, data.flows.length, MAX_FAILURES);
  for (let c = cap - 1; body.length > BUDGET && c >= 1; c--) body = render(data, c, data.flows.length, MAX_FAILURES);
  for (let n = data.flows.length - 1; body.length > BUDGET && n >= 0; n--) body = render(data, 1, n, MAX_FAILURES);
  if (body.length > BUDGET) body = render(data, 1, 0, 1);
  return body;
}

/** `imitor comment`: the comment for the last run in `root`. */
export function commentFor(root, opts = {}) {
  const config = loadConfig(root);
  return buildComment(readManifest(root), { ...opts, configured: { devices: config.devices.map((d) => d.name), schemes: config.schemes } });
}
