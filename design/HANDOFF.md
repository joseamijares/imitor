# Imitor design handoff

Status: design complete for the v1 scope, not built. Identity: Signal. Logo: Echo. Dated 11 November 2026.

The designs live in the Paper file "Imitor". This document is the written half of the handoff: tokens, component sizes, the screen list, and what is not designed. `design/tokens.css` has the tokens as CSS custom properties; `design/logo/` has the logo files; `design/paper-kit.mjs` is the script kit the screens were drawn with and is the most exact reference for any component's markup and sizes.

## How the Paper file is organised

| Page | Contents |
| --- | --- |
| Start here | Cover, page index, build rules, what is not designed |
| Foundations | Colour tokens (dark and light), type scale, spacing, radii, layout measures, logo |
| Components | Every control with its size, in both themes |
| Screens — Dark | Ten screens at 1440 × 900, numbered 01 to 10 |
| Screens — Light | The same ten screens in the light theme |
| Mobile | Two screens at 390 × 844, dark and light |
| Archive · … | Logo rounds, the identity vote and earlier directions. Reference only |

The same colours, type sizes, radii and spacing exist as design tokens inside the Paper file. Colour tokens there are named `--color-dark-*` and `--color-light-*`; in `tokens.css` they are one set, `--color-*`, that switches with the theme.

## Rules

1. **Yellow means imitated.** Anything stood-in or imitated is drawn dashed in the accent. Genuine things are solid. Green means genuine or passed, red means failed, and neither is used for anything else.
2. **Both themes ship.** Follow the system setting and offer a manual switch. On light grounds yellow is only ever a fill; text and lines that mean "imitated" use the darker gold (`--color-acc`, `--color-warn`) so they pass contrast.
3. **Mono is for data:** hashes, commands, sizes, counts and step numbers. Everything else is Geist. Sentence case throughout; no uppercase labels.
4. **Standard controls.** Buttons, segmented controls, switches, selects and tables behave as the platform's own.
5. **The sample data is invented.** "fernwood", its pull requests, agents and keys are placeholders.

## Logo

The logo is the Echo app icon: a dark rounded tile holding a solid slab with its dashed yellow copy hovering above. It is the same on dark and light grounds, and there is no separate flat mark. The dashed line is 3% of the icon's width at every size, so render the icon at its final size (`design/logo/logos.mjs` generates it; `imitor-icon-120.svg`, `-32` and `-16` are pre-rendered). The wordmark is "Imitor" in Instrument Serif Italic (400, -0.02em tracking), in the primary text colour, set 0.35 × the icon's width to its right, with a font size of about 0.85 × the icon's height. Instrument Serif is used for the wordmark only, never for interface text.

## Colour

| Token | Dark | Light | Use |
| --- | --- | --- | --- |
| `--color-bg` | `#0B0B0C` | `#FFFFFF` | App ground |
| `--color-side` | `#0B0B0C` | `#FAFAF8` | Sidebar ground |
| `--color-panel` | `#141415` | `#F4F4F1` | Inputs, code blocks, chips |
| `--color-raised` | `#1B1B1D` | `#ECECE8` | Disabled fills, neutral avatars |
| `--color-line` | `#222224` | `#E6E6E1` | Hairlines; selected row and nav fill |
| `--color-line-2` | `#303033` | `#D2D2CC` | Control borders; selected segment; switch off |
| `--color-t-1` | `#F5F5F2` | `#0B0B0C` | Primary text |
| `--color-t-2` | `#A8A8A3` | `#55554F` | Secondary text |
| `--color-t-3` | `#85857F` | `#6F6F68` | Meta text only (never essential) |
| `--color-acc` | `#FFD60A` | `#8F6B00` | Accent text and strokes |
| `--color-acc-bg` | `#FFD60A` | `#FFD60A` | Accent fill: primary button, switch on |
| `--color-on-acc` | `#0B0B0C` | `#0B0B0C` | Text and icons on accent fill |
| `--color-acc-tint` | `#262105` | `#FFF8D6` | Accent pill fill |
| `--color-acc-line` | `#5C4E0A` | `#EAD27A` | Accent pill border |
| `--color-warn` | `#FFD60A` | `#8F6B00` | Stand-in text and dashed strokes |
| `--color-ok` | `#4CB782` | `#178A52` | Genuine, passed |
| `--color-bad` | `#FF5C5C` | `#D92D20` | Failed |
| `--color-in-device` | `#B58900` | `#B58900` | Stand-in outline drawn over the app |
| `--color-ghost` | `#FFD60A` | `#C9A400` | Dashed ghost copy behind the device |

## Type

| Role | Family | Size / line | Weight | Tracking |
| --- | --- | --- | --- | --- |
| Onboarding title | Geist | 28 / 34 | 600 | -0.03em |
| Large title | Geist | 20 / 26 | 600 | -0.02em |
| Section title | Geist | 16 / 22 | 600 | -0.01em |
| Page title, emphasis | Geist | 14 / 20 | 600 | -0.01em |
| Body and controls | Geist | 13 / 18 | 400 / 500 | 0 |
| Secondary | Geist | 12 / 16 | 400 / 500 | 0 |
| Meta, code, numbers | Geist Mono | 11 / 16 | 400 | 0 |

