-- Phase 11 security review fix H5: persist `lastFiredAt` so cron idempotency
-- survives process restarts and tolerates concurrent multi-process firings.
ALTER TABLE "scheduled_jobs" ADD COLUMN "lastFiredAt" DATETIME;
