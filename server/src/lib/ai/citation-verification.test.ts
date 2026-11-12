/** #2242 — a chat answer's citations, checked against what its turn retrieved or read. */
import { describe, expect, it } from "vitest";
import { MAX_CHAT_CITATIONS } from "@metis/shared";
import {
  citationsMeta,
  collectCitationEvidence,
  normalizePath,
  priorToolEvidence,
  verifyCitations,
  type PriorRow,
  type ToolEvidence,
} from "./citation-verification.js";

const FUSED = [
  "## Retrieved Code (fused code-graph symbols)",
  "- function scheduleNextCheck — internal/model/feed.go:120-150",
  "- const MaxParsingErrors — internal/config/options.go:40-41",
].join("\n");

const retrieved = {
  contexts: ["[1] internal/model/feed.go#0 (score=0.700)\nfunc (f *Feed) ...", FUSED],
  excerpts: [
    { name: "internal/model/feed.go", source: "repo" },
    { name: "FRD-12.md", source: "upload" },
  ],
};

const tool = (over: Partial<ToolEvidence> & { result: string }): ToolEvidence => ({
  tool: "read_file_slice",
  source: "code",
  executed: true,
  ...over,
});

describe("verifyCitations — retrieved excerpts and the fused code block", () => {
  const ev = collectCitationEvidence(retrieved);

  it("verifies a cited range inside a fused locator, and a cited file the turn retrieved", () => {
    expect(verifyCitations("See `internal/model/feed.go:125-140` and FRD-12.md.", ev)).toEqual([
      {
        text: "internal/model/feed.go:125-140",
        path: "internal/model/feed.go",
        lines: [125, 140],
        status: "verified",
        source: "repo",
        commitSha: null,
      },
      { text: "FRD-12.md", path: "FRD-12.md", status: "verified", source: "document" },
    ]);
  });

  it("marks a range the turn never read, and a file it never read", () => {
    expect(
      verifyCitations("At internal/model/feed.go:10-20, see internal/storage/batch.go:5.", ev),
    ).toEqual([
      expect.objectContaining({ path: "internal/model/feed.go", status: "span-unverified" }),
      expect.objectContaining({
        path: "internal/storage/batch.go",
        lines: [5, 5],
        status: "not-read",
      }),
    ]);
  });

  it("cannot check lines of a document excerpt, which has none", () => {
    expect(verifyCitations("FRD-12.md lines 3-4 says so", ev)).toEqual([
      expect.objectContaining({ path: "FRD-12.md", lines: [3, 4], status: "span-unverified" }),
    ]);
  });

  it("resolves a short path that names exactly one file read", () => {
    expect(verifyCitations("`model/feed.go#L121-L122`", ev)).toEqual([
      expect.objectContaining({
        path: "internal/model/feed.go",
        lines: [121, 122],
        status: "verified",
      }),
    ]);
  });

  it("leaves a bare name the turn never read, with no line, alone (a mention, not a citation)", () => {
    expect(verifyCitations("Add a `config.yaml` and use Node.js 22.", ev)).toEqual([]);
  });

  it("checks [n] references against the numbered excerpts, ignoring Markdown links", () => {
    expect(verifyCitations("As [2] and [1, 3] show; see [1](https://x.test).", ev)).toEqual([
      { text: "[2]", path: "FRD-12.md", status: "verified", source: "document" },
      {
        text: "[1]",
        path: "internal/model/feed.go",
        status: "verified",
        source: "repo",
        commitSha: null,
      },
      { text: "[3]", path: "", status: "not-read" },
    ]);
  });

  it("skips paths inside fenced code blocks and URLs", () => {
    expect(
      verifyCitations(
        "```ts\nimport x from './made/up.ts';\n```\nhttps://github.com/a/b/blob/main/src/x.go#L1",
        ev,
      ),
    ).toEqual([]);
  });

  it("lists a citation repeated in the answer once", () => {
    expect(verifyCitations("FRD-12.md, then FRD-12.md again", ev)).toHaveLength(1);
  });

  it("keeps at most MAX_CHAT_CITATIONS, in the order written", () => {
    const many = Array.from({ length: MAX_CHAT_CITATIONS + 5 }, (_, i) => `src/f${i}.ts:1`);
    const out = verifyCitations(many.join(" "), ev);
    expect(out).toHaveLength(MAX_CHAT_CITATIONS);
    expect(out[0]!.path).toBe("src/f0.ts");
  });

  it("returns nothing for an empty answer", () => {
    expect(verifyCitations("", ev)).toEqual([]);
  });
});

