/**
 * #2431 — a Spec Kit artifact is read by the whole project, so its context
 * names no file a document access restriction covers: not as a caller, not in
 * the change localisation, and not in a "left out" sentence. #2314 already
 * filters the fused anchors; these are the walks that start from them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildSpecKitRagContext, type CallerEdgeRow } from "./rag-context.js";
import { buildPlanLocalisation, withoutHiddenFiles } from "./plan-localisation.js";
import { __resetConfigSingleton } from "../config/config-service.js";
import {
  codeAccessFilterOf,
  UNRESTRICTED_CODE_ACCESS,
  type CodeAccessFilter,
} from "../analysis/tools/code-access.js";
import {
  MIGRATIONS,
  STORAGE,
  fakeSource,
  minifluxGraph,
} from "../../../tests/helpers/plan-localisation-graph.js";
import type { SchemaImpactDataSource } from "../impact-analysis/schema-impact.js";

afterEach(() => __resetConfigSingleton());

const ENTRY = "internal/storage/entry.go";
const fusedCode = {
  searcher: {
    search: vi.fn(async () => [
      { symbolId: "s-mark", filePath: ENTRY, name: "MarkAllAsRead", kind: "function", score: 1 },
    ]),
  },
  lineLookup: {
    resolve: vi.fn(
      async () => new Map([["s-mark", { filePath: ENTRY, startLine: 506, endLine: 520 }]]),
    ),
  },
  hiddenSymbols: async () => new Set<string>(),
};
const noDocs = { search: vi.fn(async () => ({ hits: [] })) };
const edge = (filePath: string, repoConnectionId?: string | null): CallerEdgeRow => ({
  toSymbolId: "s-mark",
  toQualifiedName: null,
  filePath,
  line: 17,
  callerName: `caller_${filePath.replace(/\W/g, "_")}`,
  ...(repoConnectionId !== undefined ? { repoConnectionId } : {}),
});
const SECRET_CALLER = "internal/billing/secret.go";
const OPEN_CALLER = "internal/ui/unread_mark_all_read.go";

describe("#2431 — Spec Kit callers of retrieved symbols", () => {
  const build = (codeAccess: () => Promise<CodeAccessFilter>, rows: CallerEdgeRow[]) =>
    buildSpecKitRagContext("p1", "mark all as read", {
      knowledgeService: noDocs,
      fusedCode,
      includeCode: true,
      callers: { lookup: { findCallers: vi.fn(async () => rows) } },
      codeAccess,
    });

  it("neither lists nor names a call site in a restricted file", async () => {
    const res = await build(
      async () => codeAccessFilterOf([{ connectorId: "rc-1", path: SECRET_CALLER }]),
      [edge(SECRET_CALLER, "rc-1"), edge(OPEN_CALLER, "rc-1")],
    );
    expect(res.context).toContain(`at ${OPEN_CALLER}:17`);
    expect(res.context).not.toContain("secret.go");
    expect(res.files).not.toContain(SECRET_CALLER);
  });

  it("judges a call site on its own repository, and a legacy graph on every repository", async () => {
    const access = async () => codeAccessFilterOf([{ connectorId: "rc-1", path: SECRET_CALLER }]);
    const other = await build(access, [edge(SECRET_CALLER, "rc-2")]);
    expect(other.context).toContain(`at ${SECRET_CALLER}:17`);
    const legacy = await build(access, [edge(SECRET_CALLER, null)]);
    expect(legacy.context).not.toContain("secret.go");
  });

  it("lists it when nothing is restricted", async () => {
    const res = await build(async () => UNRESTRICTED_CODE_ACCESS, [edge(SECRET_CALLER, "rc-1")]);
    expect(res.context).toContain(`at ${SECRET_CALLER}:17`);
  });

  it("builds no context at all when the filter cannot be read", async () => {
    const res = await build(async () => {
      throw new Error("db down");
    }, [edge(OPEN_CALLER, "rc-1")]);
    expect(res.context).toBe("");
  });

  it("loads the filter once, and not at all when there is no caller to judge", async () => {
    const load = vi.fn(async () => UNRESTRICTED_CODE_ACCESS);
    await build(load, []);
    expect(load).not.toHaveBeenCalled();
    await buildSpecKitRagContext("p1", "mark all as read", {
      knowledgeService: noDocs,
      fusedCode,
      includeCode: true,
      callers: { lookup: { findCallers: vi.fn(async () => [edge(OPEN_CALLER)]) } },
      localise: { source: fakeSource(minifluxGraph()), timeBudgetMs: Number.POSITIVE_INFINITY },
      codeAccess: load,
    });
    expect(load).toHaveBeenCalledOnce();
  });
});

const SPEC =
  "Record, per feed, the time of the feed's most recent successful refresh, and expose it wherever the feed is returned.";
const SEEDS = [
  {
    id: "h-refresh",
    name: "refreshFeed",
    filePath: "internal/ui/feed_refresh.go",
    kind: "function",
  },
  {
    id: "m-entries",
    name: "feed_entries.go",
    filePath: "internal/ui/feed_entries.go",
    kind: "module",
  },
];
const localise = (hiddenFile?: (p: string) => boolean) =>
  buildPlanLocalisation({
    projectId: "p1",
    requirementText: SPEC,
    seeds: SEEDS,
    tokenBudget: 4000,
    source: fakeSource(minifluxGraph()),
    timeBudgetMs: Number.POSITIVE_INFINITY,
    twinTimeBudgetMs: Number.POSITIVE_INFINITY,
    ...(hiddenFile ? { hiddenFile } : {}),
  });

describe("#2431 — Spec Kit change localisation", () => {
  const FEED_STORE = `${STORAGE}/feed.go`;

  it("names the files it would name with nothing hidden (the baseline)", async () => {
    const r = await localise();
    expect(r.files).toEqual(expect.arrayContaining([MIGRATIONS, FEED_STORE]));
    expect(r.block).toContain(FEED_STORE);
  });

  it("never names a hidden file: not as a row, an excerpt or a left-out sentence", async () => {
    const hidden = new Set([MIGRATIONS, FEED_STORE]);
    const r = await localise((p) => hidden.has(p));
    for (const file of hidden) {
      expect(r.files).not.toContain(file);
      expect(r.block).not.toContain(file);
      expect(r.dropped.join("\n")).not.toContain(file);
    }
    // What is not hidden is still followed.
    expect(r.files).toContain("internal/model/feed.go");
  });

  it("does not walk from a seed in a hidden file", async () => {
    const r = await localise((p) => p.startsWith("internal/ui/"));
    expect(r).toEqual({ block: "", files: [], tables: [], dropped: [], usedSymbols: 0 });
  });
});

describe("#2431 — withoutHiddenFiles", () => {
  it("filters every located read and passes the rest through, on the source's own instance", async () => {
    class Schema {
      private readonly rows = [
        {
          id: "a",
          kind: "function",
          qualifiedName: "a",
          filePath: "hidden.go",
          startLine: 1,
          endLine: 2,
          language: "go",
        },
        {
          id: "b",
          kind: "function",
          qualifiedName: "b",
          filePath: "open.go",
          startLine: 1,
          endLine: 2,
          language: "go",
        },
      ];
      async getSchemaEdgesFrom() {
        return [{ fromSymbolId: "a", toSymbolId: "t", kind: "reads" }];
      }
      async getSchemaSymbolsByIds() {
        return [];
      }
      async getCodeSymbolDetails() {
        return this.rows;
      }
      async getDataModelSymbols() {
        return this.rows;
      }
    }
    const base = {
      schema: new Schema() as unknown as SchemaImpactDataSource,
      getReaderEdgesTo: vi.fn(async () => [{ fromSymbolId: "a", toSymbolId: "t" }]),
      getFunctionsInFiles: vi.fn(async () => new Schema()["rows"]),
      calleeNameSets: vi.fn(async () => ({ sets: new Map() })),
      getHttpHandlers: vi.fn(async () => new Schema()["rows"]),
    };
    const src = withoutHiddenFiles(base, (p) => p === "hidden.go");
    const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);
    expect(ids(await src.getFunctionsInFiles(["x"]))).toEqual(["b"]);
    expect(ids(await src.getHttpHandlers!(5))).toEqual(["b"]);
    expect(ids(await src.schema.getCodeSymbolDetails!(["a", "b"]))).toEqual(["b"]);
    expect(ids(await src.schema.getDataModelSymbols!(["t"]))).toEqual(["b"]);
    // Reads that carry no path pass through untouched.
    expect(await src.schema.getSchemaEdgesFrom(["a"])).toEqual([
      { fromSymbolId: "a", toSymbolId: "t", kind: "reads" },
    ]);
    expect(await src.getReaderEdgesTo(["t"])).toEqual([{ fromSymbolId: "a", toSymbolId: "t" }]);
    await src.calleeNameSets(["a"]);
    expect(base.calleeNameSets).toHaveBeenCalledWith(["a"], undefined);
    // An optional read the source lacks stays absent.
    expect(
      withoutHiddenFiles({ ...base, getHttpHandlers: undefined }, () => false).getHttpHandlers,
    ).toBeUndefined();
  });
});
