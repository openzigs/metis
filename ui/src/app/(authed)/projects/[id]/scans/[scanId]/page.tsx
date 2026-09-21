/**
 * Epic #708 / Issue #719 — Scan triage view.
 *
 * Lists findings for a scan with approve/reject/defer + publish controls.
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Card } from "@/components/ui/card";
import { scannerApi, type ScanFinding } from "@/lib/scanner-api";
import { ApiError } from "@/lib/api-client";

/**
 * Turn a publish failure into an operator-actionable message. A
 * `ERR_JIRA_NOT_CONFIGURED` 409 means the feature works but the project simply
 * has no Jira destination wired up, so steer the user to project settings
 * rather than surfacing the raw error.
 */
function publishErrorMessage(e: unknown): string {
  if (e instanceof ApiError && e.code === "ERR_JIRA_NOT_CONFIGURED") {
    return `${e.message} Connect Jira in project settings first.`;
  }
  return (e as Error).message;
}

export default function ScanTriagePage() {
  const params = useParams<{ id: string; scanId: string }>();
  const projectId = params.id;
  const scanId = params.scanId;

  const scanQuery = useQuery({
    queryKey: ["scanner", "scan", projectId, scanId],
    queryFn: () => scannerApi.getScan(projectId, scanId),
    refetchInterval: (q) => {
      const data = q.state.data;
      return data?.status === "running" || data?.status === "pending" ? 4000 : false;
    },
  });
  const findingsQuery = useQuery({
    queryKey: ["scanner", "findings", projectId, scanId],
    queryFn: () => scannerApi.listFindings(projectId, scanId),
    refetchInterval: 5000,
  });

  return (
    <div className="space-y-6 p-2 md:p-0" data-testid="scanner-triage-root">
      <header className="space-y-2">
        <Link
          href={`/projects/${projectId}/overview`}
          className="text-xs text-muted-foreground underline"
        >
          ← Back to project
        </Link>
        <h1 className="text-2xl font-semibold">Scan triage</h1>
        {scanQuery.data ? (
          <p className="text-xs text-muted-foreground" data-testid="scanner-triage-meta">
            commit {scanQuery.data.commitSha.slice(0, 8)} · mode {scanQuery.data.mode} · status{" "}
            {scanQuery.data.status} · {scanQuery.data.scannedSymbols}/{scanQuery.data.totalSymbols}{" "}
            symbols · {scanQuery.data.totalTokens.toLocaleString()} tokens
          </p>
        ) : null}
      </header>

      <Card className="p-4" data-testid="scanner-triage-card">
        {findingsQuery.isLoading ? (
          <p className="text-xs text-muted-foreground">Loading findings…</p>
        ) : findingsQuery.isError ? (
          <p role="alert" className="text-xs text-destructive">
            {(findingsQuery.error as Error).message}
          </p>
        ) : !findingsQuery.data?.length ? (
          <p className="text-xs text-muted-foreground" data-testid="scanner-triage-empty">
            No findings yet.
          </p>
        ) : (
          <div className="space-y-3">
            {findingsQuery.data.map((f) => (
              <FindingRow key={f.id} projectId={projectId} scanId={scanId} finding={f} />
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

function FindingRow({
  projectId,
  scanId,
  finding,
}: {
  projectId: string;
  scanId: string;
  finding: ScanFinding;
}) {
  const qc = useQueryClient();
  const [note, setNote] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const triageMutation = useMutation({
    mutationFn: (decision: "approved" | "rejected" | "deferred") =>
      scannerApi.triage(projectId, scanId, finding.id, {
        decision,
        note: note.trim() || undefined,
      }),
    onSuccess: () => {
      setErr(null);
      setNote("");
      qc.invalidateQueries({ queryKey: ["scanner", "findings", projectId, scanId] });
    },
    onError: (e: Error) => setErr(e.message),
  });

  const publishMutation = useMutation({
    mutationFn: (provider: "github" | "jira") =>
      scannerApi.publish(projectId, scanId, finding.id, { provider }),
    onSuccess: () => {
      setErr(null);
      qc.invalidateQueries({ queryKey: ["scanner", "findings", projectId, scanId] });
    },
    onError: (e: unknown) => setErr(publishErrorMessage(e)),
  });

  const isApproved = finding.triageStatus === "approved";
  const isPending = finding.triageStatus === "pending";

  return (
    <div
      className="space-y-2 rounded border border-border p-3"
      data-testid={`scanner-finding-${finding.id}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium">{finding.title}</p>
          <p className="text-xs text-muted-foreground">
            severity: {finding.severity} · confidence: {finding.confidence.toFixed(2)} · status:{" "}
            {finding.triageStatus}
          </p>
          {finding.symbol ? (
            <p className="text-xs text-muted-foreground">
              {finding.symbol.qualifiedName} — {finding.symbol.filePath}
            </p>
          ) : null}
        </div>
      </div>

      <pre className="overflow-x-auto rounded bg-muted p-2 text-xs whitespace-pre-wrap">
        {finding.body}
      </pre>

      {isPending ? (
        <div className="space-y-2">
          <input
            type="text"
            className="w-full rounded border bg-background px-2 py-1 text-xs"
            placeholder="Optional triage note"
            data-testid={`scanner-finding-note-${finding.id}`}
            value={note}
            onChange={(e) => setNote(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
              data-testid={`scanner-finding-approve-${finding.id}`}
              disabled={triageMutation.isPending}
              onClick={() => triageMutation.mutate("approved")}
            >
              Approve
            </button>
            <button
              type="button"
              className="rounded border px-3 py-1 text-xs disabled:opacity-50"
              data-testid={`scanner-finding-reject-${finding.id}`}
              disabled={triageMutation.isPending}
              onClick={() => triageMutation.mutate("rejected")}
            >
              Reject
            </button>
            <button
              type="button"
              className="rounded border px-3 py-1 text-xs disabled:opacity-50"
              data-testid={`scanner-finding-defer-${finding.id}`}
              disabled={triageMutation.isPending}
              onClick={() => triageMutation.mutate("deferred")}
            >
              Defer
            </button>
          </div>
        </div>
      ) : null}

      {isApproved ? (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            className="rounded bg-primary px-3 py-1 text-xs text-primary-foreground disabled:opacity-50"
            data-testid={`scanner-finding-publish-github-${finding.id}`}
            disabled={publishMutation.isPending}
            onClick={() => publishMutation.mutate("github")}
          >
            Publish to GitHub
          </button>
          <button
            type="button"
            className="rounded border px-3 py-1 text-xs disabled:opacity-50"
            data-testid={`scanner-finding-publish-jira-${finding.id}`}
            disabled={publishMutation.isPending}
            onClick={() => publishMutation.mutate("jira")}
          >
            Publish to Jira
          </button>
        </div>
      ) : null}

      {finding.issueLinks?.length ? (
        <ul className="text-xs" data-testid={`scanner-finding-links-${finding.id}`}>
          {finding.issueLinks.map((l) => (
            <li key={l.id}>
              <a href={l.externalUrl} target="_blank" rel="noreferrer" className="underline">
                {l.provider}: {l.externalId}
              </a>
            </li>
          ))}
        </ul>
      ) : null}

      {err ? (
        <p role="alert" className="text-xs text-destructive">
          {err}
        </p>
      ) : null}
    </div>
  );
}
