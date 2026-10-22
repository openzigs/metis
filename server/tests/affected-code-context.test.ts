/**
 * Unit tests for the deterministic requirement→code mapping (#735, Epic #726).
 *
 * Pure render/truncation is tested in isolation; `computeAffectedCodeContext`
 * is driven with an injected mapper + in-memory graph so no DB/LLM is needed.
 */
import { describe, expect, it, vi } from "vitest";
import type { AffectedCodeCandidate } from "@metis/shared";
import {
  computeAffectedCodeContext,
  relativeToBestSeed,
  shownKeywordRuleCauses,
  renderAffectedCodeBlock,
  estimateAffectedCodeTokens,
  EMPTY_AFFECTED_CODE_CONTEXT,
} from "../src/lib/analysis/affected-code-context.js";
import {
  Bm25CodeSymbolSearcher,
  MemoizingBm25CodeSymbolSearcher,
  mapRequirementToCode,
  type RequirementCodeMatch,
} from "../src/lib/traceability/requirement-code-mapping.js";
import { HybridCodeSymbolSearcher } from "../src/lib/traceability/requirement-code-searcher.js";
import { InMemoryCodeGraphDataSource } from "../src/lib/impact-analysis/impact-analysis-engine.js";
import type { CodeGraphDataSource } from "../src/lib/code-graph/query-service.js";

/** An empty code graph → no blast radius (mapper direct hits only). */
const emptyGraph = new InMemoryCodeGraphDataSource([], []);
const emptyGraphFor = (): CodeGraphDataSource => emptyGraph;

const candidate = (id: string, symbolCount: number): AffectedCodeCandidate => ({
  id,
  title: `requirement ${id}`,
  body: `body ${id}`,
  symbols: Array.from({ length: symbolCount }, (_, i) => ({
    filePath: `server/src/mod-${id}-${i}.ts`,
    qualifiedName: `Mod${id}.member${i}`,
    startLine: i + 1,
    endLine: i + 10,
    relation: i === 0 ? ("direct" as const) : ("caller" as const),
    depth: i === 0 ? 0 : 1,
    confidence: 0.9 - i * 0.1,
  })),
});

describe("renderAffectedCodeBlock", () => {
  it("returns an empty block for no candidates", () => {
    expect(renderAffectedCodeBlock([], 1000)).toEqual({ block: "", tokens: 0, truncated: false });
  });

  it("renders each symbol as a locator line and reports its token cost", () => {
    const { block, tokens, truncated } = renderAffectedCodeBlock([candidate("NR-1", 2)], 100000);
    expect(truncated).toBe(false);
    expect(block).toContain("[NR-1] requirement NR-1");
    expect(block).toContain("ModNR-1.member0"); // qualifiedName present
    expect(block).toContain("server/src/mod-NR-1-0.ts:1");
    expect(block).toContain("(direct, conf 0.90)");
    expect(block).toContain("(caller, conf 0.80)");
    expect(tokens).toBe(estimateAffectedCodeTokens(block));
  });

  it("shows a per-candidate empty state when a candidate matched no code", () => {
    const { block } = renderAffectedCodeBlock([candidate("NR-1", 1), candidate("NR-2", 0)], 100000);
    expect(block).toContain("[NR-2] requirement NR-2");
    expect(block).toContain("(no code matched — see coverage indicator)");
  });

  it("truncates deterministically at the token-budget boundary", () => {
    const cands = [candidate("NR-1", 4), candidate("NR-2", 4)];
    const full = renderAffectedCodeBlock(cands, 100000);
    expect(full.truncated).toBe(false);

    // Exactly at the full cost → identical, not truncated (inclusive boundary).
    expect(renderAffectedCodeBlock(cands, full.tokens)).toEqual(full);

    // One token below the full cost → must truncate, stay within budget, and be
    // byte-identical across repeated calls (determinism).
    const tight = renderAffectedCodeBlock(cands, full.tokens - 1);
    expect(tight.truncated).toBe(true);
    expect(tight.tokens).toBeLessThanOrEqual(full.tokens - 1);
    expect(tight.block.length).toBeLessThan(full.block.length);
    expect(renderAffectedCodeBlock(cands, full.tokens - 1)).toEqual(tight);
  });

  it("emits an empty block when not even the first line fits", () => {
    const { block, truncated } = renderAffectedCodeBlock([candidate("NR-1", 1)], 1);
    expect(block).toBe("");
    expect(truncated).toBe(true);
  });
});

