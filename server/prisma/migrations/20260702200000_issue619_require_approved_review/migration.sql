-- Epic #609 (#619) — per-project approval gate on publish/export flows.
ALTER TABLE "projects" ADD COLUMN "requireApprovedReview" BOOLEAN NOT NULL DEFAULT false;
