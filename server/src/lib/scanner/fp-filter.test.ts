/** Epic #708 / Issue #713 — fp-filter tests. */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import { combineVerdicts, filterCandidate } from "./fp-filter.js";
import type { CandidateFinding } from "./types.js";

function provider(replies: string[]): AIProvider {
  const responses: ChatResponse[] = replies.map(
    (c) =>
      ({
        role: "assistant",
        content: c,
        finishReason: "stop",
        usage: { inputTokens: 50, outputTokens: 30, totalTokens: 80 },
        model: "m",
        providerKey: "offline-stub",
      }) as unknown as ChatResponse,
  );
  const chat = vi.fn();
  for (const r of responses) chat.mockResolvedValueOnce(r);
  return {
    key: "offline-stub",
    model: "m",
    offline: true,
    chat,
    stream: vi.fn(),
    embed: vi.fn(),
    models: vi.fn(),
    ping: vi.fn(),
  } as unknown as AIProvider;
}

const candidate: CandidateFinding = {
  ruleId: "r1",
  symbolId: "s1",
  qualifiedName: "src/foo.ts::bar",
  filePath: "src/foo.ts",
  title: "raw SQL",
  body: "uses string concat in query",
  severity: "high",
  category: "security",
  evidenceLines: [11, 12],
  confidence: 0.7,
};

describe("combineVerdicts", () => {
  it("returns keep=false when no verdicts", () => {
    expect(combineVerdicts([], 0.5)).toEqual({ keep: false, finalConfidence: 0 });
  });
  it("requires majority keep AND avg conf >= floor", () => {
    const out = combineVerdicts(
      [
        { keep: true, confidence: 0.9, rationale: "" },
        { keep: true, confidence: 0.8, rationale: "" },
        { keep: false, confidence: 0.7, rationale: "" },
      ],
      0.5,
    );
    expect(out.keep).toBe(true);
    expect(out.finalConfidence).toBeCloseTo(0.8);
  });
  it("drops when majority says reject", () => {
    const out = combineVerdicts(
      [
        { keep: false, confidence: 0.9, rationale: "" },
        { keep: false, confidence: 0.8, rationale: "" },
        { keep: true, confidence: 0.7, rationale: "" },
      ],
      0.5,
    );
    expect(out.keep).toBe(false);
  });
  it("drops when avg confidence below floor even with majority keep", () => {
    const out = combineVerdicts(
      [
        { keep: true, confidence: 0.3, rationale: "" },
        { keep: true, confidence: 0.3, rationale: "" },
        { keep: true, confidence: 0.3, rationale: "" },
      ],
      0.5,
    );
    expect(out.keep).toBe(false);
    expect(out.finalConfidence).toBeCloseTo(0.3);
  });
});

describe("filterCandidate", () => {
  it("runs N votes and combines", async () => {
    const p = provider([
      JSON.stringify({ keep: true, confidence: 0.9, rationale: "real bug" }),
      JSON.stringify({ keep: true, confidence: 0.8, rationale: "yep" }),
      JSON.stringify({ keep: false, confidence: 0.6, rationale: "nope" }),
    ]);
    const out = await filterCandidate(p, { candidate, symbolBody: "code", votes: 3 });
    expect(out.verdicts.length).toBe(3);
    expect(out.keep).toBe(true);
    expect(out.totalTokens).toBe(240);
  });

  it("treats provider failures as abstentions (no verdict pushed)", async () => {
    const chat = vi
      .fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce({
        role: "assistant",
        content: JSON.stringify({ keep: true, confidence: 0.9 }),
        finishReason: "stop",
        usage: { totalTokens: 50 },
        model: "m",
        providerKey: "offline-stub",
      } as ChatResponse)
      .mockRejectedValueOnce(new Error("boom"));
    const p = {
      key: "offline-stub",
      model: "m",
      offline: true,
      chat,
      stream: vi.fn(),
      embed: vi.fn(),
      models: vi.fn(),
      ping: vi.fn(),
    } as unknown as AIProvider;
    const out = await filterCandidate(p, { candidate, symbolBody: "code", votes: 3 });
    expect(out.verdicts.length).toBe(1);
    // 1 vote, keep=true, conf 0.9 — majority of available votes says keep.
    expect(out.keep).toBe(true);
  });

  it("returns keep=false when all votes fail to parse", async () => {
    const p = provider(["not json", "still no", "nope"]);
    const out = await filterCandidate(p, { candidate, symbolBody: "code" });
    expect(out.keep).toBe(false);
    expect(out.verdicts.length).toBe(0);
  });

  it("respects an aborted signal between votes", async () => {
    const ac = new AbortController();
    const chat = vi.fn().mockImplementation(async () => {
      ac.abort();
      return {
        role: "assistant",
        content: JSON.stringify({ keep: true, confidence: 0.9 }),
        finishReason: "stop",
        usage: { totalTokens: 50 },
        model: "m",
        providerKey: "offline-stub",
      } as ChatResponse;
    });
    const p = {
      key: "offline-stub",
      model: "m",
      offline: true,
      chat,
      stream: vi.fn(),
      embed: vi.fn(),
      models: vi.fn(),
      ping: vi.fn(),
    } as unknown as AIProvider;
    const out = await filterCandidate(p, {
      candidate,
      symbolBody: "code",
      votes: 3,
      signal: ac.signal,
    });
    expect(out.verdicts.length).toBeLessThan(3);
  });
});
