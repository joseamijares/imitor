-- Projects are addressed by a slug in the interface (/p/<slug>/...): short, readable, unique, never reused while the
-- project exists, and only [a-z0-9-] (the routes accept nothing else). Projects made before this get their id with
-- the underscore as a hyphen as their slug: prj_0a1b... becomes prj-0a1b....
alter table projects add column slug text;
update projects set slug = lower(replace(id, '_', '-')) where slug is null;
alter table projects alter column slug set not null;
create unique index projects_slug on projects (slug);
