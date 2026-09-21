-- Epic #260 (#45): JUnit round-trip execution verdict on coverage mappings.
-- See the SQLite mirror for full context. Nullable columns -> no backfill.

-- AlterTable
ALTER TABLE "coverage_mappings" ADD COLUMN     IF NOT EXISTS "lastResult" TEXT,
ADD COLUMN     IF NOT EXISTS "lastResultAt" TIMESTAMP(3),
ADD COLUMN     IF NOT EXISTS "lastResultRunRef" TEXT;
