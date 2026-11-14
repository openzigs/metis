-- Issue #2448 (epic #2438) — an analysis's code passes read with the access of
-- the person who ran them, and record what each pass read.
--
-- "agent_results"."readSourceIds" (TEXT, nullable): JSON of the restricted
-- `Document` ids (`{"documentIds":[...],"chunkIds":[]}`) one pass of a run read
-- with that person's access, plus what the earlier passes of the run read.
-- Written on a run whose "analyses"."sourceAccess" is `starter`, where every
-- finding the pass writes rests on it too. NULL means "not recorded", never
-- "read nothing": on a `starter` run a reader then fails closed. Every
-- existing row reads NULL; its run is `shared` or older, whose rule never
-- reads it. Nothing is backfilled.
--
-- Rollback: server/prisma/rollbacks/20261129002448_issue2448_pass_read_sets.sql
-- (exercised by server/tests/pass-read-sets-migration-2448.sqlite.test.ts).

-- AlterTable
ALTER TABLE "agent_results" ADD COLUMN "readSourceIds" TEXT;
