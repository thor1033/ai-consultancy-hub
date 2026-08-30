-- Teardown for the tables removed when the hub was stripped to agents, knowledge
-- and MCP. Run this by hand, once, per database:
--
--   psql "$DATABASE_URL" -f packages/db/drop-legacy.sql
--
-- Deliberately NOT part of schema.sql, because migrate.mjs applies that file on
-- every deploy and this one DESTROYS DATA that cannot be recovered: every skill
-- and its versions, the whole skill_runs history the ROI figures were computed
-- from, scheduled automations, saved PowerPoint templates, and every AI Readiness
-- Assessment lead a prospect ever submitted. Export anything you still want
-- before running it. Leaving these tables in place is harmless — nothing reads
-- them any more.

begin;

-- skill_versions, skill_runs, skill_schedules and skill_grants all reference
-- skills; cascade takes them with it rather than requiring a drop order.
drop table if exists skill_grants    cascade;
drop table if exists skill_schedules cascade;
drop table if exists skill_runs      cascade;
drop table if exists skill_versions  cascade;
drop table if exists skills          cascade;

drop table if exists templates       cascade;
drop table if exists assessments     cascade;

commit;
