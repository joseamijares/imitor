// The waitlist function (cloud/src/waitlist.mjs, behind the root api/waitlist.mjs shim) with fake Requests: only
// production, only a same-origin POST, one row per address, the same answer for a new and a listed address, and a
// limit per client address.
import assert from "node:assert/strict";
import test from "node:test";
import { memoryDb } from "../src/db/memory.mjs";
import { CAPS } from "../src/mail/index.mjs";
import { recordingMail } from "../src/mail/transport.mjs";
import { JOINED, normalizeEmail, NOT_JOINED, waitlistFunction } from "../src/waitlist.mjs";

const SITE = "https://imitor.dev";
const ENV = { VERCEL_ENV: "production" };

const post = (body, { headers = {}, method = "POST", address = "203.0.113.7" } = {}) =>
  new Request(`${SITE}/api/waitlist/`, {
    method,
    headers: { "x-forwarded-host": "imitor.dev", origin: SITE, "x-forwarded-for": address, "content-type": "application/json", ...headers },
    body: method === "POST" ? (typeof body === "string" ? body : JSON.stringify(body)) : undefined,
  });

function setup(env = ENV) {
  const db = memoryDb();
  return { db, fn: waitlistFunction(env, { db }) };
}

test("an address is stored once, in lower case, and a second join gets the same answer", async () => {
  const { db, fn } = setup();
  const first = await fn.fetch(post({ email: "  Ada@Example.com " }));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });
  assert.equal(first.headers.get("cache-control"), "private, no-store");
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  const again = await fn.fetch(post({ email: "ada@example.com" }));
  assert.equal(again.status, 200);
  assert.deepEqual(await again.json(), { ok: true }, "it does not say the address was listed already");
  assert.deepEqual((await db.listWaitlist()).map((e) => e.email), ["ada@example.com"]);
  assert.equal(await db.findUserByEmail("ada@example.com"), null, "joining makes no user");
});

test("only production, only POST, only from the site itself", async () => {
  for (const VERCEL_ENV of ["preview", "development", undefined]) {
    const { db, fn } = setup({ VERCEL_ENV });
    assert.equal((await fn.fetch(post({ email: "ada@example.com" }))).status, 404, String(VERCEL_ENV));
    assert.deepEqual(await db.listWaitlist(), []);
  }
  const { db, fn } = setup();
  const get = await fn.fetch(post(null, { method: "GET" }));
  assert.equal(get.status, 405);
  assert.equal(get.headers.get("allow"), "POST");
  assert.equal((await fn.fetch(post({ email: "ada@example.com" }, { headers: { origin: "https://elsewhere.example" } }))).status, 403);
  assert.equal((await fn.fetch(post({ email: "ada@example.com" }, { headers: { "sec-fetch-site": "cross-site" } }))).status, 403);
  assert.equal((await fn.fetch(post({ email: "ada@example.com" }, { headers: { origin: "null" } }))).status, 403);
  assert.equal((await fn.fetch(post({ email: "ada@example.com" }, { headers: { origin: "http://imitor.dev" } }))).status, 403, "the same host over http is another origin");
  assert.deepEqual(await db.listWaitlist(), []);
  assert.equal((await fn.fetch(post({ email: "ada@example.com" }, { headers: { "sec-fetch-site": "same-origin" } }))).status, 200);
});

test("what is not one address is refused, and nothing is stored", async () => {
  const { db, fn } = setup();
  for (const email of ["", "ada", "ada@", "@example.com", "ada@example", "a b@example.com", "ada@example.com, grace@example.com", "<ada@example.com>", `${"a".repeat(250)}@example.com`, 7, null, ["ada@example.com"]]) {
    const res = await waitlistFunction(ENV, { db }).fetch(post({ email }));
    assert.equal(res.status, 400, JSON.stringify(email));
  }
  assert.equal((await fn.fetch(post("not json"))).status, 400);
  assert.equal((await waitlistFunction(ENV, { db }).fetch(post(JSON.stringify({ email: "ada@example.com", pad: "x".repeat(5000) })))).status, 400, "a large body");
  assert.deepEqual(await db.listWaitlist(), []);
  assert.equal(normalizeEmail(" Ada.Lovelace+imitor@Mail.Example.co.uk "), "ada.lovelace+imitor@mail.example.co.uk");
});

test("the hidden field: a script that fills it is told it worked, and nothing is stored", async () => {
  const { db, fn } = setup();
  const res = await fn.fetch(post({ email: "bot@example.com", website: "https://spam.example" }));
  assert.equal(res.status, 200);
  assert.deepEqual(await db.listWaitlist(), []);
});

test("a plain form post is sent back to the pricing page, with the outcome in the fragment", async () => {
  const { db, fn } = setup();
  const form = (fields) => post(new URLSearchParams(fields).toString(), { headers: { "content-type": "application/x-www-form-urlencoded" } });
  const ok = await fn.fetch(form({ email: "ada@example.com", website: "" }));
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get("location"), JOINED);
  const bad = await fn.fetch(form({ email: "nope" }));
  assert.equal(bad.status, 303);
  assert.equal(bad.headers.get("location"), NOT_JOINED);
  assert.deepEqual((await db.listWaitlist()).map((e) => e.email), ["ada@example.com"]);
});

