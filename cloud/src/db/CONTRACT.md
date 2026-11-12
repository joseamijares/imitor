# Repository contract

What the cloud needs from a database. `memory.mjs` (tests and local runs) and `pg.mjs` (Postgres, on
`cloud/migrations/`) implement it with the same results; `cloud/test/db.test.mjs` runs one suite against memory
always and against Postgres when `DATABASE_URL` is set. Every method is async.

Records are rows of the schema with columns in camelCase (`project_id` is `projectId`, `secret_sha256` is
`secretSha256`), timestamps as ISO 8601 strings, and `jsonb` columns as plain values. Results are copies: changing one
never changes what is stored. Times are taken from the repository's `now` option (the server's clock), never from the
database. A method that would break a unique rule throws an error with `code: "conflict"`.

## Records

- **User** `{ id, email, name, allowed, createdAt }`. One per address, whatever its case.
- **Identity** `{ provider, subject, userId, createdAt }`: `("google", the ID token's sub)` bound to one user.
- **Session** `{ idHash, userId, createdAt, expiresAt }`. `idHash` is the SHA-256 of the cookie value; the value itself
  is never stored.
- **Project** `{ id, name, slug, createdAt }`. `slug` is unique and addresses the project in URLs (`/p/<slug>/`).
- **Member** `{ projectId, userId, role: "owner" | "member", createdAt }`
- **AccessKey** `{ id, projectId, name, prefix, secretSha256, createdAt, lastUsedAt, revokedAt, expiresAt }`.
  `expiresAt` null means it never expires. The secret itself is never stored.
- **Run** `{ id, projectId, clientRunId, schemaVersion, status: "uploading" | "ready", run, manifest, files, keyId,
  createdAt, completedAt }`. `run` and `manifest` are the redacted run.json and manifest.json; `files` is
  `[{ path, size, sha256, contentType, key }]` sorted by path, where `key` is `<projectId>/<id>/<path>` in storage.
- **Seen** `{ problemId, runId, seen, updatedAt }`: a problem a person marked seen (or explicitly not seen).

## People and sessions

| Method | Arguments | Returns |
| --- | --- | --- |
| `createUser` | `{ email, name = null, allowed = false }` | User. Conflict when the address (any case) has a user. |
| `getUser` | `id` | User, or null |
| `findUserByEmail` | `email` | User whose address equals it ignoring case, or null |
| `updateUser` | `id, patch` (`name`, `allowed`) | the updated User, or null |
| `findIdentity` | `provider, subject` | Identity, or null |
| `addIdentity` | `provider, subject, userId` | Identity. Conflict when the pair is bound already. |
| `listIdentities` | `userId` | the user's Identities |
| `createSession` | `{ idHash, userId, expiresAt }` | Session |
| `getSession` | `idHash` | Session, or null. Expired sessions are returned too: the caller compares `expiresAt`. |
| `updateSession` | `idHash, { expiresAt }` | nothing |
| `deleteSession` | `idHash` | nothing |
| `deleteUserSessions` | `userId` | nothing; every session of the user |
| `deleteExpiredSessions` | `before` (ISO time) | how many sessions with `expiresAt <= before` it deleted |

## Projects and keys

| Method | Arguments | Returns |
| --- | --- | --- |
| `createProject` | `{ name, slug = null, ownerId = null }` | Project. The slug is `slugify(slug or name)`, with `-2`, `-3`, ... when taken. With `ownerId`, that user becomes its owner in the same transaction. |
| `getProject` | `id` | Project, or null |
| `getProjectBySlug` | `slug` | Project, or null |
| `listProjects` | none | every Project, oldest first (for retention) |
| `addMember` | `projectId, userId, role = "member"` | Member; a second call changes the role |
| `getMember` | `projectId, userId` | Member, or null |
| `listUserProjects` | `userId` | the user's Projects, each with its `role`, by name |
| `createAccessKey` | `projectId, { name = "default", expiresAt = null }` | AccessKey plus `secret` (`imk_...`), the only time it is returned. Throws for an unknown project. |
| `findAccessKey` | `secret` | the AccessKey whose `secretSha256` is the secret's SHA-256, if it is not revoked and not expired, else null. Sets `lastUsedAt`. |
| `getAccessKey` | `id` | AccessKey (revoked or not), or null |
| `listAccessKeys` | `projectId` | the project's AccessKeys, revoked ones too, newest first |
| `revokeAccessKey` | `id` | nothing; sets `revokedAt` unless it is set already |

## Runs

| Method | Arguments | Returns |
| --- | --- | --- |
| `createRun` | `{ id, projectId, clientRunId, schemaVersion, run, manifest, files, keyId, lines: { captures, activity } }` | `{ run: Run, created: true }` with status `uploading`, `createdAt` now and `completedAt` null; or `{ run: the existing Run, created: false }` when `(projectId, clientRunId)` exists. Atomic: two pushes of one run make one row, and the run and its lines are stored together or not at all. |
| `getRun` | `id` | Run, or null |
| `findRun` | `projectId, clientRunId` | Run, or null |
| `updateRun` | `id, patch` (`status`, `completedAt`, `run`, `manifest`, `files`) | the updated Run, or null |
| `listRuns` | `projectId, { status = null }` | Runs of the project (of that status), newest first: by `completedAt`, or `createdAt` while it is null, descending, then `id` descending |
| `deleteRun` | `id` | nothing; also deletes the run's captures, activity and seen rows (the schema's cascades) |

## Lines that came with a run

| Method | Arguments | Returns |
| --- | --- | --- |
| `addLines` | `kind` (`"captures"` or `"activity"`), `projectId, runId, lines` (objects) | nothing; one row per line, in order |
| `listLines` | `kind, runId` | the lines, in the order they were added |

## Seen

| Method | Arguments | Returns |
| --- | --- | --- |
| `setSeen` | `{ projectId, runId, userId, problemId, seen }` | nothing; replaces the user's earlier mark for that problem |
| `listSeen` | `projectId, userId` | the user's marks in the project, by problem id |

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

`close()` releases the connection pool (nothing for memory).
