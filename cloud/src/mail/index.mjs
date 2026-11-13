// Transactional mail: who sends (the environment), and notify(), the one call a route makes. Mail is off unless
// RESEND_API_KEY is set, and a message that cannot be sent never fails the request that asked for it: notify() logs
// and audits the failure and answers { sent: false }, it does not throw.
import { EMAIL } from "../email.mjs";
import { invitation } from "./templates.mjs";
import { noMail, resendTransport } from "./transport.mjs";

export { noMail, recordingMail, resendTransport } from "./transport.mjs";

const TEMPLATES = { invitation };

/** deps.mail from the environment: { transport, from, replyTo }. opts: { fetch } (tests). See cloud/README.md. */
export function mailFromEnv(env = process.env, { fetch } = {}) {
  if (!env.RESEND_API_KEY && !env.MAIL_FROM) return { transport: noMail(), from: null, replyTo: null };
  if (!env.RESEND_API_KEY || !env.MAIL_FROM) throw new Error("Email needs both RESEND_API_KEY and MAIL_FROM.");
  if (!env.PUBLIC_URL) throw new Error("Email needs PUBLIC_URL: the links in every message point at it.");
  return { transport: resendTransport({ apiKey: env.RESEND_API_KEY, fetch }), from: env.MAIL_FROM, replyTo: env.MAIL_REPLY_TO || null };
}

/**
 * Send the `kind` message (a template's name) to args.to, built from args (see templates.mjs), with args.key as its
 * idempotency key so a retried request does not send twice. Returns { sent: true, id } or { sent: false, reason:
 * "off" | "no-address" | "failed" }; never throws.
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
    if (!template) throw new Error(`there is no mail template "${kind}"`);
    // PR 2: the per-day send cap is checked here, before anything is sent.
    const res = await mail.transport.send({ from: mail.from, to, replyTo: mail.replyTo, idempotencyKey: args.key, ...template(args) });
    const who = { projectId: args.project?.id ?? null, userId: args.actor?.id ?? null };
    // A message that went out is reported as sent even when its audit row cannot be written.
    const audit = async (action, detail) => {
      try {
        await deps.db?.addAudit({ ...who, action, detail });
      } catch (error) {
        log(error);
      }
    };
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
