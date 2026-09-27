/**
 * #141 / #214 — native vs text tool calls on the ANALYSIS agent loop, measured
 * side by side on the same corpus, model and tools.
 *
 * #214 decides whether `ANALYSIS_NATIVE_TOOL_CALLS` flips on. It needs, per
 * tool protocol: findings validity, the degraded-pass rate, tool-call error
 * counts and tokens per run. This module produces exactly those, from the SAME
 * code the orchestrator's agentic pass runs:
 *
 *   • the protocol decision is {@link resolveAnalysisNativeTools} — the one
 *     function the orchestrator calls — evaluated with the flag set per mode,
 *     so "native" here means what it means in production (a model the catalog
 *     marks not tool-capable reports `text`, never a fake native number);
 *   • the loop options mirror the orchestrator's (`promptCaching`, the #769
 *     final-answer retry gated on the #1314 schema check, the #1221 output cap).
 *
 * The provider, tools and prompts are injected, so the unit tests drive it with
 * a scripted stub and the CLI (`server/scripts/eval-analysis-tool-protocol.ts`)
 * wires a real project. Nothing here calls a model on its own.
 */
import { z } from "zod";
import type { AIProvider, TokenUsage } from "../../ai/types.js";
import {
  resolveAnalysisNativeTools,
  runAgentLoop,
  type AgentLoopResult,
} from "../../analysis/agent-loop.js";
import {
  FINAL_ANSWER_INSTRUCTION,
  isSchemaValidFinalAnswer,
} from "../../analysis/agentic-degradation.js";
import {
  extractJsonObject,
  resolveFinalAnswerMaxOutputTokens,
} from "../../analysis/agent-runner.js";
import type { AgentTool, ToolContext } from "../../analysis/tools/types.js";

/** The two protocols #214 compares. */
export type ProtocolMode = "text" | "native";

/** One corpus case: the requirements one agentic pass investigates. */
export const protocolCaseSchema = z.object({
  id: z.string().min(1).max(120),
  requirements: z
    .array(z.object({ id: z.string().min(1).max(120), text: z.string().min(1).max(20_000) }))
    .min(1)
    .max(200),
});
export type ProtocolCase = z.infer<typeof protocolCaseSchema>;

/** Parse a corpus file's JSON: an array of {@link ProtocolCase}. Throws on a bad shape. */
export function parseProtocolCases(json: unknown): ProtocolCase[] {
  const cases = z.array(protocolCaseSchema).min(1).parse(json);
  const ids = new Set<string>();
  for (const c of cases) {
    if (ids.has(c.id)) throw new Error(`duplicate case id "${c.id}"`);
    ids.add(c.id);
  }
  return cases;
}

/** What one agentic pass needs besides the provider. */
export interface ProtocolPassInput {
  systemMessage: string;
  userMessage: string;
  tools: AgentTool[];
  toolContext: ToolContext;
}

export interface ProtocolRunRecord {
  caseId: string;
  mode: ProtocolMode;
  run: number;
  /** The protocol the pass actually ENDED on (see the module header). */
  protocol: "native" | "text" | "text-fallback";
  /** A schema-valid findings answer (the orchestrator's `hasFinalAnswer`). */
  findingsValid: boolean;
  findingsCount: number;
  /** No usable answer — the orchestrator would degrade this pass. */
  degraded: boolean;
  degradedReason?: "token-budget" | "turn-limit" | "no-valid-answer";
  finalAnswerRetry: boolean;
  turnsUsed: number;
  toolCalls: number;
  toolErrors: number;
  usage: TokenUsage;
  durationMs: number;
  /** The pass threw (provider error). Counted as degraded. */
  error?: string;
}

export interface ProtocolModeSummary {
  mode: ProtocolMode;
  runs: number;
  /** Runs whose pass actually used native tool calls end to end. */
  nativeRuns: number;
  textFallbackRuns: number;
  findingsValidRate: number;
  degradedRate: number;
  errors: number;
  toolCalls: number;
  toolErrors: number;
  meanTurns: number;
  meanPromptTokens: number;
  meanCompletionTokens: number;
  meanTotalTokens: number;
  meanFindings: number;
}

