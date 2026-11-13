# Imitor Cloud

A place for finished Imitor runs, so a team can look at the screens an agent or CI produced without the machine that
made them. Agents and CI upload a run with `npx imitor push`; people sign in with Google and read it in the same
interface `imitor app` shows locally.

**Status: in development, not hosted anywhere yet.** What exists: the upload API, Google sign-in with an allowlist,
projects and upload keys for people, the review interface in cloud mode, Postgres and S3-compatible storage, a Node
server for self-hosting and a Vercel adapter. None of it has run against a real Google client, bucket or Vercel
deployment yet (see [Not verified yet](#not-verified-yet)).

## What it is, and what it will not do

- **Receive-only.** It stores runs that were built and shot elsewhere. It never builds, installs or runs uploaded
  code, and it never serves uploaded files from its own origin: an upload may only hold PNG, JPEG, WebM and JSON files
  (25 MB each, 300 MB per run), the content type is signed into each upload URL, and the interface gets each file
  through a 302 to a storage URL that lasts 5 minutes.
- **Write-only keys.** Each project has upload keys (`imk_...`). A key can register and complete runs in its own
  project and nothing else: it cannot read, list or delete. Only a SHA-256 of a key is stored; the key is shown once,
  when an owner makes it.
- **People sign in; nobody else gets in.** Google sign-in admits an address on `IMITOR_ALLOWED_EMAILS` the first
  time and binds that Google account to the user; after that the account (Google's `sub`), not the address, decides.
  Everyone else sees "This Imitor Cloud is invite-only", and nothing is created for them. A person sees only the
  projects they are a member of; every route under `/p/<project>/` checks it, and run ids are not access control.
- **Files go straight to storage.** The API answers with presigned PUT URLs (S3-compatible storage or a private
  Vercel Blob store), valid for 15 minutes; the bytes never pass through the API. The server picks every storage key
  (`<projectId>/<runId>/<path>`); a client never does. On S3 each URL only takes the declared size, content type and
  SHA-256; on Blob it takes at most the declared size, only the declared content type, and never overwrites an
  existing object (Blob cannot pin a checksum, so a checked file must not be replaceable). `complete` checks size,
  content type and SHA-256 again on every stored object before a run is ready. A URL cannot be revoked: on S3 one
  issued earlier can still write its declared bytes until it expires, also after `complete` or after its run was
  pruned. `complete` re-verifies
  whatever is stored when it runs; an object written for a run that is already gone belongs to no run, is never
  served, and stays in the bucket until removed by hand.
- **Typed values stay on the machine.** `imitor push` blanks fill values (passwords, emails) before anything is sent,
  and the server blanks any it still finds.
- **Retention.** The newest 50 ready runs of a project, none older than 30 days. At most 5 unfinished uploads per
  project; one not completed within 24 hours is dropped with its files. Enforced on every register and complete, and
  daily for every project by the retention call (`CRON_SECRET`). When storage fails to delete a pruned run's files,
  the run is still removed, the error is logged, and the deletion is retried later.
- **Portable.** Plain Postgres (`DATABASE_URL`) and any S3-compatible store; handlers are web-standard
  `Request -> Response`, so it runs on a plain Node server or on Vercel.

## Routes

For agents and CI (a project key):

| Route | |
| --- | --- |
| `POST /v1/runs` | `Authorization: Bearer imk_...`. Body: [`src/schema/run-upload.v1.json`](../src/schema/run-upload.v1.json). `201` with `{ id, status, uploads: [{ path, method, url, headers }], complete }`. Idempotent on the run's folder name within the project: a repeat answers `200` with the same `id` and upload URLs only for files not stored yet. |
| `POST /v1/runs/:id/complete` | Checks every declared file is in storage with its declared size, content type and SHA-256 (one listing of the run's folder, then at most 16 HEADs at a time), marks the run ready, prunes the project, answers `{ id, status: "ready", url }`; `url` is the run in the interface, `<PUBLIC_URL>/p/<project>/runs/<id>`. Repeatable. `409` with `missing` when files have not arrived; a stored file that does not match is deleted, so the next push uploads it again. |
| `GET` or `POST /v1/cron/retention` | `Authorization: Bearer <CRON_SECRET>`. Prunes every project and drops expired sessions; answers `{ projects, pruned, failed, sessions }`. `404` without `CRON_SECRET`. |

Errors are JSON, `{ "error": "..." }`, in plain words: `400` for a body or file that is not accepted, `401` for a
missing, unknown, expired or revoked key, `403` for anything a key may not do, `404` for a run that is not in the
key's project (or was dropped unfinished), `409` for a run pushed again with different files, `413` for a body over
4 MB (counted as it arrives, so a chunked body without a `content-length` is cut off there too; under the 4.5 MB a
Vercel function accepts), `429` for a sixth unfinished upload, and `426` with `minVersion` for an `imitor` older than
`MIN_CLI_VERSION`.

For people (a session cookie):

| Route | |
| --- | --- |
| `GET /login` | Sign-in: "Continue with Google", and "Sign in with the admin token" when `IMITOR_ADMIN_TOKEN` is set. |
| `GET /auth/google`, `GET /auth/google/callback` | The OpenID Connect code flow with PKCE, state and nonce. |
| `GET` and `POST /login/token` | The admin token form, only with `IMITOR_ADMIN_TOKEN`. |
| `POST /logout`, `POST /logout/everywhere` | End this session, or every session of the person. |
| `GET /projects` | The person's projects, and a form to make one (`POST /projects`). The same path answers JSON to a request whose `Accept` does not name `text/html` (`GET` and `POST /projects`). Signing in lands here. |
| `GET /` | A redirect to `/projects` (on Vercel, `vercel.json` does it, since `/` is the site's own page there). |
| `/p/<project>/...` | The interface in cloud mode. Its API is `/p/<project>/api/*`, the same answers as the local server's `/api/*` (built with the same code, `src/derive.mjs`), plus `me`, `keys` (`GET`; `POST keys` with `{ name }` and `POST keys/<id>/revoke`, owners only) and `members` (`GET`; `POST members` with `{ email, role }`, `role` being `member` or `owner`, and `POST members/<user id>/remove`, owners only, or anyone for themselves; a project always keeps an owner: the check and the change are one transaction holding the project row, so two owners removing each other at once cannot leave none). Files: `/p/<project>/files/runs/<run>/<path>`, a 302 to storage. |

`imitor push` only sends to an `https://` address, or to plain `http://` on `localhost`, `127.0.0.1` or `[::1]`.

## Environment

| Variable | |
| --- | --- |
| `PUBLIC_URL` | The cloud's own address, e.g. `https://app.imitor.dev`. Its origin is what every form and request that changes something must come from, and Google's redirect URI is `PUBLIC_URL/auth/google/callback`. `https://` only, or `http://` on `localhost`, `127.0.0.1` or `[::1]` for local runs. The Node server defaults to its own address. |
| `DATABASE_URL` | Postgres. Without it, everything is in memory (local runs only). The Node server applies `cloud/migrations/` when it starts; on Vercel, run them yourself (`npm run migrate --prefix cloud`). |
| `S3_ENDPOINT` | e.g. `https://<account>.r2.cloudflarestorage.com` or `http://127.0.0.1:9000` (MinIO). Path-style when set; AWS virtual-hosted when not. |
| `S3_BUCKET`, `S3_REGION` | `S3_REGION` defaults to `auto` (R2). Without `S3_BUCKET` or `BLOB_READ_WRITE_TOKEN`, files are kept in memory. S3 wins when both are set. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | |
| `BLOB_READ_WRITE_TOKEN` | A private Vercel Blob store instead of S3, used when `S3_BUCKET` is not set. Vercel sets it when a Blob store is connected to the project. Uploads and downloads use Blob's presigned URLs; Blob keeps no SHA-256, so `complete` reads each file once and hashes it. |
| `S3_CHECKSUMS` | `off` to stop signing `x-amz-checksum-sha256` into uploads, for a store that does not support it. Then storage keeps no SHA-256 to check, so the server refuses to start unless `IMITOR_ALLOW_UNVERIFIED_UPLOADS` is also set. |
| `IMITOR_ALLOW_UNVERIFIED_UPLOADS` | `1` to let `complete` accept a file whose stored object has no SHA-256 (size and content type are still checked). **Unsafe**: the bytes are then whatever was uploaded to the URL, not necessarily what the run declared. Only for a store without checksum support. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A Google OAuth client of type "Web application" whose authorized redirect URI is `PUBLIC_URL/auth/google/callback`. Scopes: `openid email profile`. Both or neither. |
| `IMITOR_ALLOWED_EMAILS` | Comma-separated addresses that may sign in the first time (compared lowercased). An address an owner adds to a project (Settings, Members) before its person ever signed in may sign in too (`users.invited_at`): the owner's invitation stands in for this list, so any owner can admit people, with no cap. Removing someone from a project does not stop them signing in; an account turned off (`users.allowed = false`) cannot be added back by an owner. After someone's first sign-in their Google account decides, so removing an address does not lock its person out; to do that, set `users.allowed` to false (their sessions end at their next request). |
| `IMITOR_ADMIN_TOKEN` | For a private instance without Google: at least 32 characters (`openssl rand -base64 32`). Turns on `/login/token`, which signs in an admin user (`IMITOR_ADMIN_EMAIL`, default `admin`). Anyone with the token is that admin; leave it unset where Google sign-in is configured. |
| `CRON_SECRET` | At least 32 characters. Turns on the retention call and is its bearer token (Vercel Cron sends it). |
| `RESEND_API_KEY` | Turns on transactional email, sent through [Resend](https://resend.com)'s HTTP API (no SDK). Without it, mail is off and nothing is sent. Needs `MAIL_FROM` (both or neither) and `PUBLIC_URL`, since every message links to it. Nothing sends mail yet: the module is in place (`src/mail/`), and no route calls it. |
| `MAIL_FROM` | The sender, e.g. `Imitor Cloud <hello@jamaklab.com>`. Its domain must be verified in Resend, or Resend refuses every message. |
| `MAIL_REPLY_TO` | Optional: where replies go, when not to `MAIL_FROM`. |
| `MIN_CLI_VERSION` | Oldest `imitor` accepted, e.g. `0.1.0`. |
| `PORT`, `HOST` | For `server.mjs`: `8787` and `127.0.0.1` by default. |

## Run it locally

In memory, nothing installed:

```bash
node cloud/src/server.mjs
# prints an admin token to sign in with at http://127.0.0.1:8787/login/token, and an upload key for the project
# "local"; from an app folder with a recorded run:
IMITOR_CLOUD_URL=http://127.0.0.1:8787 IMITOR_TOKEN=imk_... npx imitor push
```

Open the printed address exactly (`127.0.0.1`, not `localhost`): forms are only accepted from `PUBLIC_URL`'s origin.
Everything is gone when it stops.

With Postgres and MinIO:

```bash
npm install --prefix cloud
docker run -d --name imitor-pg -e POSTGRES_PASSWORD=imitor -p 5432:5432 postgres:16
docker run -d --name imitor-minio -p 9000:9000 -e MINIO_ROOT_USER=imitor -e MINIO_ROOT_PASSWORD=imitor-secret minio/minio server /data
# make the bucket "runs" (MinIO console, or: mc mb local/runs), then:
DATABASE_URL=postgres://postgres:imitor@127.0.0.1:5432/postgres \
S3_ENDPOINT=http://127.0.0.1:9000 S3_BUCKET=runs S3_REGION=us-east-1 \
S3_ACCESS_KEY_ID=imitor S3_SECRET_ACCESS_KEY=imitor-secret \
IMITOR_ADMIN_TOKEN=$(openssl rand -base64 32) PUBLIC_URL=http://127.0.0.1:8787 \
node cloud/src/server.mjs
```

## Self-hosting with Node

`node cloud/src/server.mjs` is the whole server: it applies the migrations, then listens on `HOST:PORT`. Put it
behind a TLS-terminating proxy, set `PUBLIC_URL` to the `https://` address people use, `DATABASE_URL`, the `S3_*`
variables, and either Google sign-in (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `IMITOR_ALLOWED_EMAILS`) or, for a
private instance, `IMITOR_ADMIN_TOKEN`. Call the retention route once a day, e.g. from cron:
`curl -fsS -H "Authorization: Bearer $CRON_SECRET" https://cloud.example.com/v1/cron/retention`.

## Deploying on the site's Vercel project

The cloud runs in the same Vercel project as the public site, on a host of its own:

- **Its own host.** The hosted instance uses `app.imitor.dev`, added to the project next to the site's `imitor.dev`.
  A different host keeps its own cookies (`__Host-` cookies are bound to it) and storage, apart from the public site
  and the demo. The cloud is never served under a path of the site's host. A self-hoster sets their own host in the
  root `vercel.json` (`has.host`) and in `PUBLIC_URL`.
- **Functions.** `api/cloud.mjs` and `api/cron-retention.mjs` at the repository root are shims for
  [`src/vercel.mjs`](src/vercel.mjs). The root `vercel.json` rewrites the app host's `/p/*`, `/v1/*`, `/login`,
  `/logout`, `/auth/*`, `/projects` and `/static/*` to `/api/cloud/` (the trailing slash matters under `trailingSlash: true`; with the original path in `?__imitor_path=`),
  redirects the app host's `/` to `/projects/` and its other paths to the site, includes in the functions exactly what
  they load or read (`src/app/**`, the pure modules of `src/` listed below, `cloud/src/**` and `design/tokens.css`;
  never the CLI), installs only `cloud/`'s locked dependencies (`npm ci --prefix cloud`), and runs retention daily at
  04:17 UTC by calling `/api/cron-retention/` (the Hobby plan allows one run a day).
- **Static files win.** Vercel serves the site's files (`site/dist`) before it applies any rewrite, so `/` on the app
  host would be the site's landing page: that is why the cloud's home is `/projects` and `/` is a redirect (redirects
  run before files). No path the cloud answers may be a file or folder of the site (`/`, `/how-to-use/`, `/agents/`,
  `/demo/`, `/assets/`, `/404.html`, `tokens.css`, `site.css`, `site.js`, `robots.txt`); `test/vercel.test.mjs` builds
  the site and checks it.
- **Cron and `trailingSlash`.** The site's `trailingSlash: true` answers `/api/cron-retention` with a 308, and Vercel
  Cron does not follow redirects, so the cron path is `/api/cron-retention/` (the function answers on either).
- **Guards.** The function answers 404 unless `VERCEL_ENV` is `production` and the request's host is `PUBLIC_URL`'s,
  so preview deployments and the site's host never reach the cloud. Google's redirect URI is built from `PUBLIC_URL`
  only, never from a Host header. Every answer is `cache-control: private, no-store` with the strict
  Content-Security-Policy, `frame-ancestors 'none'`, `nosniff` and `Referrer-Policy: same-origin`.
- **Environment.** Add, for Production only and as Sensitive: `PUBLIC_URL` (`https://app.imitor.dev`),
  `DATABASE_URL` (a pooled connection string; each function instance holds one connection), a store for files
  (`BLOB_READ_WRITE_TOKEN` from a connected private Blob store, or `S3_*`), `GOOGLE_CLIENT_ID`,
  `GOOGLE_CLIENT_SECRET`, `IMITOR_ALLOWED_EMAILS`, `CRON_SECRET`, and `IMITOR_ADMIN_TOKEN` only if you need it.
  Without a database and a store the function refuses to run rather than keep anything in memory.
- **Database timeouts.** Each connection gives up connecting after 5 s, is closed after 10 s idle, and asks the server
  to cancel any statement after 10 s (`statement_timeout`, sent as a startup parameter; the client also stops waiting
  2 s later). A pooler (PgBouncer, which Neon's `-pooler` hosts are, or a URL with `pgbouncer=true`) refuses startup
  parameters it does not track, so through one the parameter is left out and the limit is set on the role instead
  (`alter role current_user set statement_timeout = '10s'`, which the production build runs; see Migrations). A
  database that cannot be reached, or a statement cancelled that way, is answered with `503` and a plain message (`Retry-After: 30`), not a hung request.
- **Migrations** run in the production build, after the site (`cloud/scripts/deploy-migrate.mjs` in `buildCommand`),
  over `DATABASE_URL_UNPOOLED` when it is set, else `DATABASE_URL`; preview builds skip them, and a failed migration
  fails the build. (`DATABASE_URL=... npm run migrate --prefix cloud` does the same by hand.) Each migration runs in a
  transaction of its own with no statement timeout, that first takes a transaction-level advisory lock
  (`pg_advisory_xact_lock`) and then checks whether it was applied, so two builds never apply a file twice and the
  lock ends with the transaction: the pooled URL works as well as a direct one. The schema changes before the new
  deployment is promoted, and an Instant Rollback keeps the new schema, so **every migration must keep working with
  the code before it**: add tables and columns (nullable or with a default); drop or rename only in a later release.
- **Google.** Register `PUBLIC_URL/auth/google/callback` as the client's authorized redirect URI.
- **Bucket CORS.** `imitor push` uploads with presigned PUTs from Node, which sends no `Origin`, so no CORS rule is
  needed for the CLI (nor is any setting on a Blob store). The interface only loads files through redirects into
  `<img>` and `<video>`, which need none either; allow `GET` from `PUBLIC_URL` if you want to be explicit.
- **Keep Standard Deployment Protection** on: it protects preview deployments (which the function refuses anyway) and
  leaves the production domains public, as the sign-in needs.
- **Limits.** A function accepts at most 4.5 MB per request, so the upload body is capped at 4 MB (run.json,
  manifest.json and the file list; files go to storage). The site's `trailingSlash: true` applies to the app host too;
  the function drops the trailing slash, and `fetch` (and so `imitor push`) follows a 308 with the same method and body.

The site's build (`node site/build.mjs`) stays dependency-free and never reads the environment, which in this project
holds the cloud's secrets; `test/site.test.mjs` checks both.

### Go-live checklist

Everything but Google lives in the Vercel project. In this order; nothing here needs a secret to be shared with anyone.

1. **Database**: in the project's Storage tab, create a Neon database (Vercel's Neon integration) and connect it to
   this project with no environment-variable prefix. That sets `DATABASE_URL` (pooled) and `DATABASE_URL_UNPOOLED`
   (direct). The production build then applies the migrations itself (`cloud/scripts/deploy-migrate.mjs`, over the
   direct URL) and sets the role's `statement_timeout`; a failed migration fails the build.
2. **Files**: a private Vercel Blob store connected to the project, which sets `BLOB_READ_WRITE_TOKEN`. (Done for
   imitor.dev: `imitor-cloud-runs`, in iad1.) An S3-compatible bucket works instead: set `S3_*`.
3. **Google Cloud**: an OAuth client of type "Web application" with the redirect URI
   `https://app.imitor.dev/auth/google/callback`. Consent screen: External, scopes `openid email profile`, publishing
   status **Testing**, with each allowlisted address as a test user. Testing needs no verification. Publishing later
   needs `imitor.dev` as an authorized domain, the live `https://imitor.dev/privacy/` and `/terms/`, and the domain
   verified in Search Console.
4. **Vercel** environment, Production only, Sensitive: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `CRON_SECRET`
   (`openssl rand -base64 32`). `PUBLIC_URL` and `IMITOR_ALLOWED_EMAILS` are already set. Leave `IMITOR_ADMIN_TOKEN`
   unset. Then redeploy production, and check the build log says the migrations ran.
5. **Check from outside**: `CRON_SECRET=... npm run verify-deploy --prefix cloud`. It covers the site, the host-scoped
   redirects and rewrites, path recovery and the bundle (`/projects/` answers a stranger with a redirect to sign in),
   the 308 on `POST /v1/runs`, the CSP, and one run of the retention job.
6. **Sign in** at `https://app.imitor.dev`, make a project, make an access key, and push a run:
   `IMITOR_CLOUD_URL=https://app.imitor.dev IMITOR_TOKEN=imk_... npx imitor push`. Open the run; its screenshots load
   through the five-minute storage links, which shows the presigned uploads and the checksum check worked.
7. **The next morning**, open the project's Cron Jobs logs and confirm the retention job answered 200.

### Not verified yet

Nothing here has run on Vercel, against a real Google client or real storage (the Blob store exists but is empty). Before relying on it, check on a
first deployment: that the rewrites reach `/api/cloud` with `?__imitor_path=` (the function also accepts the original
URL if the runtime shows that instead), that `trailingSlash` answers `POST /v1/runs` with a 308 that `imitor push`
follows (or no redirect at all), that `/` on the app host redirects to `/projects/` and `/projects/` shows the projects
page, that `includeFiles` bundles the interface, that Vercel Cron's call carries `Authorization: Bearer <CRON_SECRET>`,
and that sign-in completes against Google. After the first night, open the project's Cron Jobs logs and confirm the
04:17 UTC call to `/api/cron-retention/` answered 200 (not 308 or 401).

The Vercel Blob adapter is tested against a fake of the SDK only. On the first push, check that Blob accepts the
presigned PUT with the headers the adapter hands out (they copy what Vercel's own client sends), that it stores the
declared content type, and how long `complete` takes: it reads every file of the run once to hash it, so a run near
the 300 MB limit may need more than the 60 s `maxDuration` in `vercel.json` (then: record each verified file, so a retry
does not hash it again).

## Security notes

- Sessions: a random 32-byte token in `__Host-imitor_session` (HttpOnly, Secure, SameSite=Lax, Path=/; plain
  `imitor_session` without Secure only on `http://localhost` for local runs). Only its SHA-256 is stored. 30 days from
  last use, and never more than 90 days from signing in however often it is used; signing out deletes it, signing out
  everywhere deletes all of the person's.
- Google's ID token: RS256 against Google's published keys, `iss`, `aud`, `exp`, `iat` and the nonce checked, and
  `azp` must be this client whenever it is present (and present when there is more than one audience). Two first
  sign-ins of one person at once both succeed, as one user with one identity.
- A failure the handler did not answer (the Node server's last resort) is a `500` with the same security headers as
  every other answer.
- CSRF: every request that changes something and is not under `/v1` (which uses keys, not cookies) must carry an
  `Origin`, or else a `Referer`, equal to `PUBLIC_URL`'s origin. That includes the admin token form.
- The interface's pages allow scripts from the cloud's own origin and the one inline theme script by its hash; images
  and video from the cloud and the bucket; nothing may frame them. Uploaded files are never served from the cloud's
  origin (the in-memory store for local runs is the exception, and sends them sandboxed).
- The admin token is compared in constant time. After 5 wrong tokens from one address within 10 minutes, that address
  gets `429` until the window ends, even with the right token. The address is `X-Forwarded-For`'s first entry (Vercel
  sets it; behind your own proxy, have the proxy set it; the Node server fills it from the socket when it is absent),
  and the count is kept in memory per process, so on a serverless platform each instance counts on its own: it slows
  guessing down, the token's length is what stops it. A single wrong token is not audited; an address reaching the
  limit is, once per window (`user.signin-throttled` with the address). Use a long random value, and only on a
  private instance.
- Not a member of a project reads exactly as no such project (404), so project names cannot be probed.

## Layout

```
cloud/
  LICENSE                 AGPL-3.0 (the CLI, the interface and the run format in ../src stay MIT)
  migrations/             the Postgres schema, applied in order by src/db/migrate.mjs
  src/api.mjs             handle(request, deps) -> Response: the upload API, retention, and web.mjs for the rest
  src/web.mjs             sign-in, projects, keys, the interface and its files under /p/<project>/
  src/read.mjs            the interface's API, built with src/derive.mjs
  src/auth/oidc.mjs       Google OpenID Connect on fetch and node:crypto
  src/auth/session.mjs    session cookies and the Origin check
  src/pages.mjs           sign-in, projects and notice pages (no script)
  src/http.mjs            responses, bounded bodies, cookies, security headers
  src/email.mjs           what counts as an email address (the members form and mail agree on it)
  src/mail/               transactional email: Resend on fetch (no SDK), the message templates, notify(); off without RESEND_API_KEY
  src/assets.mjs          the interface (../src/app) and design tokens, read from the repository
  src/server.mjs          node:http adapter and the environment; memory adapters unless the environment says otherwise
  src/vercel.mjs          the Vercel functions (root api/ shims), with their production and host guards
  src/ids.mjs             ids, key secrets, project slugs
  src/limit.mjs           bounded concurrency for storage calls
  src/db/CONTRACT.md      every repository method, with its arguments and results
  src/db/memory.mjs       the repository in memory
  src/db/pg.mjs           the repository on Postgres (pg, loaded on first use)
  src/db/migrate.mjs      the migration runner (npm run migrate)
  src/storage/            the storage contract, in memory and on S3 (a hand-written SigV4 presigner, no SDK)
  test/                   contract, API, sign-in, web, read-parity, Vercel, bundle, server and browser tests
```

The cloud imports the run format and the interface's data code from `../src` (`upload.mjs`, `redact.mjs`,
`derive.mjs` with `state.mjs`, `config.mjs`, and the leaf modules `app-index.mjs` and `tools.mjs`), so a client, the
local server and the cloud check and show a run with the same code. It never imports the CLI (`export.mjs`, `mcp.mjs`,
`appserver.mjs`, `store.mjs`, builds, Playwright or child processes): `test/bundle.test.mjs` walks the functions'
imports and checks that, and that `vercel.json`'s `includeFiles` covers every module they reach. `../src` never
imports from `cloud/`, and the npm package does not include `cloud/`.

Problem ids (`src/derive.mjs`) are computed from a problem's run id and its message, and the cloud only ever has the
redacted message and its own run id. So a problem has another id in the cloud than on the machine that pushed it, and
what was marked seen locally (`state.json`) does not carry over. In the cloud, seen marks are kept per person.

## Tests

```bash
npm run test:cloud                                    # from the repository root
DATABASE_URL=postgres://... npm run test:cloud       # also runs the repository contract on Postgres
```

Without `DATABASE_URL` nothing is needed beyond Node: the repository contract runs on memory, sign-in runs against a
fake OpenID provider in the test process (its own RSA key, discovery, JWKS and token endpoints), the S3 signer is
checked against AWS's published Signature Version 4 examples, and `imitor push` runs against the Node server. With
Playwright installed, `browser.test.mjs` drives the interface in cloud mode in Chromium. CI runs all of it, and the
contract again against a `postgres:16` service (the Postgres suite works in a schema of its own and drops it).

## Next

- Inviting members to a project, and an owner's view of the audit log.
- `imitor push` after every run (automatic) and uploading captures and agent activity with a run; the API already
  accepts `captures` and `activity` lines.
