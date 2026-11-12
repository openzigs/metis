/** #2242 — the one validator the server and the chat page use for a reply's citations. */
import { describe, expect, it } from "vitest";
import {
  isVerifiedCitation,
  MAX_CHAT_CITATIONS,
  MAX_CODE_CITATION_REFS,
  parseChatCitations,
  parseCodeCitationRefs,
  shortCommitSha,
} from "./chat-citations.js";

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

describe("#2325 — the version fields of a chat citation", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";

  it("keeps a recorded commit and a stale flag", () => {
    const c = { text: "a.ts:1", path: "a.ts", status: "verified", source: "repo" };
    expect(parseChatCitations([{ ...c, commitSha: SHA, stale: true }])).toEqual([
      { ...c, commitSha: SHA, stale: true },
    ]);
    expect(parseChatCitations([{ ...c, commitSha: null }])).toEqual([{ ...c, commitSha: null }]);
  });

  it("reads a citation recorded before #2325 as version unknown (no commit key), never as current", () => {
    const [old] = parseChatCitations([{ text: "a.ts:1", path: "a.ts", status: "verified" }]);
    expect(old).not.toHaveProperty("commitSha");
    expect(old).not.toHaveProperty("stale");
  });

  it("reads a malformed commit as null and drops a stale flag that is not true", () => {
    const [c] = parseChatCitations([
      { text: "a.ts:1", path: "a.ts", status: "verified", commitSha: "main;rm", stale: "yes" },
    ]);
    expect(c).toEqual({ text: "a.ts:1", path: "a.ts", status: "verified", commitSha: null });
  });
});

describe("parseCodeCitationRefs (#2325)", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const ref = {
    path: "src/a.ts",
    startLine: 1,
    endLine: 200,
    commitSha: SHA,
    permalink: `https://github.com/acme/app/blob/${SHA}/src/a.ts#L1-L200`,
    matchedBy: ["dense", "lexical"],
    truncated: true,
    totalLines: 500,
    next: { startLine: 201, endLine: 400 },
    stale: true,
    workingTreeSha: null,
  };

  it("round-trips a well-formed ref", () => {
    expect(parseCodeCitationRefs([ref])).toEqual([ref]);
  });

  it("drops what is not the contract's shape, and never keeps a non-https link", () => {
    expect(parseCodeCitationRefs("x")).toEqual([]);
    expect(parseCodeCitationRefs([null, { path: "" }, { path: 3 }])).toEqual([]);
    const [r] = parseCodeCitationRefs([
      {
        path: "a.ts",
        startLine: 9,
        endLine: 2,
        commitSha: "HEAD",
        permalink: "javascript:alert(1)",
        matchedBy: ["dense", "psychic"],
        next: { startLine: 0, endLine: 1 },
        extra: "x",
      },
    ]);
    expect(r).toEqual({
      path: "a.ts",
      startLine: null,
      endLine: null,
      commitSha: null,
      permalink: null,
      matchedBy: ["dense"],
      truncated: false,
      totalLines: null,
      stale: false,
    });
    expect(
      parseCodeCitationRefs([{ path: "a.ts", permalink: "http://x.test/a" }])[0]?.permalink,
    ).toBeNull();
  });

  it("caps the list", () => {
    expect(parseCodeCitationRefs(Array.from({ length: 80 }, () => ref))).toHaveLength(
      MAX_CODE_CITATION_REFS,
    );
  });

  it("shortCommitSha cuts to 12 by default", () => {
    expect(shortCommitSha(SHA)).toBe("0123456789ab");
    expect(shortCommitSha(SHA, 7)).toBe("0123456");
  });
});
