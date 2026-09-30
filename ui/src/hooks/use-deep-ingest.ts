"use client";

/**
 * Deep Ingest as a background job — Issue #373.
 *
 * Deep Ingest used to be one request that lasted as long as the ingest; on a
 * large repository the Next.js proxy gave up after 5 minutes and the page showed
 * a 500 while the ingest went on to succeed. The server now answers
 * `202 { jobId }` at once and reports on the `job:lifecycle` bus under kind
 * `repo-ingest`. This hook:
 *   - starts the run and treats the connector as running until the job's
 *     terminal event, not until the request returns;
 *   - follows the job through {@link useJobToast}, which also fires the single
 *     terminal toast (the failure text is the server's generic message, #254);
 *   - turns the 409 `INGEST_IN_PROGRESS` a second click gets into "already
 *     running", and follows the running job when the server names it.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import type { JobLifecycleEvent } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { useJobToast } from "@/hooks/use-job-toast";

export interface DeepIngestOutcome {
  connectorId: string;
  status: "completed" | "failed";
  message: string;
  /** #432 — parts of a completed run that failed; non-zero is a partial run. */
  failureCount: number;
}

export interface UseDeepIngestOptions {
  /** After the run ends, either way — e.g. refresh the connector lists. */
  onSettled?: (connectorId: string) => void;
  /** When the run could not be started (not for "already running"). */
  onError?: (connectorId: string) => void;
}

const INGEST_IN_PROGRESS = "INGEST_IN_PROGRESS";

/** The running job's id from a 409 `INGEST_IN_PROGRESS`, when the server named one. */
function runningJobId(err: ApiError): string | null {
  const details = err.details as { jobId?: unknown } | null | undefined;
  return typeof details?.jobId === "string" ? details.jobId : null;
}

export function useDeepIngest(projectId: string, options: UseDeepIngestOptions = {}) {
  const [job, setJob] = useState<{ connectorId: string; jobId: string } | null>(null);
  const [outcome, setOutcome] = useState<DeepIngestOutcome | null>(null);

  const mutation = useMutation({
    mutationFn: (connectorId: string) => repoConnectorsApi.deepIngest(projectId, connectorId),
    onSuccess: (data, connectorId) => {
      setOutcome(null);
      setJob({ connectorId, jobId: data.jobId });
    },
    onError: (err, connectorId) => {
      if (err instanceof ApiError && err.status === 409 && err.code === INGEST_IN_PROGRESS) {
        toast.info(err.message);
        const jobId = runningJobId(err);
        if (jobId) setJob({ connectorId, jobId });
        return;
      }
      toast.error(err instanceof ApiError ? err.message : "Deep ingest failed");
      options.onError?.(connectorId);
    },
  });

  const progress = useJobToast(job?.jobId, {
    onTerminal: (event: JobLifecycleEvent) => {
      if (!job) return;
      const failed = event.status === "failed";
      setOutcome({
        connectorId: job.connectorId,
        status: failed ? "failed" : "completed",
        message: failed
          ? (event.error ?? "Deep ingest failed")
          : (event.message ?? "Deep ingest complete"),
        failureCount: event.failureCount ?? 0,
      });
      setJob(null);
      options.onSettled?.(job.connectorId);
    },
  });

  const runningConnectorId =
    job?.connectorId ?? (mutation.isPending ? (mutation.variables ?? null) : null);

  return {
    start: (connectorId: string) => mutation.mutate(connectorId),
    /** The connector whose Deep Ingest is in flight, or null. */
    runningConnectorId,
    /** The running job's latest lifecycle event, for a progress bar. */
    progress,
    /** How the last run ended, until the next one starts or it is cleared. */
    outcome,
    clearOutcome: () => setOutcome(null),
  };
}