describe("computeAffectedCodeContext", () => {
  const oneMatch: RequirementCodeMatch[] = [
    {
      codeSymbolId: "sym-1",
      filePath: "server/src/billing/invoice.ts",
      qualifiedName: "InvoiceService.charge",
      startLine: 20,
      endLine: 40,
      confidence: 0.92,
    },
  ];

  it("maps each parsed candidate to code and renders a fenced-ready block", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.\n\nAdd a refund endpoint.",
      enabled: true,
      tokenBudget: 100000,
      deps: { mapRequirement: async () => oneMatch, dataSourceFor: emptyGraphFor },
    });
    expect(ctx.result.candidates).toHaveLength(2);
    expect(ctx.result.candidates[0].id).toBe("NR-1");
    expect(ctx.result.candidates[0].symbols[0]).toMatchObject({
      qualifiedName: "InvoiceService.charge",
      relation: "direct",
      depth: 0,
    });
    expect(ctx.block).toContain("InvoiceService.charge");
    expect(ctx.block).toContain("server/src/billing/invoice.ts:20");
    expect(ctx.filePaths).toContain("server/src/billing/invoice.ts");
    expect(ctx.tokens).toBeGreaterThan(0);
  });

  it("is deterministic — identical inputs yield byte-identical output across runs", async () => {
    const opts = {
      projectId: "proj-1",
      extraInstructions: "Requirement A about billing.\n\nRequirement B about auth.",
      enabled: true,
      tokenBudget: 100000,
      deps: { mapRequirement: async () => oneMatch, dataSourceFor: emptyGraphFor },
    } as const;
    const a = await computeAffectedCodeContext(opts);
    const b = await computeAffectedCodeContext(opts);
    expect(a).toEqual(b);
  });

  it("degrades cleanly to a no-op when no code matched (no code graph)", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.\n\nAdd a refund endpoint.",
      enabled: true,
      tokenBudget: 100000,
      // No code graph ⇒ mapper returns nothing for every candidate.
      deps: { mapRequirement: async () => [], dataSourceFor: emptyGraphFor },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
    expect(ctx.block).toBe("");
  });

  it("no-ops (no throw) when extraInstructions is empty", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "   ",
      enabled: true,
      deps: { mapRequirement: async () => oneMatch, dataSourceFor: emptyGraphFor },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
  });

  it("no-ops when the feature flag is disabled", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "Add a monthly invoice charge.",
      enabled: false,
      deps: { mapRequirement: async () => oneMatch, dataSourceFor: emptyGraphFor },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
  });

  it("keeps the run alive when the mapper throws for a candidate", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-1",
      extraInstructions: "First requirement.\n\nSecond requirement.",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        // First candidate maps; second throws — the second is still surfaced
        // (with no symbols) and the whole computation does not reject.
        mapRequirement: async (req) =>
          req.title.startsWith("First") ? oneMatch : Promise.reject(new Error("boom")),
        dataSourceFor: emptyGraphFor,
      },
    });
    expect(ctx.result.candidates).toHaveLength(2);
    expect(ctx.result.candidates[0].symbols.length).toBeGreaterThan(0);
    expect(ctx.result.candidates[1].symbols).toEqual([]);
  });
});

/**
 * Issue #1063 — with the DEFAULT mapper (no injected `mapRequirement`) the
 * context serves two readers. A PERSON is shown a link only when the symbol's
 * name shares two of the requirement's terms, and "the project has code and
 * none of it matched" is reported as such. The CODE AGENT is seeded exactly as
 * before #1063 (PR #1095 review: the rule must not narrow its seeds).
 */
