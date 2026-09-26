/**
 * Contract harnesses (#131/#134): one per wire format, each turning the suite's
 * provider-neutral "reply with X" into what that backend actually sends.
 *
 * The OpenAI-compatible replies follow the documented wire shapes of each
 * runtime family (they are hand-written from the vendors' API references, NOT
 * live recordings — no test here touches a network):
 *   • `openai`  — Chat Completions; streamed `tool_calls` split into fragments
 *                 that INTERLEAVE across two calls by `index`.
 *   • `azure`   — as OpenAI plus Azure's `prompt_filter_results` preamble frame
 *                 (`choices: []`) and per-choice `content_filter_results`.
 *   • `ollama`  — Ollama's `/v1` shim: each streamed call arrives whole in one
 *                 delta, `finish_reason: "stop"` even after tool calls.
 *   • `gateway` — bedrock-access-gateway: OpenAI shape with Bedrock prompt-cache
 *                 reads in `usage.prompt_tokens_details.cached_tokens`.
 */
import { vi } from "vitest";
import type { AIProvider, ChatToolCall } from "../../../../src/lib/ai/types.js";
import { OfflineStubProvider } from "../../../../src/lib/ai/providers/offline-stub-provider.js";
import type { ContractHarness, ContractRequestView, ContractUsage } from "./suite.js";

export type OpenAIFlavour = "openai" | "azure" | "ollama" | "gateway";

/** A queued reply, rendered lazily for whichever of chat/stream asks. */
interface QueuedReply {
  text: string;
  calls: ChatToolCall[];
  usage: ContractUsage;
}

/** One request the mocked `fetch` saw. */
export interface SeenRequest {
  url: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
}

function openAIUsage(u: ContractUsage): Record<string, unknown> {
  return {
    prompt_tokens: u.input,
    completion_tokens: u.output,
    total_tokens: u.input + u.output,
    ...(u.cacheRead !== undefined ? { prompt_tokens_details: { cached_tokens: u.cacheRead } } : {}),
  };
}

function nonStreamBody(flavour: OpenAIFlavour, r: QueuedReply, model: string): unknown {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: r.calls.length > 0 && r.text === "" ? null : r.text,
  };
  if (r.calls.length > 0) {
    message.tool_calls = r.calls.map((c) => ({
      id: c.id,
      type: "function",
      function: { name: c.name, arguments: JSON.stringify(c.args) },
    }));
  }
  const choice: Record<string, unknown> = {
    index: 0,
    message,
    finish_reason: r.calls.length > 0 && flavour !== "ollama" ? "tool_calls" : "stop",
  };
  if (flavour === "azure") choice.content_filter_results = {};
  return {
    id: "chatcmpl-contract",
    object: "chat.completion",
    model,
    choices: [choice],
    usage: openAIUsage(r.usage),
    ...(flavour === "azure" ? { prompt_filter_results: [{ prompt_index: 0 }] } : {}),
  };
}

function sseFrames(flavour: OpenAIFlavour, r: QueuedReply, model: string): string[] {
  const frame = (delta: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      id: "chatcmpl-contract",
      object: "chat.completion.chunk",
      model,
      choices: [
        {
          index: 0,
          delta,
          finish_reason: null,
          ...(flavour === "azure" ? { content_filter_results: {} } : {}),
        },
      ],
      ...extra,
    });
  const frames: string[] = [];
  if (flavour === "azure") {
    frames.push(JSON.stringify({ choices: [], prompt_filter_results: [{ prompt_index: 0 }] }));
  }
  frames.push(frame({ role: "assistant", content: "" }));
  if (r.text) {
    const mid = Math.ceil(r.text.length / 2);
    frames.push(frame({ content: r.text.slice(0, mid) }));
    frames.push(frame({ content: r.text.slice(mid) }));
  }
  if (r.calls.length > 0) {
    if (flavour === "ollama") {
      r.calls.forEach((c, index) =>
        frames.push(
          frame({
            tool_calls: [
              {
                index,
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              },
            ],
          }),
        ),
      );
    } else {
      // Header fragments first, then the argument JSON split in two and
      // interleaved across calls — the case a naive per-call buffer gets wrong.
      r.calls.forEach((c, index) =>
        frames.push(
          frame({
            tool_calls: [
              { index, id: c.id, type: "function", function: { name: c.name, arguments: "" } },
            ],
          }),
        ),
      );
      const halves = r.calls.map((c) => {
        const json = JSON.stringify(c.args);
        const mid = Math.ceil(json.length / 2);
        return [json.slice(0, mid), json.slice(mid)];
      });
      for (const part of [0, 1]) {
        halves.forEach((h, index) =>
          frames.push(frame({ tool_calls: [{ index, function: { arguments: h[part] } }] })),
        );
      }
    }
  }
  const finish = r.calls.length > 0 && flavour !== "ollama" ? "tool_calls" : "stop";
  frames.push(
    JSON.stringify({
      id: "chatcmpl-contract",
      object: "chat.completion.chunk",
      model,
      choices: [{ index: 0, delta: {}, finish_reason: finish }],
    }),
  );
  frames.push(
    JSON.stringify({ id: "chatcmpl-contract", model, choices: [], usage: openAIUsage(r.usage) }),
  );
  return frames;
}

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const f of frames) controller.enqueue(encoder.encode(`data: ${f}\n\n`));
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}

