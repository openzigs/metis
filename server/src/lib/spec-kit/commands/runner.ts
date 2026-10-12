/**
 * Shared executor for every Spec Kit slash command. Wraps the project's
 * AI provider with the same governance chain that the chat surface uses:
 *
 *   1. Look up the project (404 when missing).
 *   2. `assertWithinBudget` — HTTP 402 once the monthly cap is exhausted.
 *   3. Prepend the project's `constitution.md` (when present) onto the
 *      agent system prompt, fulfilling AC #209.3 for built-in agents.
 *   4. `applySafety` on the inbound user prompt + outbound completion
 *      (HTTP 422 on safety denial, redacted text forwarded otherwise).
 *   5. `recordUsage` per call so cost accumulates against the project's
 *      FinOps ledger.
 *   6. `audit({ action: "spec_kit.command.<cmd>" })` for every run,
 *      successful or otherwise.
 *
 * The runner is provider-agnostic — tests inject the offline-stub through
 * `runDeps`. Because we re-use the existing AIProvider plumbing, every
 * provider supported by the chat surface (`bedrock-gateway`, `openai`,
 * `azure`, `anthropic`, `offline-stub`) automatically works for Spec Kit.
 */
import { assertWithinBudget, BudgetExceededError, recordUsage } from "../../finops/index.js";
import { applySafety, SafetyDeniedError } from "../../safety/index.js";
import type { ChatMessage, AIProvider } from "../../ai/types.js";
import { audit } from "../../audit/audit-service.js";
import { prisma } from "../../prisma.js";
import { readProjectConstitution } from "../constitution.js";
import { loadAsPreamble } from "../constitution-meta.js";
import { OfflineStubProvider } from "../../ai/providers/offline-stub-provider.js";
import { SpecKitArtifactError } from "../artifacts.js";
import { detectTruncation } from "../../docs-gen/truncation.js";
import { resolveSpecKitOutputOptions } from "../output-budget.js";
import {
  currentSpecKitJob,
  reportSpecKitJobPhase,
  throwIfSpecKitJobStopped,
} from "../job-scope.js";

export interface SpecKitProjectContext {
  id: string;
  name: string;
  description: string;
  safetyMode: "strict" | "standard" | "off";
  aiProviderId: string | null;
}

export async function loadProjectContext(projectId: string): Promise<SpecKitProjectContext> {
  const row = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      name: true,
      description: true,
      safetyMode: true,
      aiProviderId: true,
    },
  });
  if (!row) {
    throw new SpecKitArtifactError(404, "PROJECT_NOT_FOUND", `Project not found: ${projectId}`);
  }
  const safetyMode =
    row.safetyMode === "strict" || row.safetyMode === "off" ? row.safetyMode : "standard";
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    safetyMode,
    aiProviderId: row.aiProviderId,
  };
}

export interface RunDeps {
  /** When provided, replaces the default offline-stub provider used by tests. */
  provider?: AIProvider;
}

export interface RunCommandInput {
  command:
    | "specify"
    | "plan"
    | "tasks"
    | "clarify"
    | "analyze"
    | "implement"
    | "constitution"
    | "checklist";
  project: SpecKitProjectContext;
  systemPrompt: string;
  userPrompt: string;
  actorId?: string | null;
  sessionId?: string | null;
  deps?: RunDeps;
  /**
   * Optional project-RAG context block (#373). When present it is prepended
   * to the system prompt AFTER the constitution and BEFORE the base prompt,
   * so the chain order stays: constitution → RAG → base. Built by
   * `buildSpecKitRagContext`; empty string ⇒ ungrounded generation.
   */
  ragContext?: string;
  /**
   * Number of RAG chunks folded into `ragContext`. Recorded in the success
   * audit so we can see that RAG was attempted and how much was used.
   */
  ragChunksUsed?: number;
  /**
   * Format of the artifact, so the truncation note is valid in it. A Markdown
   * `>` quote breaks a YAML document, so `"yaml"` gets a `#` comment instead.
   * Default `"markdown"`.
   */
  format?: "markdown" | "yaml";
  /**
   * #1057 — opt out of the empty-reply and no-text-before-the-cap failures, for
   * a caller with its own fallback (`/speckit.checklist` writes the labelled
   * generic templates, #787). The run then returns `content: ""` instead of
   * throwing; `truncated` still reports a cut. Every other command keeps them.
   */
  allowEmptyOutput?: boolean;
  /**
   * #1059 — what a job running this call shows while it waits ("Generating
   * plan.md (1 of 5)"), and how far through the command it is (0-100).
   * Ignored outside a job. Default: "Waiting for the model".
   */
  phase?: string;
  phaseProgress?: number;
}

