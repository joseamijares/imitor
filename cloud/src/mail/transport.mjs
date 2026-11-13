// Where mail goes: Resend's HTTP API on fetch alone (no SDK, so the functions' bundle stays node:*, pg and
// @vercel/blob), nothing at all when mail is off, or a list in memory for tests. send() never throws: a message that
// cannot be sent must not fail the request that triggered it, so every outcome comes back as { ok, ... }.
export const RESEND_URL = "https://api.resend.com/emails";

/**
 * Extra message headers ({ name: value }) as Resend's `headers` field takes them, or null for none. Only plain names
 * and one-line values: a CR or LF in either would let it write more headers than it names, so such a header is left
 * out rather than sent.
 */
export function messageHeaders(headers) {
  if (!headers || typeof headers !== "object") return null;
  const out = {};
  for (const [name, value] of Object.entries(headers)) {
    if (/^[A-Za-z0-9-]+$/.test(name) && value != null && !/[\u0000-\u001f\u007f]/.test(String(value))) out[name] = String(value);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * opts: { apiKey, fetch, timeoutMs }. send({ from, to, replyTo, subject, text, html, idempotencyKey, tags, headers }) ->
 * { ok: true, id } or { ok: false, status?, error }. tags: [{ name, value }] or { name: value }. headers: { name:
 * value }, extra headers of the message (List-Unsubscribe), not of the request.
 */
export function resendTransport({ apiKey, fetch = globalThis.fetch, timeoutMs = 5000 }) {
  if (!apiKey) throw new Error("Resend needs an API key");
  // An error message is logged and audited; whatever it says, the key is never part of it.
  const clean = (message) => String(message).split(apiKey).join("[key]");
  return {
    async send({ from, to, replyTo, subject, text, html, idempotencyKey, tags, headers: extra }) {
      try {
        const body = { from, to: [to], subject, text, html };
        if (replyTo) body.reply_to = replyTo;
        if (tags) body.tags = Array.isArray(tags) ? tags : Object.entries(tags).map(([name, value]) => ({ name, value: String(value) }));
        const added = messageHeaders(extra);
        if (added) body.headers = added;
        const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json", "user-agent": "imitor-cloud" };
        if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
        let res;
        try {
          res = await fetch(RESEND_URL, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
        } catch (error) {
          if (error?.name === "TimeoutError" || error?.name === "AbortError") return { ok: false, error: `Resend did not answer within ${timeoutMs} ms` };
          return { ok: false, error: clean(`could not reach Resend: ${error?.cause?.message || error?.message || error}`) };
        }
        const data = await res.json().catch(() => ({}));
        if (!res.ok) return { ok: false, status: res.status, error: clean(typeof data?.message === "string" && data.message ? data.message : `Resend answered ${res.status}`) };
        return { ok: true, id: typeof data?.id === "string" ? data.id : null };
      } catch (error) {
        return { ok: false, error: clean(`sending failed: ${error?.message || error}`) };
      }
    },
  };
}

/** Mail turned off (RESEND_API_KEY unset): nothing is sent, and callers can tell. */
export function noMail() {
  return { off: true, async send() { return { ok: false, skipped: true }; } };
}

/** For tests: every message lands in .sent; set .fail to an error message to make send answer a 500 instead. */
export function recordingMail() {
  const transport = {
    sent: [],
    fail: null,
    async send(message) {
      if (transport.fail) return { ok: false, status: 500, error: String(transport.fail) };
      transport.sent.push(message);
      return { ok: true, id: `msg_${transport.sent.length}` };
    },
  };
  return transport;
}
