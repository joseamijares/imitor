// The messages the cloud sends, as pure functions of what they say: { subject, text, html, tags }. Names come from
// people (project names, Google profile names), so the subject is kept to one line (a CR or LF there would let a name
// add headers) and every value in the HTML goes through esc(). The HTML is small, inline-styled, with no images or
// remote assets and exactly one link; the text part says the same and is always sent.
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

/**
 * Someone joined the waitlist on the site's pricing page; the recipient is the operator (WAITLIST_NOTIFY_TO). The
 * address that joined is deliberately not an argument: the pricing page says it is kept for the waitlist and not
 * shared, so it stays in the database and never passes through the mail provider. The message says only that the list
 * grew, and how to read it. No link: there is no page that shows the list.
 */
export function waitlist() {
  const subject = "Someone joined the Imitor Cloud waitlist";
  const what = "A new address joined the Imitor Cloud waitlist from the pricing page.";
  const where = "The address is not in this message: it is kept only in the database. To read the list:";
  const query = "select email, created_at from waitlist order by created_at";
  const why = "You are told because this address is the instance's WAITLIST_NOTIFY_TO.";
  const text = `${[what, where, query].join("\n\n")}\n\n${why}\n`;
  const html = `<!doctype html>
<html><body style="${STYLE.body}">
<p style="${STYLE.p}">${esc(what)}</p>
<p style="${STYLE.p}">${esc(where)}</p>
<p style="${STYLE.p}"><code>${esc(query)}</code></p>
<p style="${STYLE.small}">${esc(why)}</p>
</body></html>
`;
  return { subject, text, html, tags: [{ name: "kind", value: "waitlist" }] };
}
