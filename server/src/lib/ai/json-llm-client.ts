/**
 * Epic #708 / #804 — thin JSON-returning LLM seam, used by traceability's
 * suggest-mappings.
 *
 * Wraps `AIProvider.chat()` with:
 *   • JSON-only system prompt enforcement
 *   • robust JSON extraction (handles models that wrap output in markdown
 *     fences or prose preamble)
 *   • per-call token + cost accounting via the returned `ChatResponse`
 *
 * The seam exists so callers can swap in a deterministic stub during unit
 * tests without booting the real provider singleton.
 */
import type { AIProvider, ChatMessage, ChatResponse } from "./types.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("json-llm-client");

export interface JsonLlmCallInput {
  systemPrompt: string;
  userPrompt: string;
  /** Override the provider's default model for this call (e.g. force Sonnet). */
  modelOverride?: string;
  /** Forwarded to provider.chat — enables Bedrock prompt caching for both halves. */
  promptCaching?: boolean;
  /** Soft cap; the provider may ignore. */
  maxTokens?: number;
  /** Reasoning effort hint forwarded to the provider. */
  reasoningEffort?: "low" | "medium" | "high" | "xhigh";
  /** Cancellation signal. */
  signal?: AbortSignal;
  /**
   * #718 — called with every provider response BEFORE its content is parsed,
   * so a reply that fails to parse is still metered: the tokens were spent.
   */
  onUsage?: (response: ChatResponse) => void;
}

export interface JsonLlmCallResult<T> {
  parsed: T;
  raw: string;
  response: ChatResponse;
}

/**
 * Strip markdown code fences and prose around a JSON object/array, then
 * parse. Throws when no JSON-looking substring is present. `callJsonLlm`
 * rethrows any such failure as a {@link JsonLlmParseError}.
 */
export function extractJson<T = unknown>(raw: string): T {
  const trimmed = raw.trim();
  // Fenced block.
  //
  // #1260: group 1 deliberately swallows the whitespace run after the opening
  // fence — do NOT reintroduce `\s*` before it. A greedy `\s*` immediately in
  // front of the lazy `[\s\S]*?` is QUADRATIC when the closing fence is absent:
  // each of the `w` positions the whitespace run can end at restarts a lazy
  // scan to end-of-input hunting a ``` that never comes. 200 KB of truncated
  // model output cost 1,514 ms of synchronous event-loop time, 4x per doubling.
  // The same one-token defect was removed from `parseToolCall` in #1244 and
  // `extractJsonObject` in #1253; this was the fifth and last copy.
  //
  // The parse is byte-identical. `fence[1]` has exactly one use and it trims,
  // and `if (fence)` tests the match object rather than the capture, so nothing
  // reads the extra whitespace: the old greedy `\s*` consumed the MAXIMAL
  // leading run `W`, so the new capture is exactly `W ++ old`, and
  // `(W ++ old).trim() === old.trim()`. The match index and extent cannot move
  // either, because a backtick is not whitespace, so `\s*` could never step
  // over a closing fence.
  const fence = /```(?:json)?([\s\S]*?)```/i.exec(trimmed);
  if (fence) {
    return JSON.parse(fence[1].trim()) as T;
  }
  // First { … } or [ … ] balanced span. Greedy on outer braces is fine
  // because we only feed the model JSON-only system prompts; if it
  // mis-emits multiple top-level objects we still take the first one.
  const firstBrace = trimmed.search(/[{[]/);
  if (firstBrace < 0) {
    throw new Error("no JSON object/array found in model output");
  }
  const head = trimmed[firstBrace];
  const tail = head === "{" ? "}" : "]";
  const lastTail = trimmed.lastIndexOf(tail);
  if (lastTail <= firstBrace) {
    throw new Error("unbalanced JSON in model output");
  }
  return JSON.parse(trimmed.slice(firstBrace, lastTail + 1)) as T;
}

/**
 * #718 — the model replied, but not with parseable JSON. Carries the response
 * so the caller can charge its tokens to the scan and decide whether the
 * failure is per-symbol (skip) rather than per-scan (abort). The message names
 * `finishReason` and the reply length: an empty reply with
 * `finishReason=max_tokens` is a model that spent its output cap reasoning.
 */
export class JsonLlmParseError extends Error {
  constructor(
    reason: string,
    readonly raw: string,
    readonly response: ChatResponse,
  ) {
    super(`${reason} (finishReason=${response.finishReason ?? "unknown"}, ${raw.length} chars)`);
    this.name = "JsonLlmParseError";
  }
}

const STRICT_JSON_REMINDER =
  "Respond with a single JSON object only. No prose, no markdown code fences, no commentary.";

/**
 * Execute a chat call and parse the model's response as JSON.
 *
 * Adds the strict-JSON reminder to the user prompt and prepends the
 * caller's `systemPrompt` as the chat system message.
 */
export async function callJsonLlm<T = unknown>(
  provider: AIProvider,
  input: JsonLlmCallInput,
): Promise<JsonLlmCallResult<T>> {
  const messages: ChatMessage[] = [
    { role: "system", content: input.systemPrompt },
    { role: "user", content: `${input.userPrompt}\n\n${STRICT_JSON_REMINDER}` },
  ];
  const response = await provider.chat(messages, {
    model: input.modelOverride,
    promptCaching: input.promptCaching ? { system: true, messages: true } : undefined,
    maxTokens: input.maxTokens,
    reasoningEffort: input.reasoningEffort,
    signal: input.signal,
  });
  // Metering is bookkeeping: a throw here must not read as a failed call (#718).
  try {
    input.onUsage?.(response);
  } catch (err) {
    log.warn("Usage metering failed; continuing", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const raw = response.content;
  let parsed: T;
  try {
    parsed = extractJson<T>(raw);
  } catch (err) {
    throw new JsonLlmParseError(err instanceof Error ? err.message : String(err), raw, response);
  }
  return { parsed, raw, response };
}
