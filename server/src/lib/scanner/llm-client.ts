/**
 * Epic #708 — Thin LLM seam used by the scanner pipeline.
 *
 * Wraps `AIProvider.chat()` with:
 *   • JSON-only system prompt enforcement
 *   • robust JSON extraction (handles models that wrap output in markdown
 *     fences or prose preamble)
 *   • per-call token + cost accounting via the returned `ChatResponse`
 *
 * The seam exists so the scanner orchestrator / per-symbol scanner /
 * FP-filter / rule-compiler can all swap in a deterministic stub during
 * unit tests without booting the real provider singleton.
 */
import type { AIProvider, ChatMessage, ChatResponse } from "../ai/types.js";

export interface ScannerJsonCallInput {
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
}

export interface ScannerJsonCallResult<T> {
  parsed: T;
  raw: string;
  response: ChatResponse;
}

/**
 * Strip markdown code fences and prose around a JSON object/array, then
 * parse. Throws when no JSON-looking substring is present.
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
  input: ScannerJsonCallInput,
): Promise<ScannerJsonCallResult<T>> {
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
  const raw = response.content;
  const parsed = extractJson<T>(raw);
  return { parsed, raw, response };
}
