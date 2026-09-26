/**
 * The provider contract suite (#131) — one set of behavioural tests that ANY
 * `AIProvider` can run, so "implements the contract" means the same thing for
 * the OpenAI-compatible client, the Anthropic Messages client and the offline
 * stub. #132, #133 and #134 run it; #134 runs it once per provider key.
 *
 * A provider plugs in through a {@link ContractHarness}: the harness knows how
 * to make its backend return a given reply (a mocked `fetch`, a mocked SDK, a
 * script) and how to read the request back in provider-neutral terms. The suite
 * never sees a wire format.
 */
import { describe, expect, it } from "vitest";
import {
  resolveCapabilities,
  supportsResponseFormat,
} from "../../../../src/lib/ai/capabilities.js";
import type {
  AIProvider,
  ChatChunk,
  ChatMessage,
  ChatToolCall,
  ChatToolSpec,
  JsonSchemaResponseFormat,
} from "../../../../src/lib/ai/types.js";

/** Token usage a harness makes its backend report. */
export interface ContractUsage {
  input: number;
  output: number;
  cacheRead?: number;
  cacheWrite?: number;
}

/** The request the backend received, in provider-neutral terms. */
export interface ContractRequestView {
  toolNames: string[];
  /** The tool-choice value as sent, or `undefined`. */
  toolChoice: unknown;
  responseFormatSent: boolean;
  /** Ids of tool RESULTS the request carried, in order. */
  toolResultIds: string[];
  /** Ids of tool CALLS replayed on assistant turns, in order. */
  assistantToolCallIds: string[];
}

export interface ContractHarness {
  /** Model id to request (the harness's configured default). */
  model: string;
  /** Build a fresh provider. Called AFTER the replies for a test are queued. */
  build(): AIProvider;
  /** Queue a plain text reply (served to either `chat` or `stream`). */
  queueText(text: string, usage: ContractUsage): void;
  /** Queue a reply that makes these tool calls (optionally after some text). */
  queueToolCalls(calls: ChatToolCall[], usage: ContractUsage, text?: string): void;
  /** The most recent request, decoded. */
  lastRequest(): ContractRequestView;
  /** Whether this backend reports prompt-cache write tokens (Anthropic does). */
  reportsCacheWrite: boolean;
  /** Whether this backend reports prompt-cache read tokens. */
  reportsCacheRead: boolean;
}

export const CONTRACT_TOOLS: ChatToolSpec[] = [
  {
    name: "search_code",
    description: "Search the indexed code base.",
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
  },
  {
    name: "read_file",
    description: "Read one file.",
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
    },
  },
];

export const TWO_CALLS: ChatToolCall[] = [
  { id: "call_1", name: "search_code", args: { query: "interest rate" } },
  { id: "call_2", name: "read_file", args: { path: "src/Loan.java" } },
];

const SCHEMA: JsonSchemaResponseFormat = {
  type: "json_schema",
  json_schema: {
    name: "verdict",
    schema: {
      type: "object",
      properties: { ok: { type: "boolean" } },
      required: ["ok"],
      additionalProperties: false,
    },
  },
};

const USER: ChatMessage[] = [{ role: "user", content: "hello" }];

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

/**
 * Register the contract tests for one provider. `name` labels the describe
 * block (use the provider key); `harness` is re-created per test by `make`.
 */
