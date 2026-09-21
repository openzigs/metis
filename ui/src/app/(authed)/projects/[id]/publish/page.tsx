"use client";

/**
 * Publishing tab — Phase 9.
 *
 * Lists drafts and publish batches, lets the user generate drafts from an
 * analysis, approve drafts, and run dry-run / live publishes against a
 * GitHub repo. Live progress streams over the socket `publish:{batchId}`
 * room. Intentionally minimal — Phase 10 polish will split this into
 * dedicated components.
 */
import { useParams, useSearchParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "@/lib/api-client";
import { publishingApi } from "@/lib/publishing-api";
import { analysisApi, type AnalysisListItem } from "@/lib/analysis-api";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { PausableLiveRegion } from "@/components/a11y/pausable-live-region";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSocket } from "@/lib/socket-client";
import { repoConnectorsApi } from "@/lib/connectors-api";
import { DraftDiffDialog } from "@/components/publishing/draft-diff-dialog";
import {
  BulkApproveDialog,
  computeApprovalCounts,
} from "@/components/publishing/bulk-approve-dialog";
import {
  ApprovalGateBlockNotice,
  ApprovalGateSettingsCard,
} from "@/components/publishing/approval-gate-card";
import { extractApprovalGateBlock } from "@/lib/approval-gate";
import { vaultRefHint } from "@/lib/vault-ref";
import { DryRunPlanPanel, parseDryRunPlan } from "@/components/publishing/dry-run-plan-panel";
import { PublishConfirmDialog } from "@/components/publishing/publish-confirm-dialog";
import { BatchRowActions } from "@/components/publishing/batch-row-actions";
import { ResponsiveTable, type ResponsiveColumn } from "@/components/tables/responsive-table";
import type { PublishBatch } from "@metis/shared";

const keys = {
  drafts: (pid: string) => ["publishing", "drafts", pid] as const,
  batches: (pid: string) => ["publishing", "batches", pid] as const,
};

function statusClass(status: string): string {
  switch (status) {
    case "completed":
      return "bg-emerald-100 text-emerald-700";
    case "running":
      return "bg-amber-100 text-amber-700";
    case "failed":
      return "bg-red-100 text-red-700";
    case "approved":
      return "bg-sky-100 text-sky-700";
    case "published":
      return "bg-emerald-100 text-emerald-700";
    default:
      return "bg-slate-100 text-slate-700";
  }
}

/** Human-readable label for an analysis option in the source picker. */
function analysisLabel(a: AnalysisListItem): string {
  let when = a.startedAt;
  try {
    when = new Date(a.startedAt).toLocaleString();
  } catch {
    /* keep raw value */
  }
  return `${a.status} · ${when} · ${a.id.slice(0, 8)}`;
}

