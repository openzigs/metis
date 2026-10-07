/**
 * P0 #769 — graceful degradation for the agentic code agent.
 *
 * The agentic loop can end without a parseable JSON answer for two reasons:
 *   1. it burned its turn cap / token budget while still calling tools, so the
 *      loop substituted prose for the pending tool call (`buildBudgetExhaustedMessage`), or
 *   2. the model simply answered in prose despite the output contract.
 *
 * Before #769 the orchestrator handed that text straight to `extractJsonObject`,
 * which threw — the code agent was marked `failed` and EVERY finding plus the
 * whole investigation (≈40k tokens on the run that surfaced this) was discarded,
 * while the analysis still reported `completed`.
 *
 * These helpers are PURE (no provider, no prisma) so the salvage logic is
 * directly testable:
 *   - {@link isJsonFinalAnswer} — the loop's "is this answerable?" predicate.
 *   - {@link salvageFindings} — recover whatever individually-valid findings the
 *     model DID emit, even when the object as a whole fails schema validation.
 *   - {@link buildDegradedAgentOutput} — a persistable {@link AgentOutput} that
 *     carries the salvaged findings plus an explicit, honest note about what was
 *     lost, so the run is never silently code-blind.
 *
 * {@link salvageWithRepair} is the one exception: #1217 showed that the most
 * common real-world salvage source is a payload the output cap cut off
 * mid-array, which no pure string manipulation can recover, so it wraps
 * {@link salvageFindings} with ONE bounded syntax-repair call.
 */
import {
  AGENT_DEGRADED_NOTE_PREFIX,
  agentFindingPayloadSchema,
  agentOutputSchema,
  ANALYSIS_AGENT_KEYS,
  type AgentFindingPayload,
  type AgentOutput,
  type AnalysisAgentKey,
  type AnalysisSpecialistAgentKey,
} from "@metis/shared";
import type { AIProvider } from "../ai/types.js";
import { extractJsonObject, repairAgentJson } from "./agent-runner.js";
import {
  knownDocumentsForRepair,
  repairFinding,
  repairFindingsAnswer,
  type FindKnownDocumentIds,
  type FindingsRepair,
  type KnownDocument,
} from "./findings-repair.js";
import {
  classifyFinalAnswer,
  isToolCallReply,
  type AgentLoopResult,
  type FinalAnswerKind,
} from "./agent-loop.js";

/** Why the agentic pass could not produce a validated JSON answer. */
export type AgenticDegradationReason =
  /** Turn cap reached while the model was still calling tools. */
  | "turn-limit"
  /** Token budget exhausted mid-investigation. */
  | "token-budget"
  /** Final response was prose (or otherwise carried no JSON object). */
  | "non-json-response"
  /** A JSON object came back but failed `agentOutputSchema` validation. */
  | "schema-invalid";

/** Human-readable, non-technical explanation per reason (goes into the run's notes). */
const REASON_TEXT: Record<AgenticDegradationReason, string> = {
  "turn-limit":
    "the code agent reached its tool-call turn limit before it could finish composing its answer",
  "token-budget": "the code agent exhausted its token budget mid-investigation",
  "non-json-response":
    "the code agent answered in prose instead of the required JSON, even after being asked once more for JSON only",
  "schema-invalid": "the code agent's answer did not match the required findings schema",
};

/**
 * The analysis path's "usable final answer" predicate for the agent loop
 * (#769). Stricter than the loop's default ("not a tool call") because prose is
 * exactly one of the two failure modes we must retry: an answer is usable only
 * when it is NOT a tool call AND it contains a parseable JSON object.
 */
export function isJsonFinalAnswer(text: string): boolean {
  // #15 — `isToolCallReply`, not the single-call parser: a multi-call reply's
  // first object would otherwise pass `extractJsonObject` below as an "answer".
  if (!text || isToolCallReply(text)) return false;
  try {
    const parsed = extractJsonObject(text);
    return !!parsed && typeof parsed === "object";
  } catch {
    return false;
  }
}

