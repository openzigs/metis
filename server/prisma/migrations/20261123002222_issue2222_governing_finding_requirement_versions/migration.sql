-- Issue #2222 — governing findings record the requirement versions they judged.
--
-- "governing_findings"."requirementVersions" (nullable TEXT): JSON
-- `{ "<stored requirement id>": <version> }`, written by a Re-check this
-- requirement run, so a finding judged on an older version of a requirement is
-- marked stale once the requirement is edited again. Existing rows read null:
-- they were produced from the analysed wording, which the reader compares with
-- each stored requirement's analysed version. No row is rewritten.
--
-- Rollback: server/prisma/rollbacks/20261123002222_issue2222_governing_finding_requirement_versions.sql
-- (exercised by server/tests/governing-finding-requirement-versions-migration-2222.sqlite.test.ts).

-- AlterTable
ALTER TABLE "governing_findings" ADD COLUMN "requirementVersions" TEXT;
