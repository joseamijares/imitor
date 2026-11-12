// The public demo's data: "fernwood", an invented plant-care app. Nothing here comes from a real app.
// Times are minutes before the build, so the site never looks stale. Shots point at demo/assets/shots/<screen>-<scheme>.png.

export const PACKAGE = { name: "fernwood", private: true };

export const CONFIG = {
  shims: { "expo-sqlite": "sqljs", "@shopify/react-native-skia": "skia", "expo-notifications": "inert" },
  devices: ["iphone-16"],
  schemes: ["light", "dark"],
  flows: [
    {
      name: "first-run",
      start: "/onboarding",
      steps: [
        { shot: "01-welcome" }, { tap: "Get started" },
        { shot: "02-your-space" }, { tap: "Bright indirect" }, { tap: "Continue" },
        { shot: "03-add-plant" }, { tap: "Boston fern" },
        { shot: "04-plant-details" }, { fill: { placeholder: "Name", value: "Fern" } }, { tap: "Continue" },
        { shot: "05-schedule" }, { tap: "Continue" },
        { shot: "06-reminders" }, { tap: "Not now" },
        { shot: "07-all-set" }, { tap: "Go to Today" },
        { shot: "08-today" },
      ],
    },
    {
      name: "log-a-watering",
      start: "/",
      steps: [
        { shot: "01-today" }, { tap: "Fern" },
        { shot: "02-plant-detail" }, { tap: "Log watering" },
        { shot: "03-log-sheet" }, { tap: "Add 250 ml" },
        { shot: "04-logged" },
      ],
    },
  ],
};

// Which screen image each shot shows, and its route. "skia" marks the shots where the Skia ring is a stand-in.
export const SHOTS = {
  "first-run": {
    "01-welcome": ["welcome", "/onboarding"], "02-your-space": ["your-space", "/onboarding/space"], "03-add-plant": ["add-plant", "/onboarding/plant"],
    "04-plant-details": ["plant-details", "/onboarding/details"], "05-schedule": ["schedule", "/onboarding/schedule"], "06-reminders": ["reminders", "/onboarding/reminders"],
    "07-all-set": ["all-set", "/onboarding/done"], "08-today": ["today", "/", "skia"],
  },
  "log-a-watering": {
    "01-today": ["today", "/", "skia"], "02-plant-detail": ["plant-detail", "/plants/fern"], "03-log-sheet": ["log-sheet", "/plants/fern/log"], "04-logged": ["logged", "/", "skia"],
  },
};

const by = {
  claude: { name: "Claude Code", kind: "agent" },
  cursor: { name: "Cursor", kind: "agent" },
  codex: { name: "Codex", kind: "agent" },
  ci: { name: "GitHub Actions", kind: "ci" },
  maya: { name: "Maya", kind: "person" },
  jonas: { name: "Jonas", kind: "person" },
};

const fail = (flow, step, stepConfig, message, screen, schemes = ["light", "dark"]) => ({ flow, step, stepConfig, message, screen, schemes });

// Newest first. ago: minutes before the build. skia: whether the Today ring is still drawn with Skia (a stand-in).
export const RUNS = [
  { ago: 4, minutes: 2, by: by.claude, branch: "feat/svg-ring", commit: "a41c9e2", subject: "Draw the watering ring with SVG instead of Skia", pr: 142, skia: false },
  { ago: 41, minutes: 2, by: by.claude, branch: "feat/svg-ring", commit: "5d0b7f1", subject: "Draw the watering ring with SVG instead of Skia", pr: 142, skia: true,
    pageErrors: [{ flow: "log-a-watering", scheme: "dark", message: "Warning: Each child in a list should have a unique \"key\" prop. Check the render method of `WateringHistory`." }] },
  { ago: 83, minutes: 3, by: by.ci, branch: "main", commit: "e7f2a90", subject: "Keep the Log watering label (#139)", pr: null, skia: true },
  { ago: 128, minutes: 2, by: by.cursor, branch: "fix/log-watering-label", commit: "c3b81d4", subject: "Keep the Log watering label", pr: 139, skia: true },
  { ago: 186, minutes: 2, by: by.codex, branch: "feat/water-now", commit: "9f4e6c3", subject: "Rename Log watering to Water now", pr: 138, skia: true,
    failures: [fail("log-a-watering", 4, { tap: "Log watering" }, "locator.click: Timeout 10000ms exceeded.", "plant-detail-renamed")] },
  { ago: 302, minutes: 3, by: by.ci, branch: "main", commit: "2b6d0e8", subject: "Show the next watering date on plant cards (#137)", pr: null, skia: true },
  { ago: 371, minutes: 2, by: by.maya, branch: "feat/next-watering", commit: "71ae3f5", subject: "Show the next watering date on plant cards", pr: 137, skia: true },
  { ago: 1322, minutes: 2, by: by.claude, branch: "feat/room-filter", commit: "d58c2a7", subject: "Filter plants by room", pr: 135, skia: true },
  { ago: 1455, minutes: 2, by: by.cursor, branch: "feat/reminders", commit: "4ce07b1", subject: "Ask for reminders during first run", pr: 134, skia: true },
  { ago: 1580, minutes: 3, by: by.jonas, branch: "main", commit: "b90d4f6", subject: "Tidy the onboarding copy", pr: null, skia: true, seen: true,
    failures: [fail("first-run", 9, { fill: { placeholder: "Name", value: "Fern" } }, "locator.fill: Timeout 10000ms exceeded.", "plant-details", ["dark"])] },
  { ago: 1704, minutes: 3, by: by.ci, branch: "main", commit: "0e3a7c2", subject: "Add the Plants tab (#131)", pr: null, skia: true },
  { ago: 1938, minutes: 2, by: by.codex, branch: "feat/plants-tab", commit: "6a1f9d3", subject: "Add the Plants tab", pr: 131, skia: true },
];

