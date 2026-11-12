# Repository contract

What `cloud/src/api.mjs` needs from a database. `memory.mjs` implements it today; the Postgres repository on
`cloud/migrations/001_init.sql` (week 2) implements the same methods with the same results. Every method is async.

Records are rows of the schema with columns in camelCase (`project_id` is `projectId`, `secret_sha256` is
`secretSha256`), timestamps as ISO 8601 strings, and `jsonb` columns as plain values. Results are copies: changing one
never changes what is stored.

## Records

- **Project** `{ id, name, createdAt }`
- **AccessKey** `{ id, projectId, name, prefix, secretSha256, createdAt, lastUsedAt, revokedAt, expiresAt }`.
  `expiresAt` null means it never expires. The secret itself is never stored.
- **Run** `{ id, projectId, clientRunId, schemaVersion, status: "uploading" | "ready", run, manifest, files, keyId,
  createdAt, completedAt }`. `run` and `manifest` are the redacted run.json and manifest.json; `files` is
  `[{ path, size, sha256, contentType, key }]` sorted by path, where `key` is `<projectId>/<id>/<path>` in storage.

## Projects and keys

| Method | Arguments | Returns |
| --- | --- | --- |
| `createProject` | `{ name }` | Project |
| `getProject` | `id` | Project, or null |
| `createAccessKey` | `projectId, { name = "default", expiresAt = null }` | AccessKey plus `secret` (`imk_...`), the only time it is returned. Throws for an unknown project. |
| `findAccessKey` | `secret` | the AccessKey whose `secretSha256` is the secret's SHA-256, if it is not revoked and not expired, else null. Sets `lastUsedAt`. |
| `revokeAccessKey` | `id` | nothing; sets `revokedAt` |

## Runs

| Method | Arguments | Returns |
| --- | --- | --- |
| `createRun` | `{ id, projectId, clientRunId, schemaVersion, run, manifest, files, keyId }` | `{ run: Run, created: true }` with status `uploading`, `createdAt` now and `completedAt` null; or `{ run: the existing Run, created: false }` when `(projectId, clientRunId)` exists. Atomic: two pushes of one run make one row. |
| `getRun` | `id` | Run, or null |
| `findRun` | `projectId, clientRunId` | Run, or null |
| `updateRun` | `id, patch` (e.g. `{ status: "ready", completedAt }`) | the updated Run, or null |
| `listRuns` | `projectId, { status = null }` | Runs of the project (of that status), newest first: by `completedAt`, or `createdAt` while it is null, descending, then `id` descending |
| `deleteRun` | `id` | nothing; also deletes the run's captures, activity and seen rows (the schema's cascades) |

## Lines that came with a run

| Method | Arguments | Returns |
| --- | --- | --- |
| `addLines` | `kind` (`"captures"` or `"activity"`), `projectId, runId, lines` (objects) | nothing; one row per line, in order |
| `listLines` | `kind, runId` | the lines, in the order they were added |

## Storage keys waiting to be deleted

| Method | Arguments | Returns |
| --- | --- | --- |
| `addPendingDeletions` | `projectId, keys` | nothing; a key already pending is not added twice |
| `listPendingDeletions` | `projectId` | the project's pending keys |
| `removePendingDeletions` | `keys` | nothing |

## Audit

| Method | Arguments | Returns |
| --- | --- | --- |
| `addAudit` | `{ projectId = null, userId = null, keyId = null, action, detail = {} }` | nothing; `at` is now. `detail` shapes are listed above `audit_log` in the schema. |
| `listAudit` | none | entries `{ id, at, projectId, userId, keyId, action, detail }`, oldest first |
