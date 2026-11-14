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
-- Rollback: server/prisma/rollbacks/20261128002446_issue2446_source_provenance.sql
-- (exercised by server/tests/source-provenance-migration-2446.sqlite.test.ts).

-- AlterTable
ALTER TABLE "analyses" ADD COLUMN "sourceAccess" TEXT;

-- AlterTable
ALTER TABLE "findings" ADD COLUMN "sourceIds" TEXT;

-- AlterTable
ALTER TABLE "requirements" ADD COLUMN "sourceIds" TEXT;

-- AlterTable
ALTER TABLE "cross_doc_findings" ADD COLUMN "sourceIds" TEXT;
