/**
 * #1060 — `buildSpecKitRagContext` with `localise`: the plan's context follows
 * the code graph down from what similarity retrieved, and ends with the list of
 * every file it names.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RetrievedChunk } from "@metis/shared";
import {
  MIGRATIONS,
  STORAGE,
  fakeSource,
  minifluxGraph,
  sym,
} from "../../../tests/helpers/plan-localisation-graph.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import {
  DEFAULT_LOCALISATION_TOKEN_BUDGET,
  FILE_MANIFEST_HEADER,
  buildSpecKitRagContext,
  type BuildSpecKitRagContextOptions,
} from "./rag-context.js";
import { LOCALISATION_HEADER } from "./plan-localisation.js";

afterEach(() => {
  delete process.env.SPEC_KIT_PLAN_LOCALISATION_TOKEN_BUDGET;
  __resetConfigSingleton();
});

const SPEC =
  "Record, per feed, the time of the feed's most recent successful refresh, and expose it wherever the feed is returned. A feed that never succeeded shows none.";

/** Similarity retrieves one UI handler, one UI file and a source excerpt; nothing of the data layer. */
const sourceChunk: RetrievedChunk = {
  chunkId: "c1",
  documentId: "d1",
  filename: "connector:repo:r1:src/internal/cli/refresh_feeds.go",
  position: 0,
  text: "func refreshFeeds(store *storage.Storage) {",
  score: 0.9,
  embeddingModel: "test",
  source: "repo",
};
const manual: RetrievedChunk = {
  ...sourceChunk,
  chunkId: "c2",
  documentId: "d2",
  filename: "miniflux.1.txt",
  source: "upload",
};

function options(over: Partial<BuildSpecKitRagContextOptions> = {}): BuildSpecKitRagContextOptions {
  return {
    knowledgeService: { search: vi.fn(async () => ({ hits: [sourceChunk, manual] })) },
    fusedCode: {
      searcher: {
        search: vi.fn(async () => [
          { symbolId: "h-refresh", filePath: "x", name: "refreshFeed", kind: "function", score: 1 },
          {
            symbolId: "m-entries",
            filePath: "x",
            name: "feed_entries.go",
            kind: "module",
            score: 0.9,
          },
        ]),
      },
      lineLookup: {
        resolve: vi.fn(
          async () =>
            new Map([
              [
                "h-refresh",
                { filePath: "internal/ui/feed_refresh.go", startLine: 17, endLine: 36 },
              ],
              ["m-entries", { filePath: "internal/ui/feed_entries.go", startLine: 1, endLine: 65 }],
            ]),
        ),
      },
    },
    includeCode: true,
    siblings: { lookup: { findInFiles: vi.fn(async () => []) } },
    callers: {
      lookup: {
        findCallers: vi.fn(async () => [
          {
            toSymbolId: "h-refresh",
            toQualifiedName: null,
            filePath: "internal/ui/ui.go",
            line: 88,
            callerName: "Serve",
          },
        ]),
      },
    },
    localise: { source: fakeSource(minifluxGraph()) },
    ...over,
  };
}