export interface RunCommandOutput {
  content: string;
  tokensUsed: number;
  /**
   * #944 — `true` when the reply still ended at the output-token cap after
   * {@link MAX_SPEC_KIT_CONTINUATIONS} continuation calls. `content` then ends
   * with {@link SPEC_KIT_TRUNCATION_NOTE} and the caller must warn.
   */
  truncated: boolean;
  /** #944 — continuation calls made after an output-cap cut (0 when none). */
  continuations: number;
}

/**
 * #944 — continuation calls allowed after a reply is cut at the output cap.
 * Each one is a full provider call, billed and audited like the first.
 */
export const MAX_SPEC_KIT_CONTINUATIONS = 2;

/**
 * #944 — appended to an artifact the cap still cut off, so the document says
 * so itself and is never mistaken for a whole one.
 */
export const SPEC_KIT_TRUNCATION_NOTE =
  "> **Incomplete:** this document was cut off at the model's output-token limit. Re-run the command, or split the request.";

/** The same note as a YAML comment, so a salvaged contract still parses. */
export const SPEC_KIT_TRUNCATION_NOTE_YAML =
  "# Incomplete: this document was cut off at the model's output-token limit. Re-run the command, or split the request.";

/**
 * #1057 — the error a command fails with when a reply hit the output cap
 * without one whole line of text (typically: all reasoning, no answer). It is
 * thrown before any artifact is written, so the previous version stays.
 */
export const SPEC_KIT_OUTPUT_EXHAUSTED_CODE = "SPEC_KIT_OUTPUT_EXHAUSTED";

/**
 * #1057 — the error a command fails with when the model finished normally but
 * replied with nothing (empty or whitespace only). Writing `""` would leave the
 * same stub shape as an exhausted budget, so nothing is written.
 */
export const SPEC_KIT_EMPTY_OUTPUT_CODE = "SPEC_KIT_EMPTY_OUTPUT";

/**
 * #1057 — `true` when an artifact carries the #944 Incomplete note, so a
 * stored version can be told apart from a complete one.
 */
export function isIncompleteArtifact(content: string): boolean {
  return (
    content.includes(SPEC_KIT_TRUNCATION_NOTE) || content.includes(SPEC_KIT_TRUNCATION_NOTE_YAML)
  );
}

/**
 * #1057 — a partial reply never replaces a complete stored version. `true`
 * when this run was cut off and the stored version is complete (non-empty and
 * without the Incomplete note, as `gates.ts` reads a stored plan): the caller
 * keeps that version current and returns the partial text instead of writing it.
 */
export function keepsPriorVersion(
  truncated: boolean,
  prior: { content: string } | null | undefined,
): boolean {
  return (
    truncated &&
    prior != null &&
    prior.content.trim().length > 0 &&
    !isIncompleteArtifact(prior.content)
  );
}

const CONTINUE_PROMPT = [
  "Your previous reply was cut off at the output-token limit. Continue the SAME",
  "document exactly where it stops: start with the next line, do not repeat any",
  "line already written, and do not restart or summarise it.",
].join(" ");

