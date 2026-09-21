-- Epic #260 (#45): JUnit round-trip execution verdict on coverage mappings.
-- A JUnit XML upload matches each <testcase> to a TestCaseDoc and propagates
-- pass/fail/skip to the linked requirement(s) via the active run's
-- CoverageMapping rows. These nullable columns capture the latest verdict so
-- the report/UI can surface a per-requirement execution status badge.

-- AlterTable
ALTER TABLE "coverage_mappings" ADD COLUMN "lastResult" TEXT;
ALTER TABLE "coverage_mappings" ADD COLUMN "lastResultAt" DATETIME;
ALTER TABLE "coverage_mappings" ADD COLUMN "lastResultRunRef" TEXT;