/**
 * The instruction for the bounded, tool-free final-answer call (#769). The
 * conversation already holds every tool result, so this asks ONLY for
 * serialization — it must never invite more investigation.
 */
export const FINAL_ANSWER_INSTRUCTION = [
  "STOP INVESTIGATING. You have no tools available for this turn — any tool call will be discarded.",
  "",
  "Using ONLY the tool results and context already in this conversation, emit your final answer NOW",
  "as EXACTLY ONE JSON object matching the response schema from your role description",
  "(agentKey, summary, findings[], notes[]). No prose before or after it, no markdown code fences.",
  "",
  "Report only what you actually established. If your investigation was cut short, say so in `notes`",
  "and return the findings you DID ground — an empty `findings` array is acceptable, invented findings are not.",
  "",
  // #298 — the limits the answer is validated against, stated where the model
  // writes it. Pinned to `agentOutputSchema` by agentic-degradation.test.ts.
  "Field formats and limits (the answer is validated against them):",
  "- A document citation's `documentId` is the opaque id exactly as the context or a tool result gave it:",
  "  10-64 characters, or `code-graph:<symbolId>` (at most 320). Never a file path, a filename or quoted text;",
  "  cite a source file as `filePath` + `startLine` + `endLine` instead.",
  "- `summary` at most 2048 characters; each finding's `title` at most 255 and `body` at most 4096.",
  "- At most 50 findings, at most 20 citations per finding, and at most 20 `notes` of at most 512 characters each.",
].join("\n");

/**
 * #1314 — the gate deciding whether the bounded final-answer retry fires.
 *
 * {@link isJsonFinalAnswer} only asks "is this a JSON object", so an answer that
 * parsed but failed {@link agentOutputSchema} skipped the one call built to
 * repair it and then met a salvage pass applying that very schema — zero
 * findings, structurally guaranteed. Gate on the schema the caller enforces.
 */
export function isSchemaValidFinalAnswer(text: string): boolean {
  if (!isJsonFinalAnswer(text)) return false;
  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== "object") return false;
  // #298 — judge the answer the orchestrator will actually validate: one
  // over-long `documentId` or note is repaired there, so it must not fire the
  // retry (or fail the #214 measurement) here. The gate needs no document
  // list: the repair accepts a resolved id only when the resolved citation is
  // itself valid and otherwise drops it exactly as it does here, so resolving
  // against the known documents never changes the verdict (pinned by
  // findings-repair.test.ts and agentic-findings-repair-pipeline.test.ts).
  const repaired = repairFindingsAnswer(parsed).value as Record<string, unknown>;
  // The orchestrator stamps the real `agentKey` after the loop returns, so a
  // missing or wrong one here must not decide the gate.
  return agentOutputSchema.safeParse({
    ...repaired,
    agentKey: ANALYSIS_AGENT_KEYS[0],
  }).success;
}

/**
 * Recover individually-valid findings from a model response that did not
 * validate as a whole (#769 AC: "token spend on a failed serialization is not
 * wholly wasted"). Never throws: any parse failure yields `[]`.
 */
export function salvageFindings(raw: string): AgentFindingPayload[] {
  return salvageRepairedFindings(raw).findings;
}

/**
 * {@link salvageFindings}, with #298's citation repair applied to each
 * candidate first — so a finding whose only defect is an over-long citation
 * `documentId` is recovered rather than rejected — and the repairs returned
 * for the caller to record.
 */
