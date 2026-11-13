// Transactional mail: who sends (the environment), and notify(), the one call a route makes. Mail is off unless
// RESEND_API_KEY is set, and a message that cannot be sent never fails the request that asked for it: notify() logs
// and audits the failure and answers { sent: false }, it does not throw.
import { EMAIL } from "../email.mjs";
import { accessKey, invitation, runProblems } from "./templates.mjs";
import { noMail, resendTransport } from "./transport.mjs";

export { noMail, recordingMail, resendTransport } from "./transport.mjs";

const TEMPLATES = { invitation, accessKey, runProblems };

// Mail is sent on people's behalf, so it is capped in rolling 24 hours, for each kind of message on its own (so a day
// of invitations cannot hold back a security notice, nor notices the invitations): `perSender` messages by one sender,
// and `perAddress` to one address from everyone together (so many projects cannot flood one inbox); `perProjectAddress`,
// where given, to one address about one project (so one project cannot use up an address's day). Counted from the
// mail.send rows of audit_log, not in memory: on Vercel every instance has its own.
// - invitation: to addresses owners type, which may be anyone's, so the tightest.
// - accessKey: only to a project's other owners, who chose to share it. Ordinary rotation is a make and a revoke, two
//   messages to each co-owner, so 10 to one address is five rotations a day across all their projects, and 30 by one
//   sender covers that for three co-owners. Past it, one busy owner (or a stolen session) cannot bury a co-owner in
//   mail; and the notices that did go out already told them something is happening.
// - runProblems: sent when a key completes a run with problems, so no person sends it and there is no sender to count;
//   a CI that pushes failing runs all day is bounded by the address alone: 5 a day about one project, 10 from all
//   projects together. Past that the runs are still there; the messages that went out already said where to look.
export const CAPS = {
  invitation: { perSender: 20, perAddress: 3 },
  accessKey: { perSender: 30, perAddress: 10 },
  runProblems: { perAddress: 10, perProjectAddress: 5 },
};
const DAY_MS = 24 * 60 * 60 * 1000;

/** deps.mail from the environment: { transport, from, replyTo }. opts: { fetch } (tests). See cloud/README.md. */
export function mailFromEnv(env = process.env, { fetch } = {}) {
  if (!env.RESEND_API_KEY && !env.MAIL_FROM) return { transport: noMail(), from: null, replyTo: null };
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error("Email needs both RESEND_API_KEY and MAIL_FROM.");
  if (!env.PUBLIC_URL) throw new Error("Email needs PUBLIC_URL: the links in every message point at it.");
  return { transport: resendTransport({ apiKey: env.RESEND_API_KEY, fetch }), from: env.MAIL_FROM, replyTo: env.MAIL_REPLY_TO || null };
}

/**
 * Send the `kind` message (a template's name) to args.to, built from args (see templates.mjs), with args.key as its
 * idempotency key so a retried request does not send twice. args.actor is who sends it (their id counts toward their
 * cap for this kind; without one, only the address's caps apply; see CAPS); args.project.id is the project it is about
 * (counted by perProjectAddress). Returns { sent: true, id } or
 * { sent: false, reason: "off" | "no-address" | "limit" | "failed" }; never throws.
 */
export async function notify(deps, kind, args = {}) {
  const { to } = args;
  const log = (error) => {
    try {
      deps.log?.(error);
    } catch {} // a broken logger does not make mail throw either
  };
  try {
    const mail = deps.mail;
    if (!mail?.transport || mail.transport.off) return { sent: false, reason: "off" };
    // The admin token's user is "admin" by default: not an address, so there is no one to write to.
    if (typeof to !== "string" || to.length > 254 || !EMAIL.test(to)) return { sent: false, reason: "no-address" };
    const template = TEMPLATES[kind];
    const cap = CAPS[kind];
    if (!template || !cap) throw new Error(`there is no mail template "${kind}"`);
    const who = { projectId: args.project?.id ?? null, userId: args.actor?.id ?? null };
    // A message that went out is reported as sent even when its audit row cannot be written.
    const audit = async (action, detail) => {
      try {
        await deps.db?.addAudit({ ...who, action, detail });
      } catch (error) {
        log(error);
      }
    };
    // The caps, before anything is sent, counting this kind only. A count that fails throws to the catch below: nothing
    // is sent unchecked. Two sends at the same moment can both pass; the caps bound a flood, not a single message.
    const since = new Date((deps.now?.() || new Date()).getTime() - DAY_MS).toISOString();
    const count = ({ userId = null, projectId = null, to = null }) => deps.db.countAudit({ action: "mail.send", since, userId, projectId, detail: to ? { to, kind } : { kind } });
    const over =
      (cap.perSender != null && who.userId != null && (await count({ userId: who.userId })) >= cap.perSender) ||
      (await count({ to })) >= cap.perAddress ||
      (cap.perProjectAddress != null && who.projectId != null && (await count({ to, projectId: who.projectId })) >= cap.perProjectAddress);
    if (over) {
      await audit("mail.limit", { kind, to });
      return { sent: false, reason: "limit" };
    }
    const res = await mail.transport.send({ from: mail.from, to, replyTo: mail.replyTo, idempotencyKey: args.key, ...template(args) });
    if (res.ok) {
      await audit("mail.send", { kind, to, id: res.id ?? null });
      return { sent: true, id: res.id ?? null };
    }
    await audit("mail.fail", { kind, to, status: res.status ?? null });
    log(new Error(`the ${kind} message to ${to} was not sent: ${res.error || "no reason given"}`));
    return { sent: false, reason: "failed" };
  } catch (error) {
    log(error);
    return { sent: false, reason: "failed" };
  }
}
