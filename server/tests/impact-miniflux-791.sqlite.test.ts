/**
 * #791 — impact analysis names the code that must change, on a REAL SQLite
 * database built from the migration chain and driven through the real engine
 * (BM25 mapper, in-memory graph load, Prisma schema data source, persistence).
 *
 * The fixture mirrors miniflux/v2 v2.3.3 as it is ingested after #807: SQL
 * lineage edges start at the enclosing Go function, the Go parser stores
 * `func (s *Storage) SetEntriesStatus` as a plain `function`, and every
 * `h.store.X(…)` call from a handler is left unresolved (`toSymbolId` null)
 * with only the handler package's `import ".../internal/storage"` as evidence.
 *
 * Ground truth (from the walkthrough, #706 run 2):
 *   #4336 read_at   → SetEntriesStatus, MarkAllAsRead, MarkAllAsReadBeforeDate,
 *                     the Fever and Google Reader handlers that call them;
 *   #4478 older-than → MarkAllAsReadBeforeDate (exists) and its Google Reader caller;
 *   #4511 last refresh → UpdateFeed and UpdateFeedError (they write checked_at);
 *   and no Go function is ever reported as a database routine.
 */
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => ({ db: null as unknown }));
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});
vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { executeImpactAnalysis } =
  await import("../src/lib/impact-analysis/impact-analysis-engine.js");

const PROJ = "proj-miniflux-791";
const GRAPH = "g-miniflux-791";
const STORAGE_IMPORT = "miniflux.app/v2/internal/storage";
const ENTRY = "internal/storage/entry.go";
const FEED = "internal/storage/feed.go";
const FEVER = "internal/fever/handler.go";
const GREADER = "internal/googlereader/handler.go";
const UI_MARK = "internal/ui/unread_mark_all_read.go";
const UI_HANDLER = "internal/ui/handler.go";
const API_FEED = "internal/api/feed_handlers.go";
const MIGRATIONS = "internal/database/migrations.go";

const REQ_4336 =
  "Feature Request (miniflux #4336): Track reading time — add read_at timestamp to entries. Miniflux currently does not record when an entry was read. The changed_at field updates whenever an entry is modified (including status changes), but there is no dedicated field to know when exactly a user marked an entry as read. Proposed: add a read_at TIMESTAMP column to the entries table. When an entry transitions from unread to read, set read_at = NOW().";
const REQ_4478 =
  "Feature (miniflux #4478): Mark all as read older than X. Right now you can either mark a page as read or mark everything as read. This gives people the option to just let things that are older than X days be marked as read.";
