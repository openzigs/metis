/** #18 — the one validator both the server and the chat page use for a reply's grounding. */
import { describe, expect, it } from "vitest";
import { MAX_GROUNDING_SOURCES, parseChatGrounding } from "./conversation.js";

describe("parseChatGrounding", () => {
  it("accepts each well-formed status", () => {
    for (const g of [
      { status: "unscoped" },
      { status: "no-context", projectId: "p1", projectName: "P" },
      { status: "grounded", projectId: "p1", projectName: "P", sources: 2 },
      // #439 — read through the code tools, with or without retrieved excerpts.
      { status: "grounded", projectId: "p1", projectName: "P", sources: 2, toolReads: 1 },
      { status: "grounded", projectId: "p1", projectName: "P", sources: 0, toolReads: 3 },
    ]) {
      expect(parseChatGrounding(g)).toEqual(g);
    }
  });

  it("drops extra keys", () => {
    expect(
      parseChatGrounding({
        status: "grounded",
        projectId: "p",
        projectName: "P",
        sources: 1,
        x: 1,
      }),
    ).toEqual({ status: "grounded", projectId: "p", projectName: "P", sources: 1 });
  });

  it.each([
    ["undefined", undefined],
    ["a string", "grounded"],
    ["an unknown status", { status: "maybe" }],
    ["no-context without a project id", { status: "no-context", projectName: "P" }],
    ["no-context with an empty name", { status: "no-context", projectId: "p", projectName: "" }],
    ["grounded without a name", { status: "grounded", projectId: "p", sources: 1 }],
    ["grounded without a project id", { status: "grounded", projectName: "P", sources: 1 }],
    [
      "grounded with zero sources",
      { status: "grounded", projectId: "p", projectName: "P", sources: 0 },
    ],
    [
      "grounded with string sources",
      { status: "grounded", projectId: "p", projectName: "P", sources: "2" },
    ],
    [
      "grounded with fractional sources",
      { status: "grounded", projectId: "p", projectName: "P", sources: 1.5 },
    ],
    [
      "grounded with negative sources beside tool reads",
      { status: "grounded", projectId: "p", projectName: "P", sources: -1, toolReads: 1 },
    ],
    [
      "grounded with zero tool reads",
      { status: "grounded", projectId: "p", projectName: "P", sources: 0, toolReads: 0 },
    ],
    [
      "grounded with zero tool reads beside sources",
      { status: "grounded", projectId: "p", projectName: "P", sources: 2, toolReads: 0 },
    ],
    [
      "grounded with fractional tool reads",
      { status: "grounded", projectId: "p", projectName: "P", sources: 1, toolReads: 0.5 },
    ],
    [
      "grounded with string tool reads",
      { status: "grounded", projectId: "p", projectName: "P", sources: 1, toolReads: "1" },
    ],
  ])("rejects %s", (_label, value) => {
    expect(parseChatGrounding(value)).toBeNull();
  });
});

describe("parseChatGrounding — sources, reasons and coverage (#2241)", () => {
  const grounded = { status: "grounded", projectId: "p", projectName: "P", sources: 2 } as const;
  const noContext = { status: "no-context", projectId: "p", projectName: "P" } as const;

  it("round-trips the listed sources, a reason and a partial coverage", () => {
    const g = {
      ...grounded,
      sourcesUsed: [
        { name: "rules.md", excerpts: 1, relevance: 0.61 },
        { name: "a.go", excerpts: 1 },
      ],
      coverage: { matchingChunks: 3, totalChunks: 5 },
    };
    expect(parseChatGrounding(g)).toEqual(g);
    const n = { ...noContext, reason: "insufficient-evidence", belowFloor: 8 };
    expect(parseChatGrounding(n)).toEqual(n);
    expect(parseChatGrounding({ ...noContext, reason: "retrieval-failed" })).toEqual({
      ...noContext,
      reason: "retrieval-failed",
    });
  });

  it("drops a malformed source and keeps the well-formed ones", () => {
    expect(
      parseChatGrounding({
        ...grounded,
        sourcesUsed: [
          { name: "", excerpts: 1 },
          { name: "x".repeat(501), excerpts: 1 },
          { name: "ok.md", excerpts: 0 },
          { name: "nan.md", excerpts: 1, relevance: Number.NaN },
          "not an object",
          { name: "good.md", excerpts: 2, relevance: 0.7 },
        ],
      }),
    ).toEqual({
      ...grounded,
      sourcesUsed: [
        { name: "nan.md", excerpts: 1 },
        { name: "good.md", excerpts: 2, relevance: 0.7 },
      ],
    });
  });

  it("keeps at most MAX_GROUNDING_SOURCES sources", () => {
    const many = Array.from({ length: MAX_GROUNDING_SOURCES + 3 }, (_, i) => ({
      name: `f${i}`,
      excerpts: 1,
    }));
    expect(
      parseChatGrounding({ ...grounded, sourcesUsed: many }) as { sourcesUsed: unknown[] },
    ).toMatchObject({ sourcesUsed: many.slice(0, MAX_GROUNDING_SOURCES) });
  });

  it("drops an unknown reason, a belowFloor without insufficient evidence, and a full or broken coverage", () => {
    expect(parseChatGrounding({ ...noContext, reason: "bored" })).toEqual(noContext);
    expect(parseChatGrounding({ ...noContext, reason: "nothing-found", belowFloor: 3 })).toEqual({
      ...noContext,
      reason: "nothing-found",
    });
    expect(
      parseChatGrounding({ ...noContext, reason: "insufficient-evidence", belowFloor: -1 }),
    ).toEqual({ ...noContext, reason: "insufficient-evidence" });
    expect(
      parseChatGrounding({ ...grounded, coverage: { matchingChunks: 5, totalChunks: 5 } }),
    ).toEqual(grounded);
    expect(parseChatGrounding({ ...grounded, coverage: { matchingChunks: "1" } })).toEqual(
      grounded,
    );
    expect(parseChatGrounding({ ...grounded, sourcesUsed: "a.md" })).toEqual(grounded);
  });
});