export interface ProtocolComparison {
  model: string;
  provider: string;
  runsPerCase: number;
  cases: number;
  records: ProtocolRunRecord[];
  summaries: ProtocolModeSummary[];
}

export interface ProtocolComparisonOptions {
  provider: AIProvider;
  /** The model id the passes run on (defaults to the provider's). */
  model?: string;
  cases: ProtocolCase[];
  buildPass: (c: ProtocolCase) => ProtocolPassInput | Promise<ProtocolPassInput>;
  modes?: ProtocolMode[];
  runsPerCase?: number;
  maxTurns?: number;
  /** The pass's token budget (the orchestrator's `ANALYSIS_AGENT_TOKEN_BUDGET`). */
  maxTokens?: number;
  /** Progress callback, one call per finished pass. */
  onRecord?: (r: ProtocolRunRecord) => void;
  /** Clock seam for tests. */
  now?: () => number;
}

const FLAG = "ANALYSIS_NATIVE_TOOL_CALLS";

function findingsIn(text: string): number {
  try {
    const parsed = extractJsonObject(text) as { findings?: unknown } | null;
    return Array.isArray(parsed?.findings) ? parsed.findings.length : 0;
  } catch {
    return 0;
  }
}

function recordFrom(
  base: Pick<ProtocolRunRecord, "caseId" | "mode" | "run" | "durationMs">,
  requestedNative: boolean,
  r: AgentLoopResult,
): ProtocolRunRecord {
  const degraded = !r.hasFinalAnswer;
  return {
    ...base,
    protocol: r.toolProtocol ?? (requestedNative ? "native" : "text"),
    findingsValid: r.hasFinalAnswer,
    findingsCount: r.hasFinalAnswer ? findingsIn(r.finalResponse) : 0,
    degraded,
    ...(degraded
      ? {
          degradedReason: r.budgetExhausted
            ? ("token-budget" as const)
            : r.turnsExhausted
              ? ("turn-limit" as const)
              : ("no-valid-answer" as const),
        }
      : {}),
    finalAnswerRetry: r.finalAnswerRetry?.attempted === true,
    turnsUsed: r.turnsUsed,
    toolCalls: r.toolCalls.length,
    toolErrors: r.toolCalls.filter((c) => c.isError === true).length,
    usage: { ...r.usage },
  };
}

const mean = (xs: number[]): number =>
  xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;

/** Aggregate one mode's records. */
export function summarizeMode(
  mode: ProtocolMode,
  records: ProtocolRunRecord[],
): ProtocolModeSummary {
  const rs = records.filter((r) => r.mode === mode);
  const n = rs.length;
  return {
    mode,
    runs: n,
    nativeRuns: rs.filter((r) => r.protocol === "native").length,
    textFallbackRuns: rs.filter((r) => r.protocol === "text-fallback").length,
    findingsValidRate: n === 0 ? 0 : rs.filter((r) => r.findingsValid).length / n,
    degradedRate: n === 0 ? 0 : rs.filter((r) => r.degraded).length / n,
    errors: rs.filter((r) => r.error !== undefined).length,
    toolCalls: rs.reduce((a, r) => a + r.toolCalls, 0),
    toolErrors: rs.reduce((a, r) => a + r.toolErrors, 0),
    meanTurns: mean(rs.map((r) => r.turnsUsed)),
    meanPromptTokens: mean(rs.map((r) => r.usage.promptTokens)),
    meanCompletionTokens: mean(rs.map((r) => r.usage.completionTokens)),
    meanTotalTokens: mean(rs.map((r) => r.usage.totalTokens)),
    meanFindings: mean(rs.map((r) => r.findingsCount)),
  };
}

/**
 * Run every case `runsPerCase` times under each mode. Modes interleave per
 * case and run (text, native, text, native, …) so a drifting endpoint cannot
 * bias one protocol. The flag is restored afterwards, whatever happens.
 */
