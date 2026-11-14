-- Issue #2446 (epic #2438) — record which sources each analysis finding,
-- citation and requirement drew on, at write time, as ids only.
--
-- "findings"."sourceIds", "requirements"."sourceIds" and
-- "cross_doc_findings"."sourceIds" (TEXT, nullable): JSON of the `Document` and
-- `KnowledgeChunk` ids the row drew on (a finding also per citation). NULL
-- means "not recorded", never "no sources".
--
-- "analyses"."sourceAccess" (TEXT, nullable): whose access the run read its
-- sources with; `shared` (the #2314 shared audience) for every run started
-- from now on. Every existing run reads NULL, the marker that it keeps the
-- shared-audience rule: nothing is backfilled.
--
-- Rollback: server/prisma/postgres/rollbacks/20261128002446_issue2446_source_provenance.sql

ALTER TABLE "analyses" ADD COLUMN IF NOT EXISTS "sourceAccess" TEXT;
ALTER TABLE "findings" ADD COLUMN IF NOT EXISTS "sourceIds" TEXT;
ALTER TABLE "requirements" ADD COLUMN IF NOT EXISTS "sourceIds" TEXT;
ALTER TABLE "cross_doc_findings" ADD COLUMN IF NOT EXISTS "sourceIds" TEXT;
