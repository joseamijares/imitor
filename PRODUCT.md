# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: plain static HTML, CSS and a little JavaScript, no framework and no build step, so the interface ships inside the npm package and hosts anywhere (first deploy target: Vercel).

## Users

Primary: a developer or founder reviewing a pull request on a React Native / Expo app. They open a link, on desktop or on their phone, to see how a mobile change looks without running a simulator or a build.

Co-primary: AI coding agents. Many teams will never open the interface; their agents will drive Imitor directly to build a preview, run flows, take screenshots and record videos, then read the results. (User, 11 Nov 2026: "super agentic; some people probably won't use the app".)

Secondary: open-source developers evaluating Imitor from GitHub.

## Product Purpose

Imitor shows a React Native / Expo app's UI without a simulator. It builds the app for the web, swaps native-only modules for stand-ins, and produces (a) a live, clickable preview and (b) a page of screenshots per run. Success: a reviewer catches layout, copy, colour and state problems before merge, and the final check on a real phone has less to find.

## Positioning

It is an imitation and says so. Every shot and preview states what was rendered, what was replaced by a stand-in, and what it cannot show. It runs on plain Linux: no Mac, no emulator, no device, no paid build.

## Operating Context

- Runs as one command (`npx imitor`) in an app's folder, in CI, or in a cloud agent session.
- Output is static: `preview/app` (the live web build), `preview/index.html` (report), `manifest.json`, PNGs.
- Reviewers arrive from a pull-request comment or a shared link.
- The app under preview brings its own brand and colours; Imitor's interface surrounds it.

## Capabilities and Constraints

- Works today: `imitor init` (sets an Expo app up and proposes stand-ins); Metro plugin with stand-ins (SQLite via sql.js, real Skia drawing via CanvasKit or an empty Skia box, inert), scripted flows (tap, fill, shot), devices and light/dark, HTML report with problems and stand-in labels; flows that start from a state (`after`, `state`, `seed`, `clock`); flows that sign in with a test account from environment variables (`{ "env": "NAME" }` fill values listed under `secrets`: never written to any output, scrubbed from anything a page echoes, masked in shots, no videos), and every typed value hidden in what Imitor writes; a pre-build gate and a pull-request comment with the shots (from the GitHub Action), marking shots that started from invented data or used secrets; an MCP server with eight tools and the same operations as JSON CLI commands; the review interface (`imitor app`) with runs, captures, problems, agents, a live preview and phone layouts; `imitor export` as a read-only static site, also under a sub-path with `--base`; a public demo with invented data, served at /demo/ of the public site (landing page, How to use, For agents).
- Planned, not built: text size and language controls in the live preview, "pretend iOS / Android" mode, Android widget renders, Apple surfaces on macOS. Imitor Cloud (see Business Model) is in development and not hosted.
- Known limits the interface must state: native navigation chrome, keyboard, exact fonts, entering animations, platform-specific code paths, widgets and notifications.
- Terminology: "stand-in" (a replaced native module), "flow", "shot", "device", "scheme".
- Undecided: visual diffs between commits; prices for the hosted cloud.

## Business Model

Decided by the owner, 12 Nov 2026, after reviewing Postiz and OpenSEO: open source first, then a paid hosted service.

- Free: the CLI, MCP server, review interface, `imitor export` and the run format (MIT), and a self-hostable Imitor Cloud with every feature.
- Imitor Cloud (in development, not hosted): the server code is in `cloud/` (upload API, Google sign-in with an allowlist, projects and upload keys, the interface's read API; Postgres and S3-compatible storage; deployable on Vercel at app.imitor.dev), and `imitor push` uploads to it. Agents and CI upload finished runs with `imitor push` and a per-project write-only key; people sign in with Google and review runs in the same interface. It is receive-only: it never builds or executes uploaded code. Server code in `cloud/` of this repo under AGPL-3.0 with a contributor agreement; multi-tenant with an allowlist; retention the newest 50 runs and 30 days by default.
- Paid hosted service (planned): sells running it (managed storage, longer history, share links, a ready-made GitHub App for pull-request comments, keyless CI, seats, support), not gated features. Prices are undecided placeholders; payments through a merchant of record (Polar is the lead option).
- Public promise until the hosted service exists: only "in development, not hosted" ("planned, not built" before the code landed), with interest collected on GitHub issue #11. No prices, Log in or trial on the site before the hosted service works.

## Brand Commitments

- Name: Imitor (Latin, "I imitate"). Open source, MIT.
- Voice: plain and honest about limits; never claims to be a simulator.
- User-stated bar: top-tier craft in the company of Linear, Apple, ChatGPT and Anthropic.
- Chosen identity (user, 11 Nov 2026): "Signal". Ink black (#0B0B0C) with chrome yellow (#FFD60A), Geist and Geist Mono, dense rows, standard controls. The brand colour is the imitation colour: anything imitated or stood-in is drawn dashed in yellow; genuine things are solid. Linear is a reference for density and craft only; an indigo Linear-like palette was rejected as too close a copy.
- Design handoff: `design/HANDOFF.md`, `design/tokens.css`. Both themes (dark and light) are designed.
- Logo (user, 11 Nov 2026): "Echo", used only as the app icon: a dark rounded tile holding a solid slab with its dashed yellow copy hovering above. The wordmark is "Imitor" in Instrument Serif Italic, chosen by the user after several rounds; the serif is for the wordmark only. Rejected along the way: a flat tile-less mark, a hand-drawn rounded wordmark, plain Geist, mono, wide caps, dot-matrix, and three custom-lettered options. Files in `design/logo/`.
- Standing visual preference (user, 11 Nov 2026): a technical product register like Linear, Apple and Mercury. No serif, paper-card or journal styling; the first "specimen under glass" direction was rejected for reading like a journal app.

## Evidence on Hand

- A real run on one Expo SDK 54 app: 18 shots, 0 errors (not in this repo; private app).
- No logo, no testimonials, no benchmarks, no user counts. Do not invent any.

## Product Principles

1. Honest by default: show what is imitated and what is not, next to the thing itself.
2. The app is the subject; Imitor's interface recedes around it.
3. One link, no setup, for the person reviewing.
4. Static and portable: everything works from files.

## Accessibility & Inclusion

No product-specific requirement established yet.
