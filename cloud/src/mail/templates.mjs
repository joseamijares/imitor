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
