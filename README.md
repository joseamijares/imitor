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

- Live preview shell: the app in a device frame with toggles for device, scheme, text size and language
- "Pretend iOS / Android" mode so platform-specific styles render
- Real Skia drawing on web (CanvasKit) instead of an empty box
- Seeded data states, so flows don't have to click through setup
- Android widget and notification renders on a plain JVM
- Bare React Native (no Expo) adapter
- Apple surfaces on a macOS runner

## Licence

MIT
