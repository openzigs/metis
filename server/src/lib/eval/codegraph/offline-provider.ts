/**
 * Epic #712 / Issue #717 — deterministic OFFLINE provider for the code-graph
 * citation eval.
 *
 * Mirrors the domain-eval convention (`createOfflineExtractor`): a genuine,
 * deterministic stand-in for the model that needs no network, no API key, and
 * no gateway. It drives the REAL chat code-tool loop (#713), the REAL
 * `search_code_symbols` tool, and the REAL citation-rendering path (#715) so the
 * eval exercises production code, not a re-implementation.
 *
 * Behaviour (decided purely from the message array it is handed):
 *   1. If a prior `Tool result` turn already carries a `path:line-line` locator,
 *      answer by CITING that exact locator (the grounded, tool-driven path).
 *   2. Else, if the conversation exposes the code tools (their schema block
 *      names `search_code_symbols`), emit a `search_code_symbols` tool call —
 *      forcing the loop to actually execute the tool.
 *   3. Else (flag OFF: no tools, no fused locator) answer from the document-level
 *      context WITH a "reconstructed from the knowledge base" disclaimer — the
 *      legacy, uncited behaviour the epic's flags are meant to replace.
 */
import { messageText, type ChatMessage, type ChatResponse } from "../../ai/types.js";
import type { AIProvider } from "../../ai/types.js";
import { extractFirstLocator } from "./assertions.js";

const USAGE = { promptTokens: 12, completionTokens: 8, totalTokens: 20 } as const;

function toText(messages: ChatMessage[]): string {
  return messages.map((m) => messageText(m)).join("\n");
}

/** The tool-result locator, if the loop has already fed one back. */
function locatorFromToolResult(messages: ChatMessage[]): string | null {
  for (const m of messages) {
    const text = messageText(m);
    if (text.includes("Tool result for")) {
      const loc = extractFirstLocator(text);
      if (loc) return loc;
    }
  }
  return null;
}

export interface CitationEvalProviderOptions {
  /** Query the model "chooses" for its single tool call. */
  toolQuery?: string;
  /** Tool the model calls (defaults to the hybrid symbol search). */
  toolName?: string;
}

/**
 * Build the deterministic offline provider. `chat` is a vitest-free plain
 * function so the eval CLI can use it too; the response is fully determined by
 * the messages, so runs are reproducible.
 */
export function createCitationEvalProvider(opts: CitationEvalProviderOptions = {}): AIProvider {
  const toolName = opts.toolName ?? "search_code_symbols";
  const toolQuery = opts.toolQuery ?? "calculateProcessingFee payment processing fee";

  async function chat(messages: ChatMessage[]): Promise<ChatResponse> {
    const base = {
      usage: { ...USAGE },
      model: "offline-citation-eval",
      provider: "offline-stub" as const,
    };

    const locator = locatorFromToolResult(messages);
    if (locator) {
      return {
        ...base,
        content:
          `The payment processing fee is computed by \`calculateProcessingFee\`, defined at ` +
          `${locator}. It multiplies the amount by the schedule percentage and adds the flat ` +
          `component. See ${locator} for the exact implementation.`,
      };
    }

    const exposesTools = toText(messages).includes(toolName);
    if (exposesTools) {
      return {
        ...base,
        content: JSON.stringify({ tool: toolName, args: { query: toolQuery } }),
      };
    }

    // Flag OFF: no code tools, no fused locator → legacy uncited answer.
    return {
      ...base,
      content:
        "The payment processing fee combines a percentage of the amount with a flat fee. " +
        "I could not point to a specific file and line — this was reconstructed from the " +
        "knowledge base rather than the code graph.",
    };
  }

  return {
    key: "offline-stub",
    model: "offline-citation-eval",
    offline: true,
    chat,
    stream: async function* () {
      /* not used by the eval */
    },
    embed: async () => ({ vectors: [], model: "none", dimension: 0 }),
    models: async () => [],
    ping: async () => true,
  } as unknown as AIProvider;
}
