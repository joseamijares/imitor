-- A guard for databases where an earlier 002 gave projects their id as their slug (prj_0a1b...): the routes only
-- accept slugs of 1 to 64 characters in [a-z0-9-], so those projects could not be opened and their run links were
-- dead. Any slug outside that is replaced by its id made valid (lowercased, every other character a hyphen), plus the
-- start of an MD5 of the id when that is taken. On a database where every slug is valid this changes nothing.
update projects p
set slug = case
  when exists (select 1 from projects q where q.slug = left(trim(both '-' from regexp_replace(lower(p.id), '[^a-z0-9]+', '-', 'g')), 40))
    then left(trim(both '-' from regexp_replace(lower(p.id), '[^a-z0-9]+', '-', 'g')), 40) || '-' || left(md5(p.id), 8)
  else left(trim(both '-' from regexp_replace(lower(p.id), '[^a-z0-9]+', '-', 'g')), 40)
end
where p.slug !~ '^[a-z0-9-]{1,64}$';

-- Nothing writes another slug again: createProject only makes valid ones, and this keeps it so.
alter table projects add constraint projects_slug_valid check (slug ~ '^[a-z0-9-]{1,64}$');
