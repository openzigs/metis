/**
 * Epic #726 (#734) — code-citation grounding gate. These lock the whole point
 * of the feature: a model-emitted `filePath:startLine-endLine` that was never
 * actually retrieved is DROPPED (anti-hallucination), a synthetic `code-graph:`
 * doc citation is NORMALISED into a real code citation, and document citations
 * pass through untouched.
 */
import type { Citation } from "@metis/shared";
import { describe, expect, it } from "vitest";
import type { RetrievalContextChunk } from "./agent-runner.js";
import {
  buildCodeProvenance,
  collectToolProvenance,
  groundCodeCitations,
  normalizeFilePath,
  parseLocatorFilePaths,
  type DroppedCitation,
} from "./code-citations.js";
import { CODE_GRAPH_DOCUMENT_PREFIX } from "./fused-code-chunks.js";

const codeChunk = (over: Partial<RetrievalContextChunk> = {}): RetrievalContextChunk => ({
  documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}sym-1`,
  chunkIndex: 0,
  filename: "server/src/auth/session.ts",
  text: "createSession (function) — server/src/auth/session.ts:10-42\nexport function createSession() {}",
  source: "code-graph",
  symbolId: "sym-1",
  filePath: "server/src/auth/session.ts",
  startLine: 10,
  endLine: 42,
  score: 0.9,
  ...over,
});

const docChunk = (): RetrievalContextChunk => ({
  documentId: "clabc123456",
  chunkIndex: 2,
  filename: "spec.md",
  text: "the system shall authenticate users",
});

describe("normalizeFilePath", () => {
  it("strips ./ and leading slash and normalises backslashes", () => {
    expect(normalizeFilePath("./a/b.ts")).toBe("a/b.ts");
    expect(normalizeFilePath("/a/b.ts")).toBe("a/b.ts");
    expect(normalizeFilePath("a\\b.ts")).toBe("a/b.ts");
  });
});

describe("buildCodeProvenance", () => {
  it("indexes only code-graph chunks and folds in extra allowed paths", () => {
    const prov = buildCodeProvenance([codeChunk(), docChunk()], ["extra/read.ts"]);
    expect(prov.byFilePath.has("server/src/auth/session.ts")).toBe(true);
    expect(prov.allowedFilePaths.has("server/src/auth/session.ts")).toBe(true);
    expect(prov.allowedFilePaths.has("extra/read.ts")).toBe(true);
    // The document chunk contributes no code provenance.
    expect(prov.byDocumentId.has("clabc123456")).toBe(false);
  });
});

describe("groundCodeCitations", () => {
  const prov = () => buildCodeProvenance([codeChunk()]);

  it("keeps a code citation whose filePath was retrieved and enriches its symbolId", () => {
    const citations: Citation[] = [
      { filePath: "server/src/auth/session.ts", startLine: 12, endLine: 20 },
    ];
    const [c] = groundCodeCitations(citations, prov());
    expect(c).toMatchObject({
      filePath: "server/src/auth/session.ts",
      startLine: 12,
      endLine: 20,
      symbolId: "sym-1",
    });
  });

  it("DROPS a code citation whose filePath was never retrieved (hallucination) and reports it", () => {
    const citations: Citation[] = [
      { filePath: "server/src/auth/session.ts", startLine: 12, endLine: 20 },
      { filePath: "totally/made-up.ts", startLine: 1, endLine: 5 },
    ];
    const dropped: DroppedCitation[] = [];
    const grounded = groundCodeCitations(citations, prov(), {
      onDrop: (d) => dropped.push(d),
    });
    expect(grounded).toHaveLength(1);
    expect(grounded.every((c) => "filePath" in c && c.filePath !== "totally/made-up.ts")).toBe(
      true,
    );
    // The drop is observable, not silent.
    expect(dropped).toEqual([{ filePath: "totally/made-up.ts", reason: "file-not-retrieved" }]);
  });

  it("KEEPS a citation whose span is narrower than the grounded span (containment optional)", () => {
    // provenance chunk is session.ts:10-42; model cites a sub-range 15-18.
    const [c] = groundCodeCitations(
      [{ filePath: "server/src/auth/session.ts", startLine: 15, endLine: 18 }],
      prov(),
    );
    expect(c).toMatchObject({ filePath: "server/src/auth/session.ts", startLine: 15, endLine: 18 });
  });

  it("reports a dropped code-graph: id via onDrop", () => {
    const dropped: DroppedCitation[] = [];
    groundCodeCitations(
      [{ documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}ghost`, chunkIndex: 0 }],
      prov(),
      {
        onDrop: (d) => dropped.push(d),
      },
    );
    expect(dropped).toEqual([
      { filePath: `${CODE_GRAPH_DOCUMENT_PREFIX}ghost`, reason: "code-graph-id-unresolved" },
    ]);
  });

  it("normalises a code-graph: document citation into a real code citation", () => {
    const citations: Citation[] = [
      { documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}sym-1`, chunkIndex: 0, snippet: "s" },
    ];
    const [c] = groundCodeCitations(citations, prov());
    expect(c).toMatchObject({
      filePath: "server/src/auth/session.ts",
      startLine: 10,
      endLine: 42,
      symbolId: "sym-1",
    });
    expect("documentId" in (c as object)).toBe(false);
  });

  it("normalises a code-graph chunk missing line spans / symbolId to safe defaults", () => {
    const bare = buildCodeProvenance([
      {
        documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}bare`,
        chunkIndex: 0,
        filename: "a.ts",
        text: "",
        source: "code-graph",
        filePath: "a.ts",
        // no startLine / endLine / symbolId / snippet
      },
    ]);
    const [c] = groundCodeCitations(
      [{ documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}bare`, chunkIndex: 0 }],
      bare,
    );
    expect(c).toEqual({ filePath: "a.ts", startLine: 1, endLine: 1 });
  });

  it("drops a code-graph: document citation with no matching retrieved chunk", () => {
    const citations: Citation[] = [
      { documentId: `${CODE_GRAPH_DOCUMENT_PREFIX}ghost`, chunkIndex: 0 },
    ];
    expect(groundCodeCitations(citations, prov())).toHaveLength(0);
  });

  it("passes plain document citations through untouched", () => {
    const doc: Citation = { documentId: "clabc123456", chunkIndex: 2, filename: "spec.md" };
    expect(groundCodeCitations([doc], prov())).toEqual([doc]);
  });

  it("tolerates a path with ./ prefix against a normalised provenance set", () => {
    const citations: Citation[] = [
      { filePath: "./server/src/auth/session.ts", startLine: 10, endLine: 42 },
    ];
    expect(groundCodeCitations(citations, prov())).toHaveLength(1);
  });
});

describe("parseLocatorFilePaths", () => {
  it("extracts the filePath from strict path:int-int locators", () => {
    const text =
      "function createSession — server/src/auth/session.ts:10-42 (score=0.900)\n" +
      "class OrderRepo — src/orders/order-repo.py:1-30 (score=0.812)";
    expect(parseLocatorFilePaths(text)).toEqual([
      "server/src/auth/session.ts",
      "src/orders/order-repo.py",
    ]);
  });

  it("ignores a bare path in prose and a path:int with no range", () => {
    expect(parseLocatorFilePaths("see server/src/auth/session.ts for details")).toEqual([]);
    expect(parseLocatorFilePaths("server/src/auth/session.ts:10 only a start line")).toEqual([]);
  });

  it("ignores a bare word that is not a path (no / or .)", () => {
    expect(parseLocatorFilePaths("foo:1-2 and bar:3-4")).toEqual([]);
  });

  it("keeps valid locators before a truncation cut and ignores the partial trailing token", () => {
    // A result cut mid-locator: the first two are intact, the trailing token is
    // partial (`session.t` — no `:int-int`) and must not ground a path.
    const truncated = "a/b.ts:1-5, c/d.ts:10-20, server/src/auth/session.t";
    expect(parseLocatorFilePaths(truncated)).toEqual(["a/b.ts", "c/d.ts"]);
  });

  it("returns the correct filePath even when the span itself is truncated", () => {
    // We ground on filePath only, so a cut end-line still yields the right path.
    expect(parseLocatorFilePaths("a/b.ts:10-4")).toEqual(["a/b.ts"]);
  });
});

describe("collectToolProvenance", () => {
  it("harvests read_file_slice args AND search-tool result locators", () => {
    const paths = collectToolProvenance([
      { tool: "read_file_slice", args: { filePath: "opened.ts", startLine: 1 } },
      {
        tool: "search_code_symbols",
        args: { query: "auth" },
        result: "function createSession — server/src/auth/session.ts:10-42 (score=0.9)",
      },
      {
        tool: "search_code_graph",
        args: { name: "OrderRepo" },
        result: "class OrderRepo — src/orders/order-repo.py:1-30",
      },
      { tool: "read_file_slice", args: { filePath: "  " } },
      { tool: "read_file_slice", args: null },
    ]);
    expect(paths).toEqual(["opened.ts", "server/src/auth/session.ts", "src/orders/order-repo.py"]);
  });

  it("falls back to resultPreview when full result is absent", () => {
    const paths = collectToolProvenance([
      { tool: "search_code_symbols", args: {}, resultPreview: "x — a/b.ts:1-9 (score=0.5)" },
    ]);
    expect(paths).toEqual(["a/b.ts"]);
  });

  it("grounds a citation to a file surfaced ONLY by search_code_symbols (never read)", () => {
    // The regression the coordinator flagged: discover via search, cite without
    // reading — must be KEPT, not dropped.
    const prov = buildCodeProvenance(
      [],
      collectToolProvenance([
        {
          tool: "search_code_symbols",
          args: { query: "session" },
          result: "function createSession — server/src/auth/session.ts:10-42 (score=0.9)",
        },
      ]),
    );
    const grounded = groundCodeCitations(
      [{ filePath: "server/src/auth/session.ts", startLine: 12, endLine: 20 }],
      prov,
    );
    expect(grounded).toHaveLength(1);
  });
});
