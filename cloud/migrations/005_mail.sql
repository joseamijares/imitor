-- Mail the cloud sends (src/mail/). Before sending, notify() counts in audit_log what was sent in the last 24 hours:
-- by the person whose action sends it (user_id, action, at), and to one address from anyone (detail->>'to' of
-- mail.send rows, the expression countAudit writes). Counted in the database, not in memory, because on a serverless
-- platform each instance has its own memory. The second index is partial: only mail.send rows carry a `to` worth
-- finding, so the rest of the log does not grow it.
-- Indexes only, so code from before this migration (which never counts) keeps working on this schema.
create index audit_log_user_action on audit_log (user_id, action, at desc);
create index audit_log_mail_to on audit_log ((detail->>'to'), at desc) where action = 'mail.send';

-- Audit actions added with mail: mail.send { kind, to, id } (sent; id is the provider's message id),
-- mail.fail { kind, to, status } (the provider refused or did not answer; status is its HTTP status or null),
-- mail.limit { kind, to } (not sent: the sender or the address reached its daily limit).
