-- Imitor Cloud: the first schema, for plain Postgres (12 or newer).
-- The in-memory repository (cloud/src/db/memory.mjs) has the same tables and columns, named in camelCase there
-- (secret_sha256 is secretSha256); cloud/src/db/CONTRACT.md lists its methods and cloud/src/db/pg.mjs is the
-- repository on this schema. cloud/src/db/migrate.mjs runs each file in a transaction of its own, so files hold no
-- begin or commit.
-- Ids are text with a kind prefix (prj_, run_, key_, usr_), minted by the server.

-- People. Sign-in is Google (or the admin token on a private instance); `allowed` says the person was admitted: by
-- IMITOR_ALLOWED_EMAILS on their first sign-in, after which their identity's subject decides, not the address.
create table users (
  id          text primary key,
  email       text not null,
  name        text,
  allowed     boolean not null default false,
  created_at  timestamptz not null default now()
);
-- One user per address, whatever its case: Ada@Example.com and ada@example.com are the same person.
create unique index users_email on users (lower(email));

-- An identity at a sign-in provider: ("google", the ID token's `sub`). A user is found by this pair, never by email,
-- since an address can change hands; the primary key keeps each pair to one user. One user may have several.
create table identities (
  provider    text not null,
  subject     text not null,
  user_id     text not null references users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  primary key (provider, subject)
);

-- Browser sessions. Only a hash of the cookie value is stored.
create table sessions (
  id_hash     text primary key,
  user_id     text not null references users (id) on delete cascade,
  created_at  timestamptz not null default now(),
  expires_at  timestamptz not null
);
create index sessions_user on sessions (user_id);

create table projects (
  id          text primary key,
  name        text not null,
  created_at  timestamptz not null default now()
);

create table project_members (
  project_id  text not null references projects (id) on delete cascade,
  user_id     text not null references users (id) on delete cascade,
  role        text not null default 'member' check (role in ('owner', 'member')),
  created_at  timestamptz not null default now(),
  primary key (project_id, user_id)
);

-- Write-only upload keys (imk_...). The secret is shown once; only its SHA-256 (hex) is kept, plus a short prefix
-- to tell keys apart in the interface. expires_at null means the key does not expire.
create table access_keys (
  id            text primary key,
  project_id    text not null references projects (id) on delete cascade,
  name          text not null,
  prefix        text not null,
  secret_sha256 text not null unique,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  revoked_at    timestamptz,
  expires_at    timestamptz
);
create index access_keys_project on access_keys (project_id);

-- One pushed run. (project_id, client_run_id) makes a push idempotent. files: [{ path, size, sha256, contentType,
-- key }], where key is "<project_id>/<id>/<path>" in object storage.
create table runs (
  id              text primary key,
  project_id      text not null references projects (id) on delete cascade,
  client_run_id   text not null,
  schema_version  integer not null default 1,
  status          text not null default 'uploading' check (status in ('uploading', 'ready')),
  run             jsonb not null,
  manifest        jsonb not null,
  files           jsonb not null default '[]',
  key_id          text references access_keys (id) on delete set null,
  created_at      timestamptz not null default now(),
  completed_at    timestamptz,
  unique (project_id, client_run_id)
);
-- Listing and pruning: the newest ready runs of a project, by completion time, then id for runs completed together.
create index runs_project_ready on runs (project_id, completed_at desc, id desc) where status = 'ready';
-- Unfinished uploads: at most 5 per project, dropped 24 hours after created_at.
create index runs_project_uploading on runs (project_id, created_at) where status = 'uploading';

-- Object keys of deleted runs that storage has not confirmed deleting yet. A run's keys are written here before the
-- run is deleted and removed once storage has deleted them; every create and complete retries what is left. No
-- foreign key: the files must go even after their project does.
create table pending_deletions (
  key         text primary key,
  project_id  text not null,
  created_at  timestamptz not null default now()
);
create index pending_deletions_project on pending_deletions (project_id);

-- Lines of captures/index.jsonl and activity.jsonl that came with a run.
create table captures (
  id          bigint generated always as identity primary key,
  project_id  text not null references projects (id) on delete cascade,
  run_id      text not null references runs (id) on delete cascade,
  line        jsonb not null,
  created_at  timestamptz not null default now()
);
create index captures_run on captures (run_id);

create table activity (
  id          bigint generated always as identity primary key,
  project_id  text not null references projects (id) on delete cascade,
  run_id      text not null references runs (id) on delete cascade,
  line        jsonb not null,
  created_at  timestamptz not null default now()
);
create index activity_run on activity (run_id);

-- Problems a person marked seen (or explicitly not seen), per user, as state.json does locally. A problem id is
-- derived from its run's id (src/derive.mjs problemId), so its rows go when the run does.
create table seen (
  project_id  text not null references projects (id) on delete cascade,
  run_id      text not null references runs (id) on delete cascade,
  user_id     text not null references users (id) on delete cascade,
  problem_id  text not null,
  seen        boolean not null,
  updated_at  timestamptz not null default now(),
  primary key (project_id, user_id, problem_id)
);
create index seen_run on seen (run_id);

-- Who did what: run.create, run.complete, run.prune, key.create, key.revoke, project.create, user.create,
-- user.signin, user.signout, user.signout-everywhere. Who is in the columns; what is in detail, an object:
-- { runId, clientRunId } for run.create, { runId } for run.complete, { runId, reason: "newest-runs" | "age" |
-- "unfinished" } for run.prune, { keyId, name } for key.create and key.revoke, { name, slug } for project.create,
-- { email, via: "google" | "admin-token" } for user.create and user.signin.
create table audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  project_id  text references projects (id) on delete set null,
  user_id     text references users (id) on delete set null,
  key_id      text references access_keys (id) on delete set null,
  action      text not null,
  detail      jsonb not null default '{}'
);
create index audit_log_project on audit_log (project_id, at desc);
