/**
 * Epic #260 (#81) — custom-agent analysis phase.
 *
 * Runs every custom agent ENABLED for the project (via the
 * `CustomAgentEnablement` join) — and, since #236, every LIBRARY agent the
 * project has explicitly enabled (an enabled `ProjectAgentAllowlist` row) —
 * alongside the built-in specialists during an analysis run. Each agent is
 * invoked through the shared, injection-resistant {@link invokeAgentDefinition}
 * path with the project framing as its input — which is the one agent runtime
 * (`agent-runtime/run-agent.ts`) chat sub-agents use too (#129 / #145). The
 * run is text only: no tools are offered, because no person is present to
 * approve one.
 *
 * Design notes:
 *  - Failures are isolated per-agent: one agent throwing never aborts the
 *    others or the analysis. A failed agent is returned with an `error`.
 *  - Token usage is rolled up so the orchestrator can fold it into the run
 *    totals (and budget accounting).
 *  - Pure + provider-agnostic: fully unit-testable with a mock provider.
 *  - #289 — every agent is asked for the specialists' findings answer
 *    (`OUTPUT_SCHEMA_HINT`, appended to its system prompt by the server), and
 *    its answer is validated against the same `agentOutputSchema` after the
 *    #298 documentId/note repair and the #1230 string clamp. An answer that
 *    fails gets ONE bounded retry (#769's final-answer retry, for the one-call
 *    runtime); one that still fails is kept as an `invalid` result, which
 *    {@link persistAgentPhaseResults} records as a visible failed row — never
 *    silently dropped. Before #289 every agent's answer was discarded here.
 */
import {
  ANALYSIS_AGENT_KEYS,
  agentOutputSchema,
  type AgentDefinitionDto,
  type AgentFindingPayload,
} from "@metis/shared";
import { listEnabledAgentsForProject } from "../custom-agents/index.js";
import { invokeAgentDefinition } from "../custom-agents/invoke.js";
import { customDtoDefinition, listProjectLibraryAgents } from "../agent-runtime/definition.js";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { clampAgentOutputStrings, extractJsonObject } from "./agent-runner.js";
import {
  persistAgentResult,
  type AgentPhaseOutput,
  type PersistAgentResultInput,
} from "./analysis-service.js";
import {
  repairFindingsAnswer,
  summarizeFindingsRepairs,
  withFindingsRepairNote,
} from "./findings-repair.js";
import { OUTPUT_SCHEMA_HINT } from "./prompts.js";

const log = createChildLogger("analysis-custom-agent-phase");

export interface CustomAgentPhaseInput {
  provider: AIProvider;
  projectId: string;
  projectName: string;
  projectDescription: string;
  signal?: AbortSignal;
}

export interface CustomAgentResult {
  agentId: string;
  /** #236 — `library:<id>` or `custom:<id>`. */
  agentRef: string;
  kind: AgentDefinitionDto["kind"];
  agentName: string;
  content: string;
  usage: TokenUsage;
  error?: string;
  /** e.g. the agent's saved model could not be used — never silent (#145). */
  warnings?: string[];
  /** #289 — the validated findings answer (absent on error / invalid answer). */
  output?: AgentPhaseFindings;
  /** #289 — the answer failed the findings schema after repair and one retry. */
  invalid?: AgentFindingsInvalid;
  /** #289 — the agent was cancelled with the run. */
  aborted?: boolean;
  /** #289 — did the one bounded final-answer retry fire / succeed? */
  finalAnswerRetry?: { attempted: boolean; succeeded: boolean };
  startedAt: Date;
  completedAt: Date;
}

/** #289 — a validated findings answer, without the specialist-only `agentKey`. */
export interface AgentPhaseFindings {
  summary: string;
  findings: AgentFindingPayload[];
  notes: string[];
}

export interface AgentFindingsInvalid {
  reason: "non-json-response" | "schema-invalid";
  /** `path: code` of the first few schema issues — never the model's text. */
  issues: string[];
}

export interface CustomAgentPhaseResult {
  results: CustomAgentResult[];
  usage: TokenUsage;
}

