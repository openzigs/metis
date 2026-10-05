/**
 * #774 — `search_code_graph` `calls` / `calledBy` against a REAL SQLite code
 * graph shaped like the Miniflux v2.3.3 graph the walkthrough queried.
 *
 *   1. An ambiguous name no longer resolves to an arbitrary symbol: three
 *      `UpdateFeed`-like symbols exist, and `contains` is case-insensitive on
 *      SQLite, so `{"calledBy":"updateFeed"}` used to answer for the client's
 *      `UpdateFeed`. An exact (case-sensitive) name match now wins; a name that
 *      still matches several symbols lists the candidates instead.
 *   2. `calls` reports the probable call sites the parser stored unresolved
 *      (`toSymbolId` NULL, `toQualifiedName` the bare name). Before #774,
 *      `{"calls":"ScheduleNextCheck"}` listed only the test callers and
 *      `{"calls":"<storage UpdateFeed>"}` said nothing calls it.
 *
 * Real SQLite, because the defect lives in how the queries behave on the real
 * database (`contains` case folding, `NULL` targets, the relation filter).
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

const { searchCodeGraphTool } = await import("../src/lib/analysis/tools/search-code-graph.js");

interface Sym {
  id: string;
  name: string;
  qualifiedName: string;
  kind?: string;
  filePath: string;
  startLine: number;
  language?: string;
}

const SYMBOLS: Sym[] = [
  {
    id: "client-update",
    name: "UpdateFeed",
    qualifiedName: "client/client.go::Client.UpdateFeed",
    filePath: "client/client.go",
    startLine: 700,
  },
  {
    id: "storage-update",
    name: "UpdateFeed",
    qualifiedName: "internal/storage/feed.go::Storage.UpdateFeed",
    filePath: "internal/storage/feed.go",
    startLine: 331,
  },
  {
    id: "ui-update",
    name: "updateFeed",
    qualifiedName: "internal/ui/feed_update.go::handler.updateFeed",
    filePath: "internal/ui/feed_update.go",
    startLine: 18,
  },
  {
    id: "client-update-ctx",
    name: "UpdateFeedContext",
    qualifiedName: "client/client.go::Client.UpdateFeedContext",
    filePath: "client/client.go",
    startLine: 706,
  },
  {
    id: "schedule",
    name: "ScheduleNextCheck",
    qualifiedName: "internal/model/feed.go::Feed.ScheduleNextCheck",
    filePath: "internal/model/feed.go",
    startLine: 120,
  },
  {
    id: "schedule-test",
    name: "TestFeedScheduleNextCheckDefault",
    qualifiedName: "internal/model/feed_test.go::TestFeedScheduleNextCheckDefault",
    kind: "function",
    filePath: "internal/model/feed_test.go",
    startLine: 40,
  },
  {
    id: "refresh",
    name: "RefreshFeed",
    qualifiedName: "internal/reader/handler/handler.go::RefreshFeed",
    kind: "function",
    filePath: "internal/reader/handler/handler.go",
    startLine: 200,
  },
  {
    // A same-named TypeScript caller elsewhere in the repo: not a Go call site.
    id: "ts-caller",
    name: "reschedule",
    qualifiedName: "web/src/sched.ts::reschedule",
    kind: "function",
    filePath: "web/src/sched.ts",
    startLine: 5,
    language: "ts",
  },
];

interface Edge {
  from: string;
  to: string | null;
  toQualifiedName: string;
  filePath: string;
  line: number;
}

const EDGES: Edge[] = [
  // Resolved: the only edges `calls` followed before #774.
  {
    from: "schedule-test",
    to: "schedule",
    toQualifiedName: "ScheduleNextCheck",
    filePath: "internal/model/feed_test.go",
    line: 44,
  },
  {
    from: "client-update",
    to: "client-update-ctx",
    toQualifiedName: "UpdateFeedContext",
    filePath: "client/client.go",
    line: 701,
  },
  // Unresolved receiver/field calls — the production callers that vanished.
  {
    from: "refresh",
    to: null,
    toQualifiedName: "ScheduleNextCheck",
    filePath: "internal/reader/handler/handler.go",
    line: 222,
  },
  {
    from: "refresh",
    to: null,
    toQualifiedName: "ScheduleNextCheck",
    filePath: "internal/reader/handler/handler.go",
    line: 248,
  },
  {
    from: "ui-update",
    to: null,
    toQualifiedName: "UpdateFeed",
    filePath: "internal/ui/feed_update.go",
    line: 76,
  },
  // Noise that must NOT count as a call site of ScheduleNextCheck.
  {
    from: "ts-caller",
    to: null,
    toQualifiedName: "ScheduleNextCheck",
    filePath: "web/src/sched.ts",
    line: 7,
  },
  {
    from: "refresh",
    to: null,
    toQualifiedName: "schedulenextcheck",
    filePath: "internal/reader/handler/handler.go",
    line: 300,
  },
  {
    from: "refresh",
    to: null,
    toQualifiedName: "fmt.Errorf",
    filePath: "internal/reader/handler/handler.go",
    line: 230,
  },
];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#774 — search_code_graph calls/calledBy on an ambiguous, mostly-unresolved Go graph",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let projectId: string;
    const ctx = () => ({ projectId });

    beforeAll(async () => {
      sqlite = createMigratedSqlite("774-search-code-graph");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u-774", username: "u-774", displayName: "u", email: "u-774@example.test" },
      });
      projectId = (
        await db.project.create({ data: { name: "p774", slug: "p774", createdById: "u-774" } })
      ).id;
      const graph = await db.codeGraph.create({
        data: { projectId, lastIndexedAt: new Date() },
      });
      await db.codeSymbol.createMany({
        data: SYMBOLS.map((s) => ({
          id: s.id,
          codeGraphId: graph.id,
          projectId,
          kind: s.kind ?? "method",
          name: s.name,
          qualifiedName: s.qualifiedName,
          filePath: s.filePath,
          startLine: s.startLine,
          endLine: s.startLine + 4,
          language: s.language ?? "go",
          contentHash: s.id,
        })),
      });
      await db.codeEdge.createMany({
        data: EDGES.map((e) => ({
          codeGraphId: graph.id,
          projectId,
          kind: "calls",
          fromSymbolId: e.from,
          toSymbolId: e.to,
          toQualifiedName: e.toQualifiedName,
          filePath: e.filePath,
          line: e.line,
        })),
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("an exact, case-sensitive name wins over a case-folded substring match", async () => {
      // `updateFeed` is the UI handler. Before #774 SQLite's case-insensitive
      // `contains` matched client.go's `UpdateFeed` first and returned its callees.
      const res = await searchCodeGraphTool.execute({ calledBy: "updateFeed" }, ctx());
      expect(res.content).not.toContain("UpdateFeedContext");
      expect(res.content).not.toContain("ambiguous");
      expect(res.content).toContain('"updateFeed" calls no symbols resolved');
    });

    it("a bare name shared by several symbols lists the candidates instead of picking one", async () => {
      const res = await searchCodeGraphTool.execute({ calledBy: "UpdateFeed" }, ctx());
      expect(res.content).toContain('"UpdateFeed" is ambiguous: it matches 2 symbols');
      expect(res.content).toContain(
        "method client/client.go::Client.UpdateFeed — client/client.go:700-704 [go]",
      );
      expect(res.content).toContain(
        "method internal/storage/feed.go::Storage.UpdateFeed — internal/storage/feed.go:331-335 [go]",
      );
      // No callees of either one are reported as THE answer.
      expect(res.content).not.toContain("UpdateFeedContext —");
      expect(res.resultCount).toBe(0);
    });

    it("a unique qualified-name suffix resolves without the full path", async () => {
      const res = await searchCodeGraphTool.execute({ calledBy: "Client.UpdateFeed" }, ctx());
      expect(res.content).toContain(
        "method client/client.go::Client.UpdateFeedContext — client/client.go:706-710 [go]",
      );
    });

    it("calls: lists the unresolved production call sites next to the resolved test caller", async () => {
      const res = await searchCodeGraphTool.execute({ calls: "ScheduleNextCheck" }, ctx());
      expect(res.content).toContain(
        "function internal/model/feed_test.go::TestFeedScheduleNextCheckDefault",
      );
      expect(res.content).toContain("Probable (unresolved) call sites (2)");
      expect(res.content).toContain(
        "internal/reader/handler/handler.go:222 in internal/reader/handler/handler.go::RefreshFeed",
      );
      expect(res.content).toContain("internal/reader/handler/handler.go:248");
      // Another language's same-named call, a case-folded name and unrelated
      // calls are not call sites of the Go method.
      expect(res.content).not.toContain("web/src/sched.ts");
      expect(res.content).not.toContain(":300");
      expect(res.content).not.toContain(":230");
    });

    it("calls: a target with ONLY unresolved callers is not reported as uncalled", async () => {
      const res = await searchCodeGraphTool.execute(
        { calls: "internal/storage/feed.go::Storage.UpdateFeed" },
        ctx(),
      );
      expect(res.content).not.toContain('No symbols call "');
      expect(res.content).toContain(
        'No resolved symbols call "internal/storage/feed.go::Storage.UpdateFeed".',
      );
      expect(res.content).toContain(
        "internal/ui/feed_update.go:76 in internal/ui/feed_update.go::handler.updateFeed",
      );
      expect(res.content).toContain("may target internal/storage/feed.go::Storage.UpdateFeed");
    });

    it("calls: the filePath filter also scopes the probable call sites", async () => {
      const res = await searchCodeGraphTool.execute(
        { calls: "ScheduleNextCheck", filePath: "internal/model" },
        ctx(),
      );
      expect(res.content).toContain("TestFeedScheduleNextCheckDefault");
      expect(res.content).not.toContain("Probable (unresolved) call sites");
    });

    it("caps the candidate list and the probable call-site list", async () => {
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      const base = { codeGraphId: graph.id, projectId, language: "go", kind: "method" };
      await db.codeSymbol.createMany({
        data: Array.from({ length: 12 }, (_, i) => ({
          ...base,
          id: `get-${i}`,
          name: "Get",
          qualifiedName: `pkg${String(i).padStart(2, "0")}/x.go::T.Get`,
          filePath: `pkg${i}/x.go`,
          startLine: 1,
          endLine: 2,
          contentHash: `get-${i}`,
        })),
      });
      await db.codeSymbol.create({
        data: {
          ...base,
          id: "flush",
          name: "Flush",
          qualifiedName: "internal/cache.go::Cache.Flush",
          filePath: "internal/cache.go",
          startLine: 1,
          endLine: 9,
          contentHash: "flush",
        },
      });
      await db.codeEdge.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({
          codeGraphId: graph.id,
          projectId,
          kind: "calls",
          fromSymbolId: "refresh",
          toSymbolId: null,
          toQualifiedName: "c.Flush",
          filePath: "internal/reader/handler/handler.go",
          line: 400 + i,
        })),
      });

      const ambiguous = await searchCodeGraphTool.execute({ calls: "Get" }, ctx());
      expect(ambiguous.content).toContain('"Get" is ambiguous: it matches more than 10 symbols');
      expect(ambiguous.content).toContain("pkg09/x.go::T.Get");
      expect(ambiguous.content).not.toContain("pkg10/x.go::T.Get");
      expect(ambiguous.content.trimEnd().endsWith("…")).toBe(true);

      const sites = await searchCodeGraphTool.execute({ calls: "Cache.Flush" }, ctx());
      // A dotted call target (`c.Flush`) counts as naming `Flush`.
      expect(sites.content).toContain("Probable (unresolved) call sites (25)");
      expect(sites.content).toContain("handler.go:419 ");
      expect(sites.content).not.toContain("handler.go:420 ");
      expect(sites.content.trimEnd().endsWith("…")).toBe(true);
    });

    it("a name matching nothing still says so", async () => {
      const res = await searchCodeGraphTool.execute({ calls: "NoSuchThing" }, ctx());
      expect(res.content).toBe('No symbol matching "NoSuchThing" found.');
    });
  },
);
