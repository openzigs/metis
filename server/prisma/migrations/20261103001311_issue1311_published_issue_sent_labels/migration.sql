-- Issue #1311 — record the labels METIS sent each published GitHub issue.
--
--   sentLabels  JSON array of the label names the issue was sent (or was found
--               already carrying) on this row's publish. A later publish whose
--               body is unchanged compares the labels it would send with these,
--               so a change to the draft's own labels now relabels the issue.
--               Before, the comparison used the draft's CURRENT labels plus the
--               earlier batch's Additional labels, so a draft label change went
--               unnoticed and showed as drift instead.
--
-- Not backfilled: no existing row records what it sent. A NULL keeps the
-- earlier comparison (the draft's current labels plus the matched batch's
-- Additional labels) until the issue's next publish fills the column in.
--
-- Rollback (documentation):
--   ALTER TABLE "published_issues" DROP COLUMN "sentLabels";

-- AlterTable
ALTER TABLE "published_issues" ADD COLUMN "sentLabels" TEXT;