describe("buildSpecKitRagContext — plan localisation (#1060)", () => {
  it("adds the data path of the retrieved code, and lists every file the context names", async () => {
    const r = await buildSpecKitRagContext("p1", SPEC, options());
    expect(r.context).toContain(LOCALISATION_HEADER);
    expect(r.context).toContain(FILE_MANIFEST_HEADER);
    // The manifest closes the context, after the localisation.
    expect(r.context.indexOf(LOCALISATION_HEADER)).toBeLessThan(
      r.context.indexOf(FILE_MANIFEST_HEADER),
    );
    expect(r.files).toEqual([
      // a retrieved source excerpt, by its repo-relative path
      "internal/cli/refresh_feeds.go",
      // the retrieved symbols
      "internal/ui/feed_refresh.go",
      "internal/ui/feed_entries.go",
      // a caller
      "internal/ui/ui.go",
      // the localisation
      MIGRATIONS,
      // the types named for the table, by path (as the production source returns them)
      "client/model.go",
      "internal/model/feed.go",
      `${STORAGE}/feed.go`,
      `${STORAGE}/nav_metadata.go`,
      `${STORAGE}/feed_query_builder.go`,
      `${STORAGE}/user.go`,
      "internal/http/response/json.go",
      "internal/ui/category_entries.go",
    ]);
    // Every listed file is in the manifest; an uploaded document is not a repository file.
    const manifest = r.context.slice(r.context.indexOf(FILE_MANIFEST_HEADER));
    for (const f of r.files) expect(manifest).toContain(`- ${f}`);
    expect(manifest).not.toContain("miniflux.1.txt");
    // Nothing was cut for the budget; the one table reached and not followed is said.
    expect(r.dropped).toEqual([
      "Tables: 1 more table the retrieved code reaches was not followed (users)",
    ]);
  });

  it("walks from a sibling of a retrieved symbol too, and looks for the sibling's callers", async () => {
    // #785 lists `refreshFeedAndCount` beside the retrieved `refreshFeed`. It is
    // code the plan was shown, so the walk starts from it as well: only the
    // sibling calls `NewBatch`.
    const graph = minifluxGraph();
    graph.symbols.push(
      sym(
        "sib",
        "function",
        "internal/ui/feed_refresh.go::refreshFeedAndCount",
        "internal/ui/feed_refresh.go",
        40,
      ),
      sym("st-batch", "function", `${STORAGE}/batch.go::NewBatch`, `${STORAGE}/batch.go`, 12),
    );
    graph.edges.push({ from: "sib", to: "st-batch", kind: "calls", callee: "NewBatch" });
    const findCallers = vi.fn(async () => []);
    const withSibling = (found: boolean) =>
      buildSpecKitRagContext(
        "p1",
        SPEC,
        options({
          siblings: {
            lookup: {
              findInFiles: vi.fn(async () =>
                found
                  ? [
                      {
                        id: "sib",
                        name: "refreshFeedAndCount",
                        kind: "function",
                        filePath: "internal/ui/feed_refresh.go",
                        startLine: 40,
                        endLine: 49,
                      },
                    ]
                  : [],
              ),
            },
          },
          callers: { lookup: { findCallers } },
          localise: { source: fakeSource(graph) },
        }),
      );
    const r = await withSibling(true);
    expect(r.context).toContain("(beside refreshFeed)");
    expect(r.context).toContain(
      "- NewBatch (function) — internal/storage/batch.go:12-21 (called by refreshFeedAndCount)",
    );
    expect(r.files).toContain(`${STORAGE}/batch.go`);
    // The sibling is a callee whose callers are looked for, by id and by name.
    expect(findCallers.mock.calls[0]![1]).toContainEqual({
      id: "sib",
      name: "refreshFeedAndCount",
    });
    // The sibling's own file is the retrieved symbol's file: listed once.
    expect(r.files.filter((f) => f === "internal/ui/feed_refresh.go")).toHaveLength(1);
    // Without the sibling nothing reaches NewBatch.
    expect((await withSibling(false)).files).not.toContain(`${STORAGE}/batch.go`);
  });

  it("lists a source excerpt's file, and not an upload that carries a source file's name", async () => {
    // #547 — a source file is a `repo` row. An uploaded document can be named
    // like one, and is a document, not a file of the repository.
    const lookalike: RetrievedChunk = {
      ...sourceChunk,
      chunkId: "c3",
      documentId: "d3",
      filename: "connector:repo:r1:src/internal/notes/design.go",
      source: "upload",
    };
    const r = await buildSpecKitRagContext(
      "p1",
      SPEC,
      options({
        knowledgeService: { search: vi.fn(async () => ({ hits: [sourceChunk, lookalike] })) },
        localise: { tokenBudget: 0 },
      }),
    );
    expect(r.files).toContain("internal/cli/refresh_feeds.go");
    expect(r.files).not.toContain("internal/notes/design.go");
  });

  it("builds the context without the localisation when the walk runs out of time, and says so", async () => {
    const source = fakeSource(minifluxGraph());
    source.schema.getSchemaEdgesFrom = () => new Promise(() => undefined);
    const r = await buildSpecKitRagContext(
      "p1",
      SPEC,
      options({ localise: { source, timeBudgetMs: 25 } }),
    );
    expect(r.context).toContain("## Retrieved Code Symbols");
    expect(r.context).not.toContain("## Change Localisation");
    // The manifest still lists what similarity found.
    expect(r.context).toContain(FILE_MANIFEST_HEADER);
    expect(r.files).toEqual([
      "internal/cli/refresh_feeds.go",
      "internal/ui/feed_refresh.go",
      "internal/ui/feed_entries.go",
      "internal/ui/ui.go",
    ]);
    expect(r.dropped).toEqual([
      "Change localisation skipped: the code-graph walk did not finish within 25 ms, so this plan was given similarity retrieval alone",
    ]);
  });

  it("stops the walk when the caller's signal aborts", async () => {
    const controller = new AbortController();
    controller.abort();
    const source = fakeSource(minifluxGraph());
    const spy = vi.spyOn(source, "getFunctionsInFiles");
    const r = await buildSpecKitRagContext(
      "p1",
      SPEC,
      options({ localise: { source, signal: controller.signal } }),
    );
    expect(spy).not.toHaveBeenCalled();
    expect(r.context).not.toContain("## Change Localisation");
    expect(r.dropped).toEqual([
      "Change localisation skipped: the request was cancelled during the code-graph walk",
    ]);
  });

  it("counts the localisation's rows among the code symbols", async () => {
    const without = await buildSpecKitRagContext("p1", SPEC, options({ localise: undefined }));
    const withIt = await buildSpecKitRagContext("p1", SPEC, options());
    expect(without.usedSymbols).toBe(2);
    expect(withIt.usedSymbols).toBeGreaterThan(2);
  });

  it("is byte-identical without `localise`: no block, no manifest, but the file list", async () => {
    const r = await buildSpecKitRagContext("p1", SPEC, options({ localise: undefined }));
    expect(r.context).not.toContain("## Change Localisation");
    expect(r.context).not.toContain("## Files in the Retrieved Context");
    expect(r.files).toEqual([
      "internal/cli/refresh_feeds.go",
      "internal/ui/feed_refresh.go",
      "internal/ui/feed_entries.go",
      "internal/ui/ui.go",
    ]);
    expect(r.dropped).toEqual([]);
  });

  it("scans the spec for the entity, and passes the retrieved symbols with their kind", async () => {
    const source = fakeSource(minifluxGraph());
    const spy = vi.spyOn(source, "getFunctionsInFiles");
    await buildSpecKitRagContext("p1", SPEC, options({ localise: { source } }));
    // The file-level hit is expanded to its functions: its kind reached the walk.
    expect(spy).toHaveBeenCalledWith(["internal/ui/feed_entries.go"]);
  });

  it("reads its budget from SPEC_KIT_PLAN_LOCALISATION_TOKEN_BUDGET, and reports what it left out", async () => {
    expect(DEFAULT_LOCALISATION_TOKEN_BUDGET).toBe(2500);
    process.env.SPEC_KIT_PLAN_LOCALISATION_TOKEN_BUDGET = "330";
    __resetConfigSingleton();
    const r = await buildSpecKitRagContext("p1", SPEC, options());
    expect(r.dropped.length).toBeGreaterThan(0);
    expect(r.context).toContain("### Left out of this block");
    expect(r.files).not.toContain(`${STORAGE}/feed_query_builder.go`);
  });

  it("is turned off by a zero budget, keeping the manifest of what similarity found", async () => {
    const r = await buildSpecKitRagContext("p1", SPEC, options({ localise: { tokenBudget: 0 } }));
    expect(r.context).not.toContain("## Change Localisation");
    expect(r.context).toContain(FILE_MANIFEST_HEADER);
    expect(r.files).toHaveLength(4);
  });

  it("keeps the similarity context when the graph walk fails", async () => {
    const source = fakeSource(minifluxGraph());
    source.getFunctionsInFiles = vi.fn(async () => {
      throw new Error("database is locked");
    });
    const r = await buildSpecKitRagContext("p1", SPEC, options({ localise: { source } }));
    expect(r.context).toContain("## Retrieved Code Symbols");
    expect(r.context).not.toContain("## Change Localisation");
    expect(r.files).toContain("internal/ui/feed_refresh.go");
  });

  it("writes no manifest when the context names no repository file", async () => {
    const r = await buildSpecKitRagContext(
      "p1",
      SPEC,
      options({
        knowledgeService: { search: vi.fn(async () => ({ hits: [manual] })) },
        fusedCode: {
          searcher: { search: vi.fn(async () => []) },
          lineLookup: { resolve: vi.fn(async () => new Map()) },
        },
      }),
    );
    expect(r.usedChunks).toBe(1);
    expect(r.files).toEqual([]);
    expect(r.context).not.toContain("## Files in the Retrieved Context");
  });
});
