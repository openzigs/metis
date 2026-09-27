/**
 * #141 / #214 — native vs text tool calls on the ANALYSIS agent loop, measured
 * side by side on the same corpus, model and tools.
 *
 * #214 decides whether `ANALYSIS_NATIVE_TOOL_CALLS` flips on. It needs, per
 * tool protocol: findings validity, the degraded-pass rate, tool-call error
 * counts and tokens per run. This module produces those from the orchestrator's
 * agentic LOOP, set up the way the orchestrator sets it up:
 *
 *   • the protocol decision is {@link resolveAnalysisNativeTools} — the one
 *     function the orchestrator calls — evaluated with the flag set per mode,
 *     so "native" here means what it means in production (a model the catalog
 *     marks not tool-capable reports `text`, never a fake native number);
 *   • the prompt (fused code context, affected-code and affected-schema blocks),
 *     the budget carve-out and the default turn cap are the orchestrator's own
 *     {@link buildAgenticPassPrompt} / {@link agenticPassEffectiveBudget} /
 *     {@link resolveAgenticMaxTurns} (for a single, non-escalated pass);
 *   • the loop options mirror the orchestrator's (`promptCaching`, the #769
 *     final-answer retry gated on the #1314 schema check, the #1221 output cap).
 *
 * What it does NOT run: the orchestrator's post-loop salvage/repair, citation
 * grounding and escalation split. So `degraded` here means "the loop plus its
 * #769 retry produced no schema-valid answer", not "the pass shipped zero
 * findings", and `findingsValid` is schema validity, not findings quality.
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
import {
  agenticPassEffectiveBudget,
  buildAgenticPassPrompt,
  resolveAgentTokenBudget,
  resolveAgenticMaxTurns,
  type AgenticPassSeeds,
} from "../../analysis/agentic-pass-context.js";
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
  /**
   * The operator's free-text new requirements (the analysis run's
   * `extraInstructions`). The affected-code and affected-schema blocks are
   * derived from this, exactly as in a real run; omitted ⇒ both are empty.
   */
  extraInstructions: z.string().max(20_000).optional(),
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

/**
 * What one agentic pass needs besides the provider: the orchestrator's prompt
 * inputs and seeds (the harness builds the prompt and budget from them with the
 * orchestrator's own functions), plus the tools.
 */
export interface ProtocolPassInput {
  projectName: string;
  projectDescription: string;
  requirements: Array<{ id: string; text: string }>;
  seeds: AgenticPassSeeds;
  fileToolsAvailable: boolean;
  tools: AgentTool[];
  toolContext: ToolContext;
}

export interface ProtocolRunRecord {
  caseId: string;
  mode: ProtocolMode;
  run: number;
  /** The protocol the pass actually ENDED on (see the module header). */
  protocol: "native" | "text" | "text-fallback";
  /**
   * Replies produced without the offered tools in native mode (the loop's
   * `toolsDroppedTurns`). A `"native"` run with any is not native end to end.
   */
  toolsDroppedTurns: number;
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
  /** The loop's token budget after the seed carve-out (the orchestrator's `effectiveBudget`). */
  tokenBudget: number;
  usage: TokenUsage;
  durationMs: number;
  /** The pass threw (provider error). Counted as degraded. */
  error?: string;
}

export interface ProtocolModeSummary {
  mode: ProtocolMode;
  runs: number;
  /** Runs whose pass actually used native tool calls end to end (no tool-less turn). */
  nativeRuns: number;
  /** Tool-less native replies across the mode's runs (see {@link ProtocolRunRecord.toolsDroppedTurns}). */
  toolsDroppedTurns: number;
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
  /** Turn cap; defaults to the orchestrator's {@link resolveAgenticMaxTurns} for the case. */
  maxTurns?: number;
  /**
   * The pass's token budget BEFORE the seed carve-out (defaults to the
   * orchestrator's `ANALYSIS_AGENT_TOKEN_BUDGET`). The loop receives
   * {@link agenticPassEffectiveBudget} of it, as in production.
   */
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
  base: Pick<ProtocolRunRecord, "caseId" | "mode" | "run" | "durationMs" | "tokenBudget">,
  requestedNative: boolean,
  r: AgentLoopResult,
): ProtocolRunRecord {
  const degraded = !r.hasFinalAnswer;
  return {
    ...base,
    protocol: r.toolProtocol ?? (requestedNative ? "native" : "text"),
    toolsDroppedTurns: r.toolsDroppedTurns ?? 0,
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
    nativeRuns: rs.filter((r) => r.protocol === "native" && r.toolsDroppedTurns === 0).length,
    toolsDroppedTurns: rs.reduce((a, r) => a + r.toolsDroppedTurns, 0),
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
      const { systemMessage, userMessage } = buildAgenticPassPrompt(pass);
      const maxTurns = opts.maxTurns ?? resolveAgenticMaxTurns(pass.requirements.length);
      const tokenBudget = agenticPassEffectiveBudget(
        opts.maxTokens ?? resolveAgentTokenBudget(),
        pass.seeds,
      );
      for (let run = 1; run <= runsPerCase; run++) {
        for (const mode of modes) {
          process.env[FLAG] = mode === "native" ? "true" : "false";
          const native = resolveAnalysisNativeTools(opts.provider, model, pass.tools);
          const started = now();
          const base = { caseId: c.id, mode, run, tokenBudget };
          let record: ProtocolRunRecord;
          try {
            const result = await runAgentLoop(
              opts.provider,
              {
                systemMessage,
                userMessage,
                tools: pass.tools,
                toolContext: pass.toolContext,
              },
              {
                ...(native ? { native } : {}),
                maxTurns,
                maxTokens: tokenBudget,
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
              toolsDroppedTurns: 0,
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
    "| Mode | Runs | Native runs | Text fallbacks | Tool-less native turns | Findings valid | Degraded | Errors | Tool calls | Tool errors | Mean turns | Mean prompt tok | Mean completion tok | Mean total tok | Mean findings |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...c.summaries.map(
      (s) =>
        "| " +
        [
          s.mode,
          s.runs,
          s.nativeRuns,
          s.textFallbackRuns,
          s.toolsDroppedTurns,
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
