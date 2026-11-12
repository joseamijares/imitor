# Imitor Cloud

A hosted place for finished Imitor runs, so a team can look at the screens an agent or CI produced without the
machine that made them. Agents and CI upload a run with `npx imitor push`; people will read it in the same interface
`imitor app` shows locally.

**Status: week 1, not deployable yet.** What exists is the upload API, its storage and database contracts with
in-memory versions, an S3 presigner, and the `imitor push` command. There is no sign-in, no interface, no Postgres
adapter and no hosting adapter yet.

## What it is, and what it will not do

- **Receive-only.** It stores runs that were built and shot elsewhere. It never builds, installs or runs uploaded
  code, and it never serves uploaded HTML, JavaScript or SVG: an upload may only hold PNG, JPEG, WebM and JSON files
  (25 MB each, 300 MB per run), and the content type is signed into each upload URL.
- **Write-only keys.** Each project has upload keys (`imk_...`). A key can register and complete runs in its own
  project and nothing else: it cannot read, list or delete. Only a SHA-256 of a key is stored.
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
  project; one not completed within 24 hours is dropped with its files. Both are enforced on every register and
  complete. When storage fails to delete a pruned run's files, the run is still removed, the error is logged, and the
  deletion is retried on the next register or complete.
- **Portable.** Plain Postgres (`DATABASE_URL`) and any S3-compatible store; handlers are web-standard
  `Request -> Response`, so it can run on Vercel or a plain Node server.

## API

| Route | |
| --- | --- |
| `POST /v1/runs` | `Authorization: Bearer imk_...`. Body: [`src/schema/run-upload.v1.json`](../src/schema/run-upload.v1.json). `201` with `{ id, status, uploads: [{ path, method, url, headers }], complete }`. Idempotent on the run's folder name within the project: a repeat answers `200` with the same `id` and upload URLs only for files not stored yet. |
| `POST /v1/runs/:id/complete` | Checks every declared file is in storage with its declared size, content type and SHA-256 (one listing of the run's folder, then at most 16 HEADs at a time), marks the run ready, prunes the project, answers `{ id, status: "ready", url }`. Repeatable. `409` with `missing` when files have not arrived; a stored file that does not match is deleted, so the next push uploads it again. |

Errors are JSON, `{ "error": "..." }`, in plain words: `400` for a body or file that is not accepted, `401` for a
missing, unknown, expired or revoked key, `403` for anything a key may not do, `404` for a run that is not in the
key's project (or was dropped unfinished), `409` for a run pushed again with different files, `413` for a body over
8 MB (counted as it arrives, so a chunked body without a `content-length` is cut off there too), `429` for a sixth
unfinished upload, and `426` with `minVersion` for an `imitor` older than `MIN_CLI_VERSION`.

`imitor push` only sends to an `https://` address, or to plain `http://` on `localhost`, `127.0.0.1` or `[::1]`.

## Layout

```
cloud/
  LICENSE                 AGPL-3.0 (the CLI, the interface and the run format in ../src stay MIT)
  migrations/001_init.sql the Postgres schema (written, not run yet)
  src/api.mjs             handle(request, deps) -> Response
  src/server.mjs          node:http adapter; memory adapters unless the environment says otherwise
  src/ids.mjs             ids and upload key secrets (only their SHA-256 is stored)
  src/limit.mjs           bounded concurrency for storage calls
  src/db/CONTRACT.md      every repository method, with its arguments and results
  src/db/memory.mjs       the repository, in memory
  src/storage/interface.mjs  the storage contract (JSDoc)
  src/storage/memory.mjs  storage in memory, with signed, checked upload URLs served by server.mjs
  src/storage/s3.mjs      S3-compatible storage with a hand-written SigV4 presigner (node:crypto, no SDK)
  test/                   API contract tests, SigV4 test vectors, server.mjs over a socket, imitor push end to end
```

The cloud imports the run format from `../src` (`upload.mjs`, `redact.mjs`), so a client and the server check an
upload with the same code. `../src` never imports from `cloud/`, and the npm package does not include `cloud/`.

Problem ids (`src/derive.mjs`) are computed from a problem's run id and its message, and the cloud only ever has the
redacted message and its own run id. So a problem has another id in the cloud than on the machine that pushed it, and
what was marked seen locally (`state.json`) does not carry over.

## Environment

| Variable | |
| --- | --- |
| `DATABASE_URL` | Postgres. Not supported yet (week 2): when set, the server refuses to start rather than pretend. |
| `S3_ENDPOINT` | e.g. `https://<account>.r2.cloudflarestorage.com` or `http://127.0.0.1:9000` (MinIO). Path-style when set; AWS virtual-hosted when not. |
| `S3_BUCKET`, `S3_REGION` | `S3_REGION` defaults to `auto` (R2). Without `S3_BUCKET`, files are kept in memory. |
| `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` | |
| `S3_CHECKSUMS` | `off` to stop signing `x-amz-checksum-sha256` into uploads, for a store that does not support it. Then storage keeps no SHA-256 to check, so the server refuses to start unless `IMITOR_ALLOW_UNVERIFIED_UPLOADS` is also set. |
| `IMITOR_ALLOW_UNVERIFIED_UPLOADS` | `1` to let `complete` accept a file whose stored object has no SHA-256 (size and content type are still checked). **Unsafe**: the bytes are then whatever was uploaded to the URL, not necessarily what the run declared. Only for a store without checksum support. |
| `PUBLIC_URL` | The address runs are shown at (`<PUBLIC_URL>/runs/<id>`). Defaults to the server's own address. |
| `MIN_CLI_VERSION` | Oldest `imitor` accepted, e.g. `0.1.0`. |
| `PORT`, `HOST` | For `server.mjs`: `8787` and `127.0.0.1` by default. |

## Run it locally

```bash
node cloud/src/server.mjs
# prints a project key, then, from an app folder with a recorded run:
IMITOR_CLOUD_URL=http://127.0.0.1:8787 IMITOR_TOKEN=imk_... npx imitor push
```

Everything is in memory and gone when it stops.

## Tests

```bash
npm run test:cloud      # from the repository root (CI runs it after npm test)
```

No network and no dependencies: the S3 signer is checked against AWS's published Signature Version 4 examples, and
the API and `imitor push` run against the in-memory adapters on a free local port.

## Next

- Week 2: Google sign-in with an allowlist, the Postgres repository on `001_init.sql`, the read side of the
  interface over `src/derive.mjs`, a hosting adapter.
- `imitor push` after every run (automatic) and uploading captures and agent activity with a run; the API already
  accepts `captures` and `activity` lines.
- Pruning on a schedule. Today it happens when a run is registered or completed, so a project nobody pushes to keeps
  its expired runs (and any files storage failed to delete) until the next push.
