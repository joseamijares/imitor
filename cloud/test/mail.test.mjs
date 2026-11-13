// The mail module without the network: Resend's API through a recording fetch (what is sent, what comes back, what
// happens when it fails or hangs), the invitation template (escaping, a one-line subject, one link), and notify()
// (off, no address, sent and audited, failed and audited without throwing).
import assert from "node:assert/strict";
import test from "node:test";
import { memoryDb } from "../src/db/memory.mjs";
import { mailFromEnv, notify } from "../src/mail/index.mjs";
import { invitation } from "../src/mail/templates.mjs";
import { noMail, recordingMail, RESEND_URL, resendTransport } from "../src/mail/transport.mjs";
import { cloud, clock, PUBLIC_URL } from "./helpers.mjs";

const KEY = "re_TestKey_0123456789abcdef";
const FROM = "Imitor Cloud <hello@jamaklab.com>";

/** A fetch that records each call and answers with respond(call) (a Response, or a value to reject with). */
function fakeFetch(respond = () => Response.json({ id: "em_123" })) {
  const calls = [];
  const fetch = async (url, init) => {
    const call = { url, init, body: JSON.parse(init.body) };
    calls.push(call);
    const answer = await respond(call);
    if (answer instanceof Response) return answer;
    throw answer;
  };
  return { fetch, calls };
}

const message = { from: FROM, to: "grace@example.com", replyTo: "help@example.com", subject: "Hello", text: "Hi", html: "<p>Hi</p>", idempotencyKey: "invite/p1/u2", tags: [{ name: "kind", value: "invitation" }] };

test("resend: one POST with the key, JSON, the idempotency key and the message; the id comes back", async () => {
  const { fetch, calls } = fakeFetch();
  const res = await resendTransport({ apiKey: KEY, fetch }).send(message);
  assert.deepEqual(res, { ok: true, id: "em_123" });
  assert.equal(calls.length, 1);
  const [{ url, init, body }] = calls;
  assert.equal(url, RESEND_URL);
  assert.equal(url, "https://api.resend.com/emails");
  assert.equal(init.method, "POST");
  assert.equal(init.headers.authorization, `Bearer ${KEY}`);
  assert.equal(init.headers["content-type"], "application/json");
  assert.equal(init.headers["user-agent"], "imitor-cloud");
  assert.equal(init.headers["Idempotency-Key"], "invite/p1/u2");
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(body, { from: FROM, to: ["grace@example.com"], subject: "Hello", text: "Hi", html: "<p>Hi</p>", reply_to: "help@example.com", tags: [{ name: "kind", value: "invitation" }] });

  // Without the optional parts, neither the header nor the fields are sent; tags may also be given as an object.
  await resendTransport({ apiKey: KEY, fetch }).send({ ...message, replyTo: null, idempotencyKey: undefined, tags: { kind: "invitation" } });
  assert.ok(!("Idempotency-Key" in calls[1].init.headers));
  assert.ok(!("reply_to" in calls[1].body));
  assert.deepEqual(calls[1].body.tags, [{ name: "kind", value: "invitation" }]);
  await resendTransport({ apiKey: KEY, fetch }).send({ ...message, tags: undefined });
  assert.ok(!("tags" in calls[2].body));
  assert.throws(() => resendTransport({}), /needs an API key/);
});

test("resend: a refusal comes back as ok:false with its status and message, never thrown", async () => {
  const refused = resendTransport({ apiKey: KEY, fetch: fakeFetch(() => Response.json({ name: "validation_error", message: "The from address is not verified." }, { status: 422 })).fetch });
  assert.deepEqual(await refused.send(message), { ok: false, status: 422, error: "The from address is not verified." });
  const broken = resendTransport({ apiKey: KEY, fetch: fakeFetch(() => new Response("<html>oops</html>", { status: 500 })).fetch });
  assert.deepEqual(await broken.send(message), { ok: false, status: 500, error: "Resend answered 500" });
});

test("resend: a network error or a fetch that never answers is ok:false, within timeoutMs", async () => {
  const down = resendTransport({ apiKey: KEY, fetch: fakeFetch(() => new TypeError("fetch failed", { cause: new Error("getaddrinfo ENOTFOUND api.resend.com") })).fetch });
  const res = await down.send(message);
  assert.equal(res.ok, false);
  assert.match(res.error, /could not reach Resend: getaddrinfo ENOTFOUND/);

  // A fetch that only ends when its signal aborts, as the real one does.
  const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason)));
  const started = Date.now();
  // AbortSignal.timeout's timer does not keep the process alive on its own; this does, until the answer.
  const alive = setInterval(() => {}, 1000);
  const slow = await resendTransport({ apiKey: KEY, fetch: hang, timeoutMs: 30 }).send(message).finally(() => clearInterval(alive));
  assert.equal(slow.ok, false);
  assert.match(slow.error, /did not answer within 30 ms/);
  assert.ok(Date.now() - started < 2000);

  // Even a fetch that throws synchronously, or a message that cannot be serialized, does not throw out of send.
  const odd = await resendTransport({ apiKey: KEY, fetch: () => { throw new Error("boom"); } }).send(message);
  assert.equal(odd.ok, false);
  const big = await resendTransport({ apiKey: KEY, fetch: fakeFetch().fetch }).send({ ...message, text: 10n });
  assert.equal(big.ok, false);
});

