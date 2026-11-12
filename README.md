# Imitor

See a React Native / Expo app's UI without opening a simulator.

Imitor builds your app for the web, swaps the native-only parts for stand-ins,
drives it in headless Chromium, and writes a page of screenshots. It runs on any
Linux box, CI runner or cloud agent session: no Mac, no emulator, no device.

It is an imitation, not a simulator. It shows layout, copy, colours, states and
flows. It does not replace a final check on a real phone; it shrinks what that
check has to find.

Status: early (v0). Tried on two Expo SDK 54 apps so far.

Site: [imitor.vercel.app](https://imitor.vercel.app) · Live demo: [imitor-demo.vercel.app](https://imitor-demo.vercel.app)

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

2. Wrap your Metro config: keep building `config` as you do now (`getDefaultConfig`, Sentry's `getSentryExpoConfig`, your transformers) and wrap what you export. It does nothing unless Imitor is running the build.

   ```js
   // metro.config.js
   module.exports = require("imitor/metro").withImitor(config);
   ```

   Add the output folder (`preview/` by default) to `.gitignore`.

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

   `imitor build` runs `expo export --platform web` with your environment, so `EXPO_PUBLIC_*` values are inlined into the build as usual. If the app needs them to start (a backend URL, a public key), pass harmless placeholders for that command rather than real ones, for example `EXPO_PUBLIC_API_URL=http://127.0.0.1:9 npx imitor build`; the app then sees an unreachable backend.

Other commands: `imitor build`, `imitor shoot` (reuse the last build), `imitor serve` (click around by hand), `imitor app` (the review interface), `imitor export` (the interface as a static site).

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

A public demo of the interface, with invented data for an invented plant-care app ("fernwood"), runs at [imitor-demo.vercel.app](https://imitor-demo.vercel.app). It is built from `demo/` with `npm run demo` (it writes `demo/site/`), and `demo/vercel.json` deploys it: import this repository into Vercel with `demo` as the root directory. The root `vercel.json` deploys the public site in `site/` (`npm run site`), whose How to use and For agents pages are generated from this README.

## Publish a run

```bash
npx imitor export                                  # writes preview/site/
npx imitor export --out review-site                # or anywhere else
npx imitor export --preview-url https://my-preview.example.com
```

`imitor export` writes the interface and its data as plain static files, for any static host (Vercel, Netlify, GitHub Pages, an S3 bucket): the interface, every API response as a `.json` file, and the shots, failure screenshots and captures those responses point to (nothing else from the output folder). It is read-only: marking a problem seen is kept in each visitor's browser, and nothing can start a run. The live preview needs a running build, so it is left out and the Live page says so, unless `--preview-url` names a deployed web build of the app. Serve the folder at the root of a domain; it includes a `404.html`, a `vercel.json` and a `_redirects` file so deep links like `/runs/<id>` load the interface.

The site holds the app's screenshots and videos. Publish it only where those may be seen, for example a team-only or password-protected deployment, not a public URL for an unreleased app.

## Stand-ins

| Value | Replaces | Behaviour |
| --- | --- | --- |
| `sqljs` | `expo-sqlite` | Real SQLite (sql.js, wasm) in memory, including the synchronous API. Mirrored to `sessionStorage` so a reload keeps data. |
| `skia` | `@shopify/react-native-skia` | `<Canvas>` keeps its box but draws nothing. Shots containing one are labelled in the report. |
| `inert` | any module | Every export exists and does nothing. Components render nothing. |
| `./path/to/file.js` | any module | Your own stand-in. Inside it, `require` of the module it replaces gets the real one, so a stand-in can re-export most of a package and replace one function (for example a backend client's `createClient`, to show signed-in screens with invented data). |

A key matches the module name as the app imports it (`"some-sdk"` also covers `"some-sdk/sub/path"`), before path aliases are resolved.

Stand-ins only apply to the web build Imitor makes (`IMITOR=1`). Your iOS and Android builds are untouched.

## Flow steps

| Step | Meaning |
| --- | --- |
| `{ "shot": "name" }` | Screenshot. Add `"fullPage": true` for the whole scroll height of the page. Most React Native Web screens scroll inside a `ScrollView`, not the page, and then get the viewport only: use `scroll` steps and more shots. |
| `{ "tap": "Visible text" }` | Tap by exact text. Also `{ "tap": { "testId" \| "label" \| "text" \| "css": ... } }`. |
| `{ "fill": { "placeholder" \| "label" \| "testId": ..., "value": "..." } }` | Type into a field. |
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

Other config keys: `locale` (default `en-US`), `timezone` (`UTC`), `settleMs` (`600`),
`reducedMotion` (`true`), `out` (`preview`). Devices: `iphone-16`, `iphone-se`,
`pixel-9`, `small-android`, or `{ "name", "width", "height", "scale" }`.

## Gate your native builds

A native build costs money and minutes. `imitor gate` runs first and blocks the build when the app's UI is already broken on the web imitation.

```bash
npx imitor gate
```

It builds the preview, runs every flow, prints a verdict and exits non-zero when the run should block. `--fail-on` sets how strict it is:

| `--fail-on` | Blocks when |
| --- | --- |
| `flows` (default) | A flow could not be completed |
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

On `pull_request` events the action also posts the run on the pull request as one comment, so a reviewer sees the shots without downloading anything, on a phone too. The comment has the verdict, a line of counts, each failed flow with the step it stopped at, the error and the screenshot of where it stopped, and then the shots of each flow in step order as small images (tap one for full size), each with its step name and a note when it contains a stand-in. It shows one device and scheme (the first configured) and at most `max-shots` shots per flow (default 12), and says how many more are in the full report. On every push the same comment is updated in place (it is found by a hidden `<!-- imitor-comment -->` line); the action never posts a second one.

| Input | Default | |
| --- | --- | --- |
| `comment` | `"true"` | `"false"` turns the comment off. Ignored on events other than `pull_request`. |
| `shots-branch` | `imitor-shots` | The branch that holds the images |
| `max-shots` | `12` | Most shots per flow in the comment |

Where the images live: GitHub only shows images in a comment on a private repository when they come from somewhere the viewer can already read, so the action commits the run's screenshots (and its `manifest.json`) to a separate branch of the same repository, `imitor-shots`, under `pr-<number>/<short commit>/`, using the job's own `GITHUB_TOKEN`. No other service and no secret is involved. The screenshots of your app are therefore stored in your repository and stay exactly as private as the repository is: anyone who can read the repository can open them. On a private repository viewers must be signed in to GitHub with read access to see the images (GitHub's rule for images in comments; the links have the form `https://github.com/<owner>/<repo>/blob/imitor-shots/<path>?raw=true`). Whether the GitHub mobile app shows them has not been checked yet.

The branch has no shared history with your code and never touches your working branch. On every push it keeps only the newest 3 commits' folders per pull request and is rewritten as a single commit, so it does not grow with history (Git hosts can still keep unreferenced old images for a while before cleaning them up). Folders of closed pull requests stay until removed; deleting the branch at any time is safe, the next run creates it again.

The workflow needs the `permissions:` block above: `contents: write` to push the branch and `pull-requests: write` for the comment. Without them (and always for a pull request from a fork, whose token is read-only) the action prints a notice naming the missing permission and carries on: the comment falls back to file paths, or is skipped, and the job's result is still the gate's.

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
- Real Skia drawing on web (CanvasKit) instead of an empty box
- Seeded data states, so flows don't have to click through setup
- The review interface (runs, captures, problems, agents), designed in `design/`
- Android widget and notification renders on a plain JVM
- Bare React Native (no Expo) adapter
- Apple surfaces on a macOS runner

## Licence

MIT
