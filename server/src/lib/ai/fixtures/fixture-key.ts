/**
 * Deterministic fixture keying for the record/replay LLM harness (#234).
 *
 * A fixture is keyed by a stable SHA-256 hash of the *request* — the chat
 * messages plus the small subset of {@link ChatOptions} that materially change
 * a model's response. Volatile / non-semantic options (an `AbortSignal`, a
 * logger, skill directories that vary by machine) are intentionally excluded
 * so a recording made on one host replays on another.
 *
 * The key is content-addressed: the same request always maps to the same
 * fixture file, which is what makes replay deterministic and lets `record`
 * mode refresh a single fixture without disturbing the rest.
 */
import crypto from "node:crypto";
import type { ChatMessage, ChatOptions } from "../types.js";

/**
 * The slice of {@link ChatOptions} that influences a model's output and is
 * therefore part of the fixture identity. Anything not listed here is ignored
 * when computing the key.
 */
export interface KeyedChatOptions {
  model?: string;
  systemMessage?: string;
  reasoningEffort?: ChatOptions["reasoningEffort"];
  disableThinking?: boolean;
  disableTools?: boolean;
  maxTokens?: number;
  temperature?: number;
  topP?: number;
  frequencyPenalty?: number;
  presencePenalty?: number;
  seed?: number;
  /** #131 — tools / tool choice / response format change the reply's shape. */
  tools?: ChatOptions["tools"];
  toolChoice?: ChatOptions["toolChoice"];
  responseFormat?: ChatOptions["responseFormat"];
}

/**
 * Normalise a {@link ChatMessage} to only the fields that affect generation.
 * Content blocks are preserved as-is (text + image), so multimodal requests
 * key distinctly from their text-only equivalents.
 */
function normalizeMessage(msg: ChatMessage): Record<string, unknown> {
  return {
    role: msg.role,
    content: msg.content,
    ...(msg.name !== undefined ? { name: msg.name } : {}),
    ...(msg.toolCallId !== undefined ? { toolCallId: msg.toolCallId } : {}),
    ...(msg.toolCalls !== undefined ? { toolCalls: msg.toolCalls } : {}),
    ...(msg.isError !== undefined ? { isError: msg.isError } : {}),
  };
}

/**
 * Extract the response-affecting subset of {@link ChatOptions}. Returns a
 * plain object with `undefined` fields stripped so two calls that differ only
 * in an omitted-vs-explicit-`undefined` option produce the same key.
 */
export function keyedOptions(opts: ChatOptions = {}): KeyedChatOptions {
  const out: KeyedChatOptions = {};
  if (opts.model !== undefined) out.model = opts.model;
  if (opts.systemMessage !== undefined) out.systemMessage = opts.systemMessage;
  if (opts.reasoningEffort !== undefined) out.reasoningEffort = opts.reasoningEffort;
  if (opts.disableThinking !== undefined) out.disableThinking = opts.disableThinking;
  if (opts.disableTools !== undefined) out.disableTools = opts.disableTools;
  if (opts.maxTokens !== undefined) out.maxTokens = opts.maxTokens;
  if (opts.temperature !== undefined) out.temperature = opts.temperature;
  if (opts.topP !== undefined) out.topP = opts.topP;
  if (opts.frequencyPenalty !== undefined) out.frequencyPenalty = opts.frequencyPenalty;
  if (opts.presencePenalty !== undefined) out.presencePenalty = opts.presencePenalty;
  if (opts.seed !== undefined) out.seed = opts.seed;
  // #131 — keyed only when set, so a request that sets none of these keeps
  // its pre-#131 key. A fixture recorded for a request that DID set
  // `responseFormat` or `tools` (or whose messages carry `toolCalls` /
  // `isError`) gets a new key and must be re-recorded.
  if (opts.tools !== undefined && opts.tools.length > 0) out.tools = opts.tools;
  if (opts.toolChoice !== undefined) out.toolChoice = opts.toolChoice;
  if (opts.responseFormat !== undefined) out.responseFormat = opts.responseFormat;
  return out;
}

/**
 * Compute the deterministic fixture key (hex SHA-256) for a chat request.
 *
 * Stable across machines and process restarts: depends only on the message
 * payload and the {@link keyedOptions} subset, never on wall-clock time,
 * random values, or host-specific paths.
 */
export function fixtureKey(messages: ChatMessage[], opts: ChatOptions = {}): string {
  const payload = {
    messages: messages.map(normalizeMessage),
    options: keyedOptions(opts),
  };
  return crypto.createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