export function salvageRepairedFindings(
  raw: string,
  opts: { knownDocuments?: readonly KnownDocument[] } = {},
): { findings: AgentFindingPayload[]; repairs: FindingsRepair[] } {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch {
    return { findings: [], repairs: [] };
  }
  if (!parsed || typeof parsed !== "object") return { findings: [], repairs: [] };
  const findings = (parsed as { findings?: unknown }).findings;
  if (!Array.isArray(findings)) return { findings: [], repairs: [] };
  const salvaged: AgentFindingPayload[] = [];
  const repairs: FindingsRepair[] = [];
  for (const [i, candidate] of findings.entries()) {
    const repaired = repairFinding(candidate, `findings.${i}`, opts);
    const result = agentFindingPayloadSchema.safeParse(repaired.value);
    if (result.success) {
      salvaged.push(result.data);
      // Only a salvaged finding's repairs happened to anything that is kept.
      repairs.push(...repaired.repairs);
    }
    if (salvaged.length >= 50) break; // agentOutputSchema caps findings at 50.
  }
  return { findings: salvaged, repairs };
}

/**
 * #298 / #303 — the known documents for salvaging `raw`, loaded only when its
 * findings carry a citation `documentId` the schema would reject or one that
 * is not a known document (see `knownDocumentsForRepair`). Never throws.
 */
async function documentsFor(
  raw: string,
  load: (() => Promise<readonly KnownDocument[]>) | undefined,
  findKnownIds: FindKnownDocumentIds | undefined,
): Promise<{ knownDocuments?: readonly KnownDocument[] }> {
  if (!load) return {};
  let parsed: unknown;
  try {
    parsed = extractJsonObject(raw);
  } catch {
    return {};
  }
  const knownDocuments = await knownDocumentsForRepair(parsed, load, findKnownIds);
  return knownDocuments ? { knownDocuments } : {};
}

/** Outcome of {@link salvageWithRepair}. */
export interface SalvageResult {
  findings: AgentFindingPayload[];
  /** What the salvage source actually was — drives triage and the degraded-run log. */
  sourceKind: FinalAnswerKind;
  repairAttempted: boolean;
  /**
   * #1218 — did the repair come back as parseable JSON at all?
   *
   * Separate from {@link SalvageResult.repairSucceeded} because the two failures
   * need opposite fixes: an unparseable repair is a MODEL or cap problem, while
   * a parsed repair whose findings were all rejected is a SCHEMA or
   * hallucination problem. Collapsed into one flag they read identically in the
   * log, which is the ambiguity these fields exist to remove (AC5).
   */
  repairParsed: boolean;
  repairSucceeded: boolean;
  /** #298 — field repairs applied to the recovered findings (empty when none). */
  fieldRepairs: FindingsRepair[];
}

/**
 * #1217 — salvage findings from a degraded agent answer, with ONE bounded JSON
 * repair when (and only when) the answer is structurally broken.
 *
 * `salvageFindings` alone cannot recover the single most common real failure:
 * the output cap cut the payload off mid-`findings`, so `extractJsonObject`'s
 * first-`{`-to-last-`}` slice is unbalanced and `JSON.parse` throws — every
 * finding the model actually completed is lost, and the run reports
 * `salvagedFindings: 0` no matter how much work went into it.
 *
 * Triage keeps this cheap and bounded:
 *   - findings already recovered  ⇒ no repair, we are done;
 *   - prose / empty / tool call   ⇒ no repair, there is no JSON to fix;
 *   - truncated / malformed JSON  ⇒ exactly ONE repair call, never retried.
 *
 * This is NOT a hallucination channel. `repairAgentJson` hands the model back
 * its OWN output with no project context and no schema guidance (a pure syntax
 * fix), every recovered candidate is re-validated against
 * `agentFindingPayloadSchema` here, and the caller runs the result through
 * citation grounding and verdict gating exactly as it does a non-degraded pass.
 */
