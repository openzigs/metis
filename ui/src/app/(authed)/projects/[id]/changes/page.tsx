"use client";

/**
 * Change Analysis page — Epic #557 / Issue #568.
 *
 * Lists change analysis runs, allows triggering new ones (base vs head),
 * and displays detected changes with approve/reject workflow.
 */
import { useState } from "react";
import { useParams } from "next/navigation";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "@/lib/query-keys";
import { changeAnalysisApi } from "@/lib/change-analysis-api";
import { apiFetch } from "@/lib/api-client";
import {
  formatChangeRunLabels,
  formatRunTimestamp,
  shortRunId,
} from "@/lib/format-change-run-label";
import type { ChangeAnalysisDetail, RequirementChange } from "@metis/shared";

type Analysis = { id: string; status: string; startedAt: string; completedAt: string | null };

export default function ChangeAnalysisPage() {
  const params = useParams();
  const projectId = params.id as string;
  const queryClient = useQueryClient();

  const [selectedAnalysis, setSelectedAnalysis] = useState<string | null>(null);
  const [baseAnalysisId, setBaseAnalysisId] = useState("");
  const [headAnalysisId, setHeadAnalysisId] = useState("");

  // Fetch analyses for the project (for the trigger form). This key is shared
  // with the Analysis page and the project Overview, which cache the
  // `{ items }` envelope — so cache that here too and unwrap with `select`.
  // Caching the bare array left those readers with no `.items` on a fresh cache.
  const { data: analyses } = useQuery({
    queryKey: queryKeys.analyses.forProject(projectId),
    queryFn: () => apiFetch<{ items: Analysis[] }>(`/projects/${projectId}/analyses`),
    select: (r) => r.items,
  });

  // Fetch change analyses
  const { data: changeAnalyses, isLoading } = useQuery({
    queryKey: queryKeys.changeAnalysis.forProject(projectId),
    queryFn: () => changeAnalysisApi.list(projectId),
  });

  // #430: human-readable, unambiguous run labels (stable sequence + date-time)
  // keyed by run id; the truncated id is kept only as a secondary token.
  const runLabels = formatChangeRunLabels(changeAnalyses ?? []).byId;

  // Fetch selected change analysis detail
  const { data: detail } = useQuery({
    queryKey: queryKeys.changeAnalysis.detail(projectId, selectedAnalysis ?? ""),
    queryFn: () => changeAnalysisApi.get(projectId, selectedAnalysis!),
    enabled: !!selectedAnalysis,
  });

  // Trigger mutation
  const triggerMutation = useMutation({
    mutationFn: () =>
      changeAnalysisApi.trigger(projectId, {
        baseAnalysisId,
        headAnalysisId,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.changeAnalysis.forProject(projectId),
      });
      setBaseAnalysisId("");
      setHeadAnalysisId("");
    },
  });

  // Review mutation
  const reviewMutation = useMutation({
    mutationFn: (opts: { changeId: string; reviewStatus: "approved" | "rejected" }) =>
      changeAnalysisApi.reviewChange(projectId, selectedAnalysis!, opts.changeId, {
        reviewStatus: opts.reviewStatus,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.changeAnalysis.detail(projectId, selectedAnalysis ?? ""),
      });
    },
  });

  const completedAnalyses = (analyses ?? []).filter((a) => a.status === "completed");

  return (
    <div className="space-y-6">
      <div className="px-6">
        <h1 className="text-2xl font-bold mb-4">Change Analysis</h1>
        <p className="text-muted-foreground mb-6">
          Compare requirements between analysis runs to detect additions, removals, and
          modifications.
        </p>

        {/* Trigger form */}
        <div className="rounded-lg border bg-card p-4 mb-6" data-testid="trigger-form">
          <h2 className="text-lg font-semibold mb-3">Trigger New Analysis</h2>
          <div className="flex gap-4 items-end">
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Base Analysis</label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={baseAnalysisId}
                onChange={(e) => setBaseAnalysisId(e.target.value)}
                data-testid="base-analysis-select"
              >
                <option value="">Select base…</option>
                {completedAnalyses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {formatRunTimestamp(a.startedAt)} — {shortRunId(a.id)}
                  </option>
                ))}
              </select>
            </div>
            <div className="flex-1">
              <label className="block text-sm font-medium mb-1">Head Analysis</label>
              <select
                className="w-full rounded-md border bg-background px-3 py-2 text-sm"
                value={headAnalysisId}
                onChange={(e) => setHeadAnalysisId(e.target.value)}
                data-testid="head-analysis-select"
              >
                <option value="">Select head…</option>
                {completedAnalyses.map((a) => (
                  <option key={a.id} value={a.id}>
                    {formatRunTimestamp(a.startedAt)} — {shortRunId(a.id)}
                  </option>
                ))}
              </select>
            </div>
            <button
              className="rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
              disabled={
                !baseAnalysisId ||
                !headAnalysisId ||
                baseAnalysisId === headAnalysisId ||
                triggerMutation.isPending
              }
              onClick={() => triggerMutation.mutate()}
              data-testid="trigger-btn"
            >
              {triggerMutation.isPending ? "Analyzing…" : "Compare"}
            </button>
          </div>
          {triggerMutation.isError && (
            <p className="mt-2 text-sm text-destructive">
              {(triggerMutation.error as Error).message}
            </p>
          )}
        </div>

        {/* Change analyses list */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="lg:col-span-1">
            <h2 className="text-lg font-semibold mb-3">Analysis History</h2>
            {isLoading && <p className="text-sm text-muted-foreground">Loading…</p>}
            <div className="space-y-2" data-testid="analysis-list">
              {(changeAnalyses ?? []).map((ca) => (
                <button
                  key={ca.id}
                  onClick={() => setSelectedAnalysis(ca.id)}
                  className={`w-full rounded-lg border p-3 text-left text-sm transition-colors ${
                    selectedAnalysis === ca.id ? "border-primary bg-primary/5" : "hover:bg-muted/50"
                  }`}
                  data-testid={`ca-item-${ca.id}`}
                >
                  <div className="flex justify-between items-center gap-2">
                    <span className="font-medium">
                      {runLabels.get(ca.id)?.primary ?? `Run — ${formatRunTimestamp(ca.startedAt)}`}
                    </span>
                    <StatusBadge status={ca.status} />
                  </div>
                  <div className="text-muted-foreground mt-1">
                    <span className="font-mono text-xs" data-testid={`ca-shortid-${ca.id}`}>
                      {runLabels.get(ca.id)?.shortId ?? ca.id.slice(0, 8)}
                    </span>
                    {ca.totalChanges > 0 && (
                      <span className="ml-2">
                        {ca.additions > 0 && (
                          <span className="text-green-600">+{ca.additions}</span>
                        )}
                        {ca.removals > 0 && (
                          <span className="text-red-600 ml-1">-{ca.removals}</span>
                        )}
                        {ca.modifications > 0 && (
                          <span className="text-yellow-600 ml-1">~{ca.modifications}</span>
                        )}
                      </span>
                    )}
                  </div>
                </button>
              ))}
              {!isLoading && (changeAnalyses ?? []).length === 0 && (
                <p className="text-sm text-muted-foreground">No change analyses yet.</p>
              )}
            </div>
          </div>

          {/* Detail panel */}
          <div className="lg:col-span-2">
            {selectedAnalysis && detail ? (
              <ChangeAnalysisDetailPanel
                detail={detail}
                onReview={(changeId, status) =>
                  reviewMutation.mutate({ changeId, reviewStatus: status })
                }
                isReviewing={reviewMutation.isPending}
              />
            ) : (
              <div className="rounded-lg border p-8 text-center text-muted-foreground">
                Select a change analysis to view details
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-yellow-100 text-yellow-800",
    running: "bg-blue-100 text-blue-800",
    completed: "bg-green-100 text-green-800",
    failed: "bg-red-100 text-red-800",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        colors[status] ?? "bg-gray-100 text-gray-800"
      }`}
    >
      {status}
    </span>
  );
}

function ChangeAnalysisDetailPanel({
  detail,
  onReview,
  isReviewing,
}: {
  detail: ChangeAnalysisDetail;
  onReview: (changeId: string, status: "approved" | "rejected") => void;
  isReviewing: boolean;
}) {
  return (
    <div data-testid="change-detail">
      <div className="flex justify-between items-center mb-4">
        <h2 className="text-lg font-semibold">Change Analysis Detail</h2>
        <StatusBadge status={detail.status} />
      </div>

      {detail.summary && <p className="text-sm text-muted-foreground mb-4">{detail.summary}</p>}

      <div className="grid grid-cols-3 gap-4 mb-6">
        <StatCard label="Additions" value={detail.additions} color="text-green-600" />
        <StatCard label="Removals" value={detail.removals} color="text-red-600" />
        <StatCard label="Modifications" value={detail.modifications} color="text-yellow-600" />
      </div>

      <h3 className="text-md font-semibold mb-3">Changes</h3>
      <div className="space-y-3" data-testid="changes-list">
        {detail.changes.map((change) => (
          <ChangeCard
            key={change.id}
            change={change}
            onReview={onReview}
            isReviewing={isReviewing}
          />
        ))}
        {detail.changes.length === 0 && (
          <p className="text-sm text-muted-foreground">No changes detected.</p>
        )}
      </div>
    </div>
  );
}

function StatCard({ label, value, color }: { label: string; value: number; color: string }) {
  return (
    <div className="rounded-lg border p-3 text-center">
      <div className={`text-2xl font-bold ${color}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

function ChangeCard({
  change,
  onReview,
  isReviewing,
}: {
  change: RequirementChange;
  onReview: (changeId: string, status: "approved" | "rejected") => void;
  isReviewing: boolean;
}) {
  const typeColors: Record<string, string> = {
    added: "border-l-green-500",
    removed: "border-l-red-500",
    modified: "border-l-yellow-500",
  };
  const severityColors: Record<string, string> = {
    critical: "bg-red-100 text-red-800",
    high: "bg-orange-100 text-orange-800",
    medium: "bg-yellow-100 text-yellow-800",
    low: "bg-blue-100 text-blue-800",
  };

  return (
    <div
      className={`rounded-lg border border-l-4 ${typeColors[change.changeType] ?? ""} p-4`}
      data-testid={`change-card-${change.id}`}
    >
      <div className="flex justify-between items-start mb-2">
        <div>
          <span className="font-medium">{change.title}</span>
          {change.previousTitle && change.previousTitle !== change.title && (
            <span className="text-sm text-muted-foreground ml-2">
              (was: {change.previousTitle})
            </span>
          )}
        </div>
        <div className="flex gap-2 items-center">
          <span
            className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
              severityColors[change.severity] ?? ""
            }`}
          >
            {change.severity}
          </span>
          <span className="text-xs text-muted-foreground">
            Impact: {Math.round(change.impactScore * 100)}%
          </span>
        </div>
      </div>

      {change.diffSummary && (
        <p className="text-sm text-muted-foreground mb-2">{change.diffSummary}</p>
      )}

      <div className="flex justify-between items-center mt-3">
        <ReviewStatusBadge status={change.reviewStatus} />
        {change.reviewStatus === "pending" && (
          <div className="flex gap-2">
            <button
              className="rounded-md bg-green-600 px-3 py-1 text-xs text-white hover:bg-green-700 disabled:opacity-50"
              onClick={() => onReview(change.id, "approved")}
              disabled={isReviewing}
              data-testid={`approve-${change.id}`}
            >
              Approve
            </button>
            <button
              className="rounded-md bg-red-600 px-3 py-1 text-xs text-white hover:bg-red-700 disabled:opacity-50"
              onClick={() => onReview(change.id, "rejected")}
              disabled={isReviewing}
              data-testid={`reject-${change.id}`}
            >
              Reject
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

function ReviewStatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    pending: "bg-gray-100 text-gray-700",
    approved: "bg-green-100 text-green-700",
    rejected: "bg-red-100 text-red-700",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        colors[status] ?? "bg-gray-100 text-gray-700"
      }`}
    >
      {status}
    </span>
  );
}
