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
- **Projects and access keys:** project names, who belongs to them (including the addresses owners add, before those people first sign in), and a hash of each key. The key itself is shown once and not stored.
- **Runs you upload:** each run's data (flows, steps, shots, problems, the commit and branch), its screenshots and videos, and, if the uploader sends them, the agent activity and captures that go with it. Values a flow types into a field, such as passwords, are replaced with dots before upload and again on arrival. The service never stores or runs your app's code.
- **An audit log:** sign-ups, sign-ins, project creation, who was added to or removed from a project, access-key creation and revocation, run uploads and removals, and the emails the service sent, could not send or held back under its daily limits, with the address each was for. Repeated failed admin sign-ins record the address they came from.

### Why

Only to run the service: to sign you in, to keep your projects separate from everyone else's, to show you your runs, to email you when a project owner adds you to a project, and to tell a project's owners when another owner creates or revokes one of its access keys. Nothing is sold, used for advertising or used to train models.

### Where

- Vercel runs the service.
- Neon (PostgreSQL) holds accounts, projects and run data.
- Vercel Blob, in a private store, holds screenshots and videos. They are reached only through links that expire after five minutes.
- Google handles sign-in.
- Resend sends the service's email. When an owner adds someone to a project, Resend receives the message: that person's address, the project's name and a link to it, and the name of the owner who added them (or their address, when they have no name). When an owner creates or revokes an access key, Resend receives a message to each of the project's other owners: their address, the project's name, the key's name, a link to the project's settings, and the name (or address) of the owner who did it. The key itself is never sent.

These providers may process data outside your country.

### How long

- Runs: the newest 50 per project, and none older than 30 days. Uploads that are never finished are deleted after 24 hours.
- Sessions: they end after 30 days without use, and after 90 days at most.
- Your account: until you ask for it to be deleted.

### Your choices

You can ask to see, export or delete your account, a project or a run by writing to {{contact}}. An export is a copy of the stored files: each run's data, screenshots and videos. Deleting your account deletes your sessions and your access to every project. Projects you own are deleted with their runs unless you ask otherwise.

## Changes

If this page changes, the new version is published here with a new date. Changes that affect data you have already uploaded are also announced in the repository on GitHub before they take effect, and may be emailed to the address on your account.

Last updated: 13 November 2026.
