-- The waitlist for the hosted service: addresses left on the public site's pricing page (src/waitlist.mjs). They are
-- not users and admit nobody: an address here is only someone to write to when the hosted service opens. Stored in
-- lower case, one row per address.
create table waitlist (
  email       text primary key check (email = lower(email)),
  created_at  timestamptz not null
);
