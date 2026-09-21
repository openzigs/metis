/**
 * P0 #774 (AC 4) — observability for the agent loop's tool calls.
 *
 * `runAgentLoop` returns its `toolCalls`, but the analysis orchestrator threw
 * them away. That is precisely why #774 stayed invisible until live dogfooding:
 * on the reported run EVERY tool call failed (args dropped by the parser) or
 * returned alphabetical noise, and nothing anywhere recorded that fact — the
 * persisted AgentResult looked like a normal, if empty-handed, analysis.
 *
 * This module reduces the loop's tool calls to a COMPACT, bounded summary that
 * is persisted alongside the agent output. Deliberately NOT persisted: full tool
 * results (unbounded, and already re-derivable), or argument VALUES (untrusted
 * model text). Error counts + per-tool counts + a bounded sample of the
 * model-facing repair messages is enough to answer "did this agent's searches
 * actually work?" from the row alone.
 *
 * Pure and dependency-free so it can be asserted without a DB or a provider.
 */

/** Max error messages retained on the summary. */
const MAX_ERROR_SAMPLES = 5;
/** Max chars per retained error message. */
const MAX_ERROR_CHARS = 240;

export interface ToolCallErrorSample {
  tool: string;
  message: string;
}

export interface ToolCallTelemetry {
  /** Tool calls the loop executed (across every pass of the run). */
  totalCalls: number;
  /** How many of those came back as an error / rejection. */
  errorCalls: number;
  /** Per-tool call and error counts, ordered by first use. */
  byTool: Array<{ tool: string; calls: number; errors: number }>;
  /** Bounded sample of the error text the MODEL saw, for operator triage. */
  errorSamples: ToolCallErrorSample[];
}

/** The subset of `AgentLoopResult["toolCalls"]` this summary needs. */
export interface ToolCallRecord {
  tool: string;
  resultPreview?: string;
  result?: string;
  /**
   * #773 — STRUCTURED OUTCOME, set by the tool itself (`ToolResult.isError`) and
   * forwarded by the loop. The tool knows whether it failed; prose-sniffing its
   * error copy is a convention, and #773 made that convention load-bearing for
   * VERDICTS. Absent on legacy records ⇒ fall back to the prose sniff.
   */
  isError?: boolean;
  /**
   * #773 — STRUCTURED RESULT COUNT, set by the tool itself (`ToolResult.resultCount`):
   * how many results the call returned. `0` = a well-formed EMPTY result — the tool
   * worked and the thing genuinely is not there, which is EVIDENCE OF ABSENCE, not
   * evidence of a broken run. Absent on legacy records ⇒ fall back to prose.
   */
  resultCount?: number;
}

/**
 * A tool signals failure by returning content that starts with "Error" — the
 * convention every tool in `analysis/tools/` (and the loop's own unknown-tool
 * branch) already follows. `search_code_graph`'s #774 unfiltered-call guidance
 * is intentionally error-shaped too, so an agent that keeps making empty calls
 * shows up here rather than silently "succeeding".
 *
 * PREFER {@link isErroredCall}, which reads the tool's own structured `isError`
 * flag and only falls back to this prose sniff. Kept exported because the #774
 * telemetry summary classifies from content alone.
 */
export function isToolErrorResult(content: string | undefined): boolean {
  return (content ?? "").trimStart().toLowerCase().startsWith("error");
}

/**
 * Did this call ERROR? Structured contract first (the tool said so), prose sniff
 * only as the legacy fallback. An error means RETRIEVAL IS BROKEN — it says
 * nothing about the codebase, which is exactly why #773 separates it from an
 * empty result (see `retrieval-health.ts`).
 */
export function isErroredCall(call: ToolCallRecord): boolean {
  if (typeof call.isError === "boolean") return call.isError;
  return isToolErrorResult(call.result ?? call.resultPreview);
}

export function summarizeToolCalls(calls: readonly ToolCallRecord[]): ToolCallTelemetry {
  const byTool = new Map<string, { tool: string; calls: number; errors: number }>();
  const errorSamples: ToolCallErrorSample[] = [];
  let errorCalls = 0;

  for (const call of calls) {
    const entry = byTool.get(call.tool) ?? { tool: call.tool, calls: 0, errors: 0 };
    entry.calls += 1;

    const content = call.result ?? call.resultPreview;
    if (isErroredCall(call)) {
      entry.errors += 1;
      errorCalls += 1;
      if (errorSamples.length < MAX_ERROR_SAMPLES) {
        errorSamples.push({
          tool: call.tool,
          message: (content ?? "").trim().slice(0, MAX_ERROR_CHARS),
        });
      }
    }
    byTool.set(call.tool, entry);
  }

  return {
    totalCalls: calls.length,
    errorCalls,
    byTool: [...byTool.values()],
    errorSamples,
  };
}
