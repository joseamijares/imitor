# Imitor

See a React Native / Expo app's UI without opening a simulator.

Imitor builds your app for the web, swaps the native-only parts for stand-ins,
drives it in headless Chromium, and writes a page of screenshots. It runs on any
Linux box, CI runner or cloud agent session: no Mac, no emulator, no device.

It is an imitation, not a simulator. It shows layout, copy, colours, states and
flows. It does not replace a final check on a real phone; it shrinks what that
check has to find.

Status: early (v0). Tried on two Expo SDK 54 apps so far.

Site: [imitor.vercel.app](https://imitor.vercel.app) · Live demo: [imitor.vercel.app/demo](https://imitor.vercel.app/demo/)

## What you get

```
preview/
  index.html      one page with every shot, grouped by flow
  manifest.json   what was rendered, from which commit, and what was not covered
  screens/*.png   <flow>-<shot>-<device>-<scheme>.png
  captures/       screenshots and videos taken on request by agents or scripts
  app/            the web build itself (static; host it anywhere for a live preview)
```

## Set up

In the app's folder, install Imitor and Playwright with its Chromium.

**Not on npm yet:** until the first release is published, install from GitHub instead: `npm i -D github:joseamijares/imitor playwright`.

```bash
npm i -D imitor playwright
npx playwright install chromium
```

Then, in the same folder:

```bash
npx imitor init --dry-run   # show every change it would make, as diffs
npx imitor init             # make them
```

`imitor init` works on Expo apps (with or without their own `ios/` and `android/` folders). It stops and explains on a bare React Native app without Expo. It never installs anything: it ends with the exact install command for what is missing, for the package manager your lockfile shows (npm, yarn, pnpm or bun), and the next commands to run. It is safe to run twice; the second run changes nothing. An agent can do the same through the `imitor_init` MCP tool.

### What init does

These are the steps `imitor init` takes. Do them by hand if you prefer, or when it asks you to.

1. Wrap your Metro config: keep building `config` as you do now (`getDefaultConfig`, Sentry's `getSentryExpoConfig`, your transformers) and wrap what you export. It does nothing unless Imitor is running the build.

   ```js
   // metro.config.js
   module.exports = require("imitor/metro").withImitor(config);
   ```

   init makes this one-line edit when `metro.config.js` (or `.cjs`) exports a variable or a call, creates the standard Expo config already wrapped when there is none, and otherwise leaves the file alone and prints these instructions (an ES module `metro.config.mjs` or `.ts`, or a shape it does not recognise).

2. Keep the output folder (`preview/` by default) out of git: init adds it to `.gitignore`, and to `.easignore` when there is one. If the app's runtime version comes from Expo's fingerprint (`"runtimeVersion": { "policy": "fingerprint" }`, or a `fingerprint.config.js`), editing `.gitignore` would change the runtime version and force new store builds, so init leaves it alone and sets `"out"` to a folder it already ignores, such as `dist/imitor`. It does the same, and says why, when it cannot evaluate a dynamic `app.config.js` or `app.config.ts` (for example before the app's packages are installed), since that config may set the policy. It also tells you when an ESLint flat config would lint the output folder; it does not edit lint config.

3. Add `imitor.config.json` next to `package.json`. init writes stand-ins for the app's dependencies (see [Stand-ins](#stand-ins)), one device, the colour schemes the app has (`userInterfaceStyle`) and a first flow that opens `/` and takes one shot. It lists packages it does not know that have native code and no web build as "may need a stand-in", without adding them; most Expo packages need none. If the file exists, init shows what would change and writes nothing unless you pass `--force`. A fuller config:

   ```json
   {
     "shims": {
       "expo-sqlite": "sqljs",
       "@shopify/react-native-skia": "skia",
       "some-native-only-package": "inert"
     },
     "devices": ["iphone-16", "pixel-9"],
     "schemes": ["light", "dark"],
     "flows": [
       {
         "name": "first-run",
         "start": "/",
         "steps": [
           { "shot": "welcome" },
           { "tap": "Continue" },
           { "fill": { "placeholder": "Your name", "value": "Ada" } },
           { "tap": { "label": "Next" } },
           { "shot": "home" }
         ]
       }
     ]
   }
   ```

4. Run it in the app folder:

   ```bash
   npx imitor
   ```

   `imitor build` runs `expo export --platform web` with your environment, so `EXPO_PUBLIC_*` values are inlined into the build as usual. If the app needs them to start (a backend URL, a public key), pass harmless placeholders for that command rather than real ones, for example `EXPO_PUBLIC_API_URL=http://127.0.0.1:9 npx imitor build`; the app then sees an unreachable backend.

Other commands: `imitor init`, `imitor build`, `imitor shoot` (reuse the last build), `imitor serve` (click around by hand), `imitor app` (the review interface), `imitor export` (the interface as a static site), `imitor push` (uploads a run to an Imitor Cloud instance; in development).

## For agents

Imitor is built to be driven by coding agents. Connect it as an MCP server from the app's folder:

```bash
claude mcp add imitor -- npx imitor mcp
```

Any MCP client works the same way: the command is `npx imitor mcp`, over stdio.

| Tool | What it does |
| --- | --- |
| `imitor_init` | Sets Imitor up in the app (Metro wrap, `imitor.config.json`, ignores). Only shows the changes unless `dryRun` is `false` |
| `imitor_describe` | Lists the flows, devices and stand-ins configured, and whether a build exists |
| `imitor_build` | Builds the web preview of the app as it is on disk |
| `imitor_screenshot` | Takes one screenshot and returns the image. Reach the screen by `route`, by `flow`, or with inline `steps`; `state` overrides the state label for that call |
| `imitor_run_flow` | Runs one flow and reports every step, its shots, and where it failed |
| `imitor_record_video` | Records a `.webm` video of a flow with animations on |
| `imitor_read_problems` | Failed steps, page errors, stand-ins seen and coverage limits from the last full run |
| `imitor_open_preview` | Serves the build locally and returns a URL a person can open |

Every result names the stand-ins visible in the shot, so an agent knows which parts are not drawn like the real app.

The same operations exist as commands that print JSON, for scripts and CI:

```bash
npx imitor describe
npx imitor screenshot --flow first-run --device pixel-9 --scheme dark
npx imitor flow --flow first-run
npx imitor record --flow first-run
npx imitor problems
```

Screenshots and videos from these land in `preview/captures/`. Each call starts from a fresh app state: empty, or the state the flow (or the config) sets up (see [Start a flow from a state](#start-a-flow-from-a-state)). A screenshot without `--flow` takes the top-level settings, and `--state <label>` (or `state` in the MCP tool) overrides the state label for that one call. Results say which `state` and `seeded` data a capture started from, and list `seedErrors`.

## The app

`npx imitor app` starts the local review interface, where a person looks over what agents and CI produced: runs and their shots, captures, problems, and which agents are connected.

```bash
npx imitor app            # http://127.0.0.1:4173 (or --port n)
```

It reads plain files from the output folder: `runs/` (the last 50 full runs), `captures/index.jsonl`, `activity.jsonl` (one line per MCP tool call) and `state.json`, which the CLI and the MCP server write as they work. It binds to 127.0.0.1 only, so it is reachable from this machine and nowhere else.

The live preview (`/live`, or Live on a run) shows the built app itself, running in a device frame. `imitor app` serves the build on a second port of its own, so the app's router and reloads work as at a site root, and adds a small driver script to its pages so the interface can replay a flow inside the frame up to the shot you pick: taps, fills and waits, as the runs do in headless Chromium, after the steps of any flow it runs `after`. Each replay clears what the app stored, then opens the app with `?imitor-flow=<name>`, so the page starts with that flow's `state` and `seed` (the Flow state panel lists them). Reload starts again from the first flow's state.

The Appearance and Reduce motion controls rely on an override that `imitor build` adds to every page of the build: with `?imitor-scheme=dark|light` or `?imitor-motion=reduce|no-preference` in the address, the app's `matchMedia` answers `prefers-color-scheme` and `prefers-reduced-motion` accordingly (it is kept for the browser tab's session; `auto` clears it). Builds made before this have no override: the live preview says so and the app follows the computer's settings until you run `imitor build` again. An app that ignores the system scheme (for example `userInterfaceStyle: "light"` and no `useColorScheme`) looks the same in both.

The iPhone status bar and the Android camera are drawn above the app, not over it: the web build has no safe-area insets, so drawing them on top would hide what the shots show.

A public demo of the interface, with invented data for an invented plant-care app ("fernwood"), runs at [imitor.vercel.app/demo](https://imitor.vercel.app/demo/). It is built from `demo/` with `npm run demo` (it writes `demo/site/`). The root `vercel.json` deploys the public site in `site/` (`npm run site`): its How to use and For agents pages are generated from this README, and the demo is exported into its `/demo/` folder.

## Publish a run

```bash
npx imitor export                                  # writes preview/site/
npx imitor export --out review-site                # or anywhere else
npx imitor export --preview-url https://my-preview.example.com
npx imitor export --base /review                   # to serve it under /review/ instead of a domain root
```

`imitor export` writes the interface and its data as plain static files, for any static host (Vercel, Netlify, GitHub Pages, an S3 bucket): the interface, every API response as a `.json` file, and the shots, failure screenshots and captures those responses point to (nothing else from the output folder). It is read-only: marking a problem seen is kept in each visitor's browser, and nothing can start a run. The live preview needs a running build, so it is left out and the Live page says so, unless `--preview-url` names a deployed web build of the app. Serve the folder at the root of a domain, or under the path given with `--base`; it includes a `404.html`, a `vercel.json` and a `_redirects` file so deep links like `/runs/<id>` load the interface.

The site holds the app's screenshots and videos. Publish it only where those may be seen, for example a team-only or password-protected deployment, not a public URL for an unreleased app.

## Stand-ins

| Value | Replaces | Behaviour |
| --- | --- | --- |
| `sqljs` | `expo-sqlite` | Real SQLite (sql.js, wasm) in memory, including the synchronous API. Mirrored to `sessionStorage` so a reload keeps data. A flow's `seed.sql` runs in it. |
| `skia` | `@shopify/react-native-skia` | `<Canvas>` keeps its box but draws nothing. Shots containing one are labelled in the report. |
| `canvaskit` | `@shopify/react-native-skia` | Real Skia drawing: the package's own web build, drawing with CanvasKit (Skia compiled to WebAssembly). Not a stand-in, so shots are not labelled. See [Real Skia drawing](#real-skia-drawing). |
| `inert` | any module | Every export exists and does nothing. Components render nothing. |
| `./path/to/file.js` | any module | Your own stand-in. Inside it, `require` of the module it replaces gets the real one, so a stand-in can re-export most of a package and replace one function (for example a backend client's `createClient`, to show signed-in screens with invented data). |

A key matches the module name as the app imports it (`"some-sdk"` also covers `"some-sdk/sub/path"`), before path aliases are resolved.

Stand-ins only apply to the web build Imitor makes (`IMITOR=1`). Your iOS and Android builds are untouched.

`imitor init` proposes stand-ins from [`src/standins.json`](https://github.com/joseamijares/imitor/blob/main/src/standins.json): packages checked by hand against a real install (does it ship a web build, does it load its native module at import), each with the version checked and why. So far it covers the packages of two Expo SDK 54 apps; only `expo-sqlite` and `@shopify/react-native-skia` needed a built-in kind, and everything else there works on the web as it is (its own web build, or a fallback that does nothing). For `@shopify/react-native-skia` it proposes `canvaskit` (real drawing) when `canvaskit-wasm` can be found from the app, the same way `imitor build` looks for it, and `skia` (an empty box) otherwise, and says which and why. A package with native code that is not in the table and has no web build is listed as "may need a stand-in": try the build, and add `"inert"` or your own file if it fails.

### Real Skia drawing

With `"@shopify/react-native-skia": "canvaskit"`, Imitor bundles the real React Native Skia and draws every `<Canvas>` with CanvasKit, as React Native Skia does on any website. Nothing in the app changes: `imitor build` copies CanvasKit from the app's own `canvaskit-wasm` (the copy `@shopify/react-native-skia` depends on, so the versions match) into the build, and loads it before the app's scripts. If the app already calls `LoadSkiaWeb` itself, that call finds CanvasKit loaded and does nothing. If `canvaskit-wasm` cannot be found, the build stops and says which version to install. If CanvasKit (or sql.js) then fails to load in the page, the app never starts: the flow fails with "the app did not start" instead of taking a shot of a blank page, and the gate blocks.

What can still differ from a phone:

- The first load is heavier: CanvasKit's `.wasm` is about 8 MB (8,001,100 bytes for canvaskit-wasm 0.40.0, 3.2 MB gzipped), loaded before the app starts. Use `skia` when you only need the layout.
- Fonts: on the web, Skia has no system fonts (`Skia.FontMgr.System()` is an empty font provider), so text drawn inside a `<Canvas>` with a font found by system name (`matchFont`) finds no typeface and draws nothing. Fonts the app loads from files with `useFont` or `useFonts` are drawn. Text drawn by React Native around the canvas is not affected.
- Pixel ratio: the canvas is drawn at the device's `scale` in Imitor (2 for every built-in device), not at the phone's own (3 on recent iPhones), so fine lines and edges are a little softer than on the phone.
- Animation: shots catch whatever frame is on screen. With `reducedMotion` on (the default) an app that stops its animations for reduced motion gives the same shot every run; with it off, a looping animation (waves, bubbles) is in a different place each run. A `clock` ([Start a flow from a state](#start-a-flow-from-a-state)) fixes the starting instant but does not freeze time, so it does not stop such an animation.
- GPU: headless Chromium draws WebGL in software (SwiftShader). Antialiasing and gradients may differ slightly from the phone's GPU; Chromium also logs performance warnings ("GPU stall due to ReadPixels"), which are not counted as page errors.

## Flow steps

| Step | Meaning |
| --- | --- |
| `{ "shot": "name" }` | Screenshot. Add `"fullPage": true` for the whole scroll height of the page. Most React Native Web screens scroll inside a `ScrollView`, not the page, and then get the viewport only: use `scroll` steps and more shots. |
| `{ "tap": "Visible text" }` | Tap by exact text. Also `{ "tap": { "testId" \| "label" \| "text" \| "css": ... } }`. |
| `{ "fill": { "placeholder" \| "label" \| "testId": ..., "value": "..." } }` | Type into a field. The value can also come from an environment variable, `"value": { "env": "TEST_PASSWORD" }` ([Sign in with a test account](#sign-in-with-a-test-account)). |
| `{ "goto": "/route" }` | Navigate (full reload). |
| `{ "waitFor": "Visible text" }`, `{ "wait": 500 }`, `{ "scroll": 400 }` | Wait or scroll (the wheel, in the middle of the screen). |

Each flow runs in a fresh browser, once per device and colour scheme (an app that
only has a light appearance can set `"schemes": ["light"]`). A failed
step is recorded in the report with a screenshot of where it stopped, and the
command exits non-zero.

Browser dialogs (`window.alert`, `confirm`, `prompt`, which many apps use for
errors on web) never appear in a screenshot. Imitor dismisses them and records
their text as a `dialog` problem with the step that raised it; `imitor flow`,
`screenshot` and `record` list them under `dialogs`.

What a flow types never leaves the run: in manifests, the runs store, results, the gate's
text, the pull-request comment and an exported site, every `fill` value is shown as `•••`
(or, for a value from the environment, as its `{ "env": "NAME" }`). Only `imitor app` on
your machine has the literal values, because its live preview replays them.

Other config keys: `after`, `state`, `seed` and `clock` ([Start a flow from a state](#start-a-flow-from-a-state)), `secrets` ([Sign in with a test account](#sign-in-with-a-test-account)), `locale` (default `en-US`), `timezone` (`UTC`), `settleMs` (`600`),
`reducedMotion` (`true`), `out` (`preview`). Devices: `iphone-16`, `iphone-se`,
`pixel-9`, `small-android`, or `{ "name", "width", "height", "scale" }`.

## Start a flow from a state

Most of an app sits behind onboarding or sign-in, and screens that show today's date change every day. Four optional keys set what a flow starts from. Each works on a flow, or at the top level of `imitor.config.json` as the default for every flow; a flow's own value wins, and `null` on a flow opts out of the default.

```json
{
  "shims": { "expo-sqlite": "sqljs", "@supabase/supabase-js": "./imitor-stand-ins/supabase.js" },
  "state": "signed-in",
  "clock": "2026-03-14T09:30:00Z",
  "flows": [
    { "name": "welcome", "state": "signed-out", "steps": [{ "shot": "first" }, { "tap": "Continue" }] },
    { "name": "name", "after": "welcome", "state": "signed-out", "steps": [{ "fill": { "placeholder": "Your name", "value": "Ada" } }, { "shot": "named" }] },
    {
      "name": "today",
      "start": "/today",
      "seed": {
        "storage": { "onboarding-done": "true", "settings": "{\"units\":\"metric\"}" },
        "sql": "imitor-seed/garden.sql",
        "database": "garden.db"
      },
      "steps": [{ "shot": "today" }]
    }
  ]
}
```

| Key | What it does |
| --- | --- |
| `"after": "<flow>"` | Runs that flow's steps first (its shots are skipped), then this flow's. Chains may nest. The chain starts at the first flow's `start`; a later flow's own `start`, if it has one, is opened after the flows before it (a full reload, so in-memory state is lost). Unknown names and cycles are errors when the config loads. A top-level `after` does not apply to the flow it names, nor to the flows that one runs after. |
| `"state": "<label>"` | A free-form label handed to the app's stand-ins before any app code runs, as `globalThis.__imitor.state` (a string, or `null`). |
| `"seed"` | Data put in place before the app's first script runs: `storage` and `sql`, below. |
| `"clock": "<ISO date-time>"` | Starts the page's clock at that instant, so screens that show today's date look the same whichever day the run happens. Give the zone, `Z` or an offset: `"2026-03-14T09:30:00Z"`, `"2026-03-02T15:00:00-06:00"`. |

A run of a flow uses that flow's `state`, `seed` and `clock` (its own, else the top level's) for the whole chain; the flows named in `after` contribute only their start and steps.

**State.** Use it in place of ad-hoc switches in the address: an app-local stand-in branches on the label. For example, a backend client's stand-in returns a signed-in session unless the flow says otherwise:

```js
// imitor-stand-ins/backend.js
const signedOut = (globalThis.__imitor && globalThis.__imitor.state) === "signed-out";
```

**`seed.storage`** is an object of key to string written to `localStorage` before the app runs. `@react-native-async-storage/async-storage` on web (checked with 2.2.0) reads and writes `window.localStorage` directly with the key unchanged, no prefix, so `"onboarding-done": "true"` is what `AsyncStorage.getItem("onboarding-done")` returns. Values must be strings: write objects as JSON, as AsyncStorage callers do.

**`seed.sql`** needs the `sqljs` stand-in. It is an array of SQL texts, or the path of a `.sql` file relative to the app folder. The app's code has not created its schema before it runs, so the seed cannot wait for it: the statements run when the app first opens the seed's `database` (a file name as the app passes it to `openDatabaseSync` / `openDatabaseAsync`; by default the first database it opens, other than `":memory:"`), immediately after it is opened and before the open call returns. The app's own `CREATE TABLE IF NOT EXISTS` and migrations then run on top, so the seed creates the tables it fills, and an app that tracks migrations with `PRAGMA user_version` needs the seed to set it too. Each entry (an array item, or the file) runs statement by statement; the first statement that fails stops the rest of that entry, and every failure is a `seed-failed` problem naming the statement. A seed whose database the app never opens is a problem too. Both fail the flow (and block the gate).

The seed is applied once per browser session: a reload or a `goto` step keeps what the app has done since (the stand-in mirrors the database to `sessionStorage`, and a marker there stops the seed running again). Each flow runs in a fresh browser, so each starts from its seed.

**Clock.** Runs, `flow`, `screenshot` and `record` use Playwright's clock (`clock.install`, Playwright 1.45 or newer): `Date`, `performance`, timers and `requestAnimationFrame` start at the instant and then run at normal speed, so animations and timers behave as usual and the time on screen moves on by the seconds the flow takes. A run on 12 November and one with the machine's date set to 20 January gave byte-identical shots. Imitor does not freeze the time outright: a frozen `Date` stops React Native's `Animated` timing animations, which measure progress with `Date.now()`; on a real app a card that fades in stayed invisible. In the live preview there is no Playwright: only `Date` is moved to the clock (and runs on from it); timers and animations run as usual.

The run's `manifest.json` lists each flow's `after`, `state`, `seeded` and `clock` under `flows`, and each shot carries `state` and `seeded`, so a reviewer can tell a shot came from invented data. The review interface marks those shots next to the stand-in marker, and `imitor describe` and `GET /api/project` show each flow's settings. Invented data is not the real app's data: treat seeded screens like stand-ins.

`imitor build` from this version is needed for `seed.sql` (the stand-in in the bundle applies it); `state`, `seed.storage` and `clock` also work on older builds.

## Sign in with a test account

Invented data ([Start a flow from a state](#start-a-flow-from-a-state)) shows signed-in screens without any credentials, and is what Imitor is built around. When you need the real thing (real server responses, real permissions), a flow can sign in to a real backend with a test account. Imitor takes the credentials from environment variables and does not read any secret store itself, so they can come from 1Password, another secret manager or plain CI secrets.

List the variables a flow may use under `secrets`, and refer to them in `fill` steps:

```json
{
  "secrets": ["TEST_EMAIL", "TEST_PASSWORD"],
  "flows": [
    {
      "name": "sign-in",
      "steps": [
        { "fill": { "placeholder": "Email", "value": { "env": "TEST_EMAIL" } } },
        { "fill": { "placeholder": "Password", "value": { "env": "TEST_PASSWORD" } } },
        { "tap": "Sign in" },
        { "waitFor": "Today" },
        { "shot": "today" }
      ]
    }
  ]
}
```

Then run Imitor with those variables set. With 1Password's CLI, `op run` resolves `op://` references, or a whole [1Password Environment](https://www.1password.dev/environments/), into the environment of the command it starts:

```bash
# .env.imitor (committed: it holds references, not secrets)
TEST_EMAIL=op://Imitor test/test account/username
TEST_PASSWORD=op://Imitor test/test account/password

op run --env-file .env.imitor -- npx imitor flow sign-in
op run --environment <environment id> -- npx imitor   # or from a 1Password Environment
```

In GitHub Actions, [`1password/load-secrets-action`](https://www.1password.dev/ci-cd/github-actions/) with `export-env: true` (and a service account token stored as a repository secret) does the same for later steps; a repository secret passed as `env:` works too.

What Imitor does with them:

- The value is read at the moment the field is filled. The step itself keeps the reference, so manifests, results and logs show `{ "env": "TEST_PASSWORD" }` and never the value.
- Error messages, page errors, dialogs and the addresses shots were taken at are searched for every value the flows type (the listed variables' values and the literal fill values), as written and JSON-escaped, and any found are replaced with `•••`. This covers an app that echoes what was typed, such as `alert("Wrong password …")` or a `/u/<email>` address. Text is searched before it is shortened, so a cut cannot leave half a value behind.
- In screenshots, a field filled from a variable is covered by a solid box, password fields too (a "show password" toggle could reveal one).
- A variable that is listed but not set fails the step with its name. So does one shorter than 4 characters: a value that short cannot be found in text without blanking ordinary words, so Imitor does not type it. A reference to a variable not listed in `secrets` is an error when the config loads.
- Only flows in `imitor.config.json` can use them. Steps passed to `imitor screenshot --steps` or the `imitor_screenshot` tool cannot, so an agent cannot type an arbitrary variable into a field and screenshot it.
- `imitor record` and `imitor_record_video` refuse a flow that uses them (or runs `after` one that does): a video shows every frame, and the masks do not reach it.
- The live preview in `imitor app` stops before such a step and says so. The interface never receives the values.
- Shots, flows, `describe` and the project data list the variables a flow uses under `secrets`, so a reviewer can tell those shots show a real backend.

What it cannot do: **whatever the signed-in app shows is in the screenshots.** The account's name, email and data are on screen, and so in the report, the runs, the artifact, the `imitor-shots` branch and the comment, and an exported site. Masks cover the fields Imitor typed into, not the screens that follow. Nor can it stop an agent that can run shell commands in the same session from reading the variables directly (`env`). Treat these as limits of the feature, not settings.

So, before you use it:

- **Use a test project, never production.** Make it a separate backend project (for example, a second Supabase project) whose data is entirely invented, so a screenshot that leaks shows nothing private.
- **Limit the account.** Give it access only to its own seeded rows, read-only where the app allows it, and keep a script that resets its data. An agent driving a flow can tap anything a person could, including "Delete account".
- **Keep it out of the default gate.** Run the sign-in flows locally under `op run`, or in a separate job on a runner you trust, and keep the pull-request gate on invented state. GitHub does not pass secrets to workflows run for pull requests from forks, so such a job does not run for those. Each flow runs once per device and colour scheme, and each run signs in again: expect your auth provider's rate limits.

## Gate your native builds

A native build costs money and minutes. `imitor gate` runs first and blocks the build when the app's UI is already broken on the web imitation.

```bash
npx imitor gate
```

It builds the preview, runs every flow, prints a verdict and exits non-zero when the run should block. `--fail-on` sets how strict it is:

| `--fail-on` | Blocks when |
| --- | --- |
| `flows` (default) | A flow could not be completed, or its seed failed |
| `errors` | Also when the page threw an uncaught error |
| `stand-ins` | Also when any shot contains a stand-in |

`--no-build` reuses the last build, and `--json` prints the verdict as JSON. On GitHub Actions it also writes a job summary, step outputs and error annotations.

The gate checks the web imitation only. It does not test the native build; it stops you paying for one that would fail review anyway.

### GitHub Actions

```yaml
on: pull_request

jobs:
  imitor:
    runs-on: ubuntu-latest
    concurrency:            # a newer push cancels this pull request's older run
      group: imitor-${{ github.event.pull_request.number }}
      cancel-in-progress: true
    permissions:
      contents: write       # push the screenshots to the imitor-shots branch
      pull-requests: write  # post and update the comment
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm ci
      - uses: joseamijares/imitor@main
        with:
          fail-on: flows

  build:
    needs: imitor # runs only if the gate passed
    runs-on: ubuntu-latest
    steps:
      - run: echo "start your native build here"
```

The action installs Chromium, runs the gate, and uploads the report as an artifact whether it passes or fails. Its outputs are `passed`, `shots`, `failed-flows`, `page-errors` and `stand-ins`. Your app needs `imitor` and `playwright` in its dev dependencies, as in Set up.

#### The pull-request comment

On `pull_request` events the action also posts the run on the pull request as one comment, so a reviewer sees the shots without downloading anything, on a phone too. The comment has the verdict, a line of counts, each failed flow with the step it stopped at, the error and the screenshot of where it stopped, and then the shots of each flow in step order as small images (tap one for full size), each with its step name and a note when it contains a stand-in or started from invented data (a flow's `state` or `seed`). The counts line says how many shots used invented data, and lists the kinds that run the real library on the web (`sqljs`, `canvaskit`) so they are not mistaken for stand-ins. A flow that failed inside a flow it runs `after` is reported at that flow's step (`step 2 of "welcome"`), here and in the gate's output. It shows one device and scheme (the first configured) and at most `max-shots` shots per flow (default 12), and says how many more are in the full report. On every push the same comment is updated in place (it is found by a hidden `<!-- imitor-comment -->` line); the action never posts a second one. If the gate stops before it writes this run's report (the build failed, say), the action publishes and uploads nothing, and the comment says there is no report for that commit instead of showing an earlier run's shots.

| Input | Default | |
| --- | --- | --- |
| `comment` | `"true"` | `"false"` turns the comment off. Ignored on events other than `pull_request`. |
| `shots-branch` | `imitor-shots` | The branch that holds the images |
| `max-shots` | `12` | Most shots per flow in the comment |

Where the images live: GitHub only shows images in a comment on a private repository when they come from somewhere the viewer can already read, so the action commits the run's screenshots (and its `manifest.json`) to a separate branch of the same repository, `imitor-shots`, under `pr-<number>/<short commit>/`, using the job's own `GITHUB_TOKEN`. No other service and no secret is involved. The screenshots of your app are therefore stored in your repository and stay exactly as private as the repository is: anyone who can read the repository can open them. On a private repository viewers must be signed in to GitHub with read access to see the images (GitHub's rule for images in comments; the links have the form `https://github.com/<owner>/<repo>/blob/imitor-shots/<path>?raw=true`). Whether the GitHub mobile app shows them has not been checked yet.

The branch has no shared history with your code and never touches your working branch. On every push it keeps only the newest 3 commits' folders per pull request and is rewritten as a single commit, so it does not grow with history (Git hosts can still keep unreferenced old images for a while before cleaning them up). Folders of closed pull requests stay until removed; deleting the branch at any time is safe, the next run creates it again. A branch of that name that already exists and was not made by Imitor (it has no `imitor-shots.json`) is never overwritten: publishing stops and asks for a dedicated branch (the `shots-branch` input).

The workflow needs the `permissions:` block above: `contents: write` to push the branch and `pull-requests: write` for the comment. Without them (and always for a pull request from a fork, whose token is read-only) the action prints a notice naming the missing permission and carries on: the comment falls back to file paths, or is skipped, and the job's result is still the gate's.

Keep the `concurrency` block above: two pushes in quick succession start two runs, and without it the older one can finish last and put its shots and verdict on the comment after the newer one. With it, a new push cancels the pull request's run in progress, and a cancelled run publishes and comments nothing.

Turn it off with `comment: "false"`. To delete what was stored, delete the `imitor-shots` branch.

The same comment is available locally. `imitor comment` prints it for the last run, with file paths in a table; `--image-base <url>` makes it use images at that address instead (the shot's path is added to the end, or before a `?query`). `--max-shots`, `--device`, `--scheme` and `--fail-on` change what it shows, and `--json` prints the data instead. `imitor publish-shots` is the push the action does; it refuses to run outside GitHub Actions unless given `--force`.

Nobody has seen this comment on a real pull request yet: the Markdown is tested, and publishing is tested against local Git repositories, but the action's publish and comment steps have not run on GitHub.

### EAS Workflows

```yaml
jobs:
  imitor:
    runs_on: linux-medium
    steps:
      - uses: eas/checkout
      - uses: eas/install_node_modules
      - run: npx playwright install --with-deps chromium
      - run: npx imitor gate

  build_ios:
    needs: [imitor]
    type: build
    params:
      platform: ios
      profile: production
```

This follows the EAS Workflows syntax but has not been run on EAS. Check how your plan counts custom jobs before relying on it.

## What it does not show

- Native navigation chrome, transitions and gestures
- Keyboard behaviour
- The phone's exact font rendering
- Entering and layout animations (the web lays these out differently)
- Anything behind a stand-in
- Platform-specific code paths: the build runs as `Platform.OS === "web"`
- Widgets, notifications, Live Activities, watch apps

## Roadmap

- Text size and language controls in the live preview (device, scheme and motion are there)
- "Pretend iOS / Android" mode so platform-specific styles render
- Android widget and notification renders on a plain JVM
- Bare React Native (no Expo) adapter
- Apple surfaces on a macOS runner

## Licence

MIT
