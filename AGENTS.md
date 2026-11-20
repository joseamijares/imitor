# Imitor

Imitor shows a React Native / Expo app's UI without a simulator: it builds the app for the web, swaps native-only modules for stand-ins, drives it in headless Chromium, and writes screenshots and a report page. It ships as the `imitor` npm package (CLI `bin/imitor.mjs`, Metro wrapper `imitor/metro`, MCP server `npx imitor mcp`). `README.md` is the user guide; `PRODUCT.md` holds the public promise.

Layout: `bin/` and `src/` (the published package), `test/` (its tests), `cloud/` (Imitor Cloud, AGPL-3.0, its own `package.json`; see `cloud/README.md`), `site/` (imitor.dev, deployed by the root `vercel.json`), `demo/` (the public demo), `action.yml` (the GitHub Action).

## Commands

Package manager: npm. Node 20 or later (CI uses 22).

```bash
npm install                                         # dependencies
npm install --no-save playwright && npx playwright install chromium   # optional: the browser tests skip themselves without it
npm test                                            # the package's tests (node --test test/*.test.mjs)
npm run test:cloud                                  # the cloud's tests (for Postgres: npm install --prefix cloud, then DATABASE_URL=postgres://...)
npm run site                                        # build the public site in site/
npm run demo                                        # build the demo into demo/site/
npm pack --dry-run                                  # check what the package would publish
```

There is no build step for the package itself. Publishing to npm is the owner's job: follow `RELEASING.md` (a pushed `v<version>` tag runs `.github/workflows/publish.yml`). CI (`.github/workflows/test.yml`) runs `npm test` and `npm run test:cloud` with Playwright, and the cloud tests against Postgres.

## Team memory

Memory bank: `proj-imitor`. Use it through the `jamak-memory` MCP server, passing it as `bank_id`. Rules: playbook `standards/memory.md`.

- Before starting a task, recall from this bank and from your own `dev-<id>` bank (`list_banks` shows yours).
- Before an architecture or tooling decision, reflect on `jamak-playbook` and recall from `jamak-org`.
- When you learn something a new teammate would need in 3 months (a decision, gotcha, convention, how-to, client fact), retain it to this bank with one `type:` tag.
- Files beat memory: this `AGENTS.md`, `docs/decisions/` and the playbook win over anything recalled.
- Never store secrets, credentials or customers' personal data.
