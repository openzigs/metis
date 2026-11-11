/** #2242 — the one validator the server and the chat page use for a reply's citations. */
import { describe, expect, it } from "vitest";
import { isVerifiedCitation, MAX_CHAT_CITATIONS, parseChatCitations } from "./chat-citations.js";

describe("parseChatCitations", () => {
  it("round-trips well-formed citations", () => {
    const c = [
      {
        text: "src/a.ts:3-9",
        path: "src/a.ts",
        lines: [3, 9],
        status: "verified",
        source: "repo",
      },
      { text: "[4]", path: "", status: "not-read" },
      { text: "FRD.md lines 2-3", path: "FRD.md", lines: [2, 3], status: "span-unverified" },
      {
        text: "src/b.ts:4",
        path: "src/b.ts",
        lines: [4, 4],
        status: "verified-earlier",
        source: "repo",
      },
      { text: "util.ts:4", path: "util.ts", lines: [4, 4], status: "ambiguous" },
    ];
    expect(parseChatCitations(c)).toEqual(c);
  });

  it("is empty for anything that is not a list", () => {
    expect(parseChatCitations(undefined)).toEqual([]);
    expect(parseChatCitations({ text: "a" })).toEqual([]);
  });

  it("drops a malformed entry and keeps the rest", () => {
    const good = { text: "a.md", path: "a.md", status: "verified" };
    expect(
      parseChatCitations([
        null,
        "a.md",
        { text: "", path: "a.md", status: "verified" },
        { text: "x".repeat(301), path: "a.md", status: "verified" },
        { text: "a.md", path: 3, status: "verified" },
        { text: "a.md", path: "x".repeat(301), status: "verified" },
        { text: "a.md", path: "a.md", status: "trusted" },
        good,
      ]),
    ).toEqual([good]);
  });

  it("drops a malformed line range, an unknown source and extra keys, keeping the citation", () => {
    for (const lines of [[0, 2], [5, 2], [1.5, 2], [1], "1-2"]) {
      expect(
        parseChatCitations([{ text: "a.ts:1", path: "a.ts", lines, status: "verified" }]),
      ).toEqual([{ text: "a.ts:1", path: "a.ts", status: "verified" }]);
    }
    expect(
      parseChatCitations([
        { text: "a.ts", path: "a.ts", status: "verified", source: "web", extra: 1 },
      ]),
    ).toEqual([{ text: "a.ts", path: "a.ts", status: "verified" }]);
  });

  it("keeps at most MAX_CHAT_CITATIONS", () => {
    const many = Array.from({ length: MAX_CHAT_CITATIONS + 4 }, (_, i) => ({
      text: `f${i}.md`,
      path: `f${i}.md`,
      status: "verified",
    }));
    expect(parseChatCitations(many)).toHaveLength(MAX_CHAT_CITATIONS);
  });
});

describe("isVerifiedCitation", () => {
  it("is true for a citation verified this turn or an earlier one, and only those", () => {
    expect(isVerifiedCitation("verified")).toBe(true);
    expect(isVerifiedCitation("verified-earlier")).toBe(true);
    expect(isVerifiedCitation("span-unverified")).toBe(false);
    expect(isVerifiedCitation("ambiguous")).toBe(false);
    expect(isVerifiedCitation("not-read")).toBe(false);
  });
});