## Radii, spacing, layout

| Radius | px | Use |
| --- | --- | --- |
| `--radius-chip` | 5 | Commit chips, key chips |
| `--radius-control` | 6 | Buttons, rows, nav items, fields |
| `--radius-segment` | 7 | Segmented control shell |
| `--radius-block` | 8 | Code blocks, tables, panels |
| `--radius-pill` | 10 | Status pills |
| `--radius-device` | 50 | Device frame at 330px wide |

Spacing steps, px: 2, 4, 6, 8, 10, 12, 16, 24, 32, 48.

| Measure | px |
| --- | --- |
| Sidebar width | 220 |
| Page header height | 48 |
| Filter or tab row | 40 to 44 |
| Content side padding | 24 |
| Runs row | 44 |
| Tool row (Agents) | 36 |
| Flow step row (rail) | 28 |
| Problem row | 56 |
| Live preview: flows rail | 232 |
| Live preview: inspector | 320 |
| Live preview: device | 330 × 704 (84% of 393 × 852) |
| Onboarding column | 560, 720 or 760 |
| Phone layout | 390 wide, 16 side padding, 44 minimum touch target |

## Components

| Component | Size | Notes |
| --- | --- | --- |
| Button | height 30, padding 6 × 12, radius 6, text 13 / 500 | Primary: accent fill with `--color-on-acc` text. Secondary: panel fill, `--color-line-2` border. Ghost: text only. Disabled: `--color-raised` fill, `--color-t-3` text |
| Status mark | 14 × 14 | Check on green: passed or genuine. Dashed square in accent: stand-in. Cross on red: failed. Arc in accent: in progress. Grey ring with dash: not shown or seen |
| Pill | height 20, padding 2 × 7, radius 10, text 11 / 500 | Tones: ok, warn (stand-in), bad, acc, neutral. Each has a tint fill and a line border |
| Chip | mono 11, padding 2 × 6, radius 5 | Commit hashes and keys |
| Segmented control | height 30, segment padding 4 × 12, radius 7 outer, 5 inner | Selected segment: `--color-line-2` fill, `--color-t-1` text |
| Switch | 30 × 18, knob 14 | On: accent fill, `--color-on-acc` knob. Off: `--color-line-2` track |
| Field and select | height 30, padding 0 × 10, radius 6, text 13 | Panel fill, `--color-line` border; select adds a 12px chevron |
| Code block | mono 12 / 20, padding 12 × 14, radius 8 | Copy icon top right |
| Navigation item | height 30, padding 0 × 8, radius 6, icon 16 | Selected: `--color-line` fill, text 500 |
| Flow step row | height 28, mono number 11 in a 26px slot, 6px marker | Marker shows the step contains a stand-in |
| Screen thumbnail | 132 × 286 in grids, 96 × 208 small | Failed step: 1px red outline. Not reached: dashed placeholder |

## Screens and routes

Route names are a proposal; nothing is built.

| # | Screen | Suggested route | Notes |
| --- | --- | --- | --- |
| 01 | Onboarding: Add Imitor | `/onboarding` | Agent-first: one prompt to paste; waits for the first run |
| 02 | Onboarding: Stand-ins | `/onboarding/stand-ins` | Detected native modules and the stand-in for each |
| 03 | Onboarding: First run | `/onboarding/first-run` | Result summary; leads to Agents or the run |
| 04 | Runs | `/runs` | Home. One row per run; status, pull request, branch, who started it, shots, problems, commit, time |
| 05 | Run: Shots | `/runs/:id/shots` | Shots grouped by flow; stand-in, failed and not-reached tiles |
| 06 | Captures | `/captures` | Screenshots and videos from agents and people |
| 07 | Agents | `/agents` | Connect commands, tool switches, connected agents, recent activity |
| 08 | Live preview | `/runs/:id/live` | Full-width, no sidebar: flows rail, device stage with ghost copy, fidelity inspector and controls |
| 09 | Problems | `/problems` | List and detail; “Copy for agent” exports open problems as text |
| 10 | Settings | `/settings` | General, Preview defaults, Access keys, Danger zone |
| M1 | Run on a phone | `/runs/:id/live` | The preview fills the width; no device frame |
| M2 | Runs on a phone | `/runs` | Two-line rows and a bottom tab bar |

## Not designed

- Hover, focus, pressed, loading, empty and error states.
- Any width between 390 and 1440. There is no tablet layout.
- Phone versions of every screen except a run and the runs list.
- Settings sections Stand-ins, Devices, Flows and Notifications (listed in the sub-navigation, not drawn).
- The run's Problems and Captures tabs as separate screens.

## Known inconsistencies in the sample data

- Runs shows 0 problems for #117 and #118, while Problems lists a seen stand-in problem for each.
- The "First run" flow has 8 steps in most screens; onboarding step 3 labels its last thumbnail "09 Today".
