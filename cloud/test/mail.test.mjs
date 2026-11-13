// The mail module without the network: Resend's API through a recording fetch (what is sent, what comes back, what
// happens when it fails or hangs, a message's own headers), the templates (escaping, a one-line subject, one link, or
// for run emails the run and the unsubscribe link, no key secrets), and notify() (off, no address, sent and audited,
// failed and audited without throwing, the daily caps per sender, per address and per project and address, each kind
// on its own).
import assert from "node:assert/strict";
import test from "node:test";
import { memoryDb } from "../src/db/memory.mjs";
import { CAPS, mailFromEnv, notify } from "../src/mail/index.mjs";
import { accessKey, invitation, RUN_TITLES, runProblems } from "../src/mail/templates.mjs";
import { messageHeaders, noMail, recordingMail, RESEND_URL, resendTransport } from "../src/mail/transport.mjs";
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

const SETTINGS_URL = `${PUBLIC_URL}/login?next=%2Fp%2Ffernwood%2Fsettings%23access-keys`;
const keyNotice = (over = {}) => accessKey({ project: { id: "prj1", name: "Fernwood" }, actor: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" }, keyName: "ci", revoked: false, url: SETTINGS_URL, ...over });

test("accessKey: who, which key, which project, what it means, and one link to Settings", () => {
  const made = keyNotice();
  assert.equal(made.subject, 'New access key "ci" for "Fernwood" on Imitor Cloud');
  assert.match(made.text, /^Ada Lovelace made the access key "ci" for the project "Fernwood" on Imitor Cloud\. Agents and CI can upload runs to the project with it\./);
  assert.match(made.text, /If you did not expect this, revoke the key in Settings:/);
  assert.match(made.text, /You are told because you are an owner of this project\./);
  assert.ok(made.text.includes(SETTINGS_URL));
  assert.deepEqual([...made.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]), [SETTINGS_URL]);
  assert.doesNotMatch(made.html, /<img|<script|src=|url\(/i, "no images or remote assets");
  assert.deepEqual(made.tags, [{ name: "kind", value: "accessKey" }]);

  const gone = keyNotice({ revoked: true });
  assert.equal(gone.subject, 'Access key "ci" of "Fernwood" revoked on Imitor Cloud');
  assert.match(gone.text, /^Ada Lovelace revoked the access key "ci" of the project "Fernwood" on Imitor Cloud\. It can no longer upload runs to the project\./);
  assert.doesNotMatch(gone.text, /did not expect|can upload/);
  assert.match(gone.html, /can no longer upload runs/);
  assert.deepEqual([...gone.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]), [SETTINGS_URL]);
  // No name: the address stands in for it.
  assert.match(keyNotice({ actor: { id: "u1", name: null, email: "ada@example.com" } }).text, /^ada@example\.com made the access key/);
});

test("accessKey: names are escaped in the HTML and kept to one short line in the subject; nothing but the name of the key", () => {
  const evil = "<img src=x onerror=alert(1)>";
  const m = keyNotice({ project: { id: "prj1", name: evil }, keyName: `ci "<b>"`, actor: { id: "u1", name: "Mallory <i>", email: "m@example.com" } });
  assert.ok(!m.html.includes(evil) && !m.html.includes("<b>") && !m.html.includes("<i>"));
  assert.ok(m.html.includes("&lt;img src=x onerror=alert(1)&gt;"));
  assert.ok(m.html.includes("ci &quot;&lt;b&gt;&quot;"));
  assert.ok(m.text.includes(evil));
  assert.equal([...m.html.matchAll(/href=/g)].length, 1);

  for (const revoked of [false, true]) {
    const header = keyNotice({ revoked, project: { id: "prj1", name: "Fernwood\r\nBcc: x@evil.example" }, keyName: "ci\u2028Cc: y@evil.example", actor: { id: "u1", name: "Ada\nLovelace", email: "a@example.com" } });
    assert.doesNotMatch(header.subject, /[\r\n\u0000-\u001f\u2028\u2029]/);
    assert.match(header.subject, /"ci Cc: y@evil\.example" (for|of) "Fernwood Bcc: x@evil\.example"/);
    const long = keyNotice({ revoked, project: { id: "prj1", name: "p".repeat(300) }, keyName: "k".repeat(300) });
    const [, key, name] = /"(k+…)" (?:for|of) "(p+…)"/.exec(long.subject);
    assert.equal(key.length, 80);
    assert.equal(name.length, 80);
  }

  // Given a whole key (as a careless caller might), only its name could get in: the template takes keyName alone.
  const secret = "imk_" + "S".repeat(43);
  const careless = keyNotice({ key: { name: "ci", secret, prefix: secret.slice(0, 12), hash: "h".repeat(64) }, secret });
  for (const part of [careless.subject, careless.text, careless.html]) assert.ok(!part.includes("imk_") && !part.includes("h".repeat(64)), part);
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
  const noAudit = { ...c.deps, db: { countAudit: async () => 0, addAudit: () => { throw new Error("db down"); } }, mail: { ...c.mail, transport: recordingMail() } };
  assert.deepEqual(await notify(noAudit, "invitation", args()), { sent: true, id: "msg_1" }, "a sent message stays sent");
  assert.deepEqual(await notify({ ...c.deps, log: () => { throw new Error("log down"); } }, "invitation", args()), { sent: false, reason: "failed" });
  assert.deepEqual(await notify(c.deps, "no-such-kind", args()), { sent: false, reason: "failed" });
});

const MAX_SENDS_PER_DAY = CAPS.invitation.perSender;
const MAX_PER_ADDRESS_PER_DAY = CAPS.invitation.perAddress;

test("notify: at most perSender invitations per sender in a rolling day; over it nothing is sent and mail.limit is audited", async () => {
  const c = cloud();
  assert.equal(MAX_SENDS_PER_DAY, 20);
  for (let i = 0; i < MAX_SENDS_PER_DAY; i++) {
    assert.equal((await notify(c.deps, "invitation", args({ to: `p${i}@example.com`, key: `k${i}` }))).sent, true, `message ${i + 1}`);
    c.now.advance(60 * 1000);
  }
  assert.deepEqual(await notify(c.deps, "invitation", args({ to: "late@example.com" })), { sent: false, reason: "limit" });
  assert.equal(c.mail.transport.sent.length, MAX_SENDS_PER_DAY);
  const limit = (await c.db.listAudit()).filter((a) => a.action === "mail.limit");
  assert.deepEqual(limit.map((a) => [a.userId, a.projectId, a.detail]), [["u1", "prj1", { kind: "invitation", to: "late@example.com" }]]);
  // Another sender is not held back by Ada's count.
  assert.equal((await notify(c.deps, "invitation", args({ to: "late@example.com", actor: { id: "u9", name: "Bob" } }))).sent, true);
  // A day after her first message (10:00), that one no longer counts; the refusal never counted.
  c.now.set("2026-11-13T10:00:30.000Z");
  assert.equal((await notify(c.deps, "invitation", args({ to: "next@example.com" }))).sent, true);
  assert.deepEqual(await notify(c.deps, "invitation", args({ to: "next2@example.com" })), { sent: false, reason: "limit" }, "only one slot opened");
});

test("notify: at most perAddress invitations to one address from everyone, and without a sender only that cap applies", async () => {
  const c = cloud();
  assert.equal(MAX_PER_ADDRESS_PER_DAY, 3);
  for (const id of ["u1", "u2", "u3"]) assert.equal((await notify(c.deps, "invitation", args({ actor: { id, name: id } }))).sent, true);
  assert.deepEqual(await notify(c.deps, "invitation", args({ actor: { id: "u4", name: "u4" } })), { sent: false, reason: "limit" });
  assert.deepEqual(await notify(c.deps, "invitation", args({ actor: null })), { sent: false, reason: "limit" });
  assert.equal((await notify(c.deps, "invitation", args({ to: "other@example.com", actor: null }))).sent, true, "another address is fine");
  assert.equal(c.mail.transport.sent.length, 4);
  assert.deepEqual((await c.db.listAudit()).filter((a) => a.action === "mail.limit").map((a) => [a.userId, a.detail.to]), [["u4", "grace@example.com"], [null, "grace@example.com"]]);
  c.now.advance(24 * 60 * 60 * 1000 + 1); // they were all sent at one instant; exactly a day later they still count
  assert.equal((await notify(c.deps, "invitation", args({ actor: { id: "u4", name: "u4" } }))).sent, true, "the window moved on");

  // A count the database cannot make sends nothing: the cap is never skipped.
  const broken = { ...c.deps, db: { ...c.db, countAudit: async () => { throw new Error("db down"); } } };
  const before = c.mail.transport.sent.length;
  assert.deepEqual(await notify(broken, "invitation", args({ to: "new@example.com" })), { sent: false, reason: "failed" });
  assert.equal(c.mail.transport.sent.length, before);
});

test("notify: each kind has its own caps; a day of invitations does not hold back key notices, nor the reverse", async () => {
  const c = cloud();
  assert.deepEqual(CAPS.accessKey, { perSender: 30, perAddress: 10 });
  const notice = (over = {}) => ({ to: "grace@example.com", key: "key-create/key1/u2", project: { id: "prj1", name: "Fernwood" }, actor: { id: "u1", name: "Ada" }, keyName: "ci", url: SETTINGS_URL, ...over });
  // Ada uses up her invitations, three of them to Grace.
  for (let i = 0; i < CAPS.invitation.perSender; i++) assert.equal((await notify(c.deps, "invitation", args({ to: i < 3 ? "grace@example.com" : `p${i}@example.com`, key: `i${i}` }))).sent, true);
  assert.equal((await notify(c.deps, "invitation", args({ to: "late@example.com" }))).reason, "limit");
  assert.equal((await notify(c.deps, "invitation", args({ actor: { id: "u9" } }))).reason, "limit", "Grace has had her three");
  // Key notices from Ada, to Grace too, still go.
  for (let i = 0; i < CAPS.accessKey.perAddress; i++) assert.equal((await notify(c.deps, "accessKey", notice({ key: `n${i}` }))).sent, true, `notice ${i + 1}`);
  assert.deepEqual(await notify(c.deps, "accessKey", notice({ actor: { id: "u9" } })), { sent: false, reason: "limit" }, "ten to one address");
  for (let i = CAPS.accessKey.perAddress; i < CAPS.accessKey.perSender; i++) assert.equal((await notify(c.deps, "accessKey", notice({ to: `o${i}@example.com`, key: `n${i}` }))).sent, true);
  assert.deepEqual(await notify(c.deps, "accessKey", notice({ to: "fresh@example.com" })), { sent: false, reason: "limit" }, "thirty by one sender");
  const limits = (await c.db.listAudit()).filter((a) => a.action === "mail.limit").map((a) => [a.userId, a.detail.kind, a.detail.to]);
  assert.deepEqual(limits, [["u1", "invitation", "late@example.com"], ["u9", "invitation", "grace@example.com"], ["u9", "accessKey", "grace@example.com"], ["u1", "accessKey", "fresh@example.com"]]);

  // And the reverse: Bob, at his key notice caps, still invites; Grace, at hers for notices, is still invited (by u8).
  const d = cloud();
  for (let i = 0; i < CAPS.accessKey.perSender; i++) assert.equal((await notify(d.deps, "accessKey", notice({ to: i < 10 ? "grace@example.com" : `o${i}@example.com`, key: `n${i}` }))).sent, true);
  assert.equal((await notify(d.deps, "accessKey", notice({ to: "fresh@example.com" }))).reason, "limit");
  assert.equal((await notify(d.deps, "invitation", args({ actor: { id: "u1" }, to: "fresh@example.com" }))).sent, true);
  assert.equal((await notify(d.deps, "invitation", args({ actor: { id: "u8" } }))).sent, true);
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

test("resend: a message's own headers go in the body's headers field; names and values that could add headers are left out", async () => {
  const { fetch, calls } = fakeFetch();
  const send = (headers) => resendTransport({ apiKey: KEY, fetch }).send({ ...message, headers });
  await send({ "List-Unsubscribe": "<https://cloud.example/unsubscribe/?t=abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.deepEqual(calls[0].body.headers, { "List-Unsubscribe": "<https://cloud.example/unsubscribe/?t=abc>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.ok(!("List-Unsubscribe" in calls[0].init.headers), "message headers, not the request's");
  await send({ "X-Ok": "1", "Bcc\r\nX": "y", "X-Evil": "a\r\nBcc: x@evil.example", "X-Null": null });
  assert.deepEqual(calls[1].body.headers, { "X-Ok": "1" });
  await send({ "X-Evil": "a\nb" });
  await send(undefined);
  assert.ok(!("headers" in calls[2].body) && !("headers" in calls[3].body), "no field at all when nothing is left");
  assert.deepEqual(messageHeaders({ A: 1 }), { A: "1" });
  assert.equal(messageHeaders("List-Unsubscribe: x"), null);
});

const RUN_URL = `${PUBLIC_URL}/login?next=%2Fp%2Ffernwood%2Fruns%2Frun_1`;
const UNSUB = `${PUBLIC_URL}/unsubscribe/?t=${"T".repeat(43)}`;
const problemsMail = (over = {}) => runProblems({ project: { id: "prj1", name: "Fernwood" }, run: { title: "Larger tap targets", branch: "main", commit: "abc1234" }, count: 2, titles: ["checkout failed at step 3", "Page error in checkout"], url: RUN_URL, unsubscribeUrl: UNSUB, ...over });

test("runProblems: the count, the run, its problems' titles, the run link and the unsubscribe link, nothing else", () => {
  const m = problemsMail();
  assert.equal(m.subject, '2 problems in "Larger tap targets" of "Fernwood" on Imitor Cloud');
  assert.match(m.text, /^A run of the project "Fernwood" on Imitor Cloud has 2 problems\.\n\nRun: Larger tap targets\nBranch: main\nCommit: abc1234\n\n- checkout failed at step 3\n- Page error in checkout\n\nSee the run:\n/);
  assert.ok(m.text.endsWith(`\n\nYou get this because you are a member of this project. Stop these emails: ${UNSUB}\n`));
  assert.ok(m.text.includes(RUN_URL));
  assert.deepEqual([...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]), [RUN_URL, UNSUB], "exactly two links");
  assert.doesNotMatch(m.html, /<img|<script|src=|url\(/i, "no images or remote assets");
  assert.deepEqual(m.tags, [{ name: "kind", value: "runProblems" }]);
  assert.deepEqual(m.headers, { "List-Unsubscribe": `<${UNSUB}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });

  // One problem; no title (the branch names it); nothing about the run at all.
  assert.equal(problemsMail({ count: 1, titles: ["checkout failed at step 3"] }).subject, '1 problem in "Larger tap targets" of "Fernwood" on Imitor Cloud');
  assert.equal(problemsMail({ run: { branch: "feature/tap", commit: null } }).subject, '2 problems in "feature/tap" of "Fernwood" on Imitor Cloud');
  const bare = problemsMail({ run: {}, titles: [] });
  assert.equal(bare.subject, '2 problems in a run of "Fernwood" on Imitor Cloud');
  assert.doesNotMatch(bare.text, /Run:|Branch:|Commit:|^- /m);
  // At most RUN_TITLES titles (the same title once), then how many more; a long commit is shortened.
  const many = problemsMail({ count: 7, titles: ["a failed", "a failed", "b failed", "c failed", "d failed"], run: { title: "t", commit: "0123456789abcdef0123" } });
  assert.match(many.text, /- a failed\n- b failed\n- c failed\n- and 4 more\n/);
  assert.match(many.text, /Commit: 0123456789ab\n/);
  assert.equal(RUN_TITLES, 3);
});

test("runProblems: run titles, flow names and the project's name are escaped, one line, and short; still two links", () => {
  const evil = `<a href="https://evil.example">x</a><img src=x onerror=alert(1)>`;
  const m = problemsMail({ project: { name: `Fern\r\nBcc: x@evil.example ${evil}` }, run: { title: `Fix\u2028Cc: y@evil.example ${evil}`, branch: evil, commit: `<b>` }, titles: [`${evil} failed at step 1`, `x\r\nBcc: z@evil.example`] });
  assert.doesNotMatch(m.subject, /[\r\n\u0000-\u001f\u2028\u2029]/);
  assert.match(m.subject, /^2 problems in "Fix Cc: y@evil\.example <a href=/);
  assert.ok(!m.html.includes(evil) && !m.html.includes("<b>") && !m.html.includes("evil.example\""));
  assert.ok(m.html.includes("&lt;a href=&quot;https://evil.example&quot;&gt;x&lt;/a&gt;"));
  assert.equal([...m.html.matchAll(/<a\b/g)].length, 2, "a name cannot add a link");
  assert.deepEqual([...m.html.matchAll(/href="([^"]*)"/g)].map((x) => x[1]), [RUN_URL, UNSUB]);
  assert.doesNotMatch(m.text.split("\n").filter((l) => l.startsWith("- ")).join("\n"), /\r|Bcc: z@evil\.example\n/, "each title is one line");
  assert.match(m.text, /- x Bcc: z@evil\.example\n/);
  const long = problemsMail({ project: { name: "p".repeat(300) }, run: { title: "t".repeat(300) }, titles: ["f".repeat(300)] });
  const [, run, name] = /in "(t+…)" of "(p+…)"/.exec(long.subject);
  assert.equal(run.length, 80);
  assert.equal(name.length, 80);
  assert.match(long.text, new RegExp(`^- ${"f".repeat(79)}…$`, "m"));
});

test("notify: run emails have no sender; at most perProjectAddress to one address about one project, perAddress from all", async () => {
  const c = cloud();
  assert.deepEqual(CAPS.runProblems, { perAddress: 10, perProjectAddress: 5 });
  const run = (project, i, over = {}) => ({ to: "grace@example.com", key: `run-problems/${project}-${i}/u2`, project: { id: project, name: project }, run: { title: "t" }, count: 1, titles: [], url: RUN_URL, unsubscribeUrl: UNSUB, ...over });
  for (let i = 0; i < 5; i++) assert.equal((await notify(c.deps, "runProblems", run("prj1", i))).sent, true, `message ${i + 1}`);
  assert.deepEqual(await notify(c.deps, "runProblems", run("prj1", 5)), { sent: false, reason: "limit" }, "five about one project");
  assert.equal((await notify(c.deps, "runProblems", run("prj1", 6, { to: "hal@example.com" }))).sent, true, "another address is fine");
  for (let i = 0; i < 5; i++) assert.equal((await notify(c.deps, "runProblems", run("prj2", i))).sent, true, `prj2 message ${i + 1}`);
  assert.deepEqual(await notify(c.deps, "runProblems", run("prj3", 0)), { sent: false, reason: "limit" }, "ten from all projects");
  const sent = c.mail.transport.sent;
  assert.equal(sent.length, 11);
  assert.deepEqual(sent[0].headers, { "List-Unsubscribe": `<${UNSUB}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" }, "the template's headers reach the transport");
  const rows = await c.db.listAudit();
  assert.ok(rows.every((a) => a.userId === null));
  assert.deepEqual(rows.filter((a) => a.action === "mail.limit").map((a) => [a.projectId, a.detail]), [["prj1", { kind: "runProblems", to: "grace@example.com" }], ["prj3", { kind: "runProblems", to: "grace@example.com" }]]);
  // Invitations to the same address are counted on their own.
  assert.equal((await notify(c.deps, "invitation", args())).sent, true);
});

test("mailFromEnv: a run email's List-Unsubscribe headers reach Resend's body", async () => {
  const { fetch, calls } = fakeFetch();
  const mail = mailFromEnv({ RESEND_API_KEY: KEY, MAIL_FROM: FROM, PUBLIC_URL }, { fetch });
  const db = memoryDb({ now: clock() });
  assert.equal((await notify({ db, mail }, "runProblems", { to: "grace@example.com", key: "run-problems/run_1/u2", project: { id: "prj1", name: "Fernwood" }, run: { title: "t" }, count: 2, titles: [], url: RUN_URL, unsubscribeUrl: UNSUB })).sent, true);
  assert.deepEqual(calls[0].body.headers, { "List-Unsubscribe": `<${UNSUB}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  assert.deepEqual(calls[0].body.tags, [{ name: "kind", value: "runProblems" }]);
  assert.equal(calls[0].init.headers["Idempotency-Key"], "run-problems/run_1/u2");
});