describe("computeAffectedCodeContext — default mapper (#1063)", () => {
  const symbols = [
    ["InlineKeyboardButton", "internal/integration/telegrambot/client.go"],
    ["restoreButtonState", "internal/ui/static/js/app.js"],
    ["flushSessions", "internal/cli/flush_sessions.go"],
    ["showSessionsPage", "internal/ui/session_list.go"],
    ["CleanOldWebSessions", "internal/storage/web_session.go"],
    ["WebSessionsByUserID", "internal/storage/web_session.go"],
    ["ForceRefreshInterval", "internal/config/options.go"],
    ["markAllAsRead", "internal/ui/unread_mark_all_read.go"],
    ["markFeedAsRead", "internal/ui/feed_mark_as_read.go"],
  ].map(([name, filePath], i) => ({
    id: `sym-${i}`,
    name,
    qualifiedName: `${filePath}::${name}`,
    kind: "function",
    filePath,
    startLine: 10 + i,
    endLine: 20 + i,
  }));

  const prismaWith = (rows: typeof symbols) => {
    const findMany = vi.fn(async (args: { where?: { projectId?: string } }) =>
      args?.where?.projectId === "proj-miniflux" ? rows : [],
    );
    return { prisma: { codeSymbol: { findMany } } as never, findMany };
  };

  const run = (extraInstructions: string, rows = symbols, tokenBudget = 100000) =>
    computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions,
      enabled: true,
      tokenBudget,
      deps: { prisma: prismaWith(rows).prisma, dataSourceFor: emptyGraphFor },
    });

  /**
   * The context as it was BEFORE #1063: one mapper, no shared-terms rule. Its
   * BM25 searcher reports no absolute confidence, as before #1097, so the
   * mapper normalizes to the best hit (#1330: since #1097 the BM25 searcher
   * reports one, and this reference had silently moved onto that scale).
   */
  const runAsBefore1063 = (extraInstructions: string, tokenBudget = 100000) => {
    const { prisma } = prismaWith(symbols);
    const bm25 = new Bm25CodeSymbolSearcher(prisma);
    const searcher = {
      search: async (q: string, p: string, o?: { limit?: number }) =>
        (await bm25.search(q, p, o)).map((c) => ({ ...c, confidence: undefined })),
    };
    return computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions,
      enabled: true,
      tokenBudget,
      deps: {
        prisma,
        dataSourceFor: emptyGraphFor,
        mapRequirement: (req, projectId) =>
          mapRequirementToCode(req, projectId, {}, { prisma, searcher }),
      },
    });
  };

  const THREE =
    "- Mark all as read older than X\n- Add a button to terminate all sessions\n- Ability to force IPv4 or IPv6 per feed";
  const TWO_UNLINKED =
    "- Add a button to terminate all sessions\n- Ability to force IPv4 or IPv6 per feed";
  const short = (q: string) => q.split("::")[1];

  it("SHOWS the requirement that shares two terms and leaves the others unlinked", async () => {
    const ctx = await run(THREE);
    const [mark, terminate, ipv] = ctx.result.candidates;
    expect(mark!.symbols.map((s) => short(s.qualifiedName))).toEqual(
      expect.arrayContaining(["markAllAsRead", "markFeedAsRead"]),
    );
    // The two links reported in #706 run 7 are gone, and nothing replaces them.
    expect(terminate!.symbols).toEqual([]);
    expect(ipv!.symbols).toEqual([]);
    const shown = ctx.result.candidates.flatMap((c) => c.symbols.map((s) => s.qualifiedName));
    expect(shown.join(" ")).not.toContain("InlineKeyboardButton");
    expect(shown.join(" ")).not.toContain("ForceRefreshInterval");
  });

  it("SEEDS the code agent exactly as before #1063: block, token cost and file list", async () => {
    const [now, before] = await Promise.all([run(THREE), runAsBefore1063(THREE)]);
    expect(before.block).toContain("flushSessions");
    // #1330 — a FROZEN golden, not only today's code path: the confidences are
    // each BM25 score over the requirement's best, with the 0.3 floor, as the
    // seed block read before #1097 and #1063.
    expect(now.block).toBe(
      [
        "[NR-1] Mark all as read older than X",
        "  - internal/ui/unread_mark_all_read.go::markAllAsRead (direct, conf 1.00) — internal/ui/unread_mark_all_read.go:17",
        "  - internal/ui/feed_mark_as_read.go::markFeedAsRead (direct, conf 1.00) — internal/ui/feed_mark_as_read.go:18",
        "[NR-2] Add a button to terminate all sessions",
        "  - internal/integration/telegrambot/client.go::InlineKeyboardButton (direct, conf 1.00) — internal/integration/telegrambot/client.go:10",
        "  - internal/ui/static/js/app.js::restoreButtonState (direct, conf 0.98) — internal/ui/static/js/app.js:11",
        "  - internal/cli/flush_sessions.go::flushSessions (direct, conf 0.66) — internal/cli/flush_sessions.go:12",
        "  - internal/ui/session_list.go::showSessionsPage (direct, conf 0.56) — internal/ui/session_list.go:13",
        "  - internal/storage/web_session.go::CleanOldWebSessions (direct, conf 0.54) — internal/storage/web_session.go:14",
        "  - internal/storage/web_session.go::WebSessionsByUserID (direct, conf 0.52) — internal/storage/web_session.go:15",
        "[NR-3] Ability to force IPv4 or IPv6 per feed",
        "  - internal/ui/feed_mark_as_read.go::markFeedAsRead (direct, conf 1.00) — internal/ui/feed_mark_as_read.go:18",
        "  - internal/config/options.go::ForceRefreshInterval (direct, conf 0.98) — internal/config/options.go:16",
      ].join("\n"),
    );
    expect(now.block).toBe(before.block);
    expect(now.tokens).toBe(before.tokens);
    expect(now.filePaths).toEqual(before.filePaths);
    // …while what is shown is narrower than what is seeded.
    expect(now.result).not.toEqual(before.result);
  });

  it("still seeds the session symbols for a requirement the page shows as unlinked", async () => {
    const ctx = await run(THREE);
    expect(ctx.result.candidates[1]!.symbols).toEqual([]);
    const section = ctx.block.slice(ctx.block.indexOf("[NR-2]"), ctx.block.indexOf("[NR-3]"));
    // The symbols PR #1095 itself labelled right for this requirement.
    expect(section).toContain("internal/cli/flush_sessions.go::flushSessions");
    expect(section).toContain("CleanOldWebSessions");
    expect(section).not.toContain("(no code matched");
    expect(ctx.filePaths).toEqual(
      expect.arrayContaining(["internal/cli/flush_sessions.go", "internal/storage/web_session.go"]),
    );
    expect(ctx.tokens).toBe(estimateAffectedCodeTokens(ctx.block));
  });

  it("reports every requirement as unlinked, and still seeds, when no name shares two terms", async () => {
    const [ctx, before] = await Promise.all([run(TWO_UNLINKED), runAsBefore1063(TWO_UNLINKED)]);
    expect(ctx.result.candidates.map((c) => [c.id, c.symbols.length])).toEqual([
      ["NR-1", 0],
      ["NR-2", 0],
    ]);
    expect(ctx.result.truncated).toBe(false);
    expect(before.block.length).toBeGreaterThan(0);
    expect(ctx.block).toBe(before.block);
    expect(ctx.filePaths).toEqual(before.filePaths);
  });

  it("says so, and seeds nothing, when the project has code and no symbol shares any term", async () => {
    const ctx = await run("- Zebra quux\n- Lorem ipsum dolor");
    expect(ctx.result.candidates.map((c) => [c.id, c.symbols.length])).toEqual([
      ["NR-1", 0],
      ["NR-2", 0],
    ]);
    // Nothing to seed the code agent with: its prompt is unchanged.
    expect(ctx.block).toBe("");
    expect(ctx.tokens).toBe(0);
    expect(ctx.filePaths).toEqual([]);
    expect(ctx.result.truncated).toBe(false);
  });

  it("reports truncation of the SEED block, which is what the prompt carries", async () => {
    const full = await run(THREE);
    expect(full.result.truncated).toBe(false);
    const tight = await run(THREE, symbols, full.tokens - 1);
    expect(tight.result.truncated).toBe(true);
    expect(tight.block.length).toBeLessThan(full.block.length);
    // The shown links are complete either way.
    expect(tight.result.candidates).toEqual(full.result.candidates);
  });

  it("loads the code symbols once for both readings", async () => {
    const { prisma, findMany } = prismaWith(symbols);
    await computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions: THREE,
      enabled: true,
      deps: { prisma, dataSourceFor: emptyGraphFor },
    });
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("with an injected mapper there is one list: shown and seeded are the same", async () => {
    const ctx = await runAsBefore1063(TWO_UNLINKED);
    const shown = ctx.result.candidates.flatMap((c) => c.symbols.map((s) => s.qualifiedName));
    expect(shown.length).toBeGreaterThan(0);
    for (const q of shown) expect(ctx.block).toContain(q);
    expect(ctx.filePaths).toEqual([
      ...new Set(ctx.result.candidates.flatMap((c) => c.symbols.map((s) => s.filePath))),
    ]);
  });

  it("stays a no-op when the project has no code graph at all", async () => {
    const ctx = await run("- Add a button to terminate all sessions", []);
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
  });

  it("stays a no-op when the code graph cannot be read", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions: "- Add a button to terminate all sessions",
      enabled: true,
      deps: {
        prisma: {
          codeSymbol: {
            findMany: async () => {
              throw new Error("database is locked");
            },
          },
        } as never,
        dataSourceFor: emptyGraphFor,
      },
    });
    expect(ctx).toEqual(EMPTY_AFFECTED_CODE_CONTEXT);
  });
});