test("five tries per client address in ten minutes; a database that fails is a 503", async () => {
  const { db, fn } = setup();
  for (let i = 0; i < 5; i++) assert.equal((await fn.fetch(post({ email: `p${i}@example.com` }))).status, 200);
  const sixth = await fn.fetch(post({ email: "p5@example.com" }));
  assert.equal(sixth.status, 429);
  assert.ok(Number(sixth.headers.get("retry-after")) > 0);
  assert.equal((await fn.fetch(post({ email: "other@example.com" }, { address: "203.0.113.8" }))).status, 200, "another address is not held back");
  assert.equal((await db.listWaitlist()).length, 6);
  // Without script the form is still sent back to the pricing page, not shown JSON.
  const held = await fn.fetch(post("email=p6%40example.com", { headers: { "content-type": "application/x-www-form-urlencoded" } }));
  assert.equal(held.status, 303);
  assert.equal(held.headers.get("location"), NOT_JOINED);
  assert.equal((await db.listWaitlist()).length, 6);

  const quiet = console.error;
  console.error = () => {};
  try {
    const broken = waitlistFunction(ENV, { db: { addWaitlist: async () => { throw new Error("down"); } } });
    assert.equal((await broken.fetch(post({ email: "ada@example.com" }))).status, 503);
    assert.equal((await waitlistFunction(ENV).fetch(post({ email: "ada@example.com" }))).status, 503, "no DATABASE_URL");
  } finally {
    console.error = quiet;
  }
});

test("the operator is told when the list grows: once per new address, without the address, and never in the way", async () => {
  const OPERATOR = "owner@example.com";
  const FROM = "Imitor Cloud <hello@example.com>";
  const withMail = (env = { ...ENV, WAITLIST_NOTIFY_TO: OPERATOR }, limiter) => {
    const db = memoryDb();
    const transport = recordingMail();
    return { db, transport, fn: waitlistFunction(env, { db, mail: { transport, from: FROM, replyTo: null }, ...(limiter ? { limiter } : {}) }) };
  };

  const { db, transport, fn } = withMail();
  assert.equal((await fn.fetch(post({ email: "Ada@Example.com" }))).status, 200);
  assert.equal(transport.sent.length, 1);
  const [message] = transport.sent;
  assert.equal(message.to, OPERATOR);
  assert.equal(message.from, FROM);
  for (const part of [message.subject, message.text, message.html]) assert.doesNotMatch(part, /ada|example\.com/i, "the address that joined is not in the message");
  assert.equal(message.idempotencyKey, undefined, "nothing derived from the address goes to the provider either");
  assert.deepEqual((await db.listAudit()).map((e) => [e.action, e.detail.kind, e.detail.to]), [["mail.send", "waitlist", OPERATOR]]);
  // A repeat join, a refused address and the trap send nothing.
  await fn.fetch(post({ email: "ada@example.com" }));
  await fn.fetch(post({ email: "nope" }));
  await fn.fetch(post({ email: "bot@example.com", website: "x" }));
  assert.equal(transport.sent.length, 1);

  // Off without WAITLIST_NOTIFY_TO, or with one that is not an address.
  for (const WAITLIST_NOTIFY_TO of [undefined, "", "not an address"]) {
    const off = withMail({ ...ENV, WAITLIST_NOTIFY_TO });
    assert.equal((await off.fn.fetch(post({ email: "ada@example.com" }))).status, 200);
    assert.equal(off.transport.sent.length, 0, String(WAITLIST_NOTIFY_TO));
  }

  // The cap: a flood of new addresses stops telling the operator, and every join still succeeds.
  const open = { blocked: () => 0, fail() {} };
  const flood = withMail(undefined, open);
  for (let i = 0; i < CAPS.waitlist.perAddress + 3; i++) assert.equal((await flood.fn.fetch(post({ email: `p${i}@example.com` }))).status, 200);
  assert.equal(flood.transport.sent.length, CAPS.waitlist.perAddress);
  assert.equal((await flood.db.listWaitlist()).length, CAPS.waitlist.perAddress + 3);

  // Mail that fails, or a mail setting that is wrong, never fails the join.
  const quiet = console.error;
  console.error = () => {};
  try {
    const failing = withMail();
    failing.transport.fail = "down";
    assert.equal((await failing.fn.fetch(post({ email: "ada@example.com" }))).status, 200);
    assert.deepEqual((await failing.db.listWaitlist()).map((e) => e.email), ["ada@example.com"]);
    const db2 = memoryDb();
    const half = waitlistFunction({ ...ENV, WAITLIST_NOTIFY_TO: OPERATOR, RESEND_API_KEY: "re_only_the_key" }, { db: db2 });
    assert.equal((await half.fetch(post({ email: "ada@example.com" }))).status, 200, "RESEND_API_KEY without MAIL_FROM");
    assert.equal((await db2.listWaitlist()).length, 1);
  } finally {
    console.error = quiet;
  }
});
