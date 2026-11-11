/** #18 — the one validator both the server and the chat page use for a reply's grounding. */
import { describe, expect, it } from "vitest";
import { parseChatGrounding } from "./conversation.js";

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
