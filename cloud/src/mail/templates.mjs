// The messages the cloud sends, as pure functions of what they say: { subject, text, html, tags, headers? }. Names come
// from people (project names, Google profile names, run titles, flow names), so the subject is kept to one line (a CR
// or LF there would let a name add headers) and every value in the HTML goes through esc(). The HTML is small,
// inline-styled, with no images or remote assets and exactly one link (run emails: the run, and the unsubscribe link);
// the text part says the same and is always sent.
import { esc } from "../http.mjs";

const NAME_MAX = 80;

/** One line: control characters (CR, LF, tabs, C1, the Unicode line and paragraph separators) become spaces. */
const oneLine = (value) => String(value ?? "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/ {2,}/g, " ").trim();
/** A name for the subject: one line, at most NAME_MAX characters. */
const short = (value) => {
  const s = oneLine(value);
  return s.length > NAME_MAX ? `${s.slice(0, NAME_MAX - 1).trimEnd()}…` : s;
};

const ROLES = {
  owner: "an owner, so you can also manage its upload keys and its members",
  member: "a member, so you can see its runs and review them",
};

const STYLE = {
  body: "margin:0;padding:24px;background:#ffffff;color:#1a1a1a;font:15px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif",
  p: "margin:0 0 16px",
  link: "color:#1a1a1a;font-weight:600",
  small: "margin:24px 0 0;color:#666666;font-size:13px",
};

/**
 * Someone added the recipient to a project. args: { project: { name }, actor: { name, email }, role: "member" |
 * "owner", url (where to sign in), pending (they have never signed in, so they may not expect this), to (their
 * address, named in the message when given) }.
 */
export function invitation({ project, actor, role, url, pending = false, to = null }) {
  const who = oneLine(actor?.name) || oneLine(actor?.email) || "Someone";
  const name = oneLine(project?.name) || "a project";
  const as = ROLES[role] || ROLES.member;
  const address = to ? `this exact address (${oneLine(to)})` : "this exact address";
  const subject = `${short(who)} added you to "${short(name)}" on Imitor Cloud`;
  const lines = [
    `${who} added you to the project "${name}" on Imitor Cloud, as ${as}.`,
    `To open it, sign in with Google using ${address}:`,
    url,
  ];
  const ignore = "If you were not expecting this, you can ignore this message. Nothing happens unless you sign in.";
  const text = `${lines.join("\n\n")}\n${pending ? `\n${ignore}\n` : ""}`;
  const html = `<!doctype html>
<html><body style="${STYLE.body}">
<p style="${STYLE.p}">${esc(who)} added you to the project “${esc(name)}” on Imitor Cloud, as ${esc(as)}.</p>
<p style="${STYLE.p}">To open it, sign in with Google using ${esc(address)}:</p>
<p style="${STYLE.p}"><a href="${esc(url)}" style="${STYLE.link}">${esc(url)}</a></p>
${pending ? `<p style="${STYLE.small}">${esc(ignore)}</p>\n` : ""}</body></html>
`;
  return { subject, text, html, tags: [{ name: "kind", value: "invitation" }] };
}

/**
 * An owner made or revoked one of the project's access keys; the recipient is another owner, who may not know. args:
 * { project: { name }, actor: { name, email }, keyName, revoked, url (Settings, at its access keys) }. Only the key's
 * name is ever given here: never its secret, its hash or its prefix, so a message read by the wrong person (or kept by
 * the provider) cannot help anyone upload.
 */
export function accessKey({ project, actor, keyName, revoked = false, url }) {
  const who = oneLine(actor?.name) || oneLine(actor?.email) || "Someone";
  const name = oneLine(project?.name) || "a project";
  const key = oneLine(keyName) || "unnamed";
  const subject = revoked
    ? `Access key "${short(key)}" of "${short(name)}" revoked on Imitor Cloud`
    : `New access key "${short(key)}" for "${short(name)}" on Imitor Cloud`;
  const what = revoked
    ? `${who} revoked the access key "${key}" of the project "${name}" on Imitor Cloud. It can no longer upload runs to the project.`
    : `${who} made the access key "${key}" for the project "${name}" on Imitor Cloud. Agents and CI can upload runs to the project with it.`;
  const next = revoked ? "To see the project's keys, open Settings:" : "If you did not expect this, revoke the key in Settings:";
  const why = "You are told because you are an owner of this project.";
  const text = `${[what, next, url].join("\n\n")}\n\n${why}\n`;
  const html = `<!doctype html>
<html><body style="${STYLE.body}">
<p style="${STYLE.p}">${esc(what)}</p>
<p style="${STYLE.p}">${esc(next)}</p>
<p style="${STYLE.p}"><a href="${esc(url)}" style="${STYLE.link}">${esc(url)}</a></p>
<p style="${STYLE.small}">${esc(why)}</p>
</body></html>
`;
  return { subject, text, html, tags: [{ name: "kind", value: "accessKey" }] };
}

/** At most this many problem titles are named in a run email; the rest are counted. */
export const RUN_TITLES = 3;
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * A run uploaded to the project has problems; the recipient is a member who has not turned these emails off. args:
 * { project: { name }, run: { title, branch, commit } (run.json's), count (its problems, as the run's Problems tab
 * counts them), titles (their titles, as the interface shows them; at most RUN_TITLES are named), url (the run),
 * unsubscribeUrl (turns these emails off for this membership, with no sign-in) }. Only what a member sees in the
 * interface is named: never a problem's message, which is the page's own text.
 */
export function runProblems({ project, run = {}, count, titles = [], url, unsubscribeUrl }) {
  const name = oneLine(project?.name) || "a project";
  const title = oneLine(run?.title);
  const branch = oneLine(run?.branch);
  const commit = oneLine(run?.commit).slice(0, 12);
  const which = title || branch;
  const n = Math.max(1, Number(count) || 0);
  const subject = `${plural(n, "problem")} in ${which ? `"${short(which)}"` : "a run"} of "${short(name)}" on Imitor Cloud`;
  const what = `A run of the project "${name}" on Imitor Cloud has ${plural(n, "problem")}.`;
  const about = [title && `Run: ${title}`, branch && `Branch: ${branch}`, commit && `Commit: ${commit}`].filter(Boolean);
  const named = [...new Set(titles.map(short).filter(Boolean))].slice(0, RUN_TITLES);
  const list = named.length ? [...named, ...(n > named.length ? [`and ${n - named.length} more`] : [])] : [];
  const next = "See the run:";
  const why = "You get this because you are a member of this project. Stop these emails:";
  const text = `${[what, about.join("\n"), list.map((t) => `- ${t}`).join("\n"), next].filter(Boolean).join("\n\n")}\n${url}\n\n${why} ${unsubscribeUrl}\n`;
  const html = `<!doctype html>
<html><body style="${STYLE.body}">
<p style="${STYLE.p}">${esc(what)}</p>
${about.length ? `<p style="${STYLE.p}">${about.map(esc).join("<br>")}</p>\n` : ""}${list.length ? `<p style="${STYLE.p}">${list.map((t) => `• ${esc(t)}`).join("<br>")}</p>\n` : ""}<p style="${STYLE.p}">${esc(next)}<br><a href="${esc(url)}" style="${STYLE.link}">${esc(url)}</a></p>
<p style="${STYLE.small}">${esc(why)} <a href="${esc(unsubscribeUrl)}" style="color:#666666">${esc(unsubscribeUrl)}</a></p>
</body></html>
`;
  // RFC 8058 one-click: a mail client offers "Unsubscribe" and POSTs List-Unsubscribe=One-Click to the URL itself.
  const headers = { "List-Unsubscribe": `<${unsubscribeUrl}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
  return { subject, text, html, tags: [{ name: "kind", value: "runProblems" }], headers };
}
