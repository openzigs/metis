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
import { BM25Index, tokenizeCode } from "../code-graph/hybrid-search.js";
import {
  ANALYSIS_LINK_MIN_SHARED_TERMS,
  Bm25CodeSymbolSearcher,
  MemoizingBm25CodeSymbolSearcher,
  denoiseRequirementQuery,
  mapRequirementToCode,
  requiredSharedTerms,
  symbolNameTerms,
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
  ["Client", "client/client.go", "class"],
  ["NewClient", "client/client.go", "function"],
  ["client.go", "client/client.go", "module"],
  ["flush_sessions.go", "internal/cli/flush_sessions.go", "module"],
];

/** Rows whose qualified name is not `<filePath>::<name>`, as ingested. */
const QUALIFIED: Array<[string, string, string, string]> = [
  // [name, qualifiedName, filePath, kind]
  [
    "listen",
    "internal/ui/static/js/keyboard_handler.js::KeyboardHandler::listen",
    "internal/ui/static/js/keyboard_handler.js",
    "method",
  ],
  ["ip", "user_sessions.ip", "internal/database/migrations.go", "column"],
  ["user_agent", "user_sessions.user_agent", "internal/database/migrations.go", "column"],
];

const rows = [
  ...MINIFLUX.map(([name, filePath, kind]) => ({
    name,
    // As ingested: a table is its own name, a module row is its path.
    qualifiedName: kind === "table" ? name : kind === "module" ? filePath : `${filePath}::${name}`,
    kind,
    filePath,
  })),
  ...QUALIFIED.map(([name, qualifiedName, filePath, kind]) => ({
    name,
    qualifiedName,
    kind,
    filePath,
  })),
].map((r, i) => ({ id: `sym-${i}`, ...r, startLine: 10 + i, endLine: 20 + i }));

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

const rowOf = (qualifiedName: string) => rows.find((r) => r.qualifiedName === qualifiedName)!;

/** Distinct terms of the denoised requirement that the symbol's NAME carries. */
const sharedNameTerms = (requirement: string, qualifiedName: string): string[] => {
  const nameTerms = symbolNameTerms(rowOf(qualifiedName));
  return [...new Set(tokenizeCode(denoiseRequirementQuery(requirement)))].filter((t) =>
    nameTerms.has(t),
  );
};

const TERMINATE = "Add a button to terminate all sessions";
const IPV = "Ability to force IPv4 or IPv6 per feed";
const MARK = "Mark all as read older than X";

