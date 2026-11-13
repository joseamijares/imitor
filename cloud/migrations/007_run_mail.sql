-- Run problem emails (src/api.mjs runMail): when an uploaded run with problems is completed, the project's members who
-- have signed in are emailed, unless they turned it off for that project. On by default, per membership.
-- - notify_runs: whether this member gets them. Settings (POST /p/<slug>/api/notifications) and the unsubscribe link
--   change it.
-- - run_mail_token: the secret in each message's unsubscribe link (GET and POST /unsubscribe?t=<token>), made the
--   first time a message is sent to the membership and then reused, so a link in an old message keeps working. Random,
--   so it reveals no id, and it can only turn run emails off for this one membership. Kept as is (not hashed), because
--   every later message must carry the same link.
-- Both go with the row: removing someone and adding them again starts from the default, with a new token.
-- Additive only: old code inserts members without these columns (they take their defaults) and never reads them.
alter table project_members add column notify_runs boolean not null default true;
alter table project_members add column run_mail_token text;
create unique index project_members_run_mail_token on project_members (run_mail_token) where run_mail_token is not null;

-- Audit actions added with run emails: member.run-mail { on, via: "settings" | "unsubscribe" } (the member's own
-- choice; user_id is that member). The messages are audited as mail.send, mail.fail and mail.limit with kind
-- "runProblems" (see 006_mail.sql), with project_id set: the per-project cap counts by it, through 006's index
-- audit_log_mail_to (detail->>'to', at), with project_id checked on the few rows it finds; no new index is needed.
