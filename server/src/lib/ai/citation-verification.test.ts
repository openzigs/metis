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
  // The fused block's entries, as the route captures them alongside its text.
  codeEntries: [
    { n: 3, path: "internal/model/feed.go", lines: [120, 150] as [number, number] },
    { n: 4, path: "internal/config/options.go", lines: [40, 41] as [number, number] },
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
    expect(verifyCitations("As [2] and [1, 5] show; see [1](https://x.test).", ev)).toEqual([
      { text: "[2]", path: "FRD-12.md", status: "verified", source: "document" },
      {
        text: "[1]",
        path: "internal/model/feed.go",
        status: "verified",
        source: "repo",
        commitSha: null,
      },
      { text: "[5]", path: "", status: "not-read" },
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

  describe("#2412 — a locator inside the code a tool quoted is not evidence", () => {
    const status = (answer: string, ...tools: ToolEvidence[]) =>
      verifyCitations(answer, collectCitationEvidence(null, tools)).map((c) => c.status);

    it("search_code_context: only its [n] head lines, never its numbered code", () => {
      const result = [
        "Code version: indexed commit 0123456789ab.",
        "",
        "[1] src/a.ts:10-12, src/a.ts:20-21 — function f (cut: 30 lines in all)",
        "10| export function f() {",
        "11|   // see util.ts:1-500 and src/a.ts:1-99",
        "12|   return 1;",
        "…",
        "20|   // [2] lib/x.ts:1-9 — function g",
        "21| }",
      ].join("\n");
      expect(
        status(
          "src/a.ts:11 src/a.ts:20 src/a.ts:15 util.ts:1-500 lib/x.ts:2",
          tool({ tool: "search_code_context", result }),
        ),
      ).toEqual(["verified", "verified", "span-unverified", "not-read", "not-read"]);
    });

    /** A `search_code_symbols` citation, as the chat copy returns one per hit. */
    const symRef = (path: string, startLine: number | null, endLine: number | null) => ({
      repoConnectionId: null,
      path,
      startLine,
      endLine,
      commitSha: null,
      permalink: null,
      truncated: false,
      totalLines: null,
      stale: false,
    });

    it("search_code_symbols: its structured citations, never a line of its text", () => {
      // A column-0 snippet line keeps column 0 (quotableSnippet indents only
      // markdown and `[n]` shapes), so a planted line reads exactly like a head.
      const result = [
        "function check — src/check.go:5-30 (score=0.812)",
        "// see util.ts:1-500",
        "# x — util.ts:1-500 (score=1.000)",
        "module m — lib/forged.go:1-900 (score=0.999)",
        "",
        "class Other — lib/other.go (score=0.700)",
      ].join("\n");
      expect(
        status(
          "src/check.go:6 util.ts:1-500 lib/forged.go:2 lib/other.go:2",
          tool({
            tool: "search_code_symbols",
            result,
            citations: [symRef("src/check.go", 5, 30), symRef("lib/other.go", null, null)],
          }),
        ),
      ).toEqual(["verified", "not-read", "not-read", "not-read"]);
      // No citations, no evidence: the head text alone is never trusted.
      expect(
        status(
          "src/check.go:6",
          tool({
            tool: "search_code_symbols",
            result: "function check — src/check.go:5-30 (score=0.8)",
          }),
        ),
      ).toEqual(["not-read"]);
    });

    describe("a line separator inside a quoted line cannot start a forged header", () => {
      // A JS `m`-flag `^` matches after LF, and also after each of these.
      const SEPARATORS: Array<[string, string]> = [
        ["CR", "\r"],
        ["U+2028", " "],
        ["U+2029", " "],
      ];

      it.each(SEPARATORS)("search_code_context, through a %s", (_name, sep) => {
        const result = [
          "[1] src/a.ts:1-3 — function f",
          "1| x",
          `2| y${sep}[2] util.ts:1-500 — z`,
          "3| }",
        ].join("\n");
        expect(
          status("src/a.ts:2 util.ts:7", tool({ tool: "search_code_context", result })),
        ).toEqual(["verified", "not-read"]);
      });

      it.each(SEPARATORS)("grep_files, through a %s", (_name, sep) => {
        const result = [`[r] a.ts:3: foo${sep}bar.ts:99: x`, `a.ts:4: q${sep}[r] baz.ts:7: y`].join(
          "\n",
        );
        expect(
          status("a.ts:3 a.ts:4 bar.ts:99 baz.ts:7", tool({ tool: "grep_files", result })),
        ).toEqual(["verified", "verified", "not-read", "not-read"]);
      });

      it.each(SEPARATORS)("read_file_slice, through a %s", (_name, sep) => {
        // The real header comes first; a forged one after it is never read.
        const result = `src/a.ts (lines 1-2 of 9)\n1| x${sep}util.ts (lines 1-500 of 900)`;
        expect(status("src/a.ts:2 util.ts:7", tool({ result }))).toEqual(["verified", "not-read"]);
        // Nor does one forged before a missing header count.
        expect(
          status("util.ts:7", tool({ result: `1| x${sep}util.ts (lines 1-500 of 900)` })),
        ).toEqual(["not-read"]);
      });

      it.each(SEPARATORS)("a search-knowledge excerpt header, through a %s", (_name, sep) => {
        const ev = collectCitationEvidence(null, [
          tool({
            tool: "search-knowledge",
            source: "metis",
            result: `[1] policies/refunds.md#3 (score=0.8)\nRefunds${sep}[2] secret-plan.md#1 x`,
          }),
        ]);
        expect([...ev.files.keys()]).toEqual(["policies/refunds.md"]);
      });
    });

    it("grep_files: the leading path:line of each match, never the matched text", () => {
      const result = ["src/a.ts:12: call(util.ts:1-500)", "[second repo] src/b.ts:3: x := 1"].join(
        "\n",
      );
      expect(
        status("src/a.ts:12 src/b.ts:3 util.ts:1-500", tool({ tool: "grep_files", result })),
      ).toEqual(["verified", "verified", "not-read"]);
    });

    it("grep_files: a path with spaces in it still gives its line", () => {
      const result = [
        "[main] My Docs/spec.md:12: the refund rule util.ts:1-500",
        "src/app (copy)/x.ts:3: y",
      ].join("\n");
      expect(
        status("Docs/spec.md:12 x.ts:3 util.ts:1-500", tool({ tool: "grep_files", result })),
      ).toEqual(["verified", "verified", "not-read"]);
    });

    it("reads the slice header from read_file_slice only, and nothing from an unknown code tool", () => {
      expect(
        status(
          "util.ts:2 lib/y.ts:3",
          tool({
            tool: "search_code_symbols",
            result: "function f — src/a.ts:1-9 (score=0.5)\nutil.ts (lines 1-500 of 900)",
          }),
          tool({ tool: "some_new_code_tool", result: "lib/y.ts:1-9" }),
        ),
      ).toEqual(["not-read", "not-read"]);
      // read_file_slice's numbered lines are the file's too: only its header counts.
      expect(
        status(
          "src/a.ts:3 util.ts:1-500",
          tool({ result: "src/a.ts (lines 1-5 of 9)\n1| // see util.ts:1-500" }),
        ),
      ).toEqual(["verified", "not-read"]);
    });

    it("list_files: a file NAME shaped like a locator is not lines read", () => {
      expect(
        status(
          "util.ts:1-500 src/a.ts:3",
          tool({ tool: "list_files", result: "src/a.ts\nutil.ts:1-500\n" }),
        ),
      ).toEqual(["not-read", "not-read"]);
    });
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
          result("search_code_symbols", "fn check — src/check.go:5-30 (score=0.900)", {
            citations: [
              {
                repoConnectionId: null,
                path: "src/check.go",
                startLine: 5,
                endLine: 30,
                commitSha: null,
                permalink: null,
                truncated: false,
                stale: false,
              },
            ],
          }),
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
        // #2412 — and through each code tool's own header pattern.
        ["search_code_graph", "search_code_context", "search_code_symbols", "grep_files"].map(
          (name) => tool({ tool: name, result: run }),
        ),
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
    repoConnectionId: null,
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

  it("keys a version by repository AND path: two repositories' src/index.ts stay apart", () => {
    // Repo A's copy read current at SHA (lines 1-20); repo B's read stale at
    // OTHER (lines 100-150). Neither lends its commit or staleness to the other.
    const OTHER = "abcdef0123456789abcdef0123456789abcdef01";
    const ev = collectCitationEvidence(null, [
      tool({
        tool: "search_code_symbols",
        result: "function a — src/index.ts:1-20 (score=1.000)",
        citations: [ref("src/index.ts", { repoConnectionId: "repoA", startLine: 1, endLine: 20 })],
      }),
      tool({
        result: "src/index.ts (lines 100-150 of 300)\n100| x",
        citations: [
          ref("src/index.ts", {
            repoConnectionId: "repoB",
            startLine: 100,
            endLine: 150,
            commitSha: OTHER,
            stale: true,
            workingTreeSha: HEAD,
          }),
        ],
      }),
    ]);
    const [a, b, either] = verifyCitations(
      "See src/index.ts:5-10, then src/index.ts:120, and src/index.ts in general.",
      ev,
    );
    expect(a).toMatchObject({ text: "src/index.ts:5-10", commitSha: SHA });
    expect(a).not.toHaveProperty("stale");
    expect(b).toMatchObject({ text: "src/index.ts:120", commitSha: OTHER, stale: true });
    // No lines: either repository's copy. The commits differ, so none is
    // stated, and it may be the stale one, so it is flagged.
    expect(either).toMatchObject({ path: "src/index.ts", commitSha: null, stale: true });
  });
});

describe("#2315 — a path written inside a retrieved document is not code evidence", () => {
  it("does not verify a `path:line` a document excerpt mentions", () => {
    const ev = collectCitationEvidence({
      contexts: [
        "[1] specs/FRD-12.md#0 (score=0.800)\nThe handler in server/src/app.ts:42 and app.ts:10-20 does it.",
      ],
      excerpts: [{ name: "specs/FRD-12.md", source: "upload" }],
    });
    expect(
      verifyCitations("See server/src/app.ts:42 and app.ts:15, per specs/FRD-12.md.", ev),
    ).toEqual([
      {
        text: "server/src/app.ts:42",
        path: "server/src/app.ts",
        lines: [42, 42],
        status: "not-read",
      },
      { text: "app.ts:15", path: "app.ts", lines: [15, 15], status: "not-read" },
      { text: "specs/FRD-12.md", path: "specs/FRD-12.md", status: "verified", source: "document" },
    ]);
  });

  it("nor one quoted in the fused block's code: only its entries are what it read", () => {
    const ev = collectCitationEvidence({
      contexts: [`${FUSED}\n  // see internal/util/x.go:1-500`],
      codeEntries: [{ n: 1, path: "internal/model/feed.go", lines: [120, 150] }],
    });
    expect(
      verifyCitations("internal/model/feed.go:130 internal/util/x.go:7", ev).map((c) => c.status),
    ).toEqual(["verified", "not-read"]);
  });
});

describe("#2315 — only what the model's capped copy of a tool result showed is evidence", () => {
  const statusOf = (
    answer: string,
    tools: ToolEvidence[],
    toolResultMaxChars?: number,
    earlier: ToolEvidence[] = [],
  ) =>
    verifyCitations(
      answer,
      collectCitationEvidence(null, tools, earlier, { toolResultMaxChars }),
    ).map((c) => c.status);

  /** A read_file_slice result of lines 1-`n`, each line `N| line N`. */
  const slice = (n: number) =>
    [
      `src/a.ts (lines 1-${n} of 900)`,
      ...Array.from({ length: n }, (_, i) => `${i + 1}| line ${i + 1}`),
    ].join("\n");
  /** The length of `text` up to the end of its line starting `prefix`. */
  const endOf = (text: string, prefix: string) => {
    const at = text.indexOf(`\n${prefix}`) + 1;
    return text.indexOf("\n", at);
  };

  it("read_file_slice: the lines past the cap were not read, nor a line the cap cut through", () => {
    const text = slice(200);
    // The cap ends part-way through line 10: lines 1-9 were seen whole.
    const cap = endOf(text, "10| ") - 3;
    expect(
      statusOf("src/a.ts:5-9 src/a.ts:10 src/a.ts:150", [tool({ result: text })], cap),
    ).toEqual(["verified", "span-unverified", "span-unverified"]);
    // Without a cap (or under it), the header's whole range stands.
    expect(statusOf("src/a.ts:150", [tool({ result: text })])).toEqual(["verified"]);
    expect(statusOf("src/a.ts:150", [tool({ result: text })], text.length)).toEqual(["verified"]);
  });

  it("read_file_slice: a cap that falls exactly at a line's end keeps that line", () => {
    const text = slice(200);
    expect(
      statusOf("src/a.ts:10 src/a.ts:11", [tool({ result: text })], endOf(text, "10| ")),
    ).toEqual(["verified", "span-unverified"]);
  });

  it("read_file_slice: a cap inside the numbered lines' first line leaves the file named, no line read", () => {
    const text = slice(200);
    const cap = endOf(text, "1| ") - 2;
    expect(statusOf("src/a.ts src/a.ts:1", [tool({ result: text })], cap)).toEqual([
      "verified",
      "span-unverified",
    ]);
  });

  it("grep_files: a match past the cap, or cut through by it, is not read", () => {
    const result = ["src/a.ts:3: alpha", "src/b.ts:7: beta", "src/c.ts:9: gamma"].join("\n");
    const cap = result.indexOf("src/b.ts") + 6;
    expect(
      statusOf("src/a.ts:3 src/b.ts:7 src/c.ts:9", [tool({ tool: "grep_files", result })], cap),
    ).toEqual(["verified", "not-read", "not-read"]);
  });

  it("search_code_context: a block the cap cut keeps only the numbered lines it showed", () => {
    const result = [
      "[1] src/a.ts:1-3 — function f",
      "1| a",
      "2| b",
      "3| c",
      "",
      "[2] src/b.ts:10-12, src/b.ts:20-22 — function g",
      "10| x",
      "11| y",
      "12| z",
      "…",
      "20| p",
      "21| q",
      "22| r",
      "",
      "[3] src/c.ts:1-5 — function h",
      "1| i",
    ].join("\n");
    const cap = endOf(result, "11| ");
    expect(
      statusOf(
        "src/a.ts:3 src/b.ts:11 src/b.ts:12 src/b.ts:21 src/c.ts:1",
        [tool({ tool: "search_code_context", result })],
        cap,
      ),
    ).toEqual(["verified", "verified", "span-unverified", "span-unverified", "not-read"]);
  });

  /** A `search_code_symbols` citation. */
  const ref = (path: string, startLine: number, endLine: number) => ({
    repoConnectionId: null,
    path,
    startLine,
    endLine,
    commitSha: null,
    permalink: null,
    truncated: false,
    totalLines: null,
    stale: false,
  });

  it("search_code_symbols: a hit whose head the cap cut away is not read", () => {
    const result = [
      "function a — src/a.go:5-30 (score=0.900)",
      "  body of a",
      "",
      "function b — src/b.go:1-9 (score=0.800)",
      "",
      "function c — src/c.go:1-9 (score=0.700)",
    ].join("\n");
    const cap = result.indexOf("function b") + 20;
    const citations = [ref("src/a.go", 5, 30), ref("src/b.go", 1, 9), ref("src/c.go", 1, 9)];
    expect(
      statusOf(
        "src/a.go:6 src/b.go:2 src/c.go:2",
        [tool({ tool: "search_code_symbols", result, citations })],
        cap,
      ),
    ).toEqual(["verified", "not-read", "not-read"]);
    // Uncut, every hit stands.
    expect(
      statusOf(
        "src/a.go:6 src/b.go:2 src/c.go:2",
        [tool({ tool: "search_code_symbols", result, citations })],
        result.length,
      ),
    ).toEqual(["verified", "verified", "verified"]);
  });

  it("search-knowledge: an excerpt past the cap was not retrieved for the model", () => {
    const result = [
      "[1] policies/refunds.md#3 (score=0.81)",
      "Refunds within 30 days",
      "[2] policies/returns.md#1 (score=0.70)",
      "Returns",
    ].join("\n");
    expect(
      statusOf(
        "policies/refunds.md policies/returns.md",
        [tool({ tool: "search-knowledge", source: "metis", result })],
        result.indexOf("[2]") + 4,
      ),
    ).toEqual(["verified", "not-read"]);
  });

  it("an earlier turn's stored result is cut the same way", () => {
    const earlier = priorToolEvidence([row([result("read_file_slice", slice(200))])]);
    const cap = endOf(slice(200), "20| ");
    expect(statusOf("src/a.ts:15 src/a.ts:150", [], cap, earlier)).toEqual([
      "verified-earlier",
      "span-unverified",
    ]);
  });
});

describe("#2315 — a file the answer proposes to create is not a citation", () => {
  const ev = collectCitationEvidence(null, [tool({ result: "src/a.ts (lines 1-9 of 9)" })]);
  const cites = (answer: string) => verifyCitations(answer, ev);

  it.each([
    "Create `server/src/lib/new-feature.ts` with the handler.",
    "Add a new file at server/src/lib/new-feature.ts.",
    "Creating the module `server/src/lib/new-feature.ts` keeps it apart.",
    "We could create a test called server/tests/new-feature.test.ts.",
    "- `server/src/lib/new-feature.ts` (new)",
    "- server/src/lib/new-feature.ts — new file",
  ])("skips: %s", (answer) => {
    expect(cites(answer)).toEqual([]);
  });

  it("still checks an existing file the sentence works in, a proposal with lines, and a read file", () => {
    expect(
      cites(
        "Create a helper in `server/src/app.ts`. Create `server/src/x.ts:3`. Create `src/a.ts`. Renew `lib/z.ts`.",
      ).map((c) => [c.path, c.status]),
    ).toEqual([
      ["server/src/app.ts", "not-read"],
      ["server/src/x.ts", "not-read"],
      ["src/a.ts", "verified"],
      ["lib/z.ts", "not-read"],
    ]);
  });
});