const REQ_4511 =
  "Feature (miniflux #4511): Last Successful refresh in feed API. Store and return the last time a feed was successfully refreshed. I use the Feed API (GET /v1/feeds/{feedID}) to start with the feed that was refreshed longest ago, but the Last Refreshed parameter (checked_at) only tells me when the last attempted refresh was, not when the last successful refresh was.";

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#791 — impact analysis on the miniflux walkthrough fixture (real engine, real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    const ids = new Map<string, string>();

    async function fn(filePath: string, name: string, startLine: number): Promise<string> {
      const row = await db.codeSymbol.create({
        data: {
          codeGraphId: GRAPH,
          projectId: PROJ,
          kind: "function",
          name,
          qualifiedName: `${filePath}::${name}`,
          filePath,
          startLine,
          endLine: startLine + 15,
          language: "go",
          contentHash: `${filePath}::${name}`,
        },
      });
      ids.set(name, row.id);
      return row.id;
    }

    async function module(filePath: string): Promise<string> {
      const row = await db.codeSymbol.create({
        data: {
          codeGraphId: GRAPH,
          projectId: PROJ,
          kind: "module",
          name: filePath.split("/").pop()!,
          qualifiedName: filePath,
          filePath,
          startLine: 1,
          endLine: 2000,
          language: "go",
          contentHash: filePath,
        },
      });
      return row.id;
    }

    async function schema(qualifiedName: string): Promise<string> {
      const [table, column] = qualifiedName.split(".");
      const row = await db.codeSymbol.create({
        data: {
          codeGraphId: GRAPH,
          projectId: PROJ,
          kind: column ? "column" : "table",
          name: column ?? table,
          qualifiedName,
          filePath: MIGRATIONS,
          startLine: 1,
          endLine: 1,
          language: "sql",
          source: "sqlglot",
          contentHash: qualifiedName,
        },
      });
      ids.set(qualifiedName, row.id);
      return row.id;
    }

    async function edge(
      kind: string,
      from: string,
      to: string | null,
      filePath: string,
      toQualifiedName: string | null = null,
    ): Promise<void> {
      await db.codeEdge.create({
        data: {
          codeGraphId: GRAPH,
          projectId: PROJ,
          kind,
          fromSymbolId: from,
          toSymbolId: to,
          toQualifiedName,
          filePath,
          line: 1,
        },
      });
    }

    async function run(text: string, deps: Record<string, unknown> = {}) {
      const analysis = await db.impactAnalysis.create({
        data: { sourceText: text, startedById: "u-791" },
      });
      await executeImpactAnalysis(analysis.id, [PROJ], deps);
      const done = await db.impactAnalysis.findUniqueOrThrow({ where: { id: analysis.id } });
      expect(done.errorMessage).toBeNull();
      const items = await db.impactItem.findMany({ where: { impactAnalysisId: analysis.id } });
      const itemIds = items.map((i) => i.id);
      const symbols = await db.impactAffectedSymbol.findMany({
        where: { impactItemId: { in: itemIds } },
      });
      const tables = await db.impactAffectedTable.findMany({
        where: { impactItemId: { in: itemIds } },
      });
      return { symbols, tables };
    }

    const names = (rows: Array<{ qualifiedName: string }>) => rows.map((r) => r.qualifiedName);

    beforeAll(async () => {
      sqlite = createMigratedSqlite("791-impact-miniflux");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-791", username: "u-791", displayName: "U", email: "u791@example.test" },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, description: "", createdById: "u-791" },
      });
      await db.codeGraph.create({ data: { id: GRAPH, projectId: PROJ } });

      // Schema graph (sqlglot lineage).
      for (const qn of [
        "entries",
        "entries.status",
        "entries.changed_at",
        "entries.reading_time",
        "feeds",
        "feeds.checked_at",
        "feeds.parsing_error_count",
        "feeds.last_modified_header",
        "api_keys",
        "api_keys.last_used_at",
      ]) {
        await schema(qn);
      }

      // internal/storage — the methods that must change, as plain Go functions.
      for (const [name, line] of [
        ["SetEntriesStatus", 412],
        ["MarkAllAsRead", 506],
        ["MarkAllAsReadBeforeDate", 523],
      ] as const) {
        const id = await fn(ENTRY, name, line);
        await edge("writes", id, ids.get("entries.status")!, ENTRY);
        await edge("writes", id, ids.get("entries.changed_at")!, ENTRY);
        await edge("writes", id, ids.get("entries")!, ENTRY);
      }
      const readTime = await fn(ENTRY, "GetReadTime", 300);
      await edge("reads", readTime, ids.get("entries.reading_time")!, ENTRY);
      await edge("reads", readTime, ids.get("entries")!, ENTRY);
      const updateFeed = await fn(FEED, "UpdateFeed", 331);
      await edge("writes", updateFeed, ids.get("feeds.checked_at")!, FEED);
      await edge("writes", updateFeed, ids.get("feeds.last_modified_header")!, FEED);
      const updateFeedError = await fn(FEED, "UpdateFeedError", 431);
      await edge("writes", updateFeedError, ids.get("feeds.checked_at")!, FEED);
      await edge("writes", updateFeedError, ids.get("feeds.parsing_error_count")!, FEED);
      const apiKeyUsed = await fn("internal/storage/api_key.go", "SetAPIKeyUsedTimestamp", 25);
      await edge(
        "writes",
        apiKeyUsed,
        ids.get("api_keys.last_used_at")!,
        "internal/storage/api_key.go",
      );

      // Lexical decoys: brotli's io.Reader, and the feed/refresh names that crowd
      // the mapper's top ten for #4511 in the real project.
      await fn("internal/reader/fetcher/encoding_wrappers.go", "Read", 25);
      for (const [file, name] of [
        ["internal/model/web_session.go", "LastForceRefresh"],
        ["internal/ui/feed_refresh.go", "refreshFeed"],
        ["internal/ui/feed_refresh.go", "refreshAllFeeds"],
        [API_FEED, "refreshAllFeedsHandler"],
        ["client/client.go", "RefreshFeed"],
        ["internal/reader/handler/handler.go", "RefreshFeed"],
        [FEED, "FeedByID"],
        [FEED, "FeedExists"],
        [FEED, "CreateFeed"],
        [FEED, "RemoveFeed"],
        ["internal/api/api_integration_test.go", "TestRefreshFeedEndpoint"],
        ["internal/ui/feed_icon.go", "showFeedIcon"],
      ] as const) {
        await fn(file, name, 10);
      }
      // The Go API client has its own MarkAllAsRead — never visible to the handlers.
      await fn("client/client.go", "MarkAllAsRead", 327);

      // Handlers: unresolved `h.store.X()` calls, storage imported by the package.
      for (const file of [FEVER, GREADER, UI_HANDLER, API_FEED]) {
        await edge("imports", await module(file), null, file, STORAGE_IMPORT);
      }
      await edge(
        "calls",
        await fn(FEVER, "handleWriteItems", 401),
        null,
        FEVER,
        "SetEntriesStatus",
      );
      await edge(
        "calls",
        await fn(GREADER, "editTagHandler", 187),
        null,
        GREADER,
        "SetEntriesStatus",
      );
      await edge(
        "calls",
        await fn(GREADER, "markAllAsReadHandler", 1155),
        null,
        GREADER,
        "MarkAllAsReadBeforeDate",
      );
      await edge("calls", await fn(UI_MARK, "markAllAsRead", 13), null, UI_MARK, "MarkAllAsRead");
      await edge(
        "calls",
        await fn(API_FEED, "refreshFeedHandler", 54),
        null,
        API_FEED,
        "RefreshFeed",
      );
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("#4336 read_at: names every status-change path and the handlers that call them", async () => {
      const { symbols, tables } = await run(REQ_4336);
      const all = names(symbols);
      for (const name of ["SetEntriesStatus", "MarkAllAsRead", "MarkAllAsReadBeforeDate"]) {
        expect(all).toContain(`${ENTRY}::${name}`);
      }
      expect(all).toContain(`${FEVER}::handleWriteItems`);
      expect(all).toContain(`${GREADER}::editTagHandler`);
      const status = symbols.find((s) => s.qualifiedName === `${ENTRY}::SetEntriesStatus`)!;
      expect(status).toMatchObject({ filePath: ENTRY, startLine: 412 });
      expect(["direct", "data-writer"]).toContain(status.relation);
      expect(tables.some((t) => t.tableName === "entries")).toBe(true);
      // No Go function is ever a database routine.
      expect(tables.filter((t) => t.tableName.includes("::"))).toEqual([]);
      expect(tables.filter((t) => t.objectKind === "function")).toEqual([]);
    });

    it("#4478 older-than: names the existing MarkAllAsReadBeforeDate and its Google Reader caller", async () => {
      const { symbols } = await run(REQ_4478);
      const all = names(symbols);
      expect(all).toContain(`${ENTRY}::MarkAllAsReadBeforeDate`);
      expect(all).toContain(`${GREADER}::markAllAsReadHandler`);
    });

    it("#4511 last refresh: names the refresh writers of checked_at", async () => {
      const { symbols } = await run(REQ_4511);
      const all = names(symbols);
      expect(all).toContain(`${FEED}::UpdateFeed`);
      expect(all).toContain(`${FEED}::UpdateFeedError`);
    });

    it("drops a word-matched column seed once the relevance filter judges its table tangential", async () => {
      const baseline = names((await run(REQ_4511)).symbols);
      expect(baseline).toContain("api_keys.last_used_at");

      const { symbols, tables } = await run(REQ_4511, {
        tableRelevanceFilter: async (_text: string, rows: Array<{ tableName: string }>) => ({
          primary: rows.filter((r) => r.tableName !== "api_keys"),
          secondary: rows
            .filter((r) => r.tableName === "api_keys")
            .map((r) => ({ ...r, relevanceTier: "unlikely" })),
        }),
      });
      const all = names(symbols);
      expect(all).not.toContain("api_keys.last_used_at");
      // …and its writer is not named either: the table is not in the primary set.
      expect(all).not.toContain("internal/storage/api_key.go::SetAPIKeyUsedTimestamp");
      expect(all).toContain(`${FEED}::UpdateFeed`);
      expect(tables.find((t) => t.tableName === "api_keys")?.relevanceTier).toBe("unlikely");
    });
  },
);