/**
 * #944 — the reply up to and including its last newline. The line being
 * written when the cap fired is incomplete by definition (`client/client.go:327`
 * cut mid-citation), so it is dropped rather than kept as if whole.
 */
export function keepWholeLines(text: string): string {
  const cut = text.lastIndexOf("\n");
  return cut < 0 ? "" : text.slice(0, cut + 1);
}

/**
 * #944 — the warning a step's success message carries for every artifact the
 * output cap still cut off. `""` when none was.
 */
export function truncationWarning(artifacts: readonly string[]): string {
  if (artifacts.length === 0) return "";
  const names = artifacts.map((a) => `\`${a}\``).join(", ");
  const one = artifacts.length === 1;
  return ` Warning: ${names} ${one ? "was" : "were"} cut off at the model's output-token limit and ${one ? "is" : "are"} incomplete — re-run the command or split the request.`;
}

/** #944 — append a continuation to the kept prefix (which ends on a newline). */
export function joinContinuation(kept: string, next: string): string {
  return kept.length === 0 ? next : kept + next.replace(/^\n+/, "");
}

/** Characters per token for an aborted call's estimate — the ratio docs-gen uses (#855). */
const ESTIMATE_CHARS_PER_TOKEN = 3.5;

/**
 * #1059 — record what a call its job aborted mid-flight had already cost: an
 * ESTIMATE of the prompt, under the agent step `spec-kit.<command>.aborted`, so
 * a cancelled command is not free in the ledger. Never throws.
 */
function recordAbortedCall(
  input: RunCommandInput,
  provider: AIProvider,
  sessionId: string | null,
  system: string,
  messages: readonly ChatMessage[],
): void {
  try {
    const chars = messages.reduce(
      (n, m) =>
        n + (typeof m.content === "string" ? m.content.length : JSON.stringify(m.content).length),
      system.length,
    );
    recordUsage({
      projectId: input.project.id,
      sessionId: sessionId ?? "",
      ...(input.actorId ? { userId: input.actorId } : {}),
      agentStep: `spec-kit.${input.command}.aborted`,
      provider: provider.key,
      model: provider.model,
      inputTokens: Math.ceil(chars / ESTIMATE_CHARS_PER_TOKEN),
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });
  } catch {
    // An estimate that cannot be recorded must not mask the stop.
  }
}

/**
 * Single agent invocation reused by `/specify`, `/plan`, `/tasks`,
 * `/clarify`, `/analyze`. `/implement` does NOT call this — it just
 * audits + forwards to the orchestrator.
 */
