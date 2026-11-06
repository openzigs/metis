/**
 * #1842 — the Anthropic request a chat TOOL LOOP sends, call by call, under
 * the loop's prompt-cache posture (`chatToolLoopPromptCaching("anthropic")`).
 *
 * Two documented 400s must never be built: more than four cache breakpoints
 * in one request (automatic top-level `cache_control` takes a slot too), and a
 * last block whose TTL differs from the rest. And the cache must actually be
 * reusable: each call's breakpoint sits after the newest tool results, and the
 * next call re-sends that prefix byte for byte. The SDK is mocked; nothing
 * dials out.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { createSpy } = vi.hoisted(() => ({ createSpy: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => {
  class FakeAnthropic {
    messages = { create: createSpy, stream: vi.fn() };
    models = { list: vi.fn() };
    constructor(_opts: unknown) {
      /* no network */
    }
  }
  return { default: FakeAnthropic };
});
vi.mock("../../logger.js", () => ({
  createChildLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { AnthropicProvider } from "./anthropic-provider.js";
import { __resetModelCatalogForTests } from "../model-catalog.js";
import { chatToolLoopPromptCaching } from "../chat-prompt-caching.js";
import type { ChatMessage, ChatOptions, ChatToolSpec } from "../types.js";

const TOOLS: ChatToolSpec[] = [
  { name: "search_code", description: "search", parameters: { type: "object", properties: {} } },
  { name: "read_file_slice", description: "read", parameters: { type: "object", properties: {} } },
];
const SYSTEM = "You are METIS. Answer from the project's code.";

type Block = Record<string, unknown> & { cache_control?: { type: string; ttl?: string } };
type Body = {
  system?: string | Block[];
  tools?: Block[];
  messages: Array<{ role: string; content: string | Block[] }>;
  cache_control?: unknown;
};

/**
 * The three calls of a loop that searches, then reads, then answers — the
 * transcript the agent loop hands the provider on each call.
 */
function loopTranscripts(): ChatMessage[][] {
  const q: ChatMessage[] = [
    { role: "user", content: "earlier question" },
    { role: "assistant", content: "earlier answer" },
    { role: "user", content: "which files handle refunds?" },
  ];
  const round1: ChatMessage[] = [
    {
      role: "assistant",
      content: "Searching.",
      toolCalls: [
        { id: "tu_1", name: "search_code", args: { query: "refund" } },
        { id: "tu_2", name: "search_code", args: { query: "chargeback" } },
      ],
    },
    { role: "tool", toolCallId: "tu_1", content: "refunds.go:10-40" },
    { role: "tool", toolCallId: "tu_2", content: "no hits" },
  ];
  const round2: ChatMessage[] = [
    {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "tu_3", name: "read_file_slice", args: { path: "refunds.go" } }],
    },
    { role: "tool", toolCallId: "tu_3", content: "func Refund() {}" },
  ];
  return [q, [...q, ...round1], [...q, ...round1, ...round2]];
}

async function runLoop(opts: Partial<ChatOptions> = {}): Promise<Body[]> {
  const p = new AnthropicProvider({ apiKey: "k", model: "claude-sonnet-5-5" });
  const bodies: Body[] = [];
  for (const messages of loopTranscripts()) {
    await p.chat(messages, {
      systemMessage: SYSTEM,
      tools: TOOLS,
      callType: "chat",
      promptCaching: chatToolLoopPromptCaching("anthropic"),
      ...opts,
    });
    // The provider hands the SDK one params object per call; copy it as sent.
    bodies.push(JSON.parse(JSON.stringify(createSpy.mock.calls.at(-1)?.[0])) as Body);
  }
  return bodies;
}

/** Every block of the request that carries `cache_control`, in prompt order. */
function breakpoints(body: Body): Block[] {
  const out: Block[] = [];
  for (const t of body.tools ?? []) if (t.cache_control) out.push(t);
  if (Array.isArray(body.system)) for (const b of body.system) if (b.cache_control) out.push(b);
  for (const m of body.messages) {
    if (Array.isArray(m.content)) for (const b of m.content) if (b.cache_control) out.push(b);
  }
  return out;
}

/** The request's blocks in prompt order, `cache_control` stripped: what the cache matches on. */
function promptBlocks(body: Body): unknown[] {
  const strip = ({ cache_control: _c, ...rest }: Block) => rest;
  const blocks: unknown[] = [];
  for (const t of body.tools ?? []) blocks.push(strip(t));
  if (Array.isArray(body.system)) for (const b of body.system) blocks.push(strip(b));
  else if (body.system) blocks.push({ type: "text", text: body.system });
  for (const m of body.messages) {
    const content = typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content;
    for (const b of content) blocks.push({ role: m.role, ...strip(b as Block) });
  }
  return blocks;
}

/** Index (in {@link promptBlocks} order) of the request's LAST breakpoint. */
function lastBreakpointIndex(body: Body): number {
  const all: boolean[] = [];
  for (const t of body.tools ?? []) all.push(!!t.cache_control);
  if (Array.isArray(body.system)) for (const b of body.system) all.push(!!b.cache_control);
  else if (body.system) all.push(false);
  for (const m of body.messages) {
    if (typeof m.content === "string") all.push(false);
    else for (const b of m.content) all.push(!!b.cache_control);
  }
  return all.lastIndexOf(true);
}

beforeEach(() => {
  createSpy.mockReset();
  __resetModelCatalogForTests();
  createSpy.mockResolvedValue({
    content: [{ type: "text", text: "ok" }],
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    usage: { input_tokens: 5, output_tokens: 2 },
  });
});
afterEach(() => {
  delete process.env.ANTHROPIC_PROMPT_CACHE_TTL;
  __resetModelCatalogForTests();
});

describe("#1842 — a three-call chat tool loop on the Anthropic Messages API", () => {
  for (const ttl of [undefined, "1h"] as const) {
    it(`never builds a documented 400 (TTL ${ttl ?? "5m default"}): ≤ 4 breakpoints, one TTL, no automatic cache_control`, async () => {
      if (ttl) process.env.ANTHROPIC_PROMPT_CACHE_TTL = ttl;
      const bodies = await runLoop();
      expect(bodies).toHaveLength(3);
      for (const body of bodies) {
        // Automatic caching would take a fifth slot on top of explicit ones.
        expect(body.cache_control).toBeUndefined();
        const marks = breakpoints(body);
        // System + the newest user turn: two, well inside the four allowed.
        expect(marks).toHaveLength(2);
        expect(marks.length).toBeLessThanOrEqual(4);
        const ttls = new Set(marks.map((b) => b.cache_control?.ttl ?? "5m"));
        expect([...ttls]).toEqual([ttl ?? "5m"]);
        // The LAST block of the request carries the breakpoint, at that same TTL.
        const lastMsg = body.messages.at(-1)!;
        const lastBlock = (lastMsg.content as Block[]).at(-1)!;
        expect(lastBlock.cache_control).toEqual(
          ttl ? { type: "ephemeral", ttl } : { type: "ephemeral" },
        );
      }
    });
  }

  it("with no system prompt the last tool carries the prefix breakpoint, still ≤ 4 and one TTL", async () => {
    const bodies = await runLoop({ systemMessage: undefined });
    for (const body of bodies) {
      expect(body.system).toBeUndefined();
      expect(body.tools?.at(-1)?.cache_control).toEqual({ type: "ephemeral" });
      const marks = breakpoints(body);
      expect(marks).toHaveLength(2);
      expect(new Set(marks.map((b) => JSON.stringify(b.cache_control))).size).toBe(1);
    }
  });

  it("calls two and three put their breakpoint after the previous turn's tool results", async () => {
    const [first, second, third] = await runLoop();
    // Call 1: on the question itself.
    expect(first!.messages.at(-1)).toMatchObject({
      role: "user",
      content: [{ type: "text", text: "which files handle refunds?", cache_control: {} }],
    });
    // Call 2: on the LAST of round 1's two results, which share one user turn.
    const r1 = second!.messages.at(-1)!;
    expect(r1.role).toBe("user");
    expect(r1.content).toEqual([
      { type: "tool_result", tool_use_id: "tu_1", content: "refunds.go:10-40" },
      {
        type: "tool_result",
        tool_use_id: "tu_2",
        content: "no hits",
        cache_control: { type: "ephemeral" },
      },
    ]);
    // Call 3: on round 2's result; round 1's results are re-sent unmarked.
    expect(third!.messages.at(-1)!.content).toEqual([
      {
        type: "tool_result",
        tool_use_id: "tu_3",
        content: "func Refund() {}",
        cache_control: { type: "ephemeral" },
      },
    ]);
    const r1Again = third!.messages.at(-3)!.content as Block[];
    expect(r1Again.every((b) => b.cache_control === undefined)).toBe(true);
  });

  it("each call re-sends the previous call's cached prefix byte for byte, so it can be read back", async () => {
    const bodies = await runLoop();
    for (let i = 1; i < bodies.length; i++) {
      const prev = bodies[i - 1]!;
      const cut = lastBreakpointIndex(prev) + 1;
      expect(cut).toBeGreaterThan(0);
      // Everything up to and including the previous breakpoint is unchanged…
      expect(promptBlocks(bodies[i]!).slice(0, cut)).toEqual(promptBlocks(prev).slice(0, cut));
      // …and the new breakpoint sits strictly later, within the 20-block lookback.
      const next = lastBreakpointIndex(bodies[i]!);
      expect(next).toBeGreaterThan(cut - 1);
      expect(next - (cut - 1)).toBeLessThan(20);
    }
  });
});
