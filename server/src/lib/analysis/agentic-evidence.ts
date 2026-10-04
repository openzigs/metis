/**
 * #766 / #726 — hand the code agent's retrieved evidence back to it, at full
 * fidelity, when it has to write its answer.
 *
 * The agentic loop keeps every tool result twice: once in the transcript it
 * re-sends each turn, and once, untruncated, in `AgentLoopResult.toolCalls`
 * (#734). Transcript compaction (#1225) elides the transcript copy of older
 * results down to a 600-character head so per-turn prompts stay bounded, which
 * is the right trade WHILE investigating, and the wrong one at answer time:
 *
 *   - #726 — the final answer was written over the compacted transcript, so a
 *     20-line Go validator the agent had read in full appeared as its header
 *     plus a few lines, and the agent reported it "truncated after its header".
 *     23 of 28 findings came back "Could not verify".
 *   - #766 — a token-budget stop whose one tool-free retry produced nothing left
 *     salvage with only the last tool-call reply, which can never yield a
 *     finding: 64 tool calls, 0 findings.
 *
 * {@link buildEvidenceDigest} rebuilds the evidence from the untruncated copy,
 * file reads first, under a token budget. The loop's final-answer retry gets it
 * as a quoted block ({@link formatEvidenceForAnswer}); and when every other
 * salvage path recovered nothing, {@link salvageFromEvidence} makes ONE bounded,
 * tool-free call over the task plus the digest, without the transcript.
 *
 * Nothing here can add a claim the agent did not retrieve: the digest is only
 * tool output the agent already received, and the answer still goes through
 * schema validation, citation grounding (#734) and verdict gating (#773).
 */
import type { AgentFindingPayload, AnalysisSpecialistAgentKey } from "@metis/shared";
import { callJsonLlm, JsonLlmParseError } from "../ai/json-llm-client.js";
import { fenceToolResult } from "../ai/tool-runtime/fence.js";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { estimateTokens } from "./context-window-manager.js";
import { repairMaxOutputTokens } from "./agent-runner.js";
import { FINAL_ANSWER_INSTRUCTION, salvageWithRepair } from "./agentic-degradation.js";
import type { FindKnownDocumentIds, FindingsRepair, KnownDocument } from "./findings-repair.js";

/**
 * Tools whose output is code evidence, in the order the digest fills its
 * budget. A file read is the only result that carries a function BODY, so it
 * goes first; the two searches carry `file:line` locators.
 */
export const EVIDENCE_TOOLS = [
  "read_file_slice",
  "search_code_graph",
  "search_code_symbols",
] as const;

/**
 * Evidence budget for the loop's final-answer retry. The transcript the retry
 * re-sends is already bounded by compaction (16k tokens), so this roughly
 * doubles the retry prompt in exchange for the bodies compaction elided.
 */
export const DEFAULT_RETRY_EVIDENCE_TOKENS = 16_000;

/**
 * Evidence budget for {@link salvageFromEvidence}. That call carries no
 * transcript, so it can afford more evidence than the retry.
 */
export const DEFAULT_SALVAGE_EVIDENCE_TOKENS = 24_000;

/**
 * One entry's ceiling. A 200-line `read_file_slice` (the per-call cap) is
 * typically 8-10k characters; one oversized search result must not starve
 * every file read behind it.
 */
export const MAX_EVIDENCE_ENTRY_CHARS = 12_000;

interface EvidenceCall {
  tool: string;
  args: unknown;
  result?: string;
  resultPreview?: string;
  isError?: boolean;
}

export interface EvidenceDigest {
  /** The rendered entries, or "" when nothing usable was retrieved. */
  text: string;
  /** Distinct tool results included. */
  included: number;
  /** Distinct, usable tool results left out because the budget ran out. */
  omitted: number;
}

function describeArgs(args: unknown): string {
  try {
    return JSON.stringify(args) ?? "";
  } catch {
    return "";
  }
}

function renderEntry(call: EvidenceCall, body: string): string {
  const capped =
    body.length > MAX_EVIDENCE_ENTRY_CHARS
      ? `${body.slice(0, MAX_EVIDENCE_ENTRY_CHARS)}\n[entry cut at ${MAX_EVIDENCE_ENTRY_CHARS} characters]`
      : body;
  return `### ${call.tool} ${describeArgs(call.args)}\n${capped}`;
}

/**
 * Rebuild the code evidence a loop retrieved, from the untruncated tool
 * results, under `maxTokens`. Errored calls, empty results, non-code tools and
 * exact duplicates are skipped; file reads come before searches, and each
 * group keeps the order the agent ran them in.
 */