describe("collectCitationEvidence — what the tools read", () => {
  it("reads read_file_slice's header as the lines read, joining adjacent slices", () => {
    const ev = collectCitationEvidence(null, [
      tool({ result: "src/a.ts (lines 1-50 of 300)\n1| x" }),
      tool({ result: "src/a.ts (lines 51-80 of 300)\n51| y" }),
    ]);
    expect(verifyCitations("src/a.ts:40-70", ev)[0]!.status).toBe("verified");
    expect(verifyCitations("src/a.ts:40-90", ev)[0]!.status).toBe("span-unverified");
  });

  it("reads the locators a code search tool listed", () => {
    const ev = collectCitationEvidence(null, [
      tool({
        tool: "search_code_graph",
        result: "class Validator — src/validator.ts:1-40 [ts]",
      }),
    ]);
    expect(verifyCitations("src/validator.ts:2-3", ev)[0]).toMatchObject({
      status: "verified",
      source: "repo",
    });
  });

  it("reads search-knowledge's excerpt names as documents", () => {
    const ev = collectCitationEvidence(null, [
      tool({
        tool: "search-knowledge",
        source: "metis",
        result: "[1] policies/refunds.md#3 (score=0.81)\nRefunds within 30 days",
      }),
    ]);
    expect(verifyCitations("policies/refunds.md", ev)[0]).toMatchObject({
      status: "verified",
      source: "document",
    });
  });

  it("ignores a call that failed or never ran, and tools whose content is not the project's", () => {
    const ev = collectCitationEvidence(null, [
      tool({ result: "src/a.ts (lines 1-5 of 9)", isError: true }),
      tool({ result: "src/b.ts (lines 1-5 of 9)", executed: false }),
      // Shaped like a knowledge result, so only its source keeps it out.
      tool({ tool: "web", source: "mcp", result: "[1] src/c.ts#0 (score=0.9)\nsrc/c.ts:1-9" }),
      tool({ tool: "list_requirements", source: "metis", result: "[1] src/d.ts#0" }),
    ]);
    expect(
      verifyCitations("src/a.ts:1 src/b.ts:1 src/c.ts:1 src/d.ts:1", ev).map((c) => c.status),
    ).toEqual(["not-read", "not-read", "not-read", "not-read"]);
  });

  it("reads a multi-product block's excerpt headers when it records no excerpts", () => {
    const ev = collectCitationEvidence({
      contexts: ["[1] [Reader] miniflux.py#2 (score=0.600)\ndef me(self): ..."],
    });
    expect(verifyCitations("see miniflux.py", ev)[0]).toMatchObject({
      path: "miniflux.py",
      status: "verified",
    });
  });

  it("verifies a short path naming two files read when one of them covers the lines", () => {
    const ev = collectCitationEvidence(null, [
      tool({ result: "a/util.ts (lines 1-9 of 90)" }),
      tool({ result: "b/util.ts (lines 50-60 of 90)" }),
    ]);
    expect(verifyCitations("util.ts:55", ev)[0]).toMatchObject({
      path: "b/util.ts",
      status: "verified",
      source: "repo",
    });
  });

  it("calls a short path naming two files read, neither at those lines, ambiguous — not unread", () => {
    const ev = collectCitationEvidence(null, [
      tool({ result: "a/util.ts (lines 1-9 of 90)" }),
      tool({ result: "b/util.ts (lines 1-9 of 90)" }),
    ]);
    expect(verifyCitations("util.ts:40", ev)[0]).toEqual({
      text: "util.ts:40",
      path: "util.ts",
      lines: [40, 40],
      status: "ambiguous",
    });
    // With no line it cannot be checked either way: a `/` path is listed as ambiguous…
    expect(
      verifyCitations(
        "see x/util.ts",
        collectCitationEvidence(null, [
          tool({ result: "a/x/util.ts (lines 1-9 of 9)" }),
          tool({ result: "b/x/util.ts (lines 1-9 of 9)" }),
        ]),
      )[0],
    ).toMatchObject({ status: "ambiguous" });
    // …and a bare name is a mention.
    expect(verifyCitations("see util.ts", ev)).toEqual([]);
  });

  it("calls a file read as code anywhere in the turn a repository file", () => {
    const ev = collectCitationEvidence({ contexts: [], excerpts: [{ name: "src/a.ts" }] }, [
      tool({ result: "src/a.ts (lines 1-9 of 9)" }),
    ]);
    expect(verifyCitations("src/a.ts:3", ev)[0]).toMatchObject({ source: "repo" });
  });
});

