-- Phase 7: promote requirement review status from a `review:*` pseudo-label
-- inside the JSON `labels` blob to a typed column so we can index/filter on
-- it. The legacy parsing path stays in `analysis-service.ts` so older rows
-- without the column populated still surface a status on read.

ALTER TABLE "requirements" ADD COLUMN "reviewStatus" TEXT;

-- Backfill the typed column from any existing `review:<status>` entries
-- inside the JSON labels blob. We only need to handle the four valid
-- statuses; anything else stays NULL and the read path defaults to "draft".
UPDATE "requirements"
SET "reviewStatus" = 'approved'
WHERE "reviewStatus" IS NULL AND "labels" LIKE '%"review:approved"%';

UPDATE "requirements"
SET "reviewStatus" = 'rejected'
WHERE "reviewStatus" IS NULL AND "labels" LIKE '%"review:rejected"%';

UPDATE "requirements"
SET "reviewStatus" = 'deferred'
WHERE "reviewStatus" IS NULL AND "labels" LIKE '%"review:deferred"%';

UPDATE "requirements"
SET "reviewStatus" = 'draft'
WHERE "reviewStatus" IS NULL AND "labels" LIKE '%"review:draft"%';
