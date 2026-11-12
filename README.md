# Imitor

See a React Native / Expo app's UI without opening a simulator.

Imitor builds your app for the web, swaps the native-only parts for stand-ins,
drives it in headless Chromium, and writes a page of screenshots. It runs on any
Linux box, CI runner or cloud agent session: no Mac, no emulator, no device.

It is an imitation, not a simulator. It shows layout, copy, colours, states and
flows. It does not replace a final check on a real phone; it shrinks what that
check has to find.

Status: early (v0). Tested on one Expo SDK 54 app so far.

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

1. Install (not on npm yet):

   ```bash
   npm i -D github:joseamijares/imitor playwright
   npx playwright install chromium
   ```

2. Wrap your Metro config. It does nothing unless Imitor is running the build.

   ```js
   // metro.config.js
   module.exports = require("imitor/metro").withImitor(config);
   ```

3. Add `imitor.config.json` next to `package.json`:

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

Other commands: `imitor build`, `imitor shoot` (reuse the last build), `imitor serve` (click around by hand).

## For agents

Imitor is built to be driven by coding agents. Connect it as an MCP server from the app's folder:

```bash
claude mcp add imitor -- npx imitor mcp
```

Any MCP client works the same way: the command is `npx imitor mcp`, over stdio.

| Tool | What it does |
| --- | --- |
| `imitor_describe` | Lists the flows, devices and stand-ins configured, and whether a build exists |
| `imitor_build` | Builds the web preview of the app as it is on disk |
| `imitor_screenshot` | Takes one screenshot and returns the image. Reach the screen by `route`, by `flow`, or with inline `steps` |
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

Screenshots and videos from these land in `preview/captures/`. Each call starts from a fresh, empty app state, so use a flow (or inline steps) to get past setup screens.

## The app

`npx imitor app` starts the local review interface, where a person looks over what agents and CI produced: runs and their shots, captures, problems, and which agents are connected.

```bash
npx imitor app            # http://127.0.0.1:4173 (or --port n)
```

It reads plain files from the output folder: `runs/` (the last 50 full runs), `captures/index.jsonl`, `activity.jsonl` (one line per MCP tool call) and `state.json`, which the CLI and the MCP server write as they work. It binds to 127.0.0.1 only, so it is reachable from this machine and nowhere else.

The live preview (`/live`, or Live on a run) shows the built app itself, running in a device frame. `imitor app` serves the build on a second port of its own, so the app's router and reloads work as at a site root, and adds a small driver script to its pages so the interface can replay a flow inside the frame up to the shot you pick: taps, fills and waits, as the runs do in headless Chromium. Reload starts the app again from an empty state (stored data cleared).

The Appearance and Reduce motion controls rely on an override that `imitor build` adds to every page of the build: with `?imitor-scheme=dark|light` or `?imitor-motion=reduce|no-preference` in the address, the app's `matchMedia` answers `prefers-color-scheme` and `prefers-reduced-motion` accordingly (it is kept for the browser tab's session; `auto` clears it). Builds made before this have no override: the live preview says so and the app follows the computer's settings until you run `imitor build` again. An app that ignores the system scheme (for example `userInterfaceStyle: "light"` and no `useColorScheme`) looks the same in both.

The iPhone status bar and the Android camera are drawn above the app, not over it: the web build has no safe-area insets, so drawing them on top would hide what the shots show.

## Stand-ins

| Value | Replaces | Behaviour |
| --- | --- | --- |
| `sqljs` | `expo-sqlite` | Real SQLite (sql.js, wasm) in memory, including the synchronous API. Mirrored to `sessionStorage` so a reload keeps data. |
| `skia` | `@shopify/react-native-skia` | `<Canvas>` keeps its box but draws nothing. Shots containing one are labelled in the report. |
| `inert` | any module | Every export exists and does nothing. Components render nothing. |
| `./path/to/file.js` | any module | Your own stand-in. |

Stand-ins only apply to the web build Imitor makes (`IMITOR=1`). Your iOS and Android builds are untouched.

## Flow steps

| Step | Meaning |
| --- | --- |
| `{ "shot": "name" }` | Screenshot. Add `"fullPage": true` for the whole scroll height. |
| `{ "tap": "Visible text" }` | Tap by exact text. Also `{ "tap": { "testId" \| "label" \| "text" \| "css": ... } }`. |
| `{ "fill": { "placeholder" \| "label" \| "testId": ..., "value": "..." } }` | Type into a field. |
| `{ "goto": "/route" }` | Navigate (full reload). |
| `{ "waitFor": "Visible text" }`, `{ "wait": 500 }`, `{ "scroll": 400 }` | Wait or scroll. |

Each flow runs in a fresh browser, once per device and colour scheme. A failed
step is recorded in the report with a screenshot of where it stopped, and the
command exits non-zero.

Other config keys: `locale` (default `en-US`), `timezone` (`UTC`), `settleMs` (`600`),
`reducedMotion` (`true`), `out` (`preview`). Devices: `iphone-16`, `iphone-se`,
`pixel-9`, `small-android`, or `{ "name", "width", "height", "scale" }`.

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
- Real Skia drawing on web (CanvasKit) instead of an empty box
- Seeded data states, so flows don't have to click through setup
- The review interface (runs, captures, problems, agents), designed in `design/`
- Android widget and notification renders on a plain JVM
- Bare React Native (no Expo) adapter
- Apple surfaces on a macOS runner

## Licence

MIT