const row = (parts: PriorRow["parts"], over: Partial<PriorRow> = {}): PriorRow => ({
  role: "assistant",
  kind: "message",
  compactedAt: null,
  parts,
  ...over,
});
const result = (name: string, text: string, over: Record<string, unknown> = {}) =>
  ({ type: "tool_result", toolCallId: "c1", name, text, ...over }) as PriorRow["parts"][number];

describe("citations read in an earlier turn of the conversation", () => {
  const earlier = [
    row([
      { type: "tool_call", id: "c1", name: "read_file_slice", args: { path: "src/a.ts" } },
      result("read_file_slice", "src/a.ts (lines 10-40 of 300)\n10| x"),
      { type: "text", text: "src/a.ts:12-20 does it." },
    ]),
  ];

  it("marks a follow-up's re-citation of lines an earlier turn read verified-earlier, not not-read", () => {
    const ev = collectCitationEvidence(null, [], priorToolEvidence(earlier));
    expect(verifyCitations("As before, src/a.ts:12-20 does it.", ev)).toEqual([
      {
        text: "src/a.ts:12-20",
        path: "src/a.ts",
        lines: [12, 20],
        status: "verified-earlier",
        source: "repo",
        commitSha: null,
      },
    ]);
    // Without the earlier turns the same answer is a false alarm.
    expect(verifyCitations("src/a.ts:12-20", collectCitationEvidence(null))[0]!.status).toBe(
      "not-read",
    );
  });

  it("still flags lines no turn read, and prefers this turn's read when there is one", () => {
    const ev = collectCitationEvidence(
      null,
      [tool({ result: "src/a.ts (lines 100-120 of 300)" })],
      priorToolEvidence(earlier),
    );
    expect(verifyCitations("src/a.ts:200", ev)[0]!.status).toBe("span-unverified");
    expect(verifyCitations("src/a.ts:105", ev)[0]!.status).toBe("verified");
    expect(verifyCitations("src/a.ts:30", ev)[0]!.status).toBe("verified-earlier");
  });

  it("joins lines read this turn and earlier", () => {
    const ev = collectCitationEvidence(
      null,
      [tool({ result: "src/a.ts (lines 41-60 of 300)" })],
      priorToolEvidence(earlier),
    );
    expect(verifyCitations("src/a.ts:35-50", ev)[0]!.status).toBe("verified-earlier");
  });

  it("reads earlier search-knowledge results and code-search locators", () => {
    const ev = collectCitationEvidence(
      null,
      [],
      priorToolEvidence([
        row([
          result("search-knowledge", "[1] policies/refunds.md#3 (score=0.8)\nRefunds"),
          result("search_code_symbols", "fn check — src/check.go:5-30"),
        ]),
      ]),
    );
    expect(verifyCitations("policies/refunds.md and src/check.go:6", ev)).toEqual([
      expect.objectContaining({
        path: "policies/refunds.md",
        status: "verified-earlier",
        source: "document",
      }),
      expect.objectContaining({ path: "src/check.go", status: "verified-earlier", source: "repo" }),
    ]);
  });

  it("ignores compacted rows, user rows, failed or refused calls, and tools that are not the project's", () => {
    const tools = priorToolEvidence([
      row([result("read_file_slice", "src/b.ts (lines 1-9 of 9)")], { compactedAt: new Date() }),
      row([result("read_file_slice", "src/c.ts (lines 1-9 of 9)")], { role: "user" }),
      row([result("read_file_slice", "src/d.ts (lines 1-9 of 9)")], { kind: "summary" }),
      row([
        result("read_file_slice", "src/e.ts (lines 1-9 of 9)", { isError: true }),
        result("read_file_slice", "src/f.ts (lines 1-9 of 9)", { executed: false }),
        result("fetch_url", "[1] src/g.ts#0 (score=0.9)\nsrc/g.ts:1-9"),
      ]),
    ]);
    const ev = collectCitationEvidence(null, [], tools);
    expect(
      verifyCitations("src/b.ts:1 src/c.ts:1 src/d.ts:1 src/e.ts:1 src/f.ts:1 src/g.ts:1", ev).map(
        (c) => c.status,
      ),
    ).toEqual(["not-read", "not-read", "not-read", "not-read", "not-read", "not-read"]);
  });
});