export function buildEvidenceDigest(
  toolCalls: ReadonlyArray<EvidenceCall>,
  opts: { maxTokens: number },
): EvidenceDigest {
  const seen = new Set<string>();
  const ordered: Array<{ call: EvidenceCall; body: string }> = [];
  for (const tool of EVIDENCE_TOOLS) {
    for (const call of toolCalls) {
      if (call.tool !== tool || call.isError === true) continue;
      const body = (call.result ?? call.resultPreview ?? "").trim();
      if (!body || seen.has(body)) continue;
      seen.add(body);
      ordered.push({ call, body });
    }
  }

  const entries: string[] = [];
  let used = 0;
  let omitted = 0;
  for (const { call, body } of ordered) {
    const entry = renderEntry(call, body);
    const cost = estimateTokens(entry);
    if (used + cost > opts.maxTokens) {
      omitted++;
      continue;
    }
    entries.push(entry);
    used += cost;
  }
  return { text: entries.join("\n\n"), included: entries.length, omitted };
}

/**
 * The digest as a quoted data block for the model, or "" when it is empty.
 * Fenced like any tool result: it is retrieved repository text, so it must
 * never read as an instruction.
 */
export function formatEvidenceForAnswer(digest: EvidenceDigest): string {
  if (digest.included === 0) return "";
  const more = digest.omitted > 0 ? ` ${digest.omitted} more were left out for length.` : "";
  const preamble =
    `Below is the full text of ${digest.included} tool result(s) you already received in this ` +
    "investigation. Older results above may show only their first lines; read the code here " +
    `instead, and cite it by file and line.${more}`;
  return fenceToolResult("evidence_digest", `${preamble}\n\n${digest.text}`);
}

export interface EvidenceSalvageResult {
  /** Whether a model call was made (false when there was no evidence). */
  attempted: boolean;
  findings: AgentFindingPayload[];
  /** Tool results the call was given. */
  evidenceEntries: number;
  /** The call's usage, to be added to the pass's own. Zero when not attempted. */
  usage: TokenUsage;
  /** #298 field repairs applied to the recovered findings. */
  fieldRepairs: FindingsRepair[];
  /** Why the call produced nothing, when it failed outright. */
  error?: string;
}

const NO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * #766 — the last salvage path for a degraded agentic pass: ONE tool-free call
 * over the pass's own task (system + user message, with no tool manifest) plus
 * the evidence digest, without the transcript. Smaller than the final-answer
 * retry and at full fidelity, so it does not fail the way that call did.
 *
 * Bounded: one call, plus the one #1217 syntax repair when the answer comes
 * back truncated. Never throws except on cancellation; a failure returns no
 * findings and the error text for the log.
 */
export async function salvageFromEvidence(
  provider: AIProvider,
  opts: {
    agentKey: AnalysisSpecialistAgentKey;
    /** The pass's system message WITHOUT the tool manifest. */
    systemMessage: string;
    /** The pass's task message (requirements and seeded context). */
    userMessage: string;
    toolCalls: ReadonlyArray<EvidenceCall>;
    model?: string;
    signal?: AbortSignal;
    maxOutputTokens: number;
    evidenceTokens?: number;
    loadKnownDocuments?: () => Promise<readonly KnownDocument[]>;
    findKnownDocumentIds?: FindKnownDocumentIds;
  },
): Promise<EvidenceSalvageResult> {
  const digest = buildEvidenceDigest(opts.toolCalls, {
    maxTokens: opts.evidenceTokens ?? DEFAULT_SALVAGE_EVIDENCE_TOKENS,
  });
  if (digest.included === 0) {
    return {
      attempted: false,
      findings: [],
      evidenceEntries: 0,
      usage: NO_USAGE,
      fieldRepairs: [],
    };
  }

  let raw: string;
  let usage: TokenUsage;
  try {
    const result = await callJsonLlm(provider, {
      systemPrompt: opts.systemMessage,
      userPrompt: `${opts.userMessage}\n\n${formatEvidenceForAnswer(digest)}\n\n${FINAL_ANSWER_INSTRUCTION}`,
      ...(opts.model ? { modelOverride: opts.model } : {}),
      maxTokens: opts.maxOutputTokens,
      ...(opts.signal ? { signal: opts.signal } : {}),
    });
    raw = result.raw;
    usage = result.response.usage;
  } catch (err) {
    if (err instanceof JsonLlmParseError) {
      // Prose or a truncated payload: still billed, still worth a salvage.
      raw = err.raw;
      usage = err.response.usage;
    } else {
      if ((err as Error).name === "AbortError") throw err;
      return {
        attempted: true,
        findings: [],
        evidenceEntries: digest.included,
        usage: NO_USAGE,
        fieldRepairs: [],
        error: (err as Error).message,
      };
    }
  }

  const salvage = await salvageWithRepair(provider, raw, {
    agentKey: opts.agentKey,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.signal ? { signal: opts.signal } : {}),
    maxOutputTokens: repairMaxOutputTokens(opts.maxOutputTokens, opts.model),
    ...(opts.loadKnownDocuments ? { loadKnownDocuments: opts.loadKnownDocuments } : {}),
    ...(opts.findKnownDocumentIds ? { findKnownDocumentIds: opts.findKnownDocumentIds } : {}),
  });
  return {
    attempted: true,
    findings: salvage.findings,
    evidenceEntries: digest.included,
    usage,
    fieldRepairs: salvage.fieldRepairs,
  };
}