test("resend: the API key never appears in an error", async () => {
  const echo = resendTransport({ apiKey: KEY, fetch: fakeFetch(() => Response.json({ message: `API key ${KEY} is invalid` }, { status: 401 })).fetch });
  const res = await echo.send(message);
  assert.equal(res.status, 401);
  assert.ok(!res.error.includes(KEY), res.error);
  const thrown = resendTransport({ apiKey: KEY, fetch: fakeFetch(() => new Error(`refused Bearer ${KEY}`)).fetch });
  const res2 = await thrown.send(message);
  assert.ok(!JSON.stringify(res2).includes(KEY), res2.error);
});

test("noMail sends nothing and says so; recordingMail keeps what it is given and can fail", async () => {
  const off = noMail();
  assert.equal(off.off, true);
  assert.deepEqual(await off.send(message), { ok: false, skipped: true });
  const rec = recordingMail();
  assert.deepEqual(await rec.send(message), { ok: true, id: "msg_1" });
  assert.deepEqual(rec.sent, [message]);
  rec.fail = "the provider is down";
  assert.deepEqual(await rec.send(message), { ok: false, status: 500, error: "the provider is down" });
  assert.equal(rec.sent.length, 1);
});

const URL_ = `${PUBLIC_URL}/login`;
const invite = (over = {}) => invitation({ project: { id: "prj1", name: "Fernwood" }, actor: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" }, role: "member", url: URL_, pending: false, ...over });

test("invitation: who, the project, the role, Google with this exact address, and one link", () => {
  const m = invite({ to: "grace@example.com" });
  assert.equal(m.subject, 'Ada Lovelace added you to "Fernwood" on Imitor Cloud');
  assert.match(m.text, /Ada Lovelace added you to the project "Fernwood" on Imitor Cloud, as a member/);
  assert.match(m.text, /sign in with Google using this exact address \(grace@example\.com\)/);
  assert.ok(m.text.includes(URL_));
  assert.deepEqual([...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]), [URL_]);
  assert.doesNotMatch(m.html, /<img|<script|src=|url\(/i, "no images or remote assets");
  assert.deepEqual(m.tags, [{ name: "kind", value: "invitation" }]);
  assert.match(invite({ role: "owner" }).text, /as an owner/);
  // No name: the address stands in for it.
  assert.match(invite({ actor: { id: "u1", name: null, email: "ada@example.com" } }).subject, /^ada@example\.com added you/);
});

test("invitation: names are escaped in the HTML, verbatim in the text, and kept to one line in the subject", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const m = invite({ project: { id: "prj1", name: evil }, actor: { id: "u1", name: `Mallory "the" <b>`, email: "m@example.com" } });
  assert.ok(!m.html.includes(evil));
  assert.ok(m.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(m.html.includes("Mallory &quot;the&quot; &lt;b&gt;"));
  assert.ok(m.text.includes(evil));
  assert.deepEqual([...m.html.matchAll(/href=/g)].length, 1);

  const header = invite({ project: { id: "prj1", name: "Fernwood\r\nBcc: x@evil.example" }, actor: { id: "u1", name: "Ada\nLovelace\u0007", email: "a@example.com" } });
  assert.doesNotMatch(header.subject, /[\r\n\u0000-\u001f]/);
  assert.equal(header.subject, 'Ada Lovelace added you to "Fernwood Bcc: x@evil.example" on Imitor Cloud');

  const long = invite({ project: { id: "prj1", name: "p".repeat(300) }, actor: { id: "u1", name: "a".repeat(300), email: "a@example.com" } });
  const [, who, name] = /^(a+…) added you to "(p+…)"/.exec(long.subject);
  assert.equal(who.length, 80);
  assert.equal(name.length, 80);
});

test("invitation: someone who has never signed in is told they can ignore it", () => {
  const known = invite({ pending: false });
  const pending = invite({ pending: true });
  assert.notEqual(known.text, pending.text);
  assert.notEqual(known.html, pending.html);
  assert.doesNotMatch(known.text, /ignore/);
  assert.match(pending.text, /If you were not expecting this, you can ignore this message\. Nothing happens unless you sign in\./);
  assert.match(pending.html, /Nothing happens unless you sign in/);
});

const args = (over = {}) => ({ to: "grace@example.com", key: "invite/prj1/u2", project: { id: "prj1", name: "Fernwood" }, actor: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" }, role: "member", url: URL_, pending: true, ...over });

test("notify: off without a transport or with noMail, no-address for anything but an address", async () => {
  const c = cloud();
  assert.deepEqual(await notify({ ...c.deps, mail: undefined }, "invitation", args()), { sent: false, reason: "off" });
  assert.deepEqual(await notify({ ...c.deps, mail: { transport: noMail(), from: null, replyTo: null } }, "invitation", args()), { sent: false, reason: "off" });
  for (const to of ["admin", "", null, undefined, "a@b", `${"x".repeat(250)}@example.com`]) {
    assert.deepEqual(await notify(c.deps, "invitation", args({ to })), { sent: false, reason: "no-address" }, String(to));
  }
  assert.equal(c.mail.transport.sent.length, 0);
  assert.deepEqual(await c.db.listAudit(), []);
});

test("notify: a sent message carries the idempotency key and is audited as mail.send", async () => {
  const c = cloud();
  c.mail.replyTo = "help@example.com";
  assert.deepEqual(await notify(c.deps, "invitation", args()), { sent: true, id: "msg_1" });
  const [m] = c.mail.transport.sent;
  assert.equal(m.to, "grace@example.com");
  assert.equal(m.from, c.mail.from);
  assert.equal(m.replyTo, "help@example.com");
  assert.equal(m.idempotencyKey, "invite/prj1/u2");
  assert.equal(m.subject, 'Ada Lovelace added you to "Fernwood" on Imitor Cloud');
  const audit = await c.db.listAudit();
  assert.equal(audit.length, 1);
  assert.deepEqual({ ...audit[0], id: undefined, at: undefined }, { id: undefined, at: undefined, projectId: "prj1", userId: "u1", keyId: null, action: "mail.send", detail: { kind: "invitation", to: "grace@example.com", id: "msg_1" } });
});

test("notify: a failure is audited as mail.fail and logged, and nothing throws", async () => {
  const c = cloud();
  c.mail.transport.fail = "the provider is down";
  assert.deepEqual(await notify(c.deps, "invitation", args()), { sent: false, reason: "failed" });
  const [entry] = await c.db.listAudit();
  assert.equal(entry.action, "mail.fail");
  assert.deepEqual(entry.detail, { kind: "invitation", to: "grace@example.com", status: 500 });
  assert.equal(c.logged.length, 1);
  assert.match(String(c.logged[0].message), /not sent: the provider is down/);

  // A transport, an audit or a logger that throws, or an unknown kind: still an answer, never an exception.
  const throwing = { ...c.deps, mail: { ...c.mail, transport: { async send() { throw new Error("bug"); } } } };
  assert.deepEqual(await notify(throwing, "invitation", args()), { sent: false, reason: "failed" });
  const noAudit = { ...c.deps, db: { addAudit: () => { throw new Error("db down"); } }, mail: { ...c.mail, transport: recordingMail() } };
  assert.deepEqual(await notify(noAudit, "invitation", args()), { sent: true, id: "msg_1" }, "a sent message stays sent");
  assert.deepEqual(await notify({ ...c.deps, log: () => { throw new Error("log down"); } }, "invitation", args()), { sent: false, reason: "failed" });
  assert.deepEqual(await notify(c.deps, "no-such-kind", args()), { sent: false, reason: "failed" });
});

test("mailFromEnv: off without RESEND_API_KEY; with it, the fetch given sends, end to end", async () => {
  assert.equal(mailFromEnv({}).transport.off, true);
  const on = mailFromEnv({ RESEND_API_KEY: KEY, MAIL_FROM: FROM, MAIL_REPLY_TO: "help@example.com", PUBLIC_URL });
  assert.equal(on.transport.off, undefined);
  assert.equal(on.from, FROM);
  assert.equal(on.replyTo, "help@example.com");
  assert.equal(mailFromEnv({ RESEND_API_KEY: KEY, MAIL_FROM: FROM, PUBLIC_URL }).replyTo, null);

  const { fetch, calls } = fakeFetch();
  const mail = mailFromEnv({ RESEND_API_KEY: KEY, MAIL_FROM: FROM, PUBLIC_URL }, { fetch });
  const db = memoryDb({ now: clock() });
  assert.deepEqual(await notify({ db, mail }, "invitation", args()), { sent: true, id: "em_123" });
  assert.equal(calls[0].body.from, FROM);
  assert.deepEqual(calls[0].body.to, ["grace@example.com"]);
  assert.equal(calls[0].init.headers["Idempotency-Key"], "invite/prj1/u2");
  assert.equal((await db.listAudit())[0].action, "mail.send");
});