const ZERO_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * #289 — the answer contract appended (server-authored, after the agent's own
 * persona) to every agent-phase system prompt: the specialists' findings shape.
 */
export const AGENT_PHASE_OUTPUT_CONTRACT = [
  "ANSWER FORMAT — set by the analysis run, and it applies whatever your role says about format.",
  "Report your analysis of the project as findings. You were given no documents or source code,",
  "so leave every `citations` array empty.",
  OUTPUT_SCHEMA_HINT,
].join("\n");

/** #289 — the one bounded retry's instruction (the #769 final-answer retry). */
export const AGENT_PHASE_RETRY_INSTRUCTION = [
  "Your previous answer did not match the required answer format.",
  "Re-emit it NOW as EXACTLY ONE JSON object with `summary`, `findings` and `notes`, matching the",
  "ANSWER FORMAT in your instructions. No prose before or after it, no markdown code fences.",
  "Keep only what your previous answer established — an empty `findings` array is acceptable,",
  "invented findings are not.",
  "Limits: `summary` at most 2048 characters; each finding's `title` at most 255 and `body` at most 4096;",
  "at most 50 findings and at most 20 `notes` of at most 512 characters each.",
].join("\n");

const MAX_REPORTED_ISSUES = 3;

/**
 * #289 — parse an agent's answer exactly as a specialist's is: extract the
 * JSON object, apply the #298 documentId/note repair and the #1230 string
 * clamp, then validate against `agentOutputSchema`. Never throws.
 */
