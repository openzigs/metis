/**
 * #1059 — test-only: abort and forget every Spec Kit job this process is
 * running, so one test's parked command cannot outlive it. Production code has
 * no such switch; this reaches the runner's registry directly.
 */
import { liveSpecKitJobs } from "../../src/lib/spec-kit/job-registry.js";

export function stopLiveSpecKitJobs(): void {
  for (const job of liveSpecKitJobs.values()) job.stop("superseded");
  liveSpecKitJobs.clear();
}
