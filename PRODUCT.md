# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

delegated: plain static HTML, CSS and a little JavaScript, no framework and no build step, so the interface ships inside the npm package and hosts anywhere (first deploy target: Vercel).

## Users

Primary: a developer or founder reviewing a pull request on a React Native / Expo app. They open a link, on desktop or on their phone, to see how a mobile change looks without running a simulator or a build.

Secondary: AI coding agents, which read the manifest and screenshots; and open-source developers evaluating Imitor from GitHub.

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

- Works today: Metro plugin with stand-ins (SQLite via sql.js, Skia box, inert), scripted flows (tap, fill, shot), devices and light/dark, HTML report with problems and stand-in labels.
- Planned, not built: live preview shell with device frame and controls (device, light/dark, text size, language), "pretend iOS / Android" mode, real Skia on web, seeded data states, Android widget renders, Apple surfaces on macOS.
- Known limits the interface must state: native navigation chrome, keyboard, exact fonts, entering animations, platform-specific code paths, widgets and notifications.
- Terminology: "stand-in" (a replaced native module), "flow", "shot", "device", "scheme".
- Undecided: hosted service versus self-hosted only; visual diffs between commits.

## Brand Commitments

- Name: Imitor (Latin, "I imitate"). Open source, MIT.
- Voice: plain and honest about limits; never claims to be a simulator.
- User-stated bar: top-tier craft in the company of Linear, Apple, ChatGPT and Anthropic.

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
