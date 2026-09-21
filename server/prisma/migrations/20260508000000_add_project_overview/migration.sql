-- Epic #298 / #313 — cached project_overview.md.
--
-- Two nullable columns on `projects`. Backfill is deliberately a no-op:
-- the overview is generated on demand via the `regenerate` endpoint, so
-- existing rows simply carry NULL until the first generation.

ALTER TABLE "projects" ADD COLUMN "overviewMarkdown" TEXT;
ALTER TABLE "projects" ADD COLUMN "overviewGeneratedAt" DATETIME;