export function parseAgentFindingsAnswer(text: string):
  | {
      ok: true;
      output: AgentPhaseFindings;
      repairs: ReturnType<typeof repairFindingsAnswer>["repairs"];
    }
  | { ok: false; invalid: AgentFindingsInvalid } {
  let parsed: unknown;
  try {
    parsed = extractJsonObject(text);
  } catch {
    return { ok: false, invalid: { reason: "non-json-response", issues: [] } };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, invalid: { reason: "non-json-response", issues: [] } };
  }
  const repaired = repairFindingsAnswer(parsed);
  // `agentKey` is specialist-only: stamp a valid one so the SAME schema judges
  // the rest of the answer, then drop it — the row is keyed by the agent ref.
  const candidate = clampAgentOutputStrings({
    ...(repaired.value as Record<string, unknown>),
    agentKey: ANALYSIS_AGENT_KEYS[0],
  });
  const result = agentOutputSchema.safeParse(candidate);
  if (!result.success) {
    return {
      ok: false,
      invalid: {
        reason: "schema-invalid",
        issues: result.error.issues
          .slice(0, MAX_REPORTED_ISSUES)
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.code}`),
      },
    };
  }
  const { summary, findings, notes } = result.data;
  return {
    ok: true,
    output: { summary, findings: findings.map(stripServerOwnedFields), notes },
    repairs: repaired.repairs,
  };
}

/**
 * #289 — drop every field the SERVER owns on a specialist finding. The
 * orchestrator overwrites or gates these for specialists (`verifyFinding`,
 * `gateFindingVerdict`, the #734 grounding, the support panel); this phase
 * runs none of that and gives the agent no documents or code, so any value
 * here is fabricated. A citation would render as evidence and seed
 * `RequirementCodeMapping` rows; a `verificationStatus` would render a
 * "confirmed" badge. `citations` is forced empty, as the contract says.
 * (`faithfulness` is already refused at the storage boundary.)
 *
 * #727 — and the server then stamps every such finding `ungrounded`. It was
 * written from the project's name and description alone, with no evidence and
 * no code access. Not `unverified`: that status means "cited code, and every
 * citation was dropped", and its badge says so — false for a finding that cites
 * nothing. `ungrounded` says what happened (nothing was checked against the
 * source); synthesis renders it `[UNGROUNDED]` and down-weights it like
 * `[UNVERIFIED]` (rule 4), and the findings view badges and filters it. Before #727 these findings carried `null` — the neutral
 * "nothing to verify" state — so an invented module (a `sqlc` layer the
 * project does not have) reached a requirement's acceptance criteria with the
 * same weight as a cited specialist finding.
 */
function stripServerOwnedFields(finding: AgentFindingPayload): AgentFindingPayload {
  const {
    citations: _citations,
    requirementId: _requirementId,
    verificationStatus: _verificationStatus,
    verdict: _verdict,
    supportPanel: _supportPanel,
    ...modelAuthored
  } = finding;
  return { ...modelAuthored, citations: [], verificationStatus: "ungrounded" };
}

/** #289 — the retry gate: does this answer validate as a findings answer? */
export function isValidAgentFindingsAnswer(text: string): boolean {
  return parseAgentFindingsAnswer(text).ok;
}

function frameProject(name: string, description: string): string {
  return [
    `Project: ${name}`,
    description.trim() ? `Description: ${description.trim()}` : "Description: (none provided)",
    "",
    "Analyse this project according to your role and return your findings.",
  ].join("\n");
}

export async function runEnabledCustomAgents(
  input: CustomAgentPhaseInput,
): Promise<CustomAgentPhaseResult> {
  if (input.signal?.aborted) {
    return { results: [], usage: { ...ZERO_USAGE } };
  }

  // Library agents first (explicit opt-in only), then the enabled custom agents.
  const agents: AgentDefinitionDto[] = [
    ...(await listProjectLibraryAgents(input.projectId)),
    ...(await listEnabledAgentsForProject(input.projectId)).map(customDtoDefinition),
  ];
  if (agents.length === 0) {
    return { results: [], usage: { ...ZERO_USAGE } };
  }

  const framedInput = frameProject(input.projectName, input.projectDescription);
  const totals: TokenUsage = { ...ZERO_USAGE };

  const settled = await Promise.allSettled(
    agents.map(async (agent): Promise<CustomAgentResult> => {
      const who = {
        agentId: agent.id,
        agentRef: agent.ref,
        kind: agent.kind,
        agentName: agent.name,
      };
      const startedAt = new Date();
      try {
        const res = await invokeAgentDefinition({
          provider: input.provider,
          definition: agent,
          input: framedInput,
          ...(input.signal ? { signal: input.signal } : {}),
          // #129 — the project's skill allow-list filters the agent's skills.
          projectId: input.projectId,
          outputContract: AGENT_PHASE_OUTPUT_CONTRACT,
          finalAnswerRetry: {
            instruction: AGENT_PHASE_RETRY_INSTRUCTION,
            isValid: isValidAgentFindingsAnswer,
          },
        });
        const parsed = parseAgentFindingsAnswer(res.content);
        let output: AgentPhaseFindings | undefined;
        if (parsed.ok) {
          output = parsed.output;
          if (parsed.repairs.length > 0) {
            // #298 — no repair is silent: counts and paths, never the text.
            log.warn("Agent findings answer repaired instead of rejected", {
              agentRef: agent.ref,
              repairs: summarizeFindingsRepairs(parsed.repairs),
            });
            output = withFindingsRepairNote(output, parsed.repairs);
          }
        } else {
          log.warn("Agent answer did not match the findings schema", {
            agentRef: agent.ref,
            reason: parsed.invalid.reason,
            issues: parsed.invalid.issues,
            retryAttempted: res.finalAnswerRetry?.attempted ?? false,
          });
        }
        return {
          ...who,
          content: res.content,
          usage: res.usage,
          ...(res.warnings ? { warnings: res.warnings } : {}),
          ...(output ? { output } : {}),
          ...(parsed.ok ? {} : { invalid: parsed.invalid }),
          ...(res.finalAnswerRetry ? { finalAnswerRetry: res.finalAnswerRetry } : {}),
          startedAt,
          completedAt: new Date(),
        };
      } catch (err) {
        const aborted = (err as { name?: string }).name === "AbortError";
        log.warn("Agent failed during analysis", {
          agentRef: agent.ref,
          error: (err as Error).message,
        });
        return {
          ...who,
          content: "",
          usage: { ...ZERO_USAGE },
          error: (err as Error).message,
          ...(aborted ? { aborted: true } : {}),
          startedAt,
          completedAt: new Date(),
        };
      }
    }),
  );

  const results: CustomAgentResult[] = [];
  for (const s of settled) {
    // allSettled never rejects here (we catch inside), but guard anyway.
    if (s.status === "fulfilled") {
      results.push(s.value);
      if (!s.value.error) {
        totals.promptTokens += s.value.usage.promptTokens;
        totals.completionTokens += s.value.usage.completionTokens;
        totals.totalTokens += s.value.usage.totalTokens;
      }
    }
  }

  return { results, usage: totals };
}

/** Cap on the raw answer kept on an invalid row, so it is inspectable, not lost. */
const INVALID_ANSWER_EXCERPT_CHARS = 2048;
/** Labels the excerpt so the Agents grid never shows raw model prose as a summary. */
export const INVALID_ANSWER_EXCERPT_LABEL = "Unparsed answer (excerpt): ";

/** #289 — the operator-facing reason an invalid answer's row carries. */
export function invalidAnswerMessage(r: CustomAgentResult): string {
  const why =
    r.invalid?.reason === "non-json-response"
      ? "its answer contained no JSON object"
      : `its answer failed the findings schema${
          r.invalid?.issues.length ? ` (${r.invalid.issues.join("; ")})` : ""
        }`;
  const retried = r.finalAnswerRetry?.attempted ? " after one retry" : "";
  return `No findings recorded: ${why}${retried}.`;
}

/**
 * #289 — persist every agent-phase result as its own `AgentResult` row, keyed
 * by the agent's ref (`custom:<id>` / `library:<id>`), with the agent's name
 * on the output as its `source`. A valid answer's findings are written through
 * the same `persistAgentResult` the specialists use, so they are read back by
 * the snapshot and by synthesis (`readFlattenedFindings`) with theirs. An
 * invalid answer or a failed call is written as a `failed` row whose
 * `errorMessage` says why — the #246 rule: nothing silently missing.
 */
export async function persistAgentPhaseResults(
  analysisId: string,
  results: readonly CustomAgentResult[],
): Promise<void> {
  for (const r of results) {
    const source = {
      kind: r.kind,
      ref: r.agentRef as AgentPhaseOutput["source"]["ref"],
      name: r.agentName,
    };
    // Server warnings (#145) first, so a model's 20 notes can never push them out.
    const notes = [...(r.warnings ?? []), ...(r.output?.notes ?? [])].slice(0, 20);
    const base = {
      analysisId,
      agentKey: source.ref,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      usage: r.usage,
    };
    try {
      await persistOneAgentPhaseResult(r, base, source, notes);
    } catch (err) {
      // One agent's failed write must not skip every later agent's row (#246).
      log.error("Failed to persist agent-phase result", {
        analysisId,
        agentRef: r.agentRef,
        error: (err as Error).message,
      });
    }
  }
}

async function persistOneAgentPhaseResult(
  r: CustomAgentResult,
  base: Omit<PersistAgentResultInput, "status" | "output">,
  source: AgentPhaseOutput["source"],
  notes: string[],
): Promise<void> {
  if (r.output) {
    await persistAgentResult({
      ...base,
      status: "completed",
      output: { ...r.output, notes, source },
    });
  } else if (r.error) {
    await persistAgentResult({
      ...base,
      status: r.aborted ? "cancelled" : "failed",
      output: { summary: "", findings: [], notes, source },
      errorMessage: r.aborted ? "cancelled" : r.error,
    });
  } else {
    const excerpt = `${INVALID_ANSWER_EXCERPT_LABEL}${r.content
      .trim()
      .slice(0, INVALID_ANSWER_EXCERPT_CHARS - INVALID_ANSWER_EXCERPT_LABEL.length)}`;
    await persistAgentResult({
      ...base,
      status: "failed",
      output: { summary: excerpt, findings: [], notes, source },
      errorMessage: invalidAnswerMessage(r),
    });
  }
}