/**
 * Issue #1063, reopened after #706 run 9 — the links a person is shown leave
 * test code out at EVERY depth. A test that calls a linked handler reaches the
 * blast radius as its caller, so dropping tests from the mapper's hits alone
 * brought `TestRefreshFeedEndpoint` back as a "caller" (measured on run 9's
 * stored graph). The code agent's seeds keep it, as before.
 */
describe("computeAffectedCodeContext — test code in the links (#1063, run 9)", () => {
  const HANDLER = "internal/api/feed_handlers.go";
  const TEST = "internal/api/api_integration_test.go";
  const ROUTER = "internal/api/api.go";
  const symbols = [
    { id: "h", name: "refreshFeedHandler", filePath: HANDLER, owner: "handler" },
    { id: "t", name: "TestRefreshFeedEndpoint", filePath: TEST, owner: null },
    { id: "u", name: "refreshFeed", filePath: "internal/ui/feed_refresh.go", owner: "handler" },
    { id: "r", name: "serve", filePath: ROUTER, owner: null },
  ].map((s, i) => ({
    id: s.id,
    name: s.name,
    qualifiedName: s.owner ? `${s.filePath}::${s.owner}::${s.name}` : `${s.filePath}::${s.name}`,
    kind: "function",
    filePath: s.filePath,
    startLine: 10 + i,
    endLine: 20 + i,
  }));
  const graph = new InMemoryCodeGraphDataSource(
    symbols.map((s) => ({
      id: s.id,
      qualifiedName: s.qualifiedName,
      kind: s.kind,
      filePath: s.filePath,
      language: "go",
      startLine: s.startLine,
      endLine: s.endLine,
    })),
    [
      // The integration test and the router both call the API handler.
      { id: "e1", fromSymbolId: "t", toSymbolId: "h", kind: "calls" },
      { id: "e2", fromSymbolId: "r", toSymbolId: "h", kind: "calls" },
    ],
  );
  const prisma = { codeSymbol: { findMany: async () => symbols } } as never;

  const run = () =>
    computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions: "- Last Successful refresh in feed API",
      enabled: true,
      tokenBudget: 100000,
      deps: { prisma, dataSourceFor: () => graph },
    });

  it("shows no test, neither as a hit nor as a caller, and keeps the non-test caller", async () => {
    const ctx = await run();
    const shown = ctx.result.candidates[0]!.symbols;
    expect(shown.map((s) => s.filePath)).not.toContain(TEST);
    expect(shown).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: HANDLER, relation: "direct" }),
        expect.objectContaining({ filePath: ROUTER, relation: "caller" }),
      ]),
    );
  });

  it("still seeds the code agent with the test", async () => {
    const ctx = await run();
    expect(ctx.block).toContain("TestRefreshFeedEndpoint");
    expect(ctx.filePaths).toContain(TEST);
  });
});

