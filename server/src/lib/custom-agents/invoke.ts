/**
 * Epic #260 (#80) — custom-agent invocation (playground).
 *
 * SECURITY MODEL
 * --------------
 * - The agent's `systemPrompt` is OPERATOR-authored and trusted; it becomes the
 *   provider system message.
 * - The caller's `input` is UNTRUSTED. It is never concatenated into the system
 *   message; instead it is wrapped in an explicitly-delimited `<USER_INPUT>`
 *   block in a `user`-role message, and the system message instructs the model
 *   to treat that block as data, not instructions. This is the same
 *   injection-resistant framing the analysis runner uses.
 * - Payload size is hard-capped to bound token cost and reject abuse.
 *
 * The function is provider-agnostic and fully unit-testable with a mock
 * provider — it never reaches for a real LLM on its own.
 *
 * Epic #129 (#145) — this is now a thin wrapper over the ONE agent runtime
 * (`agent-runtime/run-agent.ts`) that chat sub-agents also use: the agent is
 * read as the unified definition, its preferred model is sent only when the
 * model catalog knows it (#135), and its skills ride inline (no person is
 * present to approve a `load_skill` call, so the run stays text-only).
 */
import type { CustomAgentDto } from "@metis/shared";
import type { AIProvider, TokenUsage } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { customDtoDefinition } from "../agent-runtime/definition.js";
import { lookupCatalogEntry } from "../ai/model-catalog.js";
import { resolveSkillCatalog } from "../agent-runtime/skills.js";
import { loadInlineSkillBlocks, runAgent } from "../agent-runtime/run-agent.js";

const log = createChildLogger("custom-agent-invoke");

/** Upper bound on the untrusted invocation payload (characters). */
export const MAX_INVOKE_PAYLOAD_CHARS = 20_000;

export class InvocationError extends Error {}

export interface InvokeCustomAgentInput {
  provider: AIProvider;
  agent: CustomAgentDto;
  /** UNTRUSTED caller-supplied prompt for the playground. */
  input: string;
  signal?: AbortSignal;
  /** The project the agent runs for: its skill allow-list filters the agent's skills. */
  projectId?: string | null;
}

export interface InvokeCustomAgentResult {
  content: string;
  usage: TokenUsage;
  model: string;
  provider: string;
}

const DEFAULT_USAGE: TokenUsage = { promptTokens: 0, completionTokens: 0, totalTokens: 0 };

/**
 * #135 — the agent's model override, sent only when the model catalog knows it
 * for this provider; otherwise the provider's default (`undefined`).
 */
export function catalogModelOverride(
  providerKey: string,
  model: string | null | undefined,
): string | undefined {
  return model && lookupCatalogEntry(providerKey, model) ? model : undefined;
}

export async function invokeCustomAgent(
  input: InvokeCustomAgentInput,
): Promise<InvokeCustomAgentResult> {
  const { provider, agent } = input;
  const payload = typeof input.input === "string" ? input.input : "";
  const trimmed = payload.trim();

  if (trimmed.length === 0) {
    throw new InvocationError("Invocation input must not be empty");
  }
  if (payload.length > MAX_INVOKE_PAYLOAD_CHARS) {
    throw new InvocationError(
      `Invocation input exceeds the ${MAX_INVOKE_PAYLOAD_CHARS}-character limit`,
    );
  }

  if (input.signal?.aborted) {
    throw new DOMException("Aborted before start", "AbortError");
  }

  log.info("Custom agent invocation", {
    agentId: agent.id,
    inputChars: payload.length,
  });

  const definition = customDtoDefinition(agent);
  const catalog = await resolveSkillCatalog({
    skillKeys: definition.skillKeys,
    projectId: input.projectId ?? agent.projectId ?? null,
  });
  // Pure text synthesis — no tools are offered (the runtime sends none), and
  // the untrusted input rides in the delimited <USER_INPUT> block.
  const response = await runAgent({
    provider,
    definition,
    input: payload,
    frame: "user-input",
    model: catalogModelOverride(provider.key, agent.model),
    ...(input.signal ? { signal: input.signal } : {}),
    inlineSkillBlocks: await loadInlineSkillBlocks(catalog),
  });

  return {
    content: response.content,
    usage: response.usage ?? DEFAULT_USAGE,
    model: response.model,
    provider: response.provider,
  };
}