describe("symbolNameTerms — what a symbol is CALLED (#1063, PR #1095 review)", () => {
  const terms = (row: { name: string; qualifiedName: string; filePath: string }) =>
    [...symbolNameTerms(row)].sort();

  it("counts the name, and nothing of the path or the extension", () => {
    // The BM25 document for this row also holds internal, integration,
    // telegrambot, client and go. None of them is the symbol's name.
    expect(
      terms({
        name: "InlineKeyboardButton",
        qualifiedName: "internal/integration/telegrambot/client.go::InlineKeyboardButton",
        filePath: "internal/integration/telegrambot/client.go",
      }),
    ).toEqual(["button", "inline", "keyboard"]);
  });

  it("counts an enclosing type, because the method is called by it", () => {
    expect(
      terms({
        name: "listen",
        qualifiedName: "internal/ui/static/js/keyboard_handler.js::KeyboardHandler::listen",
        filePath: "internal/ui/static/js/keyboard_handler.js",
      }),
    ).toEqual(["handler", "keyboard", "listen"]);
  });

  it("counts a receiver written with a dot inside the member segment", () => {
    expect(
      terms({
        name: "SetEntriesStatus",
        qualifiedName: "internal/storage/entry.go::Storage.SetEntriesStatus",
        filePath: "internal/storage/entry.go",
      }),
    ).toEqual(["entries", "set", "status", "storage"]);
  });

  it("counts a column's table, and only the owner next to the member", () => {
    expect(
      terms({
        name: "ip",
        qualifiedName: "user_sessions.ip",
        filePath: "internal/database/migrations.go",
      }),
    ).toEqual(["ip", "sessions", "user", "user_sessions"]);
    // Further left is a schema or package: a path by another name.
    expect(
      terms({
        name: "column_name",
        qualifiedName: "information_schema.columns.column_name",
        filePath: "internal/database/migrations.go",
      }),
    ).toEqual(["column", "column_name", "columns", "name"]);
    expect(
      terms({
        name: "create",
        qualifiedName: "com.acme.billing.InvoiceService.create",
        filePath: "src/main/java/com/acme/billing/InvoiceService.java",
      }),
    ).toEqual(["create", "invoice", "service"]);
  });

  it("calls a module row by its file name, without directories or the extension", () => {
    expect(
      terms({
        name: "flush_sessions.go",
        qualifiedName: "internal/cli/flush_sessions.go",
        filePath: "internal/cli/flush_sessions.go",
      }),
    ).toEqual(["flush", "flush_sessions", "sessions"]);
    // A symbol IN a root-level file: the file segment has no separator to spot.
    expect(terms({ name: "run", qualifiedName: "main.go::run", filePath: "main.go" })).toEqual([
      "run",
    ]);
    // A module row whose path is written differently from filePath is still a
    // path: its directory and extension are not what the file is called.
    expect(
      terms({
        name: "client.go",
        qualifiedName: "./client/client.go",
        filePath: "client/client.go",
      }),
    ).toEqual(["client"]);
    // A file at the repository root: its qualified name has no separator.
    expect(terms({ name: "main.go", qualifiedName: "main.go", filePath: "main.go" })).toEqual([
      "main",
    ]);
  });

  it("drops a path segment that is not byte-equal to filePath", () => {
    expect(
      terms({
        name: "NewClient",
        qualifiedName: "./client/client.go::NewClient",
        filePath: "client/client.go",
      }),
    ).toEqual(["client", "new"]);
    expect(
      terms({
        name: "run",
        qualifiedName: "cmd\\tool\\main.go::run",
        filePath: "cmd/tool/main.go",
      }),
    ).toEqual(["run"]);
  });

  it("is a table's own name when that is all there is", () => {
    expect(
      terms({ name: "web_sessions", qualifiedName: "web_sessions", filePath: "internal/x.go" }),
    ).toEqual(["sessions", "web", "web_sessions"]);
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

  it("no symbol's name shares more than one word with either requirement", () => {
    const index = new BM25Index();
    index.build(rows.map((r) => ({ symbolId: r.id, ...r })));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const q of [TERMINATE, IPV]) {
      const scored = index.score(denoiseRequirementQuery(q));
      expect(scored.length).toBeGreaterThan(0);
      const counts = scored.map(
        (s) => sharedNameTerms(q, byId.get(s.symbolId)!.qualifiedName).length,
      );
      expect(Math.max(...counts)).toBe(1);
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
    // `category` is in one name only, so that one-word hit outranks the symbols
    // whose NAMES carry the two commoner words `web` and `sessions`.
    const q = "category web sessions";
    const ungated = await new Bm25CodeSymbolSearcher(fakePrisma().prisma).search(q, PROJECT, {
      limit: 1,
    });
    expect(names(ungated)).toEqual(["MarkCategoryAsRead"]);
    // Filtering after cutting to the limit would leave nothing here.
    const hits = await gated().search(q, PROJECT, { limit: 1 });
    expect(hits).toHaveLength(1);
    expect(sharedNameTerms(q, hits[0]!.qualifiedName).sort()).toEqual(["sessions", "web"]);
  });

  it("a one-word requirement links on its word in the NAME, not in the path", async () => {
    // `internal` is in most paths of this corpus and in no name.
    const plain = await new Bm25CodeSymbolSearcher(fakePrisma().prisma).search(
      "Internal",
      PROJECT,
      { limit: 8 },
    );
    expect(plain.length).toBeGreaterThan(0);
    expect(await gated().search("Internal", PROJECT, { limit: 8 })).toEqual([]);
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

/**
 * Review of PR #1095 (medium) — the rule counted the terms of the BM25
 * DOCUMENT, which is `name + qualifiedName`, and `qualifiedName` is
 * `<filePath>::<name>`. So a directory or the file extension was the second
 * "shared term", and one ordinary extra word brought both reported links back.
 * These are the reviewer's four probes.
 */
describe("path terms are not shared terms (PR #1095 review)", () => {
  const gated = () =>
    new Bm25CodeSymbolSearcher(fakePrisma().prisma, {
      minSharedTerms: ANALYSIS_LINK_MIN_SHARED_TERMS,
    });
  const TELEGRAM = "internal/integration/telegrambot/client.go::InlineKeyboardButton";
  const FORCE = "internal/config/options.go::ForceRefreshInterval";

  it("the document really does carry the path and the extension", () => {
    expect(tokenizeCode(rowOf(TELEGRAM).qualifiedName)).toEqual(
      expect.arrayContaining(["internal", "integration", "telegrambot", "client", "go", "button"]),
    );
  });

  it("probe 1: 'Add a button to terminate all sessions' links nothing", async () => {
    expect(await gated().search(TERMINATE, PROJECT, { limit: 8 })).toEqual([]);
  });

  it("probe 2: adding 'in the web client' does not bring InlineKeyboardButton back", async () => {
    const q = "Add a button in the web client to terminate all sessions";
    // `button` in the name, `client` only in telegrambot/client.go.
    expect(sharedNameTerms(q, TELEGRAM)).toEqual(["button"]);
    const hits = await gated().search(q, PROJECT, { limit: 8 });
    expect(hits.map((h) => h.qualifiedName)).not.toContain(TELEGRAM);
    // What is linked shares two terms by NAME: the web-session symbols.
    expect(hits.length).toBeGreaterThan(0);
    for (const h of hits) {
      expect(sharedNameTerms(q, h.qualifiedName).length).toBeGreaterThanOrEqual(2);
    }
    expect(names(hits)).toEqual(expect.arrayContaining(["web_sessions", "CleanOldWebSessions"]));
    const mapped = await mapRequirementToCode(
      { id: "NR-4", title: q, body: q },
      PROJECT,
      {},
      { prisma: fakePrisma().prisma as never, searcher: gated() },
    );
    expect(mapped.map((m) => m.qualifiedName)).not.toContain(TELEGRAM);
  });

  it("probe 3: 'Let users go to the client settings' does not link a file's symbols through 'go' and 'client'", async () => {
    const q = "Let users go to the client settings";
    // Without the rule the extension and the directory make every symbol of
    // client/client.go, and the Telegram class, a hit.
    const plain = await new Bm25CodeSymbolSearcher(fakePrisma().prisma).search(q, PROJECT, {
      limit: 50,
    });
    expect(plain.map((h) => h.qualifiedName)).toEqual(
      expect.arrayContaining([TELEGRAM, "client/client.go::RefreshFeed"]),
    );
    const hits = await gated().search(q, PROJECT, { limit: 50 });
    for (const h of hits) {
      expect(sharedNameTerms(q, h.qualifiedName).length).toBeGreaterThanOrEqual(2);
    }
    const linked = hits.map((h) => h.qualifiedName);
    expect(linked).not.toContain(TELEGRAM);
    expect(linked).not.toContain("client/client.go::RefreshFeed");
    expect(linked).not.toContain("client/client.go::MarkCategoryAsRead");
    // `Client` and `NewClient` are called "client", but that is one word.
    expect(linked).not.toContain("client/client.go::Client");
    expect(linked).not.toContain("client/client.go::NewClient");
    // The module row is `client.go`: its extension is not a word either.
    expect(linked).not.toContain("client/client.go");
  });

  it("probe 4: adding 'in the internal model' does not bring ForceRefreshInterval back", async () => {
    const q = "Force IPv4 or IPv6 per feed in the internal model";
    expect(sharedNameTerms(q, FORCE)).toEqual(["force"]);
    const hits = await gated().search(q, PROJECT, { limit: 8 });
    expect(hits.map((h) => h.qualifiedName)).not.toContain(FORCE);
    for (const h of hits) {
      expect(sharedNameTerms(q, h.qualifiedName).length).toBeGreaterThanOrEqual(2);
    }
  });

  it("still links through an enclosing type or table", async () => {
    const method = await gated().search("Keyboard handler should listen for Escape", PROJECT, {
      limit: 8,
    });
    expect(method.map((h) => h.qualifiedName)).toContain(
      "internal/ui/static/js/keyboard_handler.js::KeyboardHandler::listen",
    );
    const column = await gated().search(
      "Record the IP of each user session row in user_sessions",
      PROJECT,
      {
        limit: 8,
      },
    );
    expect(column.map((h) => h.qualifiedName)).toContain("user_sessions.ip");
  });

  it("links a module row by its file name", async () => {
    const hits = await gated().search("Flush sessions from the command line", PROJECT, {
      limit: 8,
    });
    expect(hits.map((h) => h.qualifiedName)).toEqual(
      expect.arrayContaining([
        "internal/cli/flush_sessions.go",
        "internal/cli/flush_sessions.go::flushSessions",
      ]),
    );
  });

  it("path terms still RANK: the order of the kept hits is BM25's", async () => {
    const q = "Flush sessions from the command line";
    const plain = await new Bm25CodeSymbolSearcher(fakePrisma().prisma).search(q, PROJECT, {
      limit: 50,
    });
    const kept = await gated().search(q, PROJECT, { limit: 50 });
    const keptIds = new Set(kept.map((h) => h.symbolId));
    expect(kept.length).toBeGreaterThan(0);
    expect(kept).toEqual(plain.filter((h) => keptIds.has(h.symbolId)));
  });

  it("the memoizing searcher's withOptions view shares one corpus load", async () => {
    const { prisma, findMany } = fakePrisma();
    const seeds = new MemoizingBm25CodeSymbolSearcher(prisma);
    const links = seeds.withOptions({ minSharedTerms: ANALYSIS_LINK_MIN_SHARED_TERMS });
    expect(names(await seeds.search(TERMINATE, PROJECT))[0]).toBe("InlineKeyboardButton");
    expect(await links.search(TERMINATE, PROJECT)).toEqual([]);
    expect(names(await seeds.search(TERMINATE, PROJECT))[0]).toBe("InlineKeyboardButton");
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(await links.hasCodeGraph(PROJECT)).toBe(true);
  });
});
