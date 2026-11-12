// The pre-build gate: decide from a run's manifest whether a paid native build should go ahead,
// and say why in the forms a CI system reads (a text summary, a Markdown job summary, outputs, annotations).
import fs from "node:fs";

export const FAIL_ON = ["flows", "errors", "stand-ins"];

const describeStep = (config) => {
  if (!config) return "opening the start route";
  const [action] = Object.keys(config);
  const target = config[action];
  const what = typeof target === "string" ? `"${target}"` : JSON.stringify(target);
  return { tap: `tapping ${what}`, fill: `filling ${what}`, goto: `going to ${what}`, waitFor: `waiting for ${what}`, shot: `taking shot ${what}` }[action] || `${action} ${what}`;
};

/**
 * Judge a run. `failOn` is the strictest thing that blocks:
 *   flows      a flow could not be completed (the default)
 *   errors     also an uncaught page error
 *   stand-ins  also any shot that contains a stand-in
 */
export function evaluate(manifest, { failOn = "flows" } = {}) {
  if (!FAIL_ON.includes(failOn)) throw new Error(`--fail-on must be one of ${FAIL_ON.join(", ")}; got "${failOn}"`);
  const problems = manifest.problems || [];
  const shots = manifest.shots || [];
  const failedFlows = problems.filter((p) => p.kind === "flow-failed").map((p) => ({
    where: p.flow ? `${p.flow} on ${p.device}, ${p.scheme}` : p.where,
    step: p.step ?? null,
    doing: describeStep(p.stepConfig),
    message: p.message,
    shot: p.file || null,
  }));
  const pageErrors = problems.filter((p) => p.kind === "page-error").map((p) => ({ where: p.flow ? `${p.flow} on ${p.device}, ${p.scheme}` : p.where, message: p.message }));
  const seedProblems = problems.filter((p) => p.kind === "seed-failed").map((p) => ({ where: p.flow ? `${p.flow} on ${p.device}, ${p.scheme}` : p.where, message: p.message }));
  const standIns = [...new Set(shots.flatMap((s) => s.stubs || []))].sort();
  const shotsWithStandIns = shots.filter((s) => (s.stubs || []).length).length;
  const reasons = [];
  if (failedFlows.length) reasons.push(`${failedFlows.length} flow${failedFlows.length === 1 ? "" : "s"} failed`);
  // A flow whose seed failed did not run from the data it was configured with, so it counts like a failed flow.
  if (seedProblems.length) reasons.push(`${seedProblems.length} seed problem${seedProblems.length === 1 ? "" : "s"}`);
  if (failOn !== "flows" && pageErrors.length) reasons.push(`${pageErrors.length} page error${pageErrors.length === 1 ? "" : "s"}`);
  if (failOn === "stand-ins" && shotsWithStandIns) reasons.push(`${shotsWithStandIns} shot${shotsWithStandIns === 1 ? "" : "s"} with a stand-in`);
  if (!shots.length && !failedFlows.length) reasons.push("no shots were taken (no flows configured?)");
  return { passed: reasons.length === 0, reasons, failOn, commit: manifest.commit || null, shots: shots.length, failedFlows, seedProblems, pageErrors, standIns, shotsWithStandIns };
}

/** Plain text for the terminal and logs. */
export function formatText(v, report) {
  const lines = [`Imitor gate: ${v.passed ? "PASSED" : "BLOCKED"}${v.passed ? "" : ` (${v.reasons.join("; ")})`}`];
  lines.push(`  ${v.shots} shots, ${v.failedFlows.length} failed flows, ${v.pageErrors.length} page errors${v.standIns.length ? `, stand-ins seen: ${v.standIns.join(", ")}` : ""}`);
  for (const f of v.failedFlows) lines.push(`  x ${f.where}: stopped at step ${f.step ?? "?"} while ${f.doing}. ${f.message}${f.shot ? ` (see ${f.shot})` : ""}`);
  for (const e of v.seedProblems || []) lines.push(`  x ${e.where}: ${e.message}`);
  for (const e of v.pageErrors) lines.push(`  ! ${e.where}: ${e.message}`);
  if (report) lines.push(`  report: ${report}`);
  lines.push(v.passed ? "  This checks the web imitation only. It does not test the native build." : "  Fix these before spending a native build.");
  return lines.join("\n");
}

const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/\n/g, " ");

/** Markdown for a CI job summary or a pull-request comment. */
export function formatMarkdown(v, report) {
  const out = [`### Imitor gate: ${v.passed ? "passed" : "blocked"}`, ""];
  if (!v.passed) out.push(`**Blocked because:** ${v.reasons.join("; ")}.`, "");
  out.push("| Shots | Failed flows | Page errors | Stand-ins seen |", "| --- | --- | --- | --- |", `| ${v.shots} | ${v.failedFlows.length} | ${v.pageErrors.length} | ${v.standIns.length ? cell(v.standIns.join(", ")) : "none"} |`, "");
  if (v.failedFlows.length) {
    out.push("| Flow | Stopped at | While | Error |", "| --- | --- | --- | --- |");
    for (const f of v.failedFlows) out.push(`| ${cell(f.where)} | step ${f.step ?? "?"} | ${cell(f.doing)} | ${cell(f.message)} |`);
    out.push("");
  }
  if (v.pageErrors.length) {
    out.push("| Page error in | Message |", "| --- | --- |");
    for (const e of v.pageErrors) out.push(`| ${cell(e.where)} | ${cell(e.message)} |`);
    out.push("");
  }
  if (report) out.push(`Report: \`${report}\``, "");
  out.push(v.passed ? "This checks the web imitation only. It does not test the native build." : "Fix these before spending a native build.");
  return out.join("\n") + "\n";
}

/** Write the job summary, outputs and annotations GitHub Actions understands, when running there. Returns what it wrote. */
export function reportToGitHub(v, report, env = process.env, write = (s) => process.stdout.write(s)) {
  const wrote = [];
  if (env.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(env.GITHUB_STEP_SUMMARY, formatMarkdown(v, report));
    wrote.push("summary");
  }
  if (env.GITHUB_OUTPUT) {
    fs.appendFileSync(env.GITHUB_OUTPUT, [`passed=${v.passed}`, `shots=${v.shots}`, `failed-flows=${v.failedFlows.length}`, `page-errors=${v.pageErrors.length}`, `stand-ins=${v.standIns.join(",")}`, `report=${report || ""}`].join("\n") + "\n");
    wrote.push("outputs");
  }
  if (env.GITHUB_ACTIONS === "true") {
    const esc = (s) => String(s).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
    for (const e of v.seedProblems || []) write(`::error title=Imitor: seed problem::${esc(`${e.where}: ${e.message}`)}\n`);
    for (const f of v.failedFlows) write(`::error title=Imitor: flow failed::${esc(`${f.where} stopped at step ${f.step ?? "?"} while ${f.doing}. ${f.message}`)}\n`);
    if (v.failOn !== "flows") for (const e of v.pageErrors) write(`::error title=Imitor: page error::${esc(`${e.where}: ${e.message}`)}\n`);
    wrote.push("annotations");
  }
  return wrote;
}