export async function runSpecKitAgent(input: RunCommandInput): Promise<RunCommandOutput> {
  const provider = input.deps?.provider ?? new OfflineStubProvider();
  const sessionId = input.sessionId ?? null;

  // 1. Budget gate.
  try {
    await assertWithinBudget(input.project.id);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      audit({
        actor: input.actorId ? { id: input.actorId } : null,
        action: `spec_kit.command.${input.command}.denied`,
        target: { type: "project", id: input.project.id },
        metadata: { reason: "budget_exceeded" },
      });
    }
    throw err;
  }

  // 2. Constitution prepended into the system prompt.
  // MVP-2: prefer the structured preamble (with semver header) when
  // available; fall back to the v1.2 raw constitution body so projects
  // that haven't run /speckit.constitution yet still get governance.
  const preamble = await loadAsPreamble(input.project.id);
  const fallback = preamble ? null : await readProjectConstitution(input.project.id);
  const constitution = preamble ?? fallback;

  // 2b. Optional project-RAG context (#373). Order is load-bearing: the
  // constitution must LEAD the system prompt, then the (untrusted) RAG
  // reference block, then the base command prompt — constitution → RAG → base.
  const rag = (input.ragContext ?? "").trim();
  const sections: string[] = [];
  if (constitution && constitution.trim().length > 0) sections.push(constitution);
  if (rag.length > 0) sections.push(rag);
  sections.push(input.systemPrompt);
  const fullSystem = sections.join("\n\n---\n\n");

  // 3. Inbound safety pass on the user prompt.
  let userText = input.userPrompt;
  try {
    const safe = await applySafety(userText, {
      projectId: input.project.id,
      sessionId,
      provider: provider.key,
      mode: input.project.safetyMode,
      direction: "input",
    });
    userText = safe.text;
  } catch (err) {
    if (err instanceof SafetyDeniedError) {
      audit({
        actor: input.actorId ? { id: input.actorId } : null,
        action: `spec_kit.command.${input.command}.denied`,
        target: { type: "project", id: input.project.id },
        metadata: { reason: "safety_blocked", direction: "input" },
      });
    }
    throw err;
  }

  // 3b. Model call(s). #944 — a reply cut at the output-token cap returns
  // HTTP 200 like any other, so it is detected (finish reason or gateway
  // placeholder), its whole lines are kept, and the model is asked to continue.
  const userTurn: ChatMessage = { role: "user", content: userText };
  const job = currentSpecKitJob();
  const phase = input.phase ?? `Waiting for the model (/${input.command})`;
  const chatOpts = {
    systemMessage: fullSystem,
    sessionId: sessionId ?? undefined,
    // #700 — attribute cache-hit telemetry to the spec-kit workload and cache
    // the system prefix. The constitution LEADS `fullSystem` (constitution →
    // RAG → base) and is stable per project, so the leading bytes are reusable
    // across commands within the cache TTL; the trust-ordered layout is left
    // unchanged. `messages` is omitted (single-shot user turn is unique).
    // Honoured on BedrockDirect/native-Anthropic; inert on the plain
    // OpenAI-compatible path, where transparent gateway caching applies instead.
    callType: "spec-kit" as const,
    promptCaching: { system: true },
    // #1057 — an explicit output cap and reasoning effort (config-driven), so
    // a thinking-by-default model cannot spend the provider default reasoning.
    ...resolveSpecKitOutputOptions(provider.model),
    // #1059 — inside a job, cancel and the time limit abort the call in flight.
    ...(job ? { signal: job.signal } : {}),
  };
  let kept = "";
  let truncated = false;
  let continuations = 0;
  let totalTokens = 0;
  let response: Awaited<ReturnType<AIProvider["chat"]>>;
  // #1057 — fail before any artifact is written, so the previous version stays.
  const failNoOutput = (reason: string, code: string, message: string): never => {
    audit({
      actor: input.actorId ? { id: input.actorId } : null,
      action: `spec_kit.command.${input.command}.failed`,
      target: { type: "project", id: input.project.id },
      metadata: { reason, provider: response.provider, model: response.model, tokens: totalTokens },
    });
    throw new SpecKitArtifactError(502, code, message);
  };
  for (;;) {
    const messages: ChatMessage[] =
      kept.length === 0
        ? [userTurn]
        : [
            userTurn,
            { role: "assistant", content: kept },
            { role: "user", content: CONTINUE_PROMPT },
          ];
    // #1059 — a stopped job makes no further call.
    throwIfSpecKitJobStopped();
    reportSpecKitJobPhase(
      continuations === 0
        ? phase
        : `${phase}: continuing a reply cut off at the output limit (${continuations} of ${MAX_SPEC_KIT_CONTINUATIONS})`,
      input.phaseProgress,
    );
    try {
      response = await provider.chat(messages, chatOpts);
    } catch (err) {
      // A call its job aborted reported no usage, but the provider bills it:
      // record an estimate of the prompt it had already been sent (as #855).
      if (job?.signal.aborted) recordAbortedCall(input, provider, sessionId, fullSystem, messages);
      throw err;
    }
    totalTokens += response.usage.totalTokens;

    // 5. FinOps ledger — every call, continuation or not, is billed.
    recordUsage({
      projectId: input.project.id,
      sessionId: sessionId ?? "",
      ...(input.actorId ? { userId: input.actorId } : {}),
      agentStep: `spec-kit.${input.command}`,
      provider: response.provider,
      model: response.model,
      inputTokens: response.usage.promptTokens,
      outputTokens: response.usage.completionTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cacheWriteTokens: response.usage.cacheWriteTokens,
    });

    const cut = detectTruncation(response.content, response.finishReason);
    if (!cut.truncated) {
      kept = joinContinuation(kept, cut.text);
      truncated = false;
      break;
    }
    // A gateway placeholder replaces the tail, so the text before it ends a line.
    const whole = cut.signals.placeholder
      ? cut.text.length > 0
        ? `${cut.text}\n`
        : ""
      : keepWholeLines(cut.text);
    // #1057 — a cut reply with no whole line made no progress, and re-sending
    // the same turn spends the same budget the same way (run 7: three
    // attempts, three stubs). With nothing kept at all the command fails here,
    // before any artifact is written; with a salvaged prefix it stops
    // continuing and keeps the #944 marked salvage.
    if (whole.trim().length === 0) {
      if (kept.trim().length === 0 && !input.allowEmptyOutput) {
        failNoOutput(
          "output_exhausted",
          SPEC_KIT_OUTPUT_EXHAUSTED_CODE,
          `/${input.command}: the model reached its output-token limit before writing any text ` +
            "(its reasoning likely used the whole budget). Nothing was saved; the previous version is kept. " +
            "Lower SPEC_KIT_REASONING, raise SPEC_KIT_MAX_OUTPUT_TOKENS, or split the request.",
        );
      }
      truncated = true;
      break;
    }
    kept = joinContinuation(kept, whole);
    truncated = true;
    if (continuations >= MAX_SPEC_KIT_CONTINUATIONS) break;
    continuations++;
  }
  // #1057 — a reply that finished normally but said nothing is no artifact
  // either: written as "", a caller's template is appended to it as a stub.
  const empty = kept.trim().length === 0;
  if (empty && !input.allowEmptyOutput) {
    failNoOutput(
      "empty_output",
      SPEC_KIT_EMPTY_OUTPUT_CODE,
      `/${input.command}: the model returned an empty reply. Nothing was saved; the previous version is kept. ` +
        "Re-run the command.",
    );
  }
  if (truncated && !empty)
    kept = `${kept.trimEnd()}\n\n${input.format === "yaml" ? SPEC_KIT_TRUNCATION_NOTE_YAML : SPEC_KIT_TRUNCATION_NOTE}\n`;

  // 4. Outbound safety pass.
  let outContent = kept;
  try {
    const safeOut = await applySafety(outContent, {
      projectId: input.project.id,
      sessionId,
      provider: response.provider,
      mode: input.project.safetyMode,
      direction: "output",
    });
    outContent = safeOut.text;
  } catch (err) {
    if (err instanceof SafetyDeniedError) {
      audit({
        actor: input.actorId ? { id: input.actorId } : null,
        action: `spec_kit.command.${input.command}.denied`,
        target: { type: "project", id: input.project.id },
        metadata: { reason: "safety_blocked", direction: "output" },
      });
    }
    throw err;
  }

  // 6. Success audit.
  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: `spec_kit.command.${input.command}`,
    target: { type: "project", id: input.project.id },
    metadata: {
      provider: response.provider,
      model: response.model,
      tokens: totalTokens,
      // #373 — record that RAG was attempted and how many chunks were used
      // (0 ⇒ ungrounded: empty retrieval or hash-embedder fallback).
      ragAttempted: input.ragContext !== undefined,
      ragChunksUsed: input.ragChunksUsed ?? 0,
      // #944 — an output-cap cut is recorded, never silent.
      truncated,
      continuations,
    },
  });

  return { content: outContent, tokensUsed: totalTokens, truncated, continuations };
}
