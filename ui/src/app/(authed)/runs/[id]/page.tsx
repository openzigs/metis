"use client";

/**
 * Epic #158 — /runs/[id] page.
 *
 * Vertical timeline visualization for a single multi-agent run. Each step is
 * an expandable card showing the kind, latency, span/trace IDs (when OTel is
 * wired up upstream), and the JSON payload (prompt / tool args / response /
 * agent transitions).
 */
import { useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { runsApi, type AgentRunStep } from "@/lib/runs-api";
import { SandboxStatusBadge } from "@/components/sandbox/SandboxStatusBadge";
import { SandboxSessionTable } from "@/components/sandbox/SandboxSessionTable";
import { PageHeader } from "@/components/ui/page-header";

function StepCard({ step }: { step: AgentRunStep }) {
  const [open, setOpen] = useState(step.kind === "tool_call" || step.kind === "agent_phase");
  const accent = (() => {
    switch (step.kind) {
      case "agent_phase":
        return "border-l-info";
      case "tool_call":
        return "border-l-success";
      case "synthesis":
        return "border-l-chart-4";
      case "error":
        return "border-l-destructive";
      default:
        return "border-l-border";
    }
  })();

  const json = (() => {
    try {
      return JSON.stringify(step.content, null, 2);
    } catch {
      return String(step.content);
    }
  })();

  return (
    <Card
      className={`border-l-4 ${accent} p-4`}
      data-testid={`run-step-${step.ord}`}
      data-step-kind={step.kind}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between text-left"
        aria-expanded={open}
      >
        <div>
          <div className="text-xs uppercase tracking-wide text-muted-foreground">
            #{step.ord} · {step.kind}
          </div>
          <div className="text-sm font-medium">{new Date(step.createdAt).toLocaleString()}</div>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          {step.latencyMs != null && (
            <span className="rounded bg-muted px-2 py-0.5">{step.latencyMs} ms</span>
          )}
          {step.traceId && <span className="font-mono">trace:{step.traceId.slice(0, 8)}</span>}
          {step.spanId && <span className="font-mono">span:{step.spanId.slice(0, 8)}</span>}
        </div>
      </button>
      {open && (
        <pre
          className="mt-3 max-h-96 overflow-auto rounded bg-muted/50 p-3 text-xs"
          data-testid={`run-step-${step.ord}-content`}
        >
          {json}
        </pre>
      )}
    </Card>
  );
}

export default function RunDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params.id;

  const detail = useQuery({
    queryKey: ["runs", "detail", id],
    queryFn: () => runsApi.get(id),
    enabled: Boolean(id),
  });

  // Epic #395 #419 — sandbox sessions for this run. Fetched independently
  // so a missing-sessions route never blocks the timeline render.
  const sandboxSessions = useQuery({
    queryKey: ["runs", "sandbox-sessions", id],
    queryFn: () => runsApi.sandboxSessions(id),
    enabled: Boolean(id),
    retry: false,
  });
  const sessions = sandboxSessions.data?.sessions ?? [];
  // Most recent session = last by createdAt (API returns oldest-first).
  const mostRecentSession = sessions.length > 0 ? sessions[sessions.length - 1] : null;

  if (!id) return null;

  return (
    <div className="space-y-6 p-6" data-testid="run-detail-page">
      <PageHeader
        eyebrow={
          <Link href="/runs" className="text-sm text-info hover:underline">
            ← All runs
          </Link>
        }
        title={`Run ${id}`}
        titleExtra={
          mostRecentSession ? (
            <SandboxStatusBadge
              outcome={mostRecentSession.outcome}
              errorMessage={mostRecentSession.errorMessage}
            />
          ) : undefined
        }
      />

      {detail.isLoading ? (
        <Card className="p-6 text-sm text-muted-foreground">Loading…</Card>
      ) : detail.isError ? (
        <Card className="p-6 text-sm text-destructive">
          Failed to load run: {(detail.error as Error).message}
        </Card>
      ) : detail.data ? (
        <>
          <Card className="grid gap-3 p-4 sm:grid-cols-2 md:grid-cols-4">
            <div>
              <div className="text-xs uppercase text-muted-foreground">Status</div>
              <div className="font-medium">{detail.data.run.status}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Kind</div>
              <div className="font-medium">{detail.data.run.kind}</div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Latency</div>
              <div className="font-medium">
                {detail.data.run.latencyMs != null ? `${detail.data.run.latencyMs} ms` : "—"}
              </div>
            </div>
            <div>
              <div className="text-xs uppercase text-muted-foreground">Total tokens</div>
              <div className="font-medium">{detail.data.run.totalTokens ?? "—"}</div>
            </div>
          </Card>

          <div className="space-y-3" data-testid="run-timeline">
            {detail.data.steps.length === 0 ? (
              <Card className="p-6 text-sm text-muted-foreground">
                No steps recorded for this run.
              </Card>
            ) : (
              detail.data.steps.map((step) => <StepCard key={step.id} step={step} />)
            )}
          </div>

          <SandboxSessionTable sessions={sessions} />
        </>
      ) : null}
    </div>
  );
}
