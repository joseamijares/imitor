// The cloud in a real browser (skipped without Playwright): sign in with the admin token, make a project and a key in
// its Settings, push a run with that key, read it in the interface in cloud mode, mark a problem seen, revoke the key,
// sign out. The page's Content-Security-Policy must not refuse anything the interface does.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadConfig } from "../../src/config.mjs";
import { push } from "../../src/push.mjs";
import { recordRun } from "../../src/store.mjs";
import { memoryDb } from "../src/db/memory.mjs";
import { startServer } from "../src/server.mjs";
import { memoryStorage } from "../src/storage/memory.mjs";

let playwright = null;
try { playwright = createRequire(import.meta.url)("playwright"); } catch {}

/** The invented app "fernwood" with one run whose dark scheme failed. */
function app() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "imitor-cloud-browser-"));
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "fernwood" }));
  fs.writeFileSync(path.join(root, "imitor.config.json"), JSON.stringify({ devices: ["iphone-16"], schemes: ["light", "dark"], flows: [{ name: "first-run", start: "/", steps: [{ shot: "01-welcome" }, { tap: "Continue" }, { shot: "02-plants" }] }] }));
  const out = path.join(root, "preview");
  fs.mkdirSync(path.join(out, "screens"), { recursive: true });
  const shots = ["light", "dark"].flatMap((scheme) => ["01-welcome", "02-plants"].filter((n) => scheme === "light" || n === "01-welcome").map((n) => ({ file: `screens/first-run-${n}-iphone-16-${scheme}.png`, flow: "first-run", shot: n, device: "iphone-16", scheme, route: "/", stubs: [] })));
  const problems = [{ where: "first-run / iphone-16 / dark", kind: "flow-failed", message: "locator.click: Timeout 10000ms exceeded.", flow: "first-run", device: "iphone-16", scheme: "dark", step: 2, stepConfig: { tap: "Continue" }, notReached: ["02-plants"] }];
  // A real 1x1 PNG, so the browser shows what storage sends.
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
  for (const s of shots) fs.writeFileSync(path.join(out, s.file), png);
  recordRun(out, { root, config: loadConfig(root), manifest: { commit: "abc1234", shots, problems }, startedAt: new Date(Date.now() - 600e3).toISOString(), by: { name: "GitHub Actions", kind: "ci" }, env: {} });
  return root;
}

test("the interface in cloud mode, end to end in Chromium", { skip: !playwright && "playwright is not installed" }, async (t) => {
  const token = crypto.randomBytes(32).toString("base64url");
  const deps = { db: memoryDb(), storage: memoryStorage(), adminToken: token, allowedEmails: new Set(), log: () => {} };
  const server = await startServer({ deps });
  t.after(() => server.close());
  const browser = await playwright.chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage();
  const refused = [];
  page.on("console", (m) => { if (/Content Security Policy|Refused to/i.test(m.text())) refused.push(m.text()); });
  page.on("pageerror", (e) => refused.push(`page error: ${e.message}`));

  // Signed out, the interface sends the browser to sign in and back.
  await page.goto(`${server.url}/p/fernwood/runs`);
  assert.equal(new URL(page.url()).pathname, "/login");
  await page.click("text=Sign in with the admin token");
  await page.fill("#token", token);
  await Promise.all([page.waitForURL(/\/p\/fernwood\/runs$/), page.click("button[type=submit]")]);
  assert.match(await page.textContent("body"), /No such project/);

  // A project, then a key in its Settings, shown once.
  await page.goto(`${server.url}/`);
  await page.fill("#project-name", "fernwood");
  await Promise.all([page.waitForURL(/\/p\/fernwood\/settings#access-keys$/), page.click("text=Create project")]);
  await page.waitForSelector("[data-key-create]");
  await page.fill("#key-name", "ci");
  await page.click("text=Make a key");
  await page.waitForSelector(".key-dialog");
  const secret = (await page.textContent(".key-dialog .code-text")).trim();
  assert.match(secret, /^imk_[A-Za-z0-9_-]{43}$/);
  assert.match(await page.textContent(".key-dialog"), /IMITOR_TOKEN=imk_/);
  await page.click("text=Done");
  assert.equal(await page.$(".key-dialog"), null);
  assert.ok(!(await page.content()).includes(secret), "the secret is gone from the page once the dialog closes");
  assert.match(await page.textContent("[data-keys]"), /ci.*never used/s);

  // A push with that key, then the run in the interface.
  const pushed = await push(app(), { cloudUrl: server.url, token: secret });
  assert.equal(pushed.url, `${server.url}/p/fernwood/runs/${pushed.id}`);
  await page.goto(`${server.url}/p/fernwood/runs`);
  await page.waitForSelector(`a[href="/p/fernwood/runs/${pushed.id}"]`);
  await page.goto(pushed.url);
  await page.waitForSelector(".thumb img");
  const src = await page.getAttribute(".thumb img", "src");
  assert.ok(src.startsWith(`/p/fernwood/files/runs/${pushed.id}/screens/`), src);
  await page.waitForFunction(() => [...document.querySelectorAll(".thumb img")].some((img) => img.complete && img.naturalWidth === 1));

  // No live preview here, said plainly.
  await page.goto(`${server.url}/p/fernwood/runs/${pushed.id}/live`);
  await page.waitForSelector("text=No live preview in Imitor Cloud");

  // Seen is kept on the server.
  await page.goto(`${server.url}/p/fernwood/problems`);
  const before = await (await page.request.get(`${server.url}/p/fernwood/api/problems`)).json();
  const failed = before.problems.find((p) => p.kind === "flow-failed");
  assert.equal(failed.seen, false);
  const marked = await page.evaluate(async (id) => (await fetch(`/p/fernwood/api/problems/${id}/seen`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seen: true }) })).status, failed.id);
  assert.equal(marked, 200, "a same-origin fetch carries the Origin the server checks");
  const admin = await deps.db.findUserByEmail("admin");
  assert.deepEqual((await deps.db.listSeen((await deps.db.getProjectBySlug("fernwood")).id, admin.id)).map((m) => m.problemId), [failed.id]);

  // Revoke the key; then sign out.
  await page.goto(`${server.url}/p/fernwood/settings#access-keys`);
  page.once("dialog", (d) => d.accept());
  await page.click("[data-revoke]");
  await page.waitForSelector("text=Revoked");
  await assert.rejects(push(app(), { cloudUrl: server.url, token: secret }), /refused the push \(401\)/);
  await Promise.all([page.waitForURL(/\/login$/), page.click("button:has-text('Sign out everywhere')")]);
  await page.goto(`${server.url}/p/fernwood/`);
  assert.equal(new URL(page.url()).pathname, "/login");

  assert.deepEqual(refused, []);
});
