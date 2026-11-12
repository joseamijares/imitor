-- Projects are addressed by a slug in the interface (/p/<slug>/...): short, readable, unique, never reused while the
-- project exists. Projects made before this get their id as their slug.
alter table projects add column slug text;
update projects set slug = id where slug is null;
alter table projects alter column slug set not null;
create unique index projects_slug on projects (slug);