// Screenshots and videos taken on request (imitor screenshot / flow / record and their MCP tools), newest first.
// file: the capture's name under captures/; image: the screen it shows (a video names its file in demo/assets/videos).
export const CAPTURES = [
  { ago: 6, by: by.claude, kind: "screenshot", file: "today-iphone-16-dark", image: "today-dark", route: "/", scheme: "dark" },
  { ago: 7, by: by.claude, kind: "screenshot", file: "today-iphone-16-light", image: "today-light", route: "/", scheme: "light" },
  { ago: 11, by: by.claude, kind: "video", file: "log-a-watering-iphone-16-light", video: "log-a-watering-light", flow: "log-a-watering", scheme: "light", seconds: 2.4 },
  { ago: 44, by: by.claude, kind: "screenshot", file: "plant-fern-iphone-16-dark", image: "plant-detail-dark", route: "/plants/fern", scheme: "dark" },
  { ago: 131, by: by.cursor, kind: "screenshot", file: "plant-fern-iphone-16-light", image: "plant-detail-light", route: "/plants/fern", scheme: "light" },
  { ago: 190, by: by.codex, kind: "screenshot", file: "log-a-watering-02-plant-detail-iphone-16-light", image: "plant-detail-renamed-light", route: "/plants/fern", flow: "log-a-watering", scheme: "light" },
  { ago: 191, by: by.codex, kind: "screenshot", file: "log-a-watering-01-today-iphone-16-light", image: "today-standin-light", route: "/", flow: "log-a-watering", scheme: "light", standIns: ["skia"] },
  { ago: 380, by: by.maya, kind: "screenshot", file: "plants-iphone-16-light", image: "plants-light", route: "/plants", scheme: "light" },
  { ago: 1330, by: by.claude, kind: "screenshot", file: "plants-iphone-16-dark", image: "plants-dark", route: "/plants", scheme: "dark" },
  { ago: 1460, by: by.cursor, kind: "video", file: "first-run-iphone-16-dark", video: "first-run-dark", flow: "first-run", scheme: "dark", seconds: 3.8 },
  { ago: 1462, by: by.cursor, kind: "screenshot", file: "onboarding-reminders-iphone-16-light", image: "reminders-light", route: "/onboarding/reminders", scheme: "light" },
];

// MCP tool calls, newest first: [minutes ago, who, tool, text, ok]
export const ACTIVITY = [
  [4, by.claude, "imitor_read_problems", "read the last run: 0 problems, 0 stand-ins"],
  [6, by.claude, "imitor_screenshot", "took a screenshot of / on iphone-16"],
  [7, by.claude, "imitor_screenshot", "took a screenshot of / on iphone-16"],
  [9, by.claude, "imitor_build", "built the preview in 48 s"],
  [11, by.claude, "imitor_record_video", "recorded log-a-watering (2.4 s)"],
  [13, by.claude, "imitor_run_flow", "ran log-a-watering, 7 of 7 steps passed"],
  [40, by.claude, "imitor_read_problems", "read the last run: 1 problem, 1 stand-in"],
  [44, by.claude, "imitor_screenshot", "took a screenshot of /plants/fern on iphone-16"],
  [46, by.claude, "imitor_build", "built the preview in 51 s"],
  [52, by.claude, "imitor_describe", "read the setup: 2 flows, built"],
  [126, by.cursor, "imitor_run_flow", "ran log-a-watering, 7 of 7 steps passed"],
  [131, by.cursor, "imitor_screenshot", "took a screenshot of /plants/fern on iphone-16"],
  [133, by.cursor, "imitor_build", "built the preview in 47 s"],
  [135, by.cursor, "imitor_read_problems", "read the last run: 1 problem, 1 stand-in"],
  [184, by.codex, "imitor_read_problems", "read the last run: 2 problems, 1 stand-in"],
  [188, by.codex, "imitor_run_flow", "ran log-a-watering, 3 of 7 steps passed; failed at step 4", false],
  [190, by.codex, "imitor_screenshot", "took a screenshot of /plants/fern on iphone-16, but step 4 failed on the way"],
  [193, by.codex, "imitor_build", "built the preview in 55 s"],
  [195, by.codex, "imitor_describe", "read the setup: 2 flows, built"],
  [1318, by.claude, "imitor_read_problems", "read the last run: 0 problems, 1 stand-in"],
  [1330, by.claude, "imitor_screenshot", "took a screenshot of /plants on iphone-16"],
  [1333, by.claude, "imitor_open_preview", "opened the preview at /plants"],
  [1336, by.claude, "imitor_build", "built the preview in 49 s"],
  [1452, by.cursor, "imitor_read_problems", "read the last run: 0 problems, 1 stand-in"],
  [1460, by.cursor, "imitor_record_video", "recorded first-run (3.8 s)"],
  [1462, by.cursor, "imitor_screenshot", "took a screenshot of /onboarding/reminders on iphone-16"],
  [1466, by.cursor, "imitor_build", "built the preview in 52 s"],
  [1470, by.cursor, "imitor_describe", "read the setup: 2 flows, built"],
  [1935, by.codex, "imitor_run_flow", "ran first-run, 17 of 17 steps passed"],
  [1941, by.codex, "imitor_build", "built the preview in 58 s"],
  [1944, by.codex, "imitor_describe", "read the setup: 2 flows, not built yet"],
];