export async function salvageWithRepair(
  provider: AIProvider,
  source: string,
  opts: {
    agentKey: AnalysisSpecialistAgentKey;
    model?: string;
    signal?: AbortSignal;
    /** OUTPUT cap for the repair call — it must be able to echo `source` back in full (#1218). */
    maxOutputTokens?: number;
    /**
     * #298 — loads the documents an over-long citation `documentId` may be
     * resolved against. Called only when a salvaged answer actually carries
     * such an id; a failure degrades to "no known documents".
     */
    loadKnownDocuments?: () => Promise<readonly KnownDocument[]>;
    /** #303 — cheap id check that spares the list load when every cited id is real. */
    findKnownDocumentIds?: FindKnownDocumentIds;
  },
): Promise<SalvageResult> {
  const sourceKind = classifyFinalAnswer(source);
  const { loadKnownDocuments, findKnownDocumentIds, ...repairOpts } = opts;
  const first = salvageRepairedFindings(
    source,
    await documentsFor(source, loadKnownDocuments, findKnownDocumentIds),
  );
  const none = {
    sourceKind,
    repairAttempted: false,
    repairParsed: false,
    repairSucceeded: false,
    fieldRepairs: [],
  };
  if (first.findings.length > 0) {
    return { ...none, findings: first.findings, fieldRepairs: first.repairs };
  }
  if (sourceKind !== "truncated-json" && sourceKind !== "malformed-json") {
    return { ...none, findings: [] };
  }

  // `repairAgentJson` already swallows its own failures and returns null, but a
  // salvage pass must never be able to fail the run it is trying to rescue.
  let repaired: unknown = null;
  try {
    repaired = await repairAgentJson(
      provider,
      source,
      new Error(`Salvage source was ${sourceKind}`),
      repairOpts,
    );
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    repaired = null;
  }
  if (repaired === null || repaired === undefined) {
    return {
      findings: [],
      sourceKind,
      repairAttempted: true,
      repairParsed: false,
      repairSucceeded: false,
      fieldRepairs: [],
    };
  }
  const repairedText = JSON.stringify(repaired);
  const recovered = salvageRepairedFindings(
    repairedText,
    await documentsFor(repairedText, loadKnownDocuments, findKnownDocumentIds),
  );
  return {
    findings: recovered.findings,
    sourceKind,
    repairAttempted: true,
    repairParsed: true,
    repairSucceeded: recovered.findings.length > 0,
    fieldRepairs: recovered.repairs,
  };
}

/**
 * #1218 — pick the text a degraded pass should salvage from.
 *
 * Extracted from the orchestrator so the choice is pinned by a test: taking
 * `finalResponse` when a `salvageSource` exists silently reinstates #1217 D1,
 * because by that point `finalResponse` may already be the deliberately
 * brace-free {@link buildDegradedAgentOutput} prose, from which no finding can
 * ever be recovered.
 */
export function selectSalvageSource(
  loopResult: Pick<AgentLoopResult, "salvageSource" | "finalResponse">,
): string {
  return loopResult.salvageSource ?? loopResult.finalResponse;
}

/**
 * Build the {@link AgentOutput} persisted when the agentic pass degraded (#769).
 * Carries the salvaged findings (possibly none) plus notes naming the reason and
 * the investigation that DID happen, so the result is honest rather than a
 * silent, code-blind "success".
 */
export function buildDegradedAgentOutput(input: {
  agentKey: AnalysisAgentKey;
  reason: AgenticDegradationReason;
  toolCalls: ReadonlyArray<{ tool: string }>;
  salvaged: AgentFindingPayload[];
}): AgentOutput {
  const toolNames = [...new Set(input.toolCalls.map((c) => c.tool))].sort();
  const investigation =
    input.toolCalls.length > 0
      ? `${input.toolCalls.length} tool call(s) were made (${toolNames.join(", ")})`
      : "no tool calls completed";
  const summary =
    `Code analysis degraded: ${REASON_TEXT[input.reason]}. ` +
    `${investigation}; ${input.salvaged.length} finding(s) were recovered. ` +
    `Treat this run's code coverage as incomplete and re-run the analysis.`;
  return {
    agentKey: input.agentKey,
    summary: summary.slice(0, 2048),
    findings: input.salvaged,
    notes: [
      `${AGENT_DEGRADED_NOTE_PREFIX} ${REASON_TEXT[input.reason]}.`.slice(0, 512),
      `Recovered ${input.salvaged.length} finding(s) from ${input.toolCalls.length} tool call(s).`.slice(
        0,
        512,
      ),
    ],
  };
}