export async function runToolProtocolComparison(
  opts: ProtocolComparisonOptions,
): Promise<ProtocolComparison> {
  const modes = opts.modes ?? ["text", "native"];
  const runsPerCase = opts.runsPerCase ?? 1;
  const model = opts.model ?? opts.provider.model;
  const now = opts.now ?? Date.now;
  const records: ProtocolRunRecord[] = [];
  const saved = process.env[FLAG];
  try {
    for (const c of opts.cases) {
      const pass = await opts.buildPass(c);
      for (let run = 1; run <= runsPerCase; run++) {
        for (const mode of modes) {
          process.env[FLAG] = mode === "native" ? "true" : "false";
          const native = resolveAnalysisNativeTools(opts.provider, model, pass.tools);
          const started = now();
          const base = { caseId: c.id, mode, run };
          let record: ProtocolRunRecord;
          try {
            const result = await runAgentLoop(
              opts.provider,
              {
                systemMessage: pass.systemMessage,
                userMessage: pass.userMessage,
                tools: pass.tools,
                toolContext: pass.toolContext,
              },
              {
                ...(native ? { native } : {}),
                maxTurns: opts.maxTurns ?? 8,
                ...(opts.maxTokens ? { maxTokens: opts.maxTokens } : {}),
                model,
                promptCaching: { system: true, messages: true },
                finalAnswerRetry: {
                  instruction: FINAL_ANSWER_INSTRUCTION,
                  isValidFinalAnswer: isSchemaValidFinalAnswer,
                  maxOutputTokens: resolveFinalAnswerMaxOutputTokens(model, opts.provider.key),
                },
              },
            );
            record = recordFrom(
              { ...base, durationMs: now() - started },
              native !== undefined,
              result,
            );
          } catch (err) {
            record = {
              ...base,
              protocol: native ? "native" : "text",
              findingsValid: false,
              findingsCount: 0,
              degraded: true,
              finalAnswerRetry: false,
              turnsUsed: 0,
              toolCalls: 0,
              toolErrors: 0,
              usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
              durationMs: now() - started,
              error: (err as Error).message.slice(0, 300),
            };
          }
          records.push(record);
          opts.onRecord?.(record);
        }
      }
    }
  } finally {
    if (saved === undefined) delete process.env[FLAG];
    else process.env[FLAG] = saved;
  }
  return {
    model,
    provider: opts.provider.key,
    runsPerCase,
    cases: opts.cases.length,
    records,
    summaries: modes.map((m) => summarizeMode(m, records)),
  };
}

const pct = (x: number): string => `${(x * 100).toFixed(1)}%`;
const num = (x: number): string => (Number.isInteger(x) ? String(x) : x.toFixed(1));

/** The Markdown table #214 asks for, ready to paste into the issue. */
export function formatProtocolComparison(c: ProtocolComparison): string {
  const lines = [
    `### Analysis tool protocol — ${c.provider} / ${c.model}`,
    "",
    `${c.cases} case(s) × ${c.runsPerCase} run(s) per mode.`,
    "",
    "| Mode | Runs | Native runs | Text fallbacks | Findings valid | Degraded | Errors | Tool calls | Tool errors | Mean turns | Mean prompt tok | Mean completion tok | Mean total tok | Mean findings |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...c.summaries.map(
      (s) =>
        "| " +
        [
          s.mode,
          s.runs,
          s.nativeRuns,
          s.textFallbackRuns,
          pct(s.findingsValidRate),
          pct(s.degradedRate),
          s.errors,
          s.toolCalls,
          s.toolErrors,
          num(s.meanTurns),
          num(s.meanPromptTokens),
          num(s.meanCompletionTokens),
          num(s.meanTotalTokens),
          num(s.meanFindings),
        ].join(" | ") +
        " |",
    ),
  ];
  const native = c.summaries.find((s) => s.mode === "native");
  if (native && native.runs > 0 && native.nativeRuns === 0) {
    lines.push(
      "",
      "**Native mode never ran natively** — the model is not tool-capable in the catalog, or the runtime rejected `tools`. This comparison says nothing about native tool calls.",
    );
  }
  return lines.join("\n");
}
