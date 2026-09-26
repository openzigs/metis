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
  command: "specify" | "plan" | "tasks" | "clarify" | "analyze" | "implement";
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
}

export interface RunCommandOutput {
  content: string;
  tokensUsed: number;
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

  const messages: ChatMessage[] = [{ role: "user", content: userText }];
  const response = await provider.chat(messages, {
    systemMessage: fullSystem,
    sessionId: sessionId ?? undefined,
    // #700 — attribute cache-hit telemetry to the spec-kit workload and cache
    // the system prefix. The constitution LEADS `fullSystem` (constitution →
    // RAG → base) and is stable per project, so the leading bytes are reusable
    // across commands within the cache TTL; the trust-ordered layout is left
    // unchanged. `messages` is omitted (single-shot user turn is unique).
    // Honoured on BedrockDirect/native-Anthropic; inert on the plain
    // OpenAI-compatible path, where transparent gateway caching applies instead.
    callType: "spec-kit",
    promptCaching: { system: true },
  });

  // 4. Outbound safety pass.
  let outContent = response.content;
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

  // 5. FinOps ledger.
  recordUsage({
    projectId: input.project.id,
    sessionId: sessionId ?? "",
    provider: response.provider,
    model: response.model,
    inputTokens: response.usage.promptTokens,
    outputTokens: response.usage.completionTokens,
    cacheReadTokens: response.usage.cacheReadTokens,
    cacheWriteTokens: response.usage.cacheWriteTokens,
  });

  // 6. Success audit.
  audit({
    actor: input.actorId ? { id: input.actorId } : null,
    action: `spec_kit.command.${input.command}`,
    target: { type: "project", id: input.project.id },
    metadata: {
      provider: response.provider,
      model: response.model,
      tokens: response.usage.totalTokens,
      // #373 — record that RAG was attempted and how many chunks were used
      // (0 ⇒ ungrounded: empty retrieval or hash-embedder fallback).
      ragAttempted: input.ragContext !== undefined,
      ragChunksUsed: input.ragChunksUsed ?? 0,
    },
  });

  return { content: outContent, tokensUsed: response.usage.totalTokens };
}
