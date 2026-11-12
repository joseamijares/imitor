Imitor is two things: open-source software you run yourself, and Imitor Cloud, a hosted service at app.imitor.dev that is invite-only while it is in development. This page says what each collects, where it goes and how long it stays. {{operator}} operates this website and Imitor Cloud. Questions and requests: {{contact}}.

## The software you run

The Imitor CLI, the MCP server and the review interface (`imitor app`) run on your own machine, in your CI or in your coding agent's environment. They keep everything in your app's output folder and send nothing to Imitor. Data leaves your machine only when you choose to send it:

- `imitor push` uploads a run to the Imitor Cloud address you give it.
- `imitor export` writes a static site that you host yourself.
- The GitHub Action can post a comment with shots to your own pull request.

## This website

imitor.dev is a static site. It has no analytics, no advertising and no cookies. It keeps your light or dark theme choice, and in the demo the problems you marked as seen, in your browser's local storage, which never leaves your device. The site loads its fonts from Google Fonts, so Google receives your IP address and browser details when the fonts load. The site is hosted by Vercel, which keeps standard request logs.

## Imitor Cloud

### What it stores

- **Your account:** the email address, name and account id that Google returns when you sign in. Sign-in asks Google only for `openid`, `email` and `profile`.
- **Sessions:** a random sign-in token in a cookie on app.imitor.dev. The service keeps only a hash of it.
- **Projects and access keys:** project names, who belongs to them, and a hash of each key. The key itself is shown once and not stored.
- **Runs you upload:** each run's data (flows, steps, shots, problems, the commit and branch), its screenshots and videos, and the agent activity that goes with it. Values a flow types into a field, such as passwords, are replaced with dots before upload and again on arrival. The service never stores or runs your app's code.
- **An audit log:** sign-ins and access-key creation, use and revocation. Repeated failed admin sign-ins record the address they came from.

### Why

Only to run the service: to sign you in, to keep your projects separate from everyone else's, and to show you your runs. Nothing is sold, used for advertising or used to train models.

### Where

- Vercel runs the service.
- Neon (PostgreSQL) holds accounts, projects and run data.
- Cloudflare R2 holds screenshots and videos. They are reached only through links that expire after five minutes.
- Google handles sign-in.

These providers may process data outside your country.

### How long

- Runs: the newest 50 per project, and none older than 30 days. Uploads that are never finished are deleted after 24 hours.
- Sessions: they end after 30 days without use, and after 90 days at most.
- Your account: until you ask for it to be deleted.

### Your choices

You can ask to see, export or delete your account, a project or a run by writing to {{contact}}. A project can be exported in the same format as `imitor export`. Deleting your account deletes your sessions and your access to every project. Projects you own are deleted with their runs unless you ask otherwise.

## Changes

If this page changes, the new version is published here with a new date. Changes that affect data you have already uploaded will be announced to Imitor Cloud users by email first.

Last updated: 12 November 2026.
