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
- **Files go straight to storage.** The API answers with presigned PUT URLs for S3-compatible storage, valid for 15
  minutes; the bytes never pass through the API. The server picks every storage key (`<projectId>/<runId>/<path>`);
  a client never does. Each URL only takes the declared size, content type and SHA-256, and `complete` checks all
  three again on every stored object before a run is ready. A URL cannot be revoked: one issued earlier can still
  write its declared bytes until it expires, also after `complete` or after its run was pruned. `complete` re-verifies
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
| `/p/<project>/...` | The interface in cloud mode. Its API is `/p/<project>/api/*`, the same answers as the local server's `/api/*` (built with the same code, `src/derive.mjs`), plus `me` and `keys` (`GET`; `POST keys` with `{ name }` and `POST keys/<id>/revoke`, owners only). Files: `/p/<project>/files/runs/<run>/<path>`, a 302 to storage. |

`imitor push` only sends to an `https://` address, or to plain `http://` on `localhost`, `127.0.0.1` or `[::1]`.

## Environment

| Variable | |
| --- | --- |
| `PUBLIC_URL` | The cloud's own address, e.g. `https://imitor-app.vercel.app`. Its origin is what every form and request that changes something must come from, and Google's redirect URI is `PUBLIC_URL/auth/google/callback`. `https://` only, or `http://` on `localhost`, `127.0.0.1` or `[::1]` for local runs. The Node server defaults to its own address. |
| `DATABASE_URL` | Postgres. Without it, everything is in memory (local runs only). The Node server applies `cloud/migrations/` when it starts; on Vercel, run them yourself (`npm run migrate --prefix cloud`). |
| `S3_ENDPOINT` | e.g. `https://<account>.r2.cloudflarestorage.com` or `http://127.0.0.1:9000` (MinIO). Path-style when set; AWS virtual-hosted when not. |
| `S3_BUCKET`, `S3_REGION` | `S3_REGION` defaults to `auto` (R2). Without `S3_BUCKET`, files are kept in memory. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | |
| `S3_CHECKSUMS` | `off` to stop signing `x-amz-checksum-sha256` into uploads, for a store that does not support it. Then storage keeps no SHA-256 to check, so the server refuses to start unless `IMITOR_ALLOW_UNVERIFIED_UPLOADS` is also set. |
| `IMITOR_ALLOW_UNVERIFIED_UPLOADS` | `1` to let `complete` accept a file whose stored object has no SHA-256 (size and content type are still checked). **Unsafe**: the bytes are then whatever was uploaded to the URL, not necessarily what the run declared. Only for a store without checksum support. |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | A Google OAuth client of type "Web application" whose authorized redirect URI is `PUBLIC_URL/auth/google/callback`. Scopes: `openid email profile`. Both or neither. |
| `IMITOR_ALLOWED_EMAILS` | Comma-separated addresses that may sign in the first time (compared lowercased). After someone's first sign-in their Google account decides, so removing an address does not lock its person out; to do that, set `users.allowed` to false (their sessions end at their next request). |
| `IMITOR_ADMIN_TOKEN` | For a private instance without Google: at least 32 characters (`openssl rand -base64 32`). Turns on `/login/token`, which signs in an admin user (`IMITOR_ADMIN_EMAIL`, default `admin`). Anyone with the token is that admin; leave it unset where Google sign-in is configured. |
| `CRON_SECRET` | At least 32 characters. Turns on the retention call and is its bearer token (Vercel Cron sends it). |
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

- **Its own host.** Add the domain `imitor-app.vercel.app` (later `app.<domain>`) to the project. `vercel.app` is on
  the Public Suffix List, so it is a separate site from `imitor.vercel.app`, with its own cookies and storage. The
  cloud is never served under a path of the site's host.
