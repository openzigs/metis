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

describe("parseChatGrounding — multi-product (#2238)", () => {
  const projects = [
    { projectId: "a", projectName: "Alpha", sources: 3 },
    { projectId: "b", projectName: "Beta", sources: 0 },
  ];

  it("accepts a multi-product grounding, with and without the projects it could not search", () => {
    for (const g of [
      { status: "multi", projects },
      { status: "multi", projects: [] },
      {
        status: "multi",
        projects,
        unsearched: [{ projectId: "c", projectName: "Gamma", reason: "timeout" }],
        unavailable: 2,
      },
      {
        status: "multi",
        projects,
        unsearched: [{ projectId: "c", projectName: "Gamma", reason: "error" }],
      },
    ]) {
      expect(parseChatGrounding(g)).toEqual(g);
    }
  });

  it("accepts the sources used, and why nothing was supplied (#2294)", () => {
    for (const g of [
      {
        status: "multi",
        projects,
        sourcesUsed: [{ name: "[Alpha] rules.md", excerpts: 3, relevance: 0.71 }],
      },
      {
        status: "multi",
        projects: [{ projectId: "a", projectName: "Alpha", sources: 0 }],
        reason: "insufficient-evidence",
        belowFloor: 6,
      },
      { status: "multi", projects: [], reason: "retrieval-failed" },
    ]) {
      expect(parseChatGrounding(g)).toEqual(g);
    }
  });

  it("drops an unknown reason, a weak-match count without its reason, and malformed sources (#2294)", () => {
    expect(
      parseChatGrounding({
        status: "multi",
        projects,
        reason: "bored",
        belowFloor: 3,
        sourcesUsed: "a.md",
      }),
    ).toEqual({ status: "multi", projects });
    expect(
      parseChatGrounding({ status: "multi", projects, reason: "nothing-found", belowFloor: 3 }),
    ).toEqual({ status: "multi", projects, reason: "nothing-found" });
  });

  it("drops extra keys and an empty unsearched list", () => {
    expect(
      parseChatGrounding({
        status: "multi",
        projects: [{ projectId: "a", projectName: "Alpha", sources: 1, x: 1 }],
        unsearched: [],
        y: 2,
      }),
    ).toEqual({
      status: "multi",
      projects: [{ projectId: "a", projectName: "Alpha", sources: 1 }],
    });
  });

  it.each([
    ["no projects list", { status: "multi" }],
    ["a project without a name", { status: "multi", projects: [{ projectId: "a", sources: 1 }] }],
    [
      "a project with a negative count",
      { status: "multi", projects: [{ projectId: "a", projectName: "A", sources: -1 }] },
    ],
    ["a project that is not an object", { status: "multi", projects: [7] }],
    ["unsearched that is not a list", { status: "multi", projects: [], unsearched: "c" }],
    [
      "an unsearched project with an unknown reason",
      {
        status: "multi",
        projects: [],
        unsearched: [{ projectId: "c", projectName: "C", reason: "slow" }],
      },
    ],
    [
      "an unsearched project without an id",
      { status: "multi", projects: [], unsearched: [{ projectName: "C", reason: "timeout" }] },
    ],
    ["a zero unavailable count", { status: "multi", projects: [], unavailable: 0 }],
    ["a fractional unavailable count", { status: "multi", projects: [], unavailable: 1.5 }],
  ])("rejects %s", (_label, value) => {
    expect(parseChatGrounding(value)).toBeNull();
  });
});

describe("parseChatGrounding — index status and failure class (#2326)", () => {
  const base = { status: "no-context", projectId: "p1", projectName: "P" } as const;
  const repo = {
    label: "acme-app",
    commitSha: "c4d54f87",
    indexedAt: "2026-11-12T05:09:00.000Z",
    lastRun: "failed",
    error: "authentication failed",
  };

  it("keeps a well-formed index on either project status, and a failure class on a failed search", () => {
    const index = { state: "failed", repos: [repo] };
    const failed = { ...base, reason: "retrieval-failed", failure: "timed out", index };
    expect(parseChatGrounding(failed)).toEqual(failed);
    const grounded = { status: "grounded", projectId: "p1", projectName: "P", sources: 1, index };
    expect(parseChatGrounding(grounded)).toEqual(grounded);
  });

  it("drops a failure outside the fixed vocabulary, or on a reply whose search did not fail", () => {
    const leaked = { ...base, reason: "retrieval-failed", failure: "ghp_SECRET at /var/lib" };
    expect(parseChatGrounding(leaked)).toEqual({ ...base, reason: "retrieval-failed" });
    const wrong = { ...base, reason: "nothing-found", failure: "timed out" };
    expect(parseChatGrounding(wrong)).toEqual({ ...base, reason: "nothing-found" });
  });

  it("drops a malformed index, and a malformed repository's bad parts", () => {
    expect(parseChatGrounding({ ...base, index: { state: "odd", repos: [] } })).toEqual(base);
    expect(parseChatGrounding({ ...base, index: { state: "partial" } })).toEqual(base);
    expect(parseChatGrounding({ ...base, index: "x" })).toEqual(base);
    const parsed = parseChatGrounding({
      ...base,
      index: {
        state: "partial",
        repos: [
          { ...repo, commitSha: "not a sha", indexedAt: "yesterday", error: "raw text" },
          { label: "", lastRun: "completed" },
          { label: "x", lastRun: "exploded" },
          7,
          ...Array.from({ length: 12 }, (_, i) => ({ label: `r${i}`, lastRun: "completed" })),
        ],
      },
    });
    expect(parsed).toMatchObject({ index: { state: "partial" } });
    const repos = (parsed as { index: { repos: unknown[] } }).index.repos;
    expect(repos[0]).toEqual({ label: "acme-app", lastRun: "failed" });
    // Only the first ten entries are read; the empty label, the unknown run
    // and the non-object among them are dropped.
    expect(repos).toHaveLength(7);
  });
});
