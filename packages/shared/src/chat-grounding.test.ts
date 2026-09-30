/** #18 — the one validator both the server and the chat page use for a reply's grounding. */
import { describe, expect, it } from "vitest";
import { parseChatGrounding } from "./conversation.js";

describe("parseChatGrounding", () => {
  it("accepts each well-formed status", () => {
    for (const g of [
      { status: "unscoped" },
      { status: "no-context", projectId: "p1", projectName: "P" },
      { status: "grounded", projectId: "p1", projectName: "P", sources: 2 },
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
  ])("rejects %s", (_label, value) => {
    expect(parseChatGrounding(value)).toBeNull();
  });
});