describe("[n] references", () => {
  const ev = collectCitationEvidence({
    contexts: [],
    excerpts: [
      { name: "FRD-12.md", source: "upload" },
      { name: "internal/model/feed.go", source: "repo" },
    ],
    // The fused block numbers on from the excerpts: its first entry is [3].
    codeEntries: [{ n: 3, path: "internal/model/feed.go", lines: [120, 150] }],
  });

  it("resolves a number past the excerpts to the fused code entry, with its locator", () => {
    expect(verifyCitations("See [1] and [3].", ev)).toEqual([
      { text: "[1]", path: "FRD-12.md", status: "verified", source: "document" },
      {
        text: "[3]",
        path: "internal/model/feed.go",
        lines: [120, 150],
        status: "verified",
        source: "repo",
        commitSha: null,
      },
    ]);
  });

  it("resolves a fused entry when no excerpt was retrieved", () => {
    const codeOnly = collectCitationEvidence({
      contexts: [],
      codeEntries: [{ n: 1, path: "src/a.ts", lines: [1, 9] }],
    });
    expect(verifyCitations("[1]", codeOnly)[0]).toMatchObject({
      path: "src/a.ts",
      status: "verified",
    });
  });

  it("is not an index after an identifier, inside inline code, or zero", () => {
    expect(
      verifyCitations("Use items[0], arr[1], f()[2], `[1]` and `x = y[2]`; see [0].", ev),
    ).toEqual([]);
  });

  it("reads [1][2] as two references", () => {
    expect(verifyCitations("Both say so [1][2].", ev).map((c) => c.path)).toEqual([
      "FRD-12.md",
      "internal/model/feed.go",
    ]);
  });

  it("still counts inline-code path citations", () => {
    expect(verifyCitations("`FRD-12.md` [2]", ev).map((c) => c.status)).toEqual([
      "verified",
      "verified",
    ]);
  });
});

describe("bounded work on hostile input", () => {
  it.each(["a", "a-", "a.", "a/", "a-a.", "[1,"])(
    "scans a long run of %s in linear time, in an answer and in tool results",
    (unit) => {
      const run = unit.repeat(Math.ceil(200_000 / unit.length));
      const t0 = performance.now();
      const ev = collectCitationEvidence(
        { contexts: [run], excerpts: [{ name: "x.md" }] },
        [tool({ tool: "search_code_graph", result: run })],
        [tool({ tool: "search_code_graph", result: run })],
      );
      verifyCitations(run, ev);
      // Quadratic takes seconds at this size; linear takes milliseconds. Wide on purpose.
      expect(performance.now() - t0).toBeLessThan(2000);
    },
  );
});

describe("URL blanking on hostile input", () => {
  it.each(["a-", "a."])("blanks URLs without a quadratic scan over a run of %s", (unit) => {
    const run = unit.repeat(100_000);
    const t0 = performance.now();
    expect(verifyCitations(run, collectCitationEvidence({ contexts: [] }, []))).toEqual([]);
    // Quadratic took ~9 s at this size; linear takes milliseconds. The bound is wide on purpose.
    expect(performance.now() - t0).toBeLessThan(3000);
  });

  it("still ignores a citation inside a URL", () => {
    const ev = collectCitationEvidence({ contexts: [] }, [
      tool({ result: "src/a.ts (lines 1-9 of 9)" }),
    ]);
    expect(verifyCitations("see https://x.test/src/a.ts:3 here", ev)).toEqual([]);
  });
});

