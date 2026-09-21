"use client";

/**
 * Epic #930 — admin Embeddings backends page.
 *
 * Shows the active embedding backend (model, dimension, egress requirement)
 * with a live health badge, the full registry of selectable backends, and a
 * per-project coverage + reindex control so an operator can migrate a project
 * to the active backend's dimension after switching backends.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { embeddingsApi } from "@/lib/embeddings-api";
import { queryKeys } from "@/lib/query-keys";
import { useJobToast } from "@/hooks/use-job-toast";
import { JobProgress } from "@/components/realtime/job-progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export default function AdminEmbeddingsPage() {
  const qc = useQueryClient();
  const [projectId, setProjectId] = useState("");
  const [submittedProjectId, setSubmittedProjectId] = useState("");
  // Issue #423 — the reindex is async now: the POST returns a `jobId` we
  // subscribe to for live progress; the final outcome arrives over the bus and
  // is stashed here for a persistent at-a-glance confirmation (the toast is the
  // transient terminal feedback).
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [lastReindexMessage, setLastReindexMessage] = useState<string | null>(null);

  const status = useQuery({
    queryKey: queryKeys.admin.embeddings(),
    queryFn: () => embeddingsApi.status(),
  });

  const coverage = useQuery({
    queryKey: queryKeys.admin.embeddingsCoverage(submittedProjectId),
    queryFn: () => embeddingsApi.coverage(submittedProjectId),
    enabled: submittedProjectId.length > 0,
  });

  // Subscribe to the in-flight reindex job: drives the progress bar and fires the
  // terminal success/failure toast (the failure text is already the server's
  // user-safe generic message, #254). On terminal, refresh coverage and clear.
  const jobEvent = useJobToast(activeJobId, {
    onTerminal: (event) => {
      if (event.status === "completed") {
        setLastReindexMessage(event.message ?? "Reindex complete.");
      }
      qc.invalidateQueries({
        queryKey: queryKeys.admin.embeddingsCoverage(submittedProjectId),
      }).catch(() => {});
      setActiveJobId(null);
    },
  });

  const reindex = useMutation({
    mutationFn: (id: string) => embeddingsApi.reindex(id),
    onSuccess: (enqueued) => {
      setLastReindexMessage(null);
      setActiveJobId(enqueued.jobId);
    },
  });

  const reindexing = activeJobId !== null || reindex.isPending;
  const active = status.data?.active;

  return (
    <div className="space-y-6 p-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Embedding backends</h1>
        <p className="text-sm text-muted-foreground">
          The active backend powers retrieval (RAG) embeddings. Switching backends may change the
          vector dimension — reindex each project below so its stored vectors match the active
          model.
        </p>
      </header>

      <Card className="space-y-4 p-6" data-testid="active-backend">
        <div className="flex items-center justify-between gap-4">
          <h2 className="text-lg font-semibold">Active backend</h2>
          {status.isLoading ? (
            <Badge variant="secondary">Checking…</Badge>
          ) : active?.healthy ? (
            <Badge variant="default" data-testid="health-badge">
              Healthy
            </Badge>
          ) : (
            <Badge variant="destructive" data-testid="health-badge">
              Unhealthy
            </Badge>
          )}
        </div>

        {status.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Failed to load backend status.
          </p>
        ) : active ? (
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm sm:grid-cols-4">
            <div>
              <dt className="text-muted-foreground">Key</dt>
              <dd className="font-mono" data-testid="active-key">
                {active.key}
              </dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Model</dt>
              <dd className="font-mono break-all">{active.model}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Dimension</dt>
              <dd className="font-mono">{active.dimension}</dd>
            </div>
            <div>
              <dt className="text-muted-foreground">Network egress</dt>
              <dd>
                {active.requiresEgress ? (
                  <Badge variant="outline">Required</Badge>
                ) : (
                  <Badge variant="secondary">None (offline-capable)</Badge>
                )}
              </dd>
            </div>
          </dl>
        ) : null}

        {active && !active.healthy && active.error ? (
          <p className="text-sm text-destructive" role="alert" data-testid="health-error">
            {active.error}
          </p>
        ) : null}
      </Card>

      <Card className="p-0" data-testid="backends-table">
        <div className="border-b px-6 py-4">
          <h2 className="text-lg font-semibold">Registered backends</h2>
          <p className="text-sm text-muted-foreground">
            Set <code className="font-mono">EMBED_BACKEND</code> to one of these keys to select a
            backend per deployment.
          </p>
        </div>
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-6 py-3">Key</th>
              <th className="px-6 py-3">Label</th>
              <th className="px-6 py-3">Network egress</th>
              <th className="px-6 py-3">Offline-capable</th>
            </tr>
          </thead>
          <tbody>
            {(status.data?.backends ?? []).length === 0 ? (
              <tr>
                <td className="px-6 py-6 text-muted-foreground" colSpan={4}>
                  {status.isLoading ? "Loading…" : "No backends registered."}
                </td>
              </tr>
            ) : (
              (status.data?.backends ?? []).map((b) => (
                <tr key={b.key} className="border-t">
                  <td className="px-6 py-3 font-mono">{b.key}</td>
                  <td className="px-6 py-3">{b.label}</td>
                  <td className="px-6 py-3">
                    {b.requiresEgress ? (
                      <Badge variant="outline">Required</Badge>
                    ) : (
                      <Badge variant="secondary">None</Badge>
                    )}
                  </td>
                  <td className="px-6 py-3">{b.offlineCapable ? "Yes" : "No"}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <Card className="space-y-4 p-6" data-testid="reindex-panel">
        <h2 className="text-lg font-semibold">Project coverage &amp; reindex</h2>
        <form
          className="flex items-end gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            setLastReindexMessage(null);
            setActiveJobId(null);
            setSubmittedProjectId(projectId.trim());
          }}
        >
          <div className="flex-1 max-w-md">
            <label htmlFor="project-id" className="text-sm text-muted-foreground">
              Project ID
            </label>
            <Input
              id="project-id"
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              placeholder="proj_…"
              data-testid="project-id-input"
            />
          </div>
          <Button type="submit" disabled={projectId.trim().length === 0}>
            Check coverage
          </Button>
        </form>

        {submittedProjectId.length > 0 ? (
          coverage.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading coverage…</p>
          ) : coverage.isError ? (
            <p className="text-sm text-destructive" role="alert">
              {coverage.error instanceof ApiError
                ? coverage.error.message
                : "Failed to load coverage."}
            </p>
          ) : coverage.data ? (
            <div className="space-y-3" data-testid="coverage-report">
              <div className="flex flex-wrap items-center gap-4 text-sm">
                <span>
                  <span className="text-muted-foreground">Total chunks:</span>{" "}
                  <span className="font-mono">{coverage.data.totalChunks}</span>
                </span>
                <span>
                  <span className="text-muted-foreground">Matching active model:</span>{" "}
                  <span className="font-mono">{coverage.data.matchingChunks}</span>
                </span>
                {coverage.data.needsReindex ? (
                  <Badge variant="destructive" data-testid="needs-reindex">
                    Reindex recommended
                  </Badge>
                ) : (
                  <Badge variant="secondary" data-testid="coverage-ok">
                    Up to date
                  </Badge>
                )}
              </div>

              {coverage.data.mismatchedModels.length > 0 ? (
                <p className="text-sm text-muted-foreground">
                  Chunks embedded with other models:{" "}
                  <span className="font-mono">{coverage.data.mismatchedModels.join(", ")}</span>
                </p>
              ) : null}

              <Button
                variant="destructive"
                disabled={reindexing || coverage.data.totalChunks === 0}
                onClick={() => reindex.mutate(submittedProjectId)}
                data-testid="reindex-button"
              >
                {reindexing
                  ? "Reindexing…"
                  : `Reindex to ${coverage.data.currentModel} (${coverage.data.currentDimension}d)`}
              </Button>

              {activeJobId ? (
                <JobProgress
                  progress={jobEvent?.progress}
                  message={jobEvent?.message ?? "Reindexing embeddings…"}
                  label="Reindex progress"
                  testId="reindex-progress"
                />
              ) : null}

              {reindex.isError ? (
                <p className="text-sm text-destructive" role="alert">
                  {reindex.error instanceof ApiError ? reindex.error.message : "Reindex failed."}
                </p>
              ) : null}

              {lastReindexMessage ? (
                <p className="text-sm text-emerald-600" data-testid="reindex-result">
                  {lastReindexMessage}
                </p>
              ) : null}
            </div>
          ) : null
        ) : null}
      </Card>
    </div>
  );
}
