"use client";

/**
 * Epic #128 — tool activity in chat.
 *
 *   • {@link ToolActivityList} — the calls of the turn in flight, live (#143),
 *     each collapsible; a call awaiting approval shows what the model asked for
 *     and Approve / Deny (#142). Nothing here decides anything: the buttons send
 *     the owner's answer to the server, which is the only place a call can be
 *     allowed.
 *   • {@link TranscriptToolCalls} — the calls a finished reply made, from the
 *     transcript, with how each was decided. Collapsed by default.
 */
import { Button } from "@/components/ui/button";
import type { TranscriptToolCall } from "@/lib/ai-client";
import { decisionLabel, toolErrorText, type ToolActivity } from "@/lib/tool-activity";

function statusText(a: ToolActivity): string {
  switch (a.phase) {
    case "started":
      return "running…";
    case "awaiting_approval":
      return "waiting for your approval";
    case "result":
      return a.isError ? "returned an error" : "done";
    case "error":
      return toolErrorText(a.code);
  }
}

export interface ToolActivityListProps {
  items: readonly ToolActivity[];
  onDecide: (item: ToolActivity, decision: "approve" | "deny") => void;
  /** Approval ids with a decision in flight (buttons disabled). */
  deciding?: ReadonlySet<string>;
}

export function ToolActivityList({ items, onDecide, deciding }: ToolActivityListProps) {
  if (items.length === 0) return null;
  return (
    <ul className="space-y-1" data-testid="tool-activity" aria-label="Tool activity">
      {items.map((a) => {
        const awaiting = a.phase === "awaiting_approval" && Boolean(a.approvalId);
        const busy = awaiting && deciding?.has(a.approvalId!);
        return (
          <li
            key={a.callId}
            data-testid={`tool-activity-${a.callId}`}
            className={`rounded border px-2 py-1 text-xs ${awaiting ? "border-amber-500/70 bg-amber-500/10" : "border-border"}`}
          >
            <details open={awaiting}>
              <summary className="cursor-pointer select-none">
                <span className="font-medium">{a.name}</span>
                {a.risk ? (
                  <span className="ml-1 text-muted-foreground">({a.risk} risk)</span>
                ) : null}
                <span
                  className={`ml-2 ${a.phase === "error" ? "text-destructive" : "text-muted-foreground"}`}
                >
                  {statusText(a)}
                </span>
              </summary>
              {a.argsPreview ? (
                <div className="mt-1">
                  <span className="text-muted-foreground">Arguments</span>
                  <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1">
                    {a.argsPreview}
                  </pre>
                </div>
              ) : null}
              {a.argsHiddenChars ? (
                <p role="alert" className="mt-1 text-destructive">
                  These arguments contain invisible characters. Check them before approving.
                </p>
              ) : null}
              {a.phase === "result" && a.resultPreview ? (
                <div className="mt-1">
                  <span className="text-muted-foreground">Result</span>
                  <pre className="mt-0.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1">
                    {a.resultPreview}
                  </pre>
                </div>
              ) : null}
              {awaiting ? (
                <div className="mt-2 flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    disabled={busy}
                    onClick={() => onDecide(a, "approve")}
                    aria-label={`Approve ${a.name}`}
                  >
                    Approve
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={busy}
                    onClick={() => onDecide(a, "deny")}
                    aria-label={`Deny ${a.name}`}
                  >
                    Deny
                  </Button>
                  {a.expiresAt ? (
                    <span className="text-muted-foreground">
                      Denied automatically at {new Date(a.expiresAt).toLocaleTimeString()}
                    </span>
                  ) : null}
                </div>
              ) : null}
            </details>
          </li>
        );
      })}
    </ul>
  );
}

export function TranscriptToolCalls({ calls }: { calls: readonly TranscriptToolCall[] }) {
  if (calls.length === 0) return null;
  return (
    <details className="mt-1 text-xs" data-testid="transcript-tool-calls">
      <summary className="cursor-pointer select-none text-muted-foreground">
        Tools used ({calls.length})
      </summary>
      <ul className="mt-1 space-y-1">
        {calls.map((c) => (
          <li key={c.id} className="rounded border border-border px-2 py-1">
            <details>
              <summary className="cursor-pointer select-none">
                <span className="font-medium">{c.name}</span>
                <span
                  className={`ml-2 ${c.executed && !c.isError ? "text-muted-foreground" : "text-destructive"}`}
                >
                  {c.errorCode && c.executed
                    ? toolErrorText(c.errorCode as never)
                    : decisionLabel(c.decision, c.executed)}
                </span>
              </summary>
              {c.executed && c.resultPreview ? (
                <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded bg-muted p-1">
                  {c.resultPreview}
                </pre>
              ) : null}
            </details>
          </li>
        ))}
      </ul>
    </details>
  );
}