export function runProviderContract(name: string, make: () => ContractHarness): void {
  describe(`provider contract: ${name}`, () => {
    it("chat returns the text and the usage the backend reported", async () => {
      const h = make();
      h.queueText("The answer.", { input: 12, output: 3, cacheRead: 5, cacheWrite: 7 });
      const res = await h.build().chat(USER, { model: h.model });
      expect(res.content).toBe("The answer.");
      expect(res.usage.promptTokens).toBe(12);
      expect(res.usage.completionTokens).toBe(3);
      if (h.reportsCacheRead) expect(res.usage.cacheReadTokens).toBe(5);
      if (h.reportsCacheWrite) expect(res.usage.cacheWriteTokens).toBe(7);
      expect(res.toolCalls).toBeUndefined();
    });

    it("stream yields the text as deltas, then usage, then done — in that order", async () => {
      const h = make();
      h.queueText("Streamed answer.", { input: 4, output: 2 });
      const chunks = await collect(h.build().stream(USER, { model: h.model }));
      const text = chunks
        .filter((c): c is Extract<ChatChunk, { type: "delta" }> => c.type === "delta")
        .map((c) => c.content)
        .join("");
      expect(text.trim()).toBe("Streamed answer.");
      const usage = chunks.find((c) => c.type === "usage");
      expect(usage && usage.type === "usage" ? usage.usage.completionTokens : -1).toBe(2);
      expect(chunks.at(-1)?.type).toBe("done");
    });

    it("declares native tool calls for the requested model", () => {
      const h = make();
      const provider = h.build();
      expect(resolveCapabilities(provider, h.model).nativeToolCalls).toBe(true);
    });

    it("chat sends the tools and returns two calls, typed and in order", async () => {
      const h = make();
      h.queueToolCalls(TWO_CALLS, { input: 20, output: 9 });
      const res = await h.build().chat(USER, {
        model: h.model,
        tools: CONTRACT_TOOLS,
        toolChoice: "auto",
      });
      expect(h.lastRequest().toolNames).toEqual(["search_code", "read_file"]);
      expect(res.toolCalls).toEqual(TWO_CALLS);
    });

    it("stream returns two native tool_call chunks, in order, before done", async () => {
      const h = make();
      h.queueToolCalls(TWO_CALLS, { input: 20, output: 9 }, "Let me look.");
      const chunks = await collect(
        h.build().stream(USER, { model: h.model, tools: CONTRACT_TOOLS }),
      );
      const calls = chunks.filter(
        (c): c is Extract<ChatChunk, { type: "tool_call" }> => c.type === "tool_call",
      );
      expect(calls.map((c) => [c.toolCallId, c.name, c.arguments, c.native])).toEqual(
        TWO_CALLS.map((c) => [c.id, c.name, c.args, true]),
      );
      const doneIdx = chunks.findIndex((c) => c.type === "done");
      const lastCallIdx = chunks.findLastIndex((c) => c.type === "tool_call");
      expect(lastCallIdx).toBeLessThan(doneIdx);
    });

    it("replays an assistant turn's tool calls and carries the tool results by id", async () => {
      const h = make();
      h.queueText("Done.", { input: 30, output: 2 });
      const conversation: ChatMessage[] = [
        { role: "user", content: "find the rate" },
        { role: "assistant", content: "", toolCalls: TWO_CALLS },
        {
          role: "tool",
          content: "Loan.java:12 rate = 0.05",
          toolCallId: "call_1",
          name: "search_code",
        },
        { role: "tool", content: "class Loan {}", toolCallId: "call_2", name: "read_file" },
      ];
      await h.build().chat(conversation, { model: h.model, tools: CONTRACT_TOOLS });
      const req = h.lastRequest();
      expect(req.assistantToolCallIds).toEqual(["call_1", "call_2"]);
      expect(req.toolResultIds).toEqual(["call_1", "call_2"]);
    });

    it("sends a json_schema response format exactly when it declares support", async () => {
      const h = make();
      h.queueText('{"ok":true}', { input: 5, output: 3 });
      const provider = h.build();
      const supported = supportsResponseFormat(provider, h.model, "json_schema");
      const res = await provider.chat(USER, { model: h.model, responseFormat: SCHEMA });
      expect(h.lastRequest().responseFormatSent).toBe(supported);
      expect(res.content).toBe('{"ok":true}');
    });

    it("sends no tools when none are supplied", async () => {
      const h = make();
      h.queueText("plain", { input: 1, output: 1 });
      await h.build().chat(USER, { model: h.model });
      expect(h.lastRequest().toolNames).toEqual([]);
    });

    it("honours an already-aborted signal", async () => {
      const h = make();
      h.queueText("never", { input: 1, output: 1 });
      const controller = new AbortController();
      controller.abort();
      await expect(
        h.build().chat(USER, { model: h.model, signal: controller.signal }),
      ).rejects.toMatchObject({ name: "AbortError" });
    });
  });
}
