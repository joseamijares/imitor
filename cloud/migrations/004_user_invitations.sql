-- An address an owner added to a project before its person ever signed in. Only a user row with invited_at, not any
-- allowed one, lets a first Google sign-in in without IMITOR_ALLOWED_EMAILS (see admit in src/web.mjs): an allowed
-- row made another way, such as the admin-token user, never stands in for an invitation.
-- Added as nullable, so code from before this migration (which never reads it) keeps working on this schema.
alter table users add column invited_at timestamptz;

-- Audit actions added with members: user.invite { email }, member.add { email, role },
-- member.role { email, role, from }, member.remove { email, self }.