export default function PublishingPage() {
  const params = useParams<{ id: string }>();
  const projectId = params?.id ?? "";
  const searchParams = useSearchParams();
  const qc = useQueryClient();
  const socket = useSocket();

  const drafts = useQuery({
    queryKey: keys.drafts(projectId),
    queryFn: () => publishingApi.listDrafts(projectId),
    enabled: Boolean(projectId),
  });
  const batches = useQuery({
    queryKey: keys.batches(projectId),
    queryFn: () => publishingApi.listBatches(projectId, false),
    enabled: Boolean(projectId),
  });

  // ── Generate-from-analysis form ────────────────────────────────────────
  const [analysisId, setAnalysisId] = useState(searchParams?.get("analysisId") ?? "");
  const [targetOwner, setTargetOwner] = useState("");
  const [targetRepo, setTargetRepo] = useState("");

  // Pick the source analysis from the project's analyses instead of pasting an
  // opaque Analysis ID. The list endpoint already exists.
  const analyses = useQuery({
    queryKey: ["analyses", projectId],
    queryFn: () => analysisApi.listForProject(projectId),
    enabled: Boolean(projectId),
  });

  // Epic #640 — pre-fill owner/repo from primary repo connector
  const primaryRepo = useQuery({
    queryKey: ["connectors", "repos", projectId, "primary"],
    queryFn: () => repoConnectorsApi.getPrimary(projectId),
    enabled: Boolean(projectId),
  });
  useEffect(() => {
    if (primaryRepo.data) {
      // Issue #288 — owner/repo are null for local/upload connectors.
      setTargetOwner(primaryRepo.data.ownerOrOrg ?? "");
      setTargetRepo(primaryRepo.data.repoName ?? "");
    }
  }, [primaryRepo.data]);

  const generate = useMutation({
    mutationFn: () =>
      publishingApi.generateDrafts(projectId, {
        analysisId,
        targetOwner,
        targetRepo,
      }),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.drafts(projectId) }),
  });

  const approve = useMutation({
    mutationFn: (id: string) => publishingApi.approveDraft(projectId, id),
    onSuccess: () => qc.invalidateQueries({ queryKey: keys.drafts(projectId) }),
  });

  // ── Diff preview ───────────────────────────────────────────────────────
  const [diffDraftId, setDiffDraftId] = useState<string | null>(null);
  const diffDraft = drafts.data?.find((d) => d.id === diffDraftId);
  // Recover any previousBody we have stashed in the JSON metadata blob.
  const previousBody: string | null = (() => {
    if (!diffDraft?.metadata) return null;
    try {
      const parsed = JSON.parse(diffDraft.metadata) as { previousBody?: unknown };
      return typeof parsed.previousBody === "string" ? parsed.previousBody : null;
    } catch {
      return null;
    }
  })();

  // ── Bulk approve ───────────────────────────────────────────────────────
  const [bulkOpen, setBulkOpen] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);
  const [bulkError, setBulkError] = useState<unknown>(null);
  // Declared here (ahead of the publish-batch form block below) because
  // `selectedDraftRows` reads it synchronously during render — a later `const`
  // would sit in the temporal dead zone and throw once any draft is present.
  const [selectedDrafts, setSelectedDrafts] = useState<Set<string>>(new Set());
  const selectedDraftRows = drafts.data?.filter((d) => selectedDrafts.has(d.id)) ?? [];
  const bulkCounts = computeApprovalCounts(selectedDraftRows);
  async function runBulkApprove(): Promise<void> {
    setBulkPending(true);
    setBulkError(null);
    try {
      for (const d of selectedDraftRows) {
        if (d.status === "draft" || d.status === "approved") {
          await publishingApi.approveDraft(projectId, d.id);
        }
      }
      setBulkOpen(false);
    } catch (err) {
      // #619 — surface approval-gate blocks (and any other failure) instead
      // of leaving an unhandled rejection.
      setBulkError(err);
      setBulkOpen(false);
    } finally {
      void qc.invalidateQueries({ queryKey: keys.drafts(projectId) });
      setBulkPending(false);
    }
  }

  // ── Publish batch form ─────────────────────────────────────────────────
  const [batchOwner, setBatchOwner] = useState("");
  const [batchRepo, setBatchRepo] = useState("");
  const [batchBaseUrl, setBatchBaseUrl] = useState("");
  const [batchSecret, setBatchSecret] = useState("");
  const [batchLabels, setBatchLabels] = useState("");
  const [dryRun, setDryRun] = useState(true);
  // #1094 — tell the user the required shape before they submit, rather than
  // after a 400 that used to say only "The request could not be processed."
  const vaultRefHintText = vaultRefHint(batchSecret);
  const [copilotWorkspace, setCopilotWorkspace] = useState(false);
  const [projectsV2, setProjectsV2] = useState(false);

  // Epic #640 — pre-fill batch owner/repo from primary repo connector
  useEffect(() => {
    if (primaryRepo.data) {
      setBatchOwner(primaryRepo.data.ownerOrOrg ?? "");
      setBatchRepo(primaryRepo.data.repoName ?? "");
      setBatchBaseUrl(primaryRepo.data.apiBaseUrl ?? "");
    }
  }, [primaryRepo.data]);

  // The one request body, shared by the publish itself and by the plan the
  // confirmation renders — so the confirmation can never describe a different
  // batch from the one that runs (#1104 D).
  const effectiveOwner = batchOwner || targetOwner;
  const effectiveRepo = batchRepo || targetRepo;
  const batchBody = () => ({
    targetOwner: effectiveOwner,
    targetRepo: effectiveRepo,
    targetBaseUrl: batchBaseUrl ? batchBaseUrl : undefined,
    provider: (batchBaseUrl ? "github_enterprise" : "github") as "github" | "github_enterprise",
    dryRun,
    draftIds: [...selectedDrafts],
    additionalLabels: batchLabels
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    milestone: undefined,
    secretRef: batchSecret || undefined,
    metadata: { copilotWorkspace, projectsV2 },
  });

  const publish = useMutation({
    mutationFn: () => publishingApi.createBatch(projectId, batchBody()),
    // #1104 (E) — onSettled, not onSuccess. A rejected publish still writes a
    // `failed` row, and the panel used to keep showing "No batches yet." until
    // a manual reload.
    onSettled: () => {
      qc.invalidateQueries({ queryKey: keys.batches(projectId) });
      qc.invalidateQueries({ queryKey: keys.drafts(projectId) });
    },
  });

  // ── Live-publish confirmation (#1104 D) ────────────────────────────────
  // Dry runs write nothing and are fired directly; a LIVE publish must be
  // confirmed against a named repository first. The plan is fetched when the
  // dialog opens — it creates no batch and makes no GitHub call — and the
  // confirm button never waits on it (see PublishConfirmDialog).
  const [confirmOpen, setConfirmOpen] = useState(false);
  const plan = useMutation({
    mutationFn: () => publishingApi.previewBatch(projectId, batchBody()),
  });

  function onPublishClick(): void {
    if (dryRun) {
      publish.mutate();
      return;
    }
    plan.reset();
    setConfirmOpen(true);
    plan.mutate();
  }

  // ── Stranded-batch cancel (#1104 F) ────────────────────────────────────
  const [cancellingId, setCancellingId] = useState<string | null>(null);
  const cancelBatch = useMutation({
    mutationFn: (id: string) => publishingApi.cancelBatch(projectId, id),
    onSettled: () => {
      setCancellingId(null);
      qc.invalidateQueries({ queryKey: keys.batches(projectId) });
    },
  });

  // ── Live progress feed ─────────────────────────────────────────────────
  const [liveBatchId, setLiveBatchId] = useState<string | null>(null);
  const [liveLog, setLiveLog] = useState<string[]>([]);

  const batchColumns: ResponsiveColumn<PublishBatch>[] = useMemo(
    () => [
      {
        key: "id",
        header: "ID",
        cell: (b) => b.id.slice(0, 10),
        cellClassName: "font-mono text-xs",
      },
      {
        key: "target",
        header: "Target",
        cell: (b) => (
          <>
            {b.targetOwner}/{b.targetRepo}
            {b.dryRun && <span className="ml-1 text-xs text-slate-400">(dry)</span>}
          </>
        ),
      },
      {
        key: "status",
        header: "Status",
        cell: (b) => (
          <span className={`rounded px-2 py-0.5 text-xs ${statusClass(b.status)}`}>{b.status}</span>
        ),
      },
      { key: "published", header: "Published", cell: (b) => b.publishedCount },
      { key: "failed", header: "Failed", cell: (b) => b.failedCount },
      { key: "dedup", header: "Dedup", cell: (b) => b.dedupSkipped },
      {
        key: "started",
        header: "Started",
        cell: (b) => (
          <span className="text-xs text-slate-500">{new Date(b.startedAt).toLocaleString()}</span>
        ),
      },
      {
        key: "actions",
        header: <span className="sr-only">Actions</span>,
        cardLabel: "Actions",
        hideCardLabel: true,
        cell: (b) => (
          <BatchRowActions
            batch={b}
            onWatch={setLiveBatchId}
            onCancel={(id) => {
              setCancellingId(id);
              cancelBatch.mutate(id);
            }}
            cancelPending={cancellingId === b.id}
          />
        ),
      },
    ],
    [cancelBatch, cancellingId],
  );

  useEffect(() => {
    if (!socket || !liveBatchId) return;
    socket.emit("subscribe:publish", { batchId: liveBatchId });
    const onStatus = (e: { status: string; message?: string | null }) => {
      setLiveLog((prev) => [...prev, `[${e.status}] ${e.message ?? ""}`]);
    };
    const onProgress = (e: {
      phase: string;
      step: string;
      current?: number;
      total?: number;
      issueNumber?: number;
    }) => {
      setLiveLog((prev) => [
        ...prev,
        `${e.phase}/${e.step}${e.current ? ` ${e.current}/${e.total ?? "?"}` : ""}${
          e.issueNumber ? ` #${e.issueNumber}` : ""
        }`,
      ]);
    };
    const onCompleted = (e: {
      status: string;
      publishedCount: number;
      failedCount: number;
      dedupSkipped: number;
    }) => {
      setLiveLog((prev) => [
        ...prev,
        `[completed] ${e.status} · published=${e.publishedCount} failed=${e.failedCount} dedup=${e.dedupSkipped}`,
      ]);
      qc.invalidateQueries({ queryKey: keys.batches(projectId) });
    };
    socket.on("publish:status", onStatus);
    socket.on("publish:progress", onProgress);
    socket.on("publish:completed", onCompleted);
    return () => {
      socket.emit("unsubscribe:publish", { batchId: liveBatchId });
      socket.off("publish:status", onStatus);
      socket.off("publish:progress", onProgress);
      socket.off("publish:completed", onCompleted);
    };
  }, [socket, liveBatchId, qc, projectId]);

  // #619 — approval gate blocks (409 APPROVAL_REQUIRED / 503 fail-closed).
  const publishGateBlock = extractApprovalGateBlock(publish.error);
  const approveGateBlock =
    extractApprovalGateBlock(approve.error) ?? extractApprovalGateBlock(bulkError);

  if (!projectId) return <p className="text-sm text-slate-500">Select a project.</p>;

  return (
    <div className="flex flex-col gap-8">
      <header>
        <h1 className="text-xl font-semibold">Publishing</h1>
        <p className="text-sm text-slate-500">
          Generate GitHub issue drafts from an analysis, then dry-run or publish them as a batch.
        </p>
      </header>

      <ApprovalGateSettingsCard projectId={projectId} />

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Generate drafts from analysis</h2>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="analysisId">Analysis</Label>
            <select
              id="analysisId"
              data-testid="publish-analysis-select"
              className="h-9 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={analysisId}
              disabled={analyses.isLoading}
              onChange={(e) => setAnalysisId(e.target.value)}
            >
              <option value="">
                {analyses.isLoading
                  ? "Loading analyses…"
                  : (analyses.data?.items.length ?? 0) === 0
                    ? "No analyses yet"
                    : "Select an analysis…"}
              </option>
              {(analyses.data?.items ?? []).map((a) => (
                <option key={a.id} value={a.id}>
                  {analysisLabel(a)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Label htmlFor="genOwner">Target owner</Label>
            <Input
              id="genOwner"
              value={targetOwner}
              onChange={(e) => setTargetOwner(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="genRepo">Target repo</Label>
            <Input
              id="genRepo"
              value={targetRepo}
              onChange={(e) => setTargetRepo(e.target.value)}
            />
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3">
          <Button
            onClick={() => generate.mutate()}
            disabled={!analysisId || !targetOwner || !targetRepo || generate.isPending}
          >
            {generate.isPending ? "Generating…" : "Generate"}
          </Button>
          {generate.error && (
            <span className="text-xs text-red-600">
              {generate.error instanceof ApiError ? generate.error.message : String(generate.error)}
            </span>
          )}
          {generate.data && (
            <span className="text-xs text-emerald-600">
              {generate.data.summary.upserted} created · {generate.data.summary.refreshed} refreshed
            </span>
          )}
        </div>
      </Card>

      <Card className="p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold">Drafts ({drafts.data?.length ?? 0})</h2>
          <Button
            size="sm"
            variant="outline"
            disabled={selectedDrafts.size === 0}
            onClick={() => setBulkOpen(true)}
            data-testid="bulk-approve-trigger"
          >
            Bulk approve ({selectedDrafts.size})
          </Button>
        </div>
        {/* Issue #1117 (finding F) — the gate block used to render AFTER the
            list. With 31 drafts the notice landed hundreds of pixels below the
            Approve button that produced it, off-screen, so a 409 read as a
            silent failure. It now sits above the list, and the row that was
            clicked carries its own inline alert (below) so the feedback is
            adjacent to the action however long the list is. */}
        {approveGateBlock && <ApprovalGateBlockNotice block={approveGateBlock} />}
        {drafts.isLoading ? (
          <p className="text-xs text-slate-500">Loading…</p>
        ) : (
          <ul className="mt-3 divide-y divide-slate-200">
            {(drafts.data ?? []).map((d) => (
              <li key={d.id} className="py-2">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      aria-label={`Select draft: ${d.title}`}
                      checked={selectedDrafts.has(d.id)}
                      disabled={d.status === "published"}
                      onChange={(e) => {
                        const next = new Set(selectedDrafts);
                        if (e.target.checked) next.add(d.id);
                        else next.delete(d.id);
                        setSelectedDrafts(next);
                      }}
                    />
                    <div>
                      <div className="text-sm font-medium">{d.title}</div>
                      <div className="text-xs text-slate-500">
                        {d.draftType} · sp={d.storyPoints}
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span
                      className={`rounded px-2 py-0.5 text-xs font-medium ${statusClass(d.status)}`}
                    >
                      {d.status}
                    </span>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => setDiffDraftId(d.id)}
                      data-testid={`preview-${d.id}`}
                    >
                      Preview
                    </Button>
                    {d.status === "draft" && (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => approve.mutate(d.id)}
                        disabled={approve.isPending}
                      >
                        Approve
                      </Button>
                    )}
                  </div>
                </div>
                {/* Issue #1117 (finding F) — the row that was actually clicked
                    says so, right where the click happened. */}
                {approve.isError && approve.variables === d.id && (
                  <p
                    role="alert"
                    data-testid={`approve-error-${d.id}`}
                    className="mt-1 rounded border border-amber-300 bg-amber-50 px-2 py-1 text-xs text-amber-900"
                  >
                    {approveGateBlock
                      ? "Blocked by the approval gate — this draft needs an approved, up-to-date review. Details are at the top of this list."
                      : approve.error instanceof ApiError
                        ? approve.error.message
                        : "Could not approve this draft."}
                  </p>
                )}
              </li>
            ))}
            {!drafts.data?.length && (
              <li className="py-2 text-xs text-slate-500">No drafts yet.</li>
            )}
          </ul>
        )}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">New publish batch</h2>
        <div className="mt-3 grid grid-cols-3 gap-3">
          <div>
            <Label htmlFor="batchOwner">Owner</Label>
            <Input
              id="batchOwner"
              placeholder={targetOwner}
              value={batchOwner}
              onChange={(e) => setBatchOwner(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="batchRepo">Repo</Label>
            <Input
              id="batchRepo"
              placeholder={targetRepo}
              value={batchRepo}
              onChange={(e) => setBatchRepo(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="batchBaseUrl">GHE base URL (optional)</Label>
            <Input
              id="batchBaseUrl"
              placeholder="https://github.example.com/api/v3"
              value={batchBaseUrl}
              onChange={(e) => setBatchBaseUrl(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="batchSecret">Vault secret ref</Label>
            <Input
              id="batchSecret"
              // #1094 — the placeholder used to read `vault:gh-publish-token`,
              // a shape the server rejects with 400 VAULT_REF_INVALID. It now
              // matches the actual contract and the Connections page.
              placeholder="${vault:my-token-label}"
              aria-describedby="batchSecretHelp"
              aria-invalid={Boolean(vaultRefHintText) || undefined}
              value={batchSecret}
              onChange={(e) => setBatchSecret(e.target.value)}
            />
            <p
              id="batchSecretHelp"
              className={`mt-1 text-xs ${vaultRefHintText ? "text-red-600" : "text-slate-500"}`}
            >
              {vaultRefHintText ??
                "Label of a secret stored in the vault, wrapped as ${vault:label} — not the token itself."}
            </p>
          </div>
          <div>
            <Label htmlFor="batchLabels">Additional labels (csv)</Label>
            <Input
              id="batchLabels"
              value={batchLabels}
              onChange={(e) => setBatchLabels(e.target.value)}
            />
          </div>
          <div className="flex items-end gap-2">
            <input
              id="dryRun"
              type="checkbox"
              checked={dryRun}
              onChange={(e) => setDryRun(e.target.checked)}
            />
            <Label htmlFor="dryRun">Dry run (no GitHub writes)</Label>
          </div>
          <div className="flex items-end gap-2">
            <input
              id="copilotWorkspace"
              data-testid="copilot-workspace-toggle"
              type="checkbox"
              checked={copilotWorkspace}
              onChange={(e) => setCopilotWorkspace(e.target.checked)}
            />
            <Label htmlFor="copilotWorkspace">Also commit .copilot-workspace.md</Label>
          </div>
          <div className="flex items-end gap-2">
            <input
              id="projectsV2"
              data-testid="projects-v2-toggle"
              type="checkbox"
              checked={projectsV2}
              onChange={(e) => setProjectsV2(e.target.checked)}
            />
            <Label htmlFor="projectsV2">Add to GitHub Projects v2 board</Label>
          </div>
        </div>
        <div className="mt-4 flex items-center gap-3">
          <Button
            onClick={onPublishClick}
            disabled={
              publish.isPending ||
              selectedDrafts.size === 0 ||
              (!batchOwner && !targetOwner) ||
              (!batchRepo && !targetRepo) ||
              (!dryRun && !batchSecret)
            }
          >
            {publish.isPending ? "Publishing…" : dryRun ? "Run dry-run" : "Publish now"}
          </Button>
          <span className="text-xs text-slate-500">{selectedDrafts.size} drafts selected</span>
          {publish.error && !publishGateBlock && (
            <span className="text-xs text-red-600" role="alert" data-testid="publish-error">
              {publish.error instanceof ApiError ? publish.error.message : String(publish.error)}
              {/* #1094 — show the code so a user can self-diagnose or search
                  for it, instead of only seeing prose. */}
              {publish.error instanceof ApiError && publish.error.code ? (
                <span className="ml-1 font-mono text-slate-500">({publish.error.code})</span>
              ) : null}
            </span>
          )}
        </div>
        {publishGateBlock && <ApprovalGateBlockNotice block={publishGateBlock} />}
        {publish.data && (
          <div className="mt-3 text-xs text-slate-700">
            Batch <code>{publish.data.batch.id.slice(0, 10)}</code> · run status{" "}
            <span className={`rounded px-2 py-0.5 ${statusClass(publish.data.run.status)}`}>
              {publish.data.run.status}
            </span>
          </div>
        )}
        {/* #1093 — the server always computed this plan; nothing ever showed
            it, so a dry run looked like it had done nothing. */}
        {(() => {
          const plan = parseDryRunPlan(publish.data?.batch.dryRunPlan);
          return plan ? <DryRunPlanPanel plan={plan} /> : null;
        })()}
      </Card>

      <Card className="p-4">
        <h2 className="text-sm font-semibold">Recent batches</h2>
        <div className="mt-3">
          <ResponsiveTable
            data={batches.data ?? []}
            getRowKey={(b) => b.id}
            ariaLabel="Recent publish batches"
            columns={batchColumns}
            emptyContent="No batches yet."
          />
        </div>
        {liveBatchId && (
          <div className="mt-4 rounded border bg-slate-50 p-3 text-xs">
            <div className="mb-1 flex items-center justify-between">
              <span>
                Live · <code>{liveBatchId.slice(0, 10)}</code>
              </span>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => {
                  setLiveBatchId(null);
                  setLiveLog([]);
                }}
              >
                Close
              </Button>
            </div>
            {/* #662 — SC 2.2.2 Pause, Stop, Hide. The publish batch streams log
                lines into this live region for the duration of the run; expose
                a keyboard-operable control to pause the updates + silence
                announcements. It renders only while a live batch is attached. */}
            <PausableLiveRegion
              label="Publish progress log"
              role="log"
              testId="publish-log"
              className="space-y-1 font-mono"
            >
              <ol className="space-y-1">
                {liveLog.map((l, i) => (
                  <li key={i}>{l}</li>
                ))}
                {liveLog.length === 0 && <li className="text-slate-400">Waiting for events…</li>}
              </ol>
            </PausableLiveRegion>
          </div>
        )}
      </Card>

      {diffDraft && (
        <DraftDiffDialog
          open={diffDraftId !== null}
          onOpenChange={(o) => !o && setDiffDraftId(null)}
          title={diffDraft.title}
          body={diffDraft.body}
          previousBody={previousBody}
        />
      )}
      <BulkApproveDialog
        open={bulkOpen}
        onOpenChange={setBulkOpen}
        counts={bulkCounts}
        pending={bulkPending}
        onConfirm={runBulkApprove}
      />
      {/* #1104 (D) — nothing is written until this is confirmed. */}
      <PublishConfirmDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        target={{ owner: effectiveOwner, repo: effectiveRepo }}
        draftCount={selectedDrafts.size}
        plan={plan.data ?? null}
        planLoading={plan.isPending}
        planError={plan.error}
        pending={publish.isPending}
        onConfirm={() => {
          setConfirmOpen(false);
          publish.mutate();
        }}
      />
    </div>
  );
}
