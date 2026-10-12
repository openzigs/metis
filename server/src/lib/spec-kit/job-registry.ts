/**
 * #1059 — the Spec Kit jobs THIS process is running, by job id.
 *
 * Only an accelerator: it lets a cancel, a time limit or a sweep handled by the
 * owning process abort the job's in-flight model call at once instead of at its
 * next heartbeat. It decides nothing. Who may save, and what a job's outcome
 * is, is decided by the `spec_kit_jobs` row (`job-store.ts`), which is the only
 * state every replica shares.
 *
 * Internal to the job runner (`jobs.ts`); nothing else in `src/` imports it.
 */
import type { SpecKitJobStopReason } from "./job-scope.js";

export interface LiveSpecKitJob {
  /** Abort the job's in-flight work. The first reason wins; later calls do nothing. */
  stop(reason: SpecKitJobStopReason): void;
}

export const liveSpecKitJobs = new Map<string, LiveSpecKitJob>();
