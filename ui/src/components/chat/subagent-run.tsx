"use client";

/**
 * Epic #129 (#147) — a sub-agent run's stored transcript, linked from the tool
 * call that started it. Collapsed by default; the run is fetched only when the
 * user opens it (through the same session authorisation as the transcript).
 * Everything is rendered as text — no HTML from a model reaches the DOM.
 */
import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import type { SubAgentRunDto } from "@metis/shared";
import { getSubAgentRun } from "@/lib/ai-client";
import { decisionLabel, toolErrorText } from "@/lib/tool-activity";

const STATUS_TEXT: Record<SubAgentRunDto["status"], string> = {
  running: "still running",
  completed: "finished",
  failed: "failed",
  budget_exhausted: "stopped — the sub-agent token budget ran out",
  aborted: "stopped",
};

export function SubAgentRunDetails({ sessionId, runId }: { sessionId: string; runId: string }) {
  const [open, setOpen] = useState(false);
  const run = useQuery({
    queryKey: ["ai", "subagent-run", sessionId, runId],
    queryFn: () => getSubAgentRun(sessionId, runId),
    enabled: open,
    staleTime: 30_000,
  });
  return (
    <details
      className="mt-1"
      data-testid={`subagent-run-${runId}`}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary className="cursor-pointer select-none text-muted-foreground">
        Sub-agent transcript
      </summary>
      {run.isLoading ? <p className="mt-1 text-muted-foreground">Loading…</p> : null}
      {run.isError ? (
        <p role="alert" className="mt-1 text-destructive">
          The sub-agent transcript could not be loaded.
        </p>
      ) : null}
      {run.data ? <SubAgentRunBody run={run.data} /> : null}
    </details>
  );
}

function SubAgentRunBody({ run }: { run: SubAgentRunDto }) {
  return (
    <div className="mt-1 space-y-1" data-testid="subagent-run-body">
      <p>
        <span className="font-medium">{run.agentName}</span>
        <span className="ml-2 text-muted-foreground">
          {STATUS_TEXT[run.status] ?? run.status} · {run.usage.totalTokens} tokens
          {run.model ? ` · ${run.model}` : ""}
        </span>
      </p>
      <div>
        <span className="text-muted-foreground">Task</span>
        <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-1">
          {run.task}
        </pre>
      </div>
      {run.toolCalls.length > 0 ? (
        <ul className="space-y-0.5">
          {run.toolCalls.map((c) => (
            <li key={c.callId} className="rounded border border-border px-2 py-0.5">
              <span className="font-medium">{c.tool}</span>
              <span
                className={`ml-2 ${c.executed && !c.isError ? "text-muted-foreground" : "text-destructive"}`}
              >
                {c.errorCode && c.executed
                  ? toolErrorText(c.errorCode as never)
                  : decisionLabel(c.decision, c.executed)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      <div>
        <span className="text-muted-foreground">Answer</span>
        <pre className="mt-0.5 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded bg-muted p-1">
          {run.result || "(no answer)"}
        </pre>
      </div>
    </div>
  );
}