- **Functions.** `api/cloud.mjs` and `api/cron-retention.mjs` at the repository root are shims for
  [`src/vercel.mjs`](src/vercel.mjs). The root `vercel.json` rewrites the app host's `/p/*`, `/v1/*`, `/login`,
  `/logout`, `/auth/*`, `/projects` and `/static/*` to `/api/cloud` (with the original path in `?__imitor_path=`),
  redirects the app host's `/` to `/projects/` and its other paths to the site, includes `src/`, `cloud/src/` and
  `design/tokens.css` in the functions, installs only `cloud/`'s locked dependencies (`npm ci --prefix cloud`), and
  runs retention daily at 04:17 UTC by calling `/api/cron-retention/` (the Hobby plan allows one run a day).
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
- **Environment.** Add, for Production only and as Sensitive: `PUBLIC_URL` (`https://imitor-app.vercel.app`),
  `DATABASE_URL` (a pooled connection string; each function instance holds one connection), `S3_*`,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `IMITOR_ALLOWED_EMAILS`, `CRON_SECRET`, and `IMITOR_ADMIN_TOKEN` only if
  you need it. Without `DATABASE_URL` and `S3_BUCKET` the function refuses to run rather than keep anything in memory.
- **Before the first deploy**, apply the migrations from your machine:
  `DATABASE_URL=... npm run migrate --prefix cloud`. Do the same before deploying a change that adds one.
- **Google.** Register `PUBLIC_URL/auth/google/callback` as the client's authorized redirect URI.
- **Bucket CORS.** `imitor push` uploads with presigned PUTs from Node, which sends no `Origin`, so no CORS rule is
  needed for the CLI. The interface only loads files through redirects into `<img>` and `<video>`, which need none
  either; allow `GET` from `PUBLIC_URL` if you want to be explicit.
- **Keep Standard Deployment Protection** on: it protects preview deployments (which the function refuses anyway) and
  leaves the production domains public, as the sign-in needs.
- **Limits.** A function accepts at most 4.5 MB per request, so the upload body is capped at 4 MB (run.json,
  manifest.json and the file list; files go to storage). The site's `trailingSlash: true` applies to the app host too;
  the function drops the trailing slash, and `fetch` (and so `imitor push`) follows a 308 with the same method and body.

The site's build (`node site/build.mjs`) stays dependency-free and never reads the environment, which in this project
holds the cloud's secrets; `test/site.test.mjs` checks both.

### Not verified yet

Nothing here has run on Vercel, against a real Google client or a real bucket. Before relying on it, check on a
first deployment: that the rewrites reach `/api/cloud` with `?__imitor_path=` (the function also accepts the original
URL if the runtime shows that instead), that `trailingSlash` answers `POST /v1/runs` with a 308 that `imitor push`
follows (or no redirect at all), that `/` on the app host redirects to `/projects/` and `/projects/` shows the projects
page, that `includeFiles` bundles the interface, that Vercel Cron's call carries `Authorization: Bearer <CRON_SECRET>`,
and that sign-in completes against Google. After the first night, open the project's Cron Jobs logs and confirm the
04:17 UTC call to `/api/cron-retention/` answered 200 (not 308 or 401).

## Security notes

- Sessions: a random 32-byte token in `__Host-imitor_session` (HttpOnly, Secure, SameSite=Lax, Path=/; plain
  `imitor_session` without Secure only on `http://localhost` for local runs). Only its SHA-256 is stored. 30 days from
  last use; signing out deletes it, signing out everywhere deletes all of the person's.
- CSRF: every request that changes something and is not under `/v1` (which uses keys, not cookies) must carry an
  `Origin`, or else a `Referer`, equal to `PUBLIC_URL`'s origin. That includes the admin token form.
- The interface's pages allow scripts from the cloud's own origin and the one inline theme script by its hash; images
  and video from the cloud and the bucket; nothing may frame them. Uploaded files are never served from the cloud's
  origin (the in-memory store for local runs is the exception, and sends them sandboxed).
- The admin token is compared in constant time and has no rate limit: use a long random value, and only on a
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
  test/                   contract, API, sign-in, web, read-parity, Vercel, server and browser tests
```

The cloud imports the run format and the interface's data code from `../src` (`upload.mjs`, `redact.mjs`,
`derive.mjs`), so a client, the local server and the cloud check and show a run with the same code. `../src` never
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
