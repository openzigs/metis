/**
 * Issue #1063 — the deterministic mapper linked "Add a button to terminate all
 * sessions" to the Telegram bot's `InlineKeyboardButton` and "Ability to force
 * IPv4 or IPv6 per feed" to `ForceRefreshInterval`, both at confidence 1.0.
 *
 * The corpus below is an excerpt of the #706 run-7 Miniflux code graph: the
 * symbol names are the real ones, and it keeps the property that decided the
 * ranking there (`button` is in fewer names than `sessions`: 7 against 20 of
 * 3,845), so the "before" assertions reproduce the two reported links. BM25 scores only the terms that match, so when a
 * requirement's most distinctive word (`terminate`, `IPv4`) is in no symbol
 * name, every hit shares one word and the rarest word wins.
 */
import { describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@prisma/client";
import { BM25Index } from "../code-graph/hybrid-search.js";
import {
  ANALYSIS_LINK_MIN_SHARED_TERMS,
  Bm25CodeSymbolSearcher,
  MemoizingBm25CodeSymbolSearcher,
  denoiseRequirementQuery,
  mapRequirementToCode,
  requiredSharedTerms,
} from "./requirement-code-mapping.js";

const PROJECT = "proj-miniflux";

/** [name, filePath, kind] — names as ingested from Miniflux v2.3.3. */
const MINIFLUX: Array<[string, string, string]> = [
  ["InlineKeyboardButton", "internal/integration/telegrambot/client.go", "class"],
  ["restoreButtonState", "internal/ui/static/js/app.js", "function"],
  ["setButtonToLoadingState", "internal/ui/static/js/app.js", "function"],
  ["flushSessions", "internal/cli/flush_sessions.go", "function"],
  ["user_sessions", "internal/database/migrations.go", "table"],
  ["web_sessions", "internal/storage/web_session.go", "table"],
  ["FlushAllSessions", "internal/storage/web_session.go", "function"],
  ["showSessionsPage", "internal/ui/session_list.go", "function"],
  ["CleanOldWebSessions", "internal/storage/web_session.go", "function"],
  ["WebSessionsByUserID", "internal/storage/web_session.go", "function"],
  ["CleanupRemoveSessionsInterval", "internal/config/options.go", "function"],
  ["ForceRefreshInterval", "internal/config/options.go", "function"],
  ["LastForceRefresh", "internal/model/web_session.go", "function"],
  ["MarkForceRefreshed", "internal/model/web_session.go", "function"],
  ["Feed", "internal/model/feed.go", "class"],
  ["FeedCounters", "internal/model/feed.go", "class"],
  ["UpdateFeed", "internal/storage/feed.go", "function"],
  ["markAllAsRead", "internal/ui/unread_mark_all_read.go", "function"],
  ["markFeedAsRead", "internal/ui/feed_mark_as_read.go", "function"],
  ["MarkCategoryAsRead", "client/client.go", "function"],
  ["refreshFeedHandler", "internal/api/feed_handlers.go", "function"],
  ["RefreshFeed", "client/client.go", "function"],
  ["parseDescriptors", "internal/reader/sanitizer/srcset.go", "function"],
  ["Entries", "internal/model/entry.go", "class"],
];

const rows = MINIFLUX.map(([name, filePath, kind], i) => ({
  id: `sym-${i}`,
  name,
  qualifiedName: kind === "table" ? name : `${filePath}::${name}`,
  kind,
  filePath,
  startLine: 10 + i,
  endLine: 20 + i,
}));

function fakePrisma() {
  const findMany = vi.fn(async (args: { where?: { projectId?: string } }) =>
    args?.where?.projectId === PROJECT ? rows : [],
  );
  return {
    prisma: { codeSymbol: { findMany } } as unknown as Pick<PrismaClient, "codeSymbol">,
    findMany,
  };
}

const names = (hits: Array<{ qualifiedName: string }>): string[] =>
  hits.map((h) => h.qualifiedName.split("::").pop()!);

const TERMINATE = "Add a button to terminate all sessions";
const IPV = "Ability to force IPv4 or IPv6 per feed";
const MARK = "Mark all as read older than X";

describe("BM25Index.score — matchedTerms (#1063)", () => {
  const index = new BM25Index();
  index.build(rows.map((r) => ({ symbolId: r.id, ...r })));
  const byId = new Map(rows.map((r) => [r.id, r.name]));

  it("counts the DISTINCT query terms a symbol's name carries", () => {
    const scored = index.score("mark read older");
    const hit = scored.find((s) => byId.get(s.symbolId) === "markAllAsRead")!;
    expect(hit.matchedTerms).toBe(2);
  });

  it("does not count a repeated query term twice", () => {
    const once = index.score("sessions").find((s) => byId.get(s.symbolId) === "flushSessions")!;
    const thrice = index
      .score("sessions sessions sessions")
      .find((s) => byId.get(s.symbolId) === "flushSessions")!;
    expect(once.matchedTerms).toBe(1);
    expect(thrice.matchedTerms).toBe(1);
    // The repetition still weighs in the SCORE, exactly as before.
    expect(thrice.score).toBeGreaterThan(once.score);
  });

  it("returns only symbols that share a term, each with a count of at least one", () => {
    const scored = index.score("button terminate sessions");
    expect(scored.length).toBeGreaterThan(0);
    for (const s of scored) expect(s.matchedTerms).toBeGreaterThanOrEqual(1);
    expect(index.score("zzzz")).toEqual([]);
  });
});

describe("requiredSharedTerms (#1063)", () => {
  it("is 1 by default, whatever the query", () => {
    expect(requiredSharedTerms("button terminate sessions")).toBe(1);
  });

  it("is the minimum when the query has that many distinct terms", () => {
    expect(requiredSharedTerms("button terminate sessions", 2)).toBe(2);
    expect(requiredSharedTerms("force feed", 2)).toBe(2);
  });

  it("is capped at the query's distinct terms, so a one-word requirement can still link", () => {
    expect(requiredSharedTerms("sessions", 2)).toBe(1);
    expect(requiredSharedTerms("sessions sessions", 2)).toBe(1);
  });

  it("never falls below 1", () => {
    expect(requiredSharedTerms("", 2)).toBe(1);
    expect(requiredSharedTerms("sessions", 0)).toBe(1);
    expect(requiredSharedTerms("sessions", -3)).toBe(1);
  });

  it("counts the parts of a snake_case term, as the index does", () => {
    // `user_sessions` → user_sessions, user, sessions.
    expect(requiredSharedTerms("user_sessions", 3)).toBe(3);
  });
});

describe("the two wrong links from #706 run 7", () => {
  it("BEFORE (any shared word links): the reported symbols are the top hit", async () => {
    const searcher = new Bm25CodeSymbolSearcher(fakePrisma().prisma);
    const terminate = await searcher.search(TERMINATE, PROJECT, { limit: 8 });
    expect(names(terminate)[0]).toBe("InlineKeyboardButton");
    const ipv = await searcher.search(IPV, PROJECT, { limit: 8 });
    expect(names(ipv)[0]).toBe("ForceRefreshInterval");
  });

  it("BEFORE: relative confidence reports the wrong top hit at 1.0", async () => {
    const { prisma } = fakePrisma();
    const matches = await mapRequirementToCode(
      { id: "NR-4", title: TERMINATE, body: TERMINATE },
      PROJECT,
      {},
      { prisma: prisma as never },
    );
    expect(names(matches)[0]).toBe("InlineKeyboardButton");
    expect(matches[0]!.confidence).toBe(1);
  });

  it("every hit for either requirement shares exactly one word with it", () => {
    const index = new BM25Index();
    index.build(rows.map((r) => ({ symbolId: r.id, ...r })));
    for (const q of [TERMINATE, IPV]) {
      const scored = index.score(denoiseRequirementQuery(q));
      expect(scored.length).toBeGreaterThan(0);
      expect(new Set(scored.map((s) => s.matchedTerms))).toEqual(new Set([1]));
    }
  });

  it("AFTER (two shared terms): neither requirement gets a link", async () => {
    const searcher = new Bm25CodeSymbolSearcher(fakePrisma().prisma, {
      minSharedTerms: ANALYSIS_LINK_MIN_SHARED_TERMS,
    });
    expect(await searcher.search(TERMINATE, PROJECT, { limit: 8 })).toEqual([]);
    expect(await searcher.search(IPV, PROJECT, { limit: 8 })).toEqual([]);
  });

  it("AFTER: mapRequirementToCode returns no match rather than a best guess", async () => {
    const { prisma } = fakePrisma();
    const searcher = new MemoizingBm25CodeSymbolSearcher(prisma, {
      minSharedTerms: ANALYSIS_LINK_MIN_SHARED_TERMS,
    });
    for (const title of [TERMINATE, IPV]) {
      expect(
        await mapRequirementToCode(
          { id: "NR", title, body: title },
          PROJECT,
          {},
          { prisma: prisma as never, searcher },
        ),
      ).toEqual([]);
    }
  });
});

describe("the two-shared-terms rule (#1063)", () => {
  const gated = () =>
    new Bm25CodeSymbolSearcher(fakePrisma().prisma, {
      minSharedTerms: ANALYSIS_LINK_MIN_SHARED_TERMS,
    });

  it("keeps a symbol that shares two terms, and only those", async () => {
    const hits = await gated().search(MARK, PROJECT, { limit: 8 });
    expect(new Set(names(hits))).toEqual(
      new Set(["markAllAsRead", "markFeedAsRead", "MarkCategoryAsRead"]),
    );
  });

  it("still links a one-word requirement on its one word", async () => {
    const hits = await gated().search("Sessions", PROJECT, { limit: 8 });
    expect(names(hits)).toEqual(
      expect.arrayContaining(["flushSessions", "user_sessions", "web_sessions"]),
    );
  });

  it("is applied before the limit, so one-word hits do not crowd out two-word ones", async () => {
    // `category` is in one name only, so that one-word hit outranks every symbol
    // sharing the two commoner words `internal` and `storage`.
    const q = "category internal storage";
    const ungated = await new Bm25CodeSymbolSearcher(fakePrisma().prisma).search(q, PROJECT, {
      limit: 1,
    });
    expect(names(ungated)).toEqual(["MarkCategoryAsRead"]);
    // Filtering after cutting to the limit would leave nothing here.
    const hits = await gated().search(q, PROJECT, { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(hits[0]!.filePath).toMatch(/^internal\/storage\//);
  });

  it("is OFF by default: every other caller of the searchers is unchanged", async () => {
    const plain = await new Bm25CodeSymbolSearcher(fakePrisma().prisma).search(TERMINATE, PROJECT, {
      limit: 8,
    });
    const explicitOne = await new Bm25CodeSymbolSearcher(fakePrisma().prisma, {
      minSharedTerms: 1,
    }).search(TERMINATE, PROJECT, { limit: 8 });
    expect(plain.length).toBeGreaterThan(0);
    expect(explicitOne).toEqual(plain);
  });

  it("the memoizing searcher applies the same rule and still builds the corpus once", async () => {
    const { prisma, findMany } = fakePrisma();
    const searcher = new MemoizingBm25CodeSymbolSearcher(prisma, {
      minSharedTerms: ANALYSIS_LINK_MIN_SHARED_TERMS,
    });
    expect(await searcher.search(TERMINATE, PROJECT)).toEqual([]);
    expect(names(await searcher.search(MARK, PROJECT))).toContain("markAllAsRead");
    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it("the memoizing searcher without the option keeps one-word hits", async () => {
    const searcher = new MemoizingBm25CodeSymbolSearcher(fakePrisma().prisma);
    expect(names(await searcher.search(TERMINATE, PROJECT))[0]).toBe("InlineKeyboardButton");
  });

  it("returns nothing for a project with no code graph", async () => {
    expect(await gated().search(MARK, "another-project", { limit: 8 })).toEqual([]);
  });
});