describe("computeAffectedCodeContext — hybrid ranking and its record (#1097)", () => {
  const rows = [
    ["flush", "FlushAllSessions", "internal/storage/web_session.go"],
    ["remove", "removeSession", "internal/ui/session_remove.go"],
    ["button", "InlineKeyboardButton", "internal/integration/telegrambot/client.go"],
    ["caller", "handleSessions", "internal/ui/routes.go"],
  ].map(([id, name, filePath], i) => ({
    id: id!,
    name: name!,
    qualifiedName: `${filePath}::${name}`,
    kind: "function",
    filePath: filePath!,
    startLine: 10 + i,
    endLine: 20 + i,
  }));
  const prisma = { codeSymbol: { findMany: async () => rows } } as never;
  const graph = new InMemoryCodeGraphDataSource(
    rows.map((r) => ({ ...r, language: "go" })),
    [{ id: "e", fromSymbolId: "caller", toSymbolId: "flush", kind: "calls" }],
  );

  /** A hybrid ranker answering with fixed cosines, or with nothing (not embedded). */
  const searcherWith = (hits: Array<[string, number]> | null) =>
    new HybridCodeSymbolSearcher({
      bm25: new MemoizingBm25CodeSymbolSearcher(prisma),
      hybrid: {
        async search(_q, _p, opts) {
          opts?.onRetrievalMode?.(hits ? "hybrid" : "bm25-only");
          return (hits ?? []).map(([symbolId, cosine], i) => ({
            symbolId,
            filePath: "",
            name: symbolId,
            kind: "function",
            score: 1 / (61 + i),
            vectorScore: cosine,
          }));
        },
      },
      semanticModel: () => "Alibaba-NLP/gte-modernbert-base",
    });

  const run = (searcher: HybridCodeSymbolSearcher) =>
    computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions: "- Add a button to terminate all sessions",
      enabled: true,
      tokenBudget: 100000,
      deps: { prisma, dataSourceFor: () => graph, searcher },
    });

  it("records `hybrid`, and SHOWS a one-word link the embeddings rank close (no two-term rule)", async () => {
    const ctx = await run(
      searcherWith([
        ["flush", 0.667],
        ["remove", 0.649],
        ["button", 0.45],
      ]),
    );
    expect(ctx.result.retrievalMode).toBe("hybrid");
    const shown = ctx.result.candidates[0]!.symbols;
    expect(shown.map((s) => s.qualifiedName)).toEqual(
      expect.arrayContaining([
        "internal/storage/web_session.go::FlushAllSessions",
        "internal/ui/session_remove.go::removeSession",
      ]),
    );
    // The far one-word button is under the floor: not shown.
    expect(shown.map((s) => s.qualifiedName)).not.toContain(
      "internal/integration/telegrambot/client.go::InlineKeyboardButton",
    );
  });

  it("reports absolute confidences: a caller is never surer than its best seed, and nothing reads 1.0", async () => {
    const ctx = await run(searcherWith([["flush", 0.667]]));
    const [flush, caller] = ["FlushAllSessions", "handleSessions"].map((n) =>
      ctx.result.candidates[0]!.symbols.find((s) => s.qualifiedName.endsWith(n)),
    );
    expect(flush!.confidence).toBeLessThan(0.5);
    expect(caller!.relation).toBe("caller");
    expect(caller!.confidence).toBeLessThanOrEqual(flush!.confidence);
    // The code agent's block keeps the scale it always had (best seed = 1.00):
    // no model run measured feeding it the absolute scale (review of PR #1325).
    expect(ctx.block).toContain("FlushAllSessions (direct, conf 1.00)");
    expect(ctx.block).not.toContain(`conf ${flush!.confidence.toFixed(2)}`);
    expect(ctx.result.candidates[0]!.retrievalMode).toBe("hybrid");
  });

  it("records a run whose requirements were answered differently as `mixed`, each with its own mode", async () => {
    // The vector channel answers the first requirement and has nothing for the second.
    const searcher = new HybridCodeSymbolSearcher({
      bm25: new MemoizingBm25CodeSymbolSearcher(prisma),
      hybrid: {
        async search(q, _p, opts) {
          const answered = q.includes("terminate");
          opts?.onRetrievalMode?.(answered ? "hybrid" : "bm25-only");
          return answered
            ? [
                {
                  symbolId: "flush",
                  filePath: "",
                  name: "flush",
                  kind: "function",
                  score: 1,
                  vectorScore: 0.7,
                },
              ]
            : [];
        },
      },
      semanticModel: () => "Alibaba-NLP/gte-modernbert-base",
    });
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions:
        "- Add a button to terminate all sessions\n- Remove a session from the list",
      enabled: true,
      tokenBudget: 100000,
      deps: { prisma, dataSourceFor: () => graph, searcher },
    });
    expect(ctx.result.retrievalMode).toBe("mixed");
    expect(ctx.result.candidates.map((c) => c.retrievalMode)).toEqual(["hybrid", "bm25-only"]);
  });

  it("relativeToBestSeed: the best reads 1.00, the rest keep their ratio, an empty or zero list is unchanged", () => {
    const c = {
      id: "NR-1",
      title: "t",
      body: "t",
      symbols: [0.2, 0.1].map((confidence, i) => ({
        filePath: `f${i}.go`,
        qualifiedName: `f${i}`,
        startLine: 1,
        endLine: 2,
        relation: "direct" as const,
        depth: 0,
        confidence,
      })),
    };
    expect(relativeToBestSeed(c).symbols.map((s) => s.confidence)).toEqual([1, 0.5]);
    const zero = { ...c, symbols: c.symbols.map((s) => ({ ...s, confidence: 0 })) };
    expect(relativeToBestSeed(zero)).toBe(zero);
  });

  it("records `bm25-only` when the vector channel had nothing, and keeps the keyword link rules", async () => {
    const ctx = await run(searcherWith(null));
    expect(ctx.result.retrievalMode).toBe("bm25-only");
    // Every name shares one word at most: the two-term rule leaves the requirement unlinked.
    expect(ctx.result.candidates[0]!.symbols).toEqual([]);
    expect(ctx.block).toContain("FlushAllSessions"); // the agent is still seeded
    expect(ctx.result.candidates[0]!.linkRule).toBe("shared-terms");
  });

  it("records which rule decided each requirement's links: the floor, or two shared terms (#1330)", async () => {
    const hybrid = await run(searcherWith([["flush", 0.667]]));
    expect(hybrid.result.candidates[0]).toMatchObject({
      retrievalMode: "hybrid",
      linkRule: "confidence",
    });
    expect(hybrid.result.candidates[0]).not.toHaveProperty("keywordRuleCause");
    expect(hybrid.result.candidates[0]).not.toHaveProperty("keywordRuleCauses");
    // #1417 — each shown direct link names its own rule; a caller names none.
    const [flush, caller] = hybrid.result.candidates[0]!.symbols;
    expect(flush).toMatchObject({ relation: "direct", linkRule: "confidence" });
    expect(caller).toMatchObject({ relation: "caller" });
    expect(caller).not.toHaveProperty("linkRule");
    // Ranked by an embedding model the confidence is not calibrated for: the
    // two-term rule decided, though the ranking reads hybrid, and the run says why.
    const uncalibrated = new HybridCodeSymbolSearcher({
      bm25: new MemoizingBm25CodeSymbolSearcher(prisma),
      hybrid: {
        async search(_q, _p, opts) {
          opts?.onRetrievalMode?.("hybrid");
          return [
            {
              symbolId: "flush",
              filePath: "",
              name: "f",
              kind: "function",
              score: 2,
              vectorScore: 0.7,
            },
          ];
        },
      },
      semanticModel: () => "BAAI/bge-small-en-v1.5",
    });
    const gated = await run(uncalibrated);
    expect(gated.result.retrievalMode).toBe("hybrid");
    expect(gated.result.candidates[0]).toMatchObject({
      retrievalMode: "hybrid",
      linkRule: "shared-terms",
      // #1417 — the model decided the whole requirement, links or none.
      keywordRuleCauses: ["uncalibrated-model"],
    });
    expect(gated.result.candidates[0]).not.toHaveProperty("keywordRuleCause");
  });

  // #1417 — the causes are those of the links SHOWN, and a mixed answer has more than one.
  describe("records the causes behind the SHOWN keyword-rule links (#1417)", () => {
    const withSchema = [
      ...rows,
      {
        id: "table",
        name: "web_sessions",
        qualifiedName: "web_sessions",
        kind: "table",
        filePath: "schema.sql",
        startLine: null,
        endLine: null,
      },
      {
        id: "restore",
        name: "restoreButtonState",
        qualifiedName: "internal/ui/static/js/app.js::restoreButtonState",
        kind: "function",
        filePath: "internal/ui/static/js/app.js",
        startLine: 5,
        endLine: 9,
      },
    ];
    const schemaPrisma = { codeSymbol: { findMany: async () => withSchema } } as never;
    const schemaGraph = new InMemoryCodeGraphDataSource(
      withSchema.map((r) => ({ ...r, language: "go" })) as never,
      [],
    );
    const searcherOver = (hits: Array<[string, number | null]>, tags: Record<string, string>) =>
      new HybridCodeSymbolSearcher({
        bm25: new MemoizingBm25CodeSymbolSearcher(schemaPrisma),
        hybrid: {
          async search(_q, _p, opts) {
            opts?.onRetrievalMode?.("hybrid");
            return hits.map(([symbolId, cosine], i) => ({
              symbolId,
              filePath: "",
              name: symbolId,
              kind: "function",
              score: 1 / (61 + i),
              ...(cosine === null ? {} : { vectorScore: cosine }),
            }));
          },
        },
        semanticModel: () => "Alibaba-NLP/gte-modernbert-base",
        embeddingModels: async (_p, ids) =>
          new Map(ids.filter((id) => id in tags).map((id) => [id, tags[id]!])),
      });
    const runOver = (searcher: HybridCodeSymbolSearcher, maxSymbolsPerCandidate = 8) =>
      computeAffectedCodeContext({
        projectId: "proj-miniflux",
        extraInstructions: "- Flush web sessions and restore the button state",
        enabled: true,
        tokenBudget: 100000,
        maxSymbolsPerCandidate,
        deps: { prisma: schemaPrisma, dataSourceFor: () => schemaGraph, searcher },
      });

    it("a table and code still being embedded: both causes, and each link names its rule", async () => {
      const ctx = await runOver(
        searcherOver(
          [
            ["flush", 0.7],
            ["table", null],
            ["restore", null],
          ],
          { flush: "Alibaba-NLP/gte-modernbert-base", restore: "" },
        ),
      );
      const [candidate] = ctx.result.candidates;
      expect(candidate).toMatchObject({
        linkRule: "confidence",
        keywordRuleCauses: ["schema-not-embedded", "embedding-pending"],
      });
      const rule = new Map(candidate!.symbols.map((s) => [s.qualifiedName, s.linkRule]));
      expect(rule.get("internal/storage/web_session.go::FlushAllSessions")).toBe("confidence");
      expect(rule.get("web_sessions")).toBe("shared-terms");
      expect(rule.get("internal/ui/static/js/app.js::restoreButtonState")).toBe("shared-terms");
    });

    it("records no cause for a keyword-ruled hit that is not shown", async () => {
      // `flush` shares two words at cosine 0.95, so it outranks the 0.273
      // keyword-ruled table; with one link shown, the table is cut.
      const ctx = await runOver(
        searcherOver(
          [
            ["flush", 0.95],
            ["table", null],
          ],
          { flush: "Alibaba-NLP/gte-modernbert-base" },
        ),
        1,
      );
      const [candidate] = ctx.result.candidates;
      expect(candidate!.symbols.map((s) => s.qualifiedName)).toEqual([
        "internal/storage/web_session.go::FlushAllSessions",
      ]);
      expect(candidate).not.toHaveProperty("keywordRuleCauses");
    });
  });

  it("shownKeywordRuleCauses: unique, in a fixed order, the model's cause kept with no link", () => {
    expect(
      shownKeywordRuleCauses(undefined, ["no-vector", "schema-not-embedded", "no-vector"]),
    ).toEqual(["schema-not-embedded", "no-vector"]);
    expect(shownKeywordRuleCauses("uncalibrated-model", [])).toEqual(["uncalibrated-model"]);
    // A cause the answer reports for anything else is not a shown link's.
    expect(shownKeywordRuleCauses("schema-not-embedded", [])).toEqual([]);
  });

  // #1330 — the pre-#1097 floor: a seed under 0.3 of the best BM25 hit is not
  // given to the agent. The oracle is the BM25 index's own scores, not the
  // mapper's normalization, so a change to either the ratio or the floor fails.
  it("drops a keyword-fallback seed under 0.3 of the best BM25 score, and keeps one above it", async () => {
    const weak = {
      id: "weak",
      name: "renderSessionsWidgetToolbarHeaderFooterPanelLayoutGridColumnRowCell",
      qualifiedName:
        "internal/ui/static/js/legacy/widgets/layout/grid/toolbar/header/footer/panel.js::renderSessionsWidgetToolbarHeaderFooterPanelLayoutGridColumnRowCell",
      kind: "function",
      filePath: "internal/ui/static/js/legacy/widgets/layout/grid/toolbar/header/footer/panel.js",
      startLine: 30,
      endLine: 40,
    };
    const withWeak = { codeSymbol: { findMany: async () => [...rows, weak] } } as never;
    const text = "Add a button to terminate all sessions";
    const raw = await new Bm25CodeSymbolSearcher(withWeak).search(`${text}\n\n${text}`, "p", {
      limit: 20,
    });
    const max = Math.max(...raw.map((c) => c.score));
    const ratio = new Map(raw.map((c) => [c.name, c.score / max]));
    // Precondition: the long-named symbol matches, but under the floor.
    expect(ratio.get(weak.name)).toBeGreaterThan(0.05);
    expect(ratio.get(weak.name)).toBeLessThan(0.3);
    expect(ratio.get("FlushAllSessions")).toBeGreaterThanOrEqual(0.3);
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions: `- ${text}`,
      enabled: true,
      tokenBudget: 100000,
      deps: {
        prisma: withWeak,
        dataSourceFor: emptyGraphFor,
        searcher: new HybridCodeSymbolSearcher({
          bm25: new MemoizingBm25CodeSymbolSearcher(withWeak),
          hybrid: { search: async () => [] },
          semanticModel: () => null,
        }),
      },
    });
    expect(ctx.block).toBe(
      [
        "[NR-1] Add a button to terminate all sessions",
        "  - internal/integration/telegrambot/client.go::InlineKeyboardButton (direct, conf 1.00) — internal/integration/telegrambot/client.go:12",
        "  - internal/ui/routes.go::handleSessions (direct, conf 0.41) — internal/ui/routes.go:13",
        "  - internal/storage/web_session.go::FlushAllSessions (direct, conf 0.38) — internal/storage/web_session.go:10",
      ].join("\n"),
    );
    expect(ctx.block).not.toContain(weak.name);
  });

  // #1330 — on a keyword-fallback answer the agent's seeds are what they were
  // before #1097. The reference is the pre-#1097 mapper: a BM25 searcher that
  // reports no absolute confidence, so the mapper normalizes to the best hit.
  it("seeds the code agent on a keyword-fallback run exactly as before #1097 (relative BM25 values)", async () => {
    const ctx = await run(searcherWith(null));
    const bm25 = new Bm25CodeSymbolSearcher(prisma);
    const before = await computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions: "- Add a button to terminate all sessions",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        prisma,
        dataSourceFor: () => graph,
        mapRequirement: (req, projectId) =>
          mapRequirementToCode(
            req,
            projectId,
            {},
            {
              prisma,
              searcher: {
                search: async (q, p, o) =>
                  (await bm25.search(q, p, o)).map((c) => ({ ...c, confidence: undefined })),
              },
            },
          ),
      },
    });
    expect(before.block).not.toBe("");
    // A frozen golden: each BM25 score over the best, the 0.3 floor, BM25 order
    // (on the absolute scale all three would read 1.00, sharing one word each).
    expect(ctx.block).toBe(
      [
        "[NR-1] Add a button to terminate all sessions",
        "  - internal/integration/telegrambot/client.go::InlineKeyboardButton (direct, conf 1.00) — internal/integration/telegrambot/client.go:12",
        "  - internal/ui/routes.go::handleSessions (direct, conf 0.63) — internal/ui/routes.go:13",
        "  - internal/storage/web_session.go::FlushAllSessions (direct, conf 0.56) — internal/storage/web_session.go:10",
      ].join("\n"),
    );
    expect(ctx.block).toBe(before.block);
    expect(ctx.filePaths).toEqual(before.filePaths);
    // Every hit shares one name word, so on the absolute scale every seed would
    // read 1.00; the BM25 values tell them apart.
    const directConfs = [...ctx.block.matchAll(/\(direct, conf (\d\.\d\d)\)/g)].map((m) => m[1]);
    expect(new Set(directConfs).size).toBeGreaterThan(1);
  });

  it("records no mode for an injected mapper", async () => {
    const ctx = await computeAffectedCodeContext({
      projectId: "proj-miniflux",
      extraInstructions: "- Add a button to terminate all sessions",
      enabled: true,
      tokenBudget: 100000,
      deps: {
        prisma,
        dataSourceFor: () => graph,
        mapRequirement: async () => [
          {
            codeSymbolId: "flush",
            filePath: rows[0]!.filePath,
            qualifiedName: rows[0]!.qualifiedName,
            startLine: 10,
            endLine: 20,
            confidence: 0.5,
          },
        ],
      },
    });
    expect(ctx.result).not.toHaveProperty("retrievalMode");
  });
});