function headersOf(init?: RequestInit): Record<string, string> {
  const out: Record<string, string> = {};
  const h = init?.headers;
  if (h && typeof h === "object" && !Array.isArray(h) && !(h instanceof Headers)) {
    for (const [k, v] of Object.entries(h as Record<string, string>)) out[k.toLowerCase()] = v;
  }
  return out;
}

/**
 * Install a `fetch` mock that answers chat-completion requests from a queue and
 * `GET …/models` with a one-model list. Returns the queue and the request log;
 * the caller restores `globalThis.fetch` (see `restoreFetch`).
 */
export function installOpenAIFetch(flavour: OpenAIFlavour, model: string) {
  const queue: QueuedReply[] = [];
  const seen: SeenRequest[] = [];
  const fetchMock = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const headers = headersOf(init);
    if (!init?.body) {
      seen.push({ url, headers, body: {} });
      return new Response(JSON.stringify({ data: [{ id: model }] }), { status: 200 });
    }
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    seen.push({ url, headers, body });
    const reply = queue.shift() ?? { text: "", calls: [], usage: { input: 0, output: 0 } };
    if (body.stream === true) return sseResponse(sseFrames(flavour, reply, model));
    return new Response(JSON.stringify(nonStreamBody(flavour, reply, model)), { status: 200 });
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { queue, seen, fetchMock };
}

/** Decode an OpenAI-compatible request body into the suite's neutral view. */
export function viewOpenAIRequest(body: Record<string, unknown> | undefined): ContractRequestView {
  const tools = (body?.tools as Array<{ function?: { name?: string } }> | undefined) ?? [];
  const messages = (body?.messages as Array<Record<string, unknown>> | undefined) ?? [];
  return {
    toolNames: tools.map((t) => t.function?.name ?? ""),
    toolChoice: body?.tool_choice,
    responseFormatSent: body?.response_format !== undefined,
    toolResultIds: messages.filter((m) => m.role === "tool").map((m) => String(m.tool_call_id)),
    assistantToolCallIds: messages.flatMap((m) =>
      ((m.tool_calls as Array<{ id: string }> | undefined) ?? []).map((c) => c.id),
    ),
  };
}

/** Harness for any provider built on the OpenAI-compatible client. */
export function openAIHarness(
  flavour: OpenAIFlavour,
  model: string,
  build: () => AIProvider,
): ContractHarness & { seen: SeenRequest[] } {
  const { queue, seen } = installOpenAIFetch(flavour, model);
  return {
    model,
    seen,
    build,
    queueText: (text, usage) => queue.push({ text, calls: [], usage }),
    queueToolCalls: (calls, usage, text = "") => queue.push({ text, calls, usage }),
    lastRequest: () => viewOpenAIRequest(seen.filter((r) => r.body.messages).at(-1)?.body),
    reportsCacheRead: true,
    reportsCacheWrite: false,
  };
}

// ── Anthropic Messages ────────────────────────────────────────────────────

/** The mocked SDK's call log and reply queue (shared with the test's vi.mock). */
export interface AnthropicSdkMock {
  createSpy: ReturnType<typeof vi.fn>;
  streamSpy: ReturnType<typeof vi.fn>;
}

function anthropicMessage(r: QueuedReply, model: string): Record<string, unknown> {
  return {
    id: "msg_contract",
    type: "message",
    role: "assistant",
    model,
    content: [
      ...(r.text ? [{ type: "text", text: r.text }] : []),
      ...r.calls.map((c) => ({ type: "tool_use", id: c.id, name: c.name, input: c.args })),
    ],
    stop_reason: r.calls.length > 0 ? "tool_use" : "end_turn",
    usage: {
      input_tokens: r.usage.input,
      output_tokens: r.usage.output,
      cache_read_input_tokens: r.usage.cacheRead ?? 0,
      cache_creation_input_tokens: r.usage.cacheWrite ?? 0,
    },
  };
}