describe("normalizePath and citationsMeta", () => {
  it("normalises a path to repository-relative", () => {
    expect(normalizePath(" ./src\\a.ts ")).toBe("src/a.ts");
    expect(normalizePath("/src/a.ts")).toBe("src/a.ts");
  });

  it("records citations on the row only when there are some", () => {
    expect(citationsMeta([])).toEqual({});
    const c = [{ text: "a.md", path: "a.md", status: "verified" as const }];
    expect(citationsMeta(c)).toEqual({ citations: c });
  });
});

describe("#2325 — a code citation records the version it was read at", () => {
  const SHA = "0123456789abcdef0123456789abcdef01234567";
  const HEAD = "fedcba9876543210fedcba9876543210fedcba98";
  const ref = (path: string, over: Record<string, unknown> = {}) => ({
    path,
    startLine: 10,
    endLine: 40,
    commitSha: SHA,
    permalink: null,
    truncated: false,
    totalLines: 300,
    stale: false,
    ...over,
  });

  it("stamps a citation with the commit the tool's contract stated", () => {
    const ev = collectCitationEvidence(null, [
      tool({ result: "src/a.ts (lines 10-40 of 300)\n10| x", citations: [ref("src/a.ts")] }),
    ]);
    expect(verifyCitations("src/a.ts:12-20", ev)).toEqual([
      {
        text: "src/a.ts:12-20",
        path: "src/a.ts",
        lines: [12, 20],
        status: "verified",
        source: "repo",
        commitSha: SHA,
      },
    ]);
  });

  it("flags a citation of a stale read, keeping its status (never dropped or downgraded)", () => {
    const ev = collectCitationEvidence(null, [
      tool({
        result: "src/a.ts (lines 10-40 of 300)\n10| x",
        citations: [ref("src/a.ts", { stale: true, workingTreeSha: HEAD })],
      }),
      // A later, fresh search of the same file does not hide the stale read.
      tool({
        tool: "search_code_symbols",
        result: "function f — src/a.ts:10-40 (score=1.000)",
        citations: [ref("src/a.ts")],
      }),
    ]);
    expect(verifyCitations("src/a.ts:12-20", ev)[0]).toMatchObject({
      status: "verified",
      commitSha: SHA,
      stale: true,
    });
  });

  it("reads the version back from an earlier turn's stored tool result", () => {
    const earlier = [
      row([
        result("read_file_slice", "src/a.ts (lines 10-40 of 300)\n10| x", {
          citations: [ref("src/a.ts", { stale: true }), { path: 42 }],
        }),
      ]),
    ];
    const prior = priorToolEvidence(earlier);
    expect(prior[0]?.citations).toHaveLength(1);
    const ev = collectCitationEvidence(null, [], prior);
    expect(verifyCitations("src/a.ts:12-20", ev)[0]).toMatchObject({
      status: "verified-earlier",
      commitSha: SHA,
      stale: true,
    });
  });

  it("gives a fused entry's [n] its version, and a repository file no tool versioned null", () => {
    const ev = collectCitationEvidence({
      contexts: ["[1] A (class) — src/a.ts:1-9"],
      codeEntries: [{ n: 1, path: "src/a.ts", lines: [1, 9], commitSha: SHA }],
    });
    expect(verifyCitations("See [1] and src/a.ts:2.", ev)).toEqual([
      expect.objectContaining({ text: "[1]", commitSha: SHA }),
      expect.objectContaining({ text: "src/a.ts:2", commitSha: SHA }),
    ]);
    const unversioned = collectCitationEvidence(null, [
      tool({ result: "src/b.ts (lines 1-5 of 5)\n1| x" }),
    ]);
    expect(verifyCitations("src/b.ts:2", unversioned)[0]).toMatchObject({ commitSha: null });
  });

  it("leaves a document citation without version fields, and a tool that is not the project's unread", () => {
    const ev = collectCitationEvidence(retrieved, [
      tool({
        tool: "mcp:x:read",
        source: "mcp",
        result: "src/c.ts (lines 1-5 of 5)",
        citations: [ref("src/c.ts")],
      }),
    ]);
    const [doc, mcp] = verifyCitations("FRD-12.md and src/c.ts:2", ev);
    expect(doc).not.toHaveProperty("commitSha");
    expect(doc).not.toHaveProperty("stale");
    expect(mcp).toMatchObject({ status: "not-read" });
    expect(mcp).not.toHaveProperty("commitSha");
  });
});
