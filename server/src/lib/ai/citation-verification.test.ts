/** #2242 — a chat answer's citations, checked against what its turn retrieved or read. */
import { describe, expect, it } from "vitest";
import { MAX_CHAT_CITATIONS } from "@metis/shared";
import {
  citationsMeta,
  collectCitationEvidence,
  normalizePath,
  verifyCitations,
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

  it("treats two files ending in the cited name as no match", () => {
    const ev = collectCitationEvidence(null, [
      tool({ result: "a/util.ts (lines 1-9 of 9)" }),
      tool({ result: "b/util.ts (lines 1-9 of 9)" }),
    ]);
    expect(verifyCitations("util.ts:2", ev)[0]).toMatchObject({ status: "not-read" });
  });

  it("calls a file read as code anywhere in the turn a repository file", () => {
    const ev = collectCitationEvidence({ contexts: [], excerpts: [{ name: "src/a.ts" }] }, [
      tool({ result: "src/a.ts (lines 1-9 of 9)" }),
    ]);
    expect(verifyCitations("src/a.ts:3", ev)[0]).toMatchObject({ source: "repo" });
  });
});

describe("bounded work on hostile input", () => {
  it("scans a long run of path characters in linear time, in an answer and in a tool result", () => {
    const run = "a".repeat(200_000);
    const t0 = performance.now();
    const ev = collectCitationEvidence({ contexts: [run] }, [
      tool({ tool: "search_code_graph", result: run }),
    ]);
    expect(verifyCitations(run, ev)).toEqual([]);
    expect(performance.now() - t0).toBeLessThan(1000);
  });
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
