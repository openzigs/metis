/**
 * #131 — the offline stub's scripted mode: tool calls with no network, and the
 * unscripted stub unchanged.
 */
import { describe, expect, it } from "vitest";
import { OfflineStubProvider } from "./offline-stub-provider.js";
import { NO_PROVIDER_CAPABILITIES } from "../capabilities.js";
import type { ChatChunk } from "../types.js";

async function collect(gen: AsyncGenerator<ChatChunk>): Promise<ChatChunk[]> {
  const out: ChatChunk[] = [];
  for await (const c of gen) out.push(c);
  return out;
}

describe("OfflineStubProvider script", () => {
  it("replays turns in order, records requests without the signal, then falls back to the hash reply", async () => {
    const stub = new OfflineStubProvider({
      script: [
        { toolCalls: [{ id: "c1", name: "search_code", args: { q: "x" } }] },
        { content: "final answer", finishReason: "end_turn" },
      ],
    });
    expect(stub.capabilities.nativeToolCalls).toBe(true);
    const signal = new AbortController().signal;
    const first = await stub.chat([{ role: "user", content: "go" }], {
      signal,
      toolChoice: "auto",
    });
    expect(first).toMatchObject({
      content: "",
      finishReason: "tool_calls",
      toolCalls: [{ id: "c1", name: "search_code", args: { q: "x" } }],
      offline: true,
    });
    const second = await stub.chat([{ role: "user", content: "go" }]);
    expect(second.content).toBe("final answer");
    expect(second.finishReason).toBe("end_turn");
    expect(second.toolCalls).toBeUndefined();
    expect(stub.requests[0].opts).toEqual({ toolChoice: "auto" });
    const third = await stub.chat([{ role: "user", content: "go" }]);
    expect(third.content).toContain("[offline-stub]");
  });

  it("streams a scripted turn as delta, native tool_call chunks, usage, done", async () => {
    const stub = new OfflineStubProvider({
      script: [
        {
          content: "Looking.",
          toolCalls: [{ id: "c1", name: "x", args: {} }],
          usage: { promptTokens: 9 },
        },
      ],
    });
    const chunks = await collect(stub.stream([{ role: "user", content: "go" }]));
    expect(chunks.map((c) => c.type)).toEqual(["delta", "tool_call", "usage", "done"]);
    expect(chunks[1]).toEqual({
      type: "tool_call",
      name: "x",
      arguments: {},
      toolCallId: "c1",
      native: true,
    });
    expect(chunks[2]).toMatchObject({ usage: { promptTokens: 9 } });
    expect(chunks[3]).toEqual({ type: "done", finishReason: "tool_calls" });
  });

  it("a scripted stream honours an aborted signal", async () => {
    const stub = new OfflineStubProvider({ script: [{ content: "x" }] });
    const c = new AbortController();
    c.abort();
    await expect(
      collect(stub.stream([{ role: "user", content: "go" }], { signal: c.signal })),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("the unscripted stub still declares nothing and records nothing", async () => {
    const stub = new OfflineStubProvider();
    expect(stub.capabilities).toBe(NO_PROVIDER_CAPABILITIES);
    await stub.chat([{ role: "user", content: "go" }]);
    expect(stub.requests).toEqual([]);
  });
});
