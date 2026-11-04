import { describe, expect, it } from "vitest";
import type { AIProvider, ChatChunk, ChatResponse } from "../../ai/types.js";
import { LedgerCostMeter, meterProvider } from "./cost.js";

const usage = { promptTokens: 1000, completionTokens: 1000, totalTokens: 2000 };

describe("LedgerCostMeter", () => {
  it("prices a call the way the usage ledger does", () => {
    const meter = new LedgerCostMeter();
    // claude-sonnet-5-5: $2 / MTok in, $10 / MTok out ⇒ 1k + 1k = $0.012.
    expect(meter.record("anthropic", "claude-sonnet-5-5", usage)).toBeCloseTo(0.012, 10);
    expect(meter.spentUsd()).toBeCloseTo(0.012, 10);
    expect(meter.callCount()).toBe(1);
    expect(meter.unpricedCalls()).toBe(0);
  });

  it("counts a model with no price as unpriced, never as $0", () => {
    const meter = new LedgerCostMeter();
    expect(meter.record("nobody", "no-such-model", usage)).toBeNull();
    expect(meter.unpricedCalls()).toBe(1);
    expect(meter.spentUsd()).toBe(0);
  });

  it("ignores a call that reported no usage", () => {
    const meter = new LedgerCostMeter();
    expect(meter.record("anthropic", "claude-sonnet-5-5", undefined)).toBe(0);
    expect(meter.callCount()).toBe(0);
  });
});

describe("meterProvider", () => {
  function fakeProvider(): AIProvider {
    return {
      key: "anthropic",
      model: "claude-sonnet-5-5",
      offline: false,
      async chat() {
        return { content: "ok", model: "claude-sonnet-5-5", usage } as ChatResponse;
      },
      async *stream(): AsyncGenerator<ChatChunk> {
        yield { type: "text", text: "a" } as ChatChunk;
        yield { type: "usage", usage } as ChatChunk;
      },
      async embed() {
        return { vectors: [], model: "e", dimension: 0 } as never;
      },
      async models() {
        return ["claude-sonnet-5-5"];
      },
      async ping() {
        return true;
      },
    } as AIProvider;
  }

  it("meters chat and stream, and passes everything else through", async () => {
    const meter = new LedgerCostMeter();
    const p = meterProvider(fakeProvider(), meter);
    expect((await p.chat([])).content).toBe("ok");
    const chunks: ChatChunk[] = [];
    for await (const c of p.stream([])) chunks.push(c);
    expect(chunks).toHaveLength(2);
    expect(meter.callCount()).toBe(2);
    expect(meter.spentUsd()).toBeCloseTo(0.024, 10);
    expect(p.key).toBe("anthropic");
    expect(await p.models()).toEqual(["claude-sonnet-5-5"]);
  });
});
