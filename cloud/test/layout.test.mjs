// The licence boundary: src/ (MIT) never depends on cloud/ (AGPL), and the npm package leaves cloud/ out.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));

test("nothing in src/ imports from cloud/", () => {
  const files = fs.readdirSync(path.join(ROOT, "src"), { recursive: true }).filter((f) => /\.(mjs|cjs|js)$/.test(f));
  assert.ok(files.length > 10);
  for (const f of files) assert.doesNotMatch(fs.readFileSync(path.join(ROOT, "src", f), "utf8"), /cloud\//, f);
});

test("the npm package excludes cloud/; cloud/ is AGPL with two pinned dependencies (pg, @vercel/blob) and the root gains none", () => {
  const root = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8"));
  assert.ok(!root.files.some((f) => f.startsWith("cloud")));
  assert.equal(root.license, "MIT");
  const cloud = JSON.parse(fs.readFileSync(path.join(ROOT, "cloud", "package.json"), "utf8"));
  assert.equal(cloud.license, "AGPL-3.0-only");
  assert.equal(cloud.private, true);
  assert.deepEqual(Object.keys(cloud.dependencies), ["@vercel/blob", "pg"]);
  for (const [name, version] of Object.entries(cloud.dependencies)) assert.match(version, /^\d+\.\d+\.\d+$/, `${name}: an exact version`);
  assert.deepEqual(Object.keys(root.dependencies), ["sql.js"]);
  assert.match(fs.readFileSync(path.join(ROOT, "cloud", "LICENSE"), "utf8"), /^\s+GNU AFFERO GENERAL PUBLIC LICENSE\s+Version 3, 19 November 2007/);
});