/** A fake `messages.stream()` handle: text deltas, then the SDK-assembled final message. */
export function fakeAnthropicStream(message: Record<string, unknown>) {
  const content = message.content as Array<{ type: string; text?: string }>;
  const events = content
    .filter((b) => b.type === "text")
    .flatMap((b) => {
      const text = b.text ?? "";
      const mid = Math.ceil(text.length / 2);
      return [text.slice(0, mid), text.slice(mid)].map((t) => ({
        type: "content_block_delta",
        delta: { type: "text_delta", text: t },
      }));
    });
  return {
    controller: { abort: vi.fn() },
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e;
    },
    finalMessage: async () => message,
  };
}

/** Decode Anthropic Messages params into the suite's neutral view. */
export function viewAnthropicRequest(
  params: Record<string, unknown> | undefined,
): ContractRequestView {
  const tools = (params?.tools as Array<{ name: string }> | undefined) ?? [];
  const messages =
    (params?.messages as Array<{ role: string; content: unknown }> | undefined) ?? [];
  const blocks = (role: string, type: string) =>
    messages
      .filter((m) => m.role === role && Array.isArray(m.content))
      .flatMap((m) => (m.content as Array<Record<string, unknown>>).filter((b) => b.type === type));
  const oc = params?.output_config as { format?: unknown } | undefined;
  return {
    toolNames: tools.map((t) => t.name),
    toolChoice: params?.tool_choice,
    responseFormatSent: oc?.format !== undefined,
    toolResultIds: blocks("user", "tool_result").map((b) => String(b.tool_use_id)),
    assistantToolCallIds: blocks("assistant", "tool_use").map((b) => String(b.id)),
  };
}

/** Harness for the Anthropic Messages client, over a mocked `@anthropic-ai/sdk`. */
export function anthropicHarness(
  sdk: AnthropicSdkMock,
  model: string,
  build: () => AIProvider,
): ContractHarness {
  const queue: QueuedReply[] = [];
  sdk.createSpy.mockReset();
  sdk.streamSpy.mockReset();
  sdk.createSpy.mockImplementation(async () => {
    const r = queue.shift() ?? { text: "", calls: [], usage: { input: 0, output: 0 } };
    return anthropicMessage(r, model);
  });
  sdk.streamSpy.mockImplementation(() => {
    const r = queue.shift() ?? { text: "", calls: [], usage: { input: 0, output: 0 } };
    return fakeAnthropicStream(anthropicMessage(r, model));
  });
  const lastParams = (): Record<string, unknown> | undefined => {
    const all = [...sdk.createSpy.mock.calls, ...sdk.streamSpy.mock.calls];
    const order = [
      ...sdk.createSpy.mock.invocationCallOrder,
      ...sdk.streamSpy.mock.invocationCallOrder,
    ];
    if (all.length === 0) return undefined;
    const latest = order.indexOf(Math.max(...order));
    return all[latest]?.[0] as Record<string, unknown>;
  };
  return {
    model,
    build,
    queueText: (text, usage) => queue.push({ text, calls: [], usage }),
    queueToolCalls: (calls, usage, text = "") => queue.push({ text, calls, usage }),
    lastRequest: () => viewAnthropicRequest(lastParams()),
    reportsCacheRead: true,
    reportsCacheWrite: true,
  };
}

// ── Offline stub ──────────────────────────────────────────────────────────

/** Harness for the scripted offline stub — the no-network reference implementation. */
export function offlineStubHarness(): ContractHarness {
  const script: QueuedReply[] = [];
  let last: OfflineStubProvider | undefined;
  return {
    model: "offline-stub",
    build: () => {
      last = new OfflineStubProvider({
        script: script.map((r) => ({
          content: r.text,
          toolCalls: r.calls,
          usage: {
            promptTokens: r.usage.input,
            completionTokens: r.usage.output,
            totalTokens: r.usage.input + r.usage.output,
          },
        })),
      });
      return last;
    },
    queueText: (text, usage) => script.push({ text, calls: [], usage }),
    queueToolCalls: (calls, usage, text = "") => script.push({ text, calls, usage }),
    lastRequest: () => {
      const req = last?.requests.at(-1);
      const messages = req?.messages ?? [];
      return {
        toolNames: (req?.opts.tools ?? []).map((t) => t.name),
        toolChoice: req?.opts.toolChoice,
        // The stub honours no response format (it declares none), so none is "sent".
        responseFormatSent: false,
        toolResultIds: messages.filter((m) => m.role === "tool").map((m) => String(m.toolCallId)),
        assistantToolCallIds: messages.flatMap((m) => (m.toolCalls ?? []).map((c) => c.id)),
      };
    },
    reportsCacheRead: false,
    reportsCacheWrite: false,
  };
}
