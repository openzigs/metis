/**
 * #1831 (epic #1827) — when a repo's new code graph completes, every saved
 * code link into that repo is re-checked against it, with no model call.
 *
 * Real SQLite built from the migration chain and the REAL ingest
 * (`ingestCodeGraph`), over the synthetic trees committed in
 * `src/lib/traceability/__fixtures__/citation-freshness/scenarios.json`. Repo A
 * is ingested as `before`, its citations are written through the real seeder,
 * then A is re-ingested as `after`: the hook re-validates, and the links are
 * read back through the real traceability route on a FRESH Prisma client.
 *
 * Also: repo B's link is untouched by A's ingest; a failed ingest changes
 * nothing; a manual link is flagged, never rewritten; neither a model nor an
 * embedder is called; 5,000 links re-validate in a bounded number of queries;
 * and the #1831 migration applies up -> reverse -> up.
 */
import { promises as fs, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import express from "express";
import request from "supertest";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.AI_OFFLINE = "1";
  return { db: null as unknown };
});
const spies = vi.hoisted(() => ({
  getProvider: vi.fn(),
  buildProvider: vi.fn(),
  embedTexts: vi.fn(),
  enqueueSymbolEmbeddings: vi.fn(),
  embedProjectSymbols: vi.fn(),
}));
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
vi.mock("../src/lib/docs-gen/approved-requirements-staleness.js", () => ({
  noteRequirementCodeLinksChanged: vi.fn(),
}));
vi.mock("../src/lib/code-graph/sql-lineage-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/code-graph/sql-lineage-client.js")>();
  return { ...actual, isSqlLineageEnabled: () => false };
});
// No model, no embedder: every entry point is a spy that must stay uncalled.
vi.mock("../src/lib/ai/providers/factory.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ai/providers/factory.js")>()),
  getProvider: spies.getProvider,
  buildProvider: spies.buildProvider,
}));
vi.mock("../src/lib/ai/embeddings.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/ai/embeddings.js")>()),
  embedTexts: spies.embedTexts,
}));
vi.mock("../src/lib/code-graph/symbol-embedding-service.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/code-graph/symbol-embedding-service.js")>()),
  enqueueSymbolEmbeddings: spies.enqueueSymbolEmbeddings,
  embedProjectSymbols: spies.embedProjectSymbols,
}));

const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
const { traceabilityRouter } = await import("../src/routes/traceability.js");
const { errorHandler, notFoundHandler } = await import("../src/middleware/error-handler.js");
const { issueTokens } = await import("../src/lib/auth/jwt.js");
const { seedRequirementCodeLinksFromFindings } =
  await import("../src/lib/traceability/seed-code-links-from-findings.js");
const { revalidateCodeCitations } =
  await import("../src/lib/traceability/revalidate-code-citations.js");

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE = JSON.parse(
  readFileSync(
    path.join(SERVER_ROOT, "src/lib/traceability/__fixtures__/citation-freshness/scenarios.json"),
    "utf-8",
  ),
) as {
  before: Record<string, string>;
  after: Record<string, string>;
  citations: Array<{ name: string; filePath: string; startLine: number; endLine: number }>;
};

const USER = "u-1831";
const PROJ = "proj-1831";
const SHA_BEFORE = "1111111111111111111111111111111111111111";
const SHA_AFTER = "2222222222222222222222222222222222222222";
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

type Row = Awaited<ReturnType<PrismaClient["requirementCodeMapping"]["findMany"]>>[number];

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1831 — saved code links are re-validated when a repo's new graph completes",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let token = "";
    const repo = { A: "conn-A-1831", B: "conn-B-1831" };
    const graph = { A: "", B: "" };
    /** Requirement id per scenario name (`file:<path>` for a file-level citation). */
    const req = new Map<string, string>();
    let manualReq = "";
    let bReq = "";
    let rowsBeforeFailedIngest: Row[] = [];
    let bRowBefore: Row | undefined;

    const rootA = () => path.join(scratch, "repo-a");
    async function writeTree(root: string, files: Record<string, string>): Promise<void> {
      await fs.rm(root, { recursive: true, force: true });
      for (const [rel, content] of Object.entries(files)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), content);
      }
    }
    const ingestA = (commitSha: string, rootDir = rootA()) =>
      ingestCodeGraph(db, { projectId: PROJ, rootDir, repoConnectionId: repo.A, commitSha });

    const app = () => {
      const a = express();
      a.use(express.json());
      a.use("/api/projects/:projectId", traceabilityRouter());
      a.use(notFoundHandler);
      a.use(errorHandler);
      return a;
    };
    /** The requirement's one direct link, read through the route on a fresh client. */
    async function linkVia(requirementId: string): Promise<Record<string, unknown>> {
      const fresh = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      const previous = state.db;
      state.db = fresh;
      try {
        const res = await request(app())
          .get(`/api/projects/${PROJ}/requirements/${requirementId}/traceability`)
          .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(200);
        expect(res.body.data.directCode).toHaveLength(1);
        return res.body.data.directCode[0];
      } finally {
        state.db = previous;
        await fresh.$disconnect();
      }
    }
    const allRows = () =>
      db.requirementCodeMapping.findMany({ where: { projectId: PROJ }, orderBy: { id: "asc" } });

    async function requirementCiting(
      name: string,
      citation: Record<string, unknown>,
      agentResultId: string,
    ): Promise<string> {
      const finding = await db.finding.create({
        data: {
          agentResultId,
          category: "rationale",
          title: name,
          body: name,
          confidence: 0.8,
          evidence: JSON.stringify({ citations: [citation] }),
        },
      });
      return (
        await db.requirement.create({
          data: {
            projectId: PROJ,
            analysisId: "an-1831",
            title: name,
            body: name,
            labels: JSON.stringify([`finding:${finding.id}`]),
          },
        })
      ).id;
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1831-citation-revalidation");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-1831-"));
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
      await db.project.create({
        data: { id: PROJ, name: PROJ, slug: PROJ, createdById: USER },
      });
      await db.analysis.create({ data: { id: "an-1831", projectId: PROJ, startedById: USER } });
      for (const key of ["A", "B"] as const) {
        await db.repoConnection.create({
          data: { id: repo[key], projectId: PROJ, label: `repo-${key}`, createdById: USER },
        });
      }

      // Repo A as it was; repo B, which A's ingests must never touch.
      await writeTree(rootA(), FIXTURE.before);
      await ingestA(SHA_BEFORE);
      const rootB = path.join(scratch, "repo-b");
      await writeTree(rootB, {
        "src/other.ts": "export function other(): number {\n  return 7;\n}\n",
      });
      await ingestCodeGraph(db, {
        projectId: PROJ,
        rootDir: rootB,
        repoConnectionId: repo.B,
        commitSha: SHA_B,
      });
      for (const key of ["A", "B"] as const) {
        graph[key] = (
          await db.codeGraph.findFirstOrThrow({ where: { repoConnectionId: repo[key] } })
        ).id;
      }

      // The code agent's citations, one requirement each, written by the real seeder.
      const passA = await db.agentResult.create({
        data: { analysisId: "an-1831", agentKey: "code", connectorId: repo.A },
      });
      const passB = await db.agentResult.create({
        data: { analysisId: "an-1831", agentKey: "code", connectorId: repo.B },
      });
      for (const c of FIXTURE.citations) {
        req.set(
          c.name,
          await requirementCiting(
            c.name,
            { filePath: c.filePath, startLine: c.startLine, endLine: c.endLine },
            passA.id,
          ),
        );
      }
      for (const file of ["src/unchanged.ts", "src/deleted.ts"]) {
        req.set(
          `file:${file}`,
          await requirementCiting(
            `file ${file}`,
            { documentId: "d", chunkIndex: 0, filename: `connector:repo:${repo.A}:src/${file}` },
            passA.id,
          ),
        );
      }
      bReq = await requirementCiting(
        "other",
        { filePath: "src/other.ts", startLine: 2, endLine: 2 },
        passB.id,
      );
      const seeded = await seedRequirementCodeLinksFromFindings({
        analysisId: "an-1831",
        projectId: PROJ,
        requirementIds: [...req.values(), bReq],
      });
      expect(seeded.linksCreated).toBe(FIXTURE.citations.length + 3);

      // A person's link to `relocated`, with no stamp: it is attributed to A by its symbol.
      const relocatedBefore = await db.codeSymbol.findFirstOrThrow({
        where: { codeGraphId: graph.A, name: "relocated" },
      });
      manualReq = (
        await db.requirement.create({
          data: { projectId: PROJ, analysisId: "an-1831", title: "manual", body: "manual" },
        })
      ).id;
      await db.requirementCodeMapping.create({
        data: {
          requirementId: manualReq,
          projectId: PROJ,
          codeSymbolId: relocatedBefore.id,
          filePath: relocatedBefore.filePath,
          startLine: relocatedBefore.startLine,
          endLine: relocatedBefore.endLine,
          confidence: 1,
          source: "manual",
        },
      });

      token = issueTokens({
        userId: USER,
        username: USER,
        role: "admin",
        permissions: [],
        workspaces: [],
      }).accessToken;
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    it(
      "re-ingesting an unchanged tree keeps every link fresh and adopts the manual link",
      async () => {
        await ingestA(SHA_BEFORE);
        const rows = await allRows();
        const inA = rows.filter((r) => r.requirementId !== bReq);
        expect(inA.map((r) => r.freshness)).toEqual(inA.map(() => "fresh"));
        for (const r of inA) expect(r.codeGraphId).toBe(graph.A);
        const manual = rows.find((r) => r.requirementId === manualReq)!;
        expect(manual).toMatchObject({
          freshness: "fresh",
          symbolQualifiedName: "src/mover.ts::relocated",
          symbolKind: "function",
        });
        rowsBeforeFailedIngest = rows;
        bRowBefore = rows.find((r) => r.requirementId === bReq);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("a failed ingest re-validates nothing and moves no commit", async () => {
      await expect(ingestA(SHA_AFTER, path.join(scratch, "does-not-exist"))).rejects.toThrow();
      expect(await allRows()).toEqual(rowsBeforeFailedIngest);
      const g = await db.codeGraph.findUniqueOrThrow({ where: { id: graph.A } });
      expect(g.commitSha).toBe(SHA_BEFORE);
    });

    describe("after repo A changes", () => {
      /** Links written before #1831: no stored symbol identity. */
      const legacyReq = { stamped: "", unstamped: "" };
      let symbollessFileReq = "";
      beforeAll(async () => {
        // A link to `edited` as #1830 wrote it (stamped) and as a pre-#1830
        // writer did (unstamped): neither holds the symbol's identity, and the
        // ingest below deletes the symbol row they point at.
        const seeded = await db.requirementCodeMapping.findFirstOrThrow({
          where: { requirementId: req.get("edited") },
        });
        for (const kind of ["stamped", "unstamped"] as const) {
          legacyReq[kind] = (
            await db.requirement.create({
              data: { projectId: PROJ, analysisId: "an-1831", title: kind, body: kind },
            })
          ).id;
          await db.requirementCodeMapping.create({
            data: {
              requirementId: legacyReq[kind],
              projectId: PROJ,
              codeSymbolId: seeded.codeSymbolId,
              filePath: seeded.filePath,
              startLine: seeded.startLine,
              endLine: seeded.endLine,
              confidence: 0.8,
              source: "agent",
              ...(kind === "stamped"
                ? {
                    codeGraphId: graph.A,
                    commitSha: SHA_BEFORE,
                    freshness: "fresh",
                    validatedAt: new Date(),
                  }
                : {}),
            },
          });
        }
        // A file the walk finds but no parser gives a symbol: still in the repo.
        symbollessFileReq = (
          await db.requirement.create({
            data: { projectId: PROJ, analysisId: "an-1831", title: "notes", body: "notes" },
          })
        ).id;
        await db.requirementCodeMapping.create({
          data: {
            requirementId: symbollessFileReq,
            projectId: PROJ,
            filePath: "docs/notes.txt",
            confidence: 1,
            source: "manual",
            codeGraphId: graph.A,
            freshness: "fresh",
          },
        });
        await writeTree(rootA(), { ...FIXTURE.after, "docs/notes.txt": "release notes\n" });
        await ingestA(SHA_AFTER);
      }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

      it("a link written before #1831 whose symbol was edited is stale, never fresh", async () => {
        for (const kind of ["stamped", "unstamped"] as const) {
          const row = await db.requirementCodeMapping.findFirstOrThrow({
            where: { requirementId: legacyReq[kind] },
          });
          expect({ kind, ...row }).toMatchObject({
            kind,
            freshness: "stale",
            staleReason: "content-changed",
            codeGraphId: graph.A,
            filePath: "src/edited.ts",
            symbolQualifiedName: "src/edited.ts::edited",
            symbolKind: "function",
          });
        }
      });

      it("a file the graph walked but holds no symbol for is not file-missing", async () => {
        const row = await db.requirementCodeMapping.findFirstOrThrow({
          where: { requirementId: symbollessFileReq },
        });
        expect(row).toMatchObject({ freshness: "fresh", staleReason: null });
      });

      const symbolAfter = (name: string, filePath: string) =>
        db.codeSymbol.findFirstOrThrow({ where: { codeGraphId: graph.A, name, filePath } });

      it("unchanged symbol: fresh, at the same place, stamped with the new commit", async () => {
        const link = await linkVia(req.get("unchanged")!);
        const sym = await symbolAfter("unchanged", "src/unchanged.ts");
        expect(link).toMatchObject({
          freshness: "fresh",
          filePath: "src/unchanged.ts",
          startLine: sym.startLine,
          endLine: sym.endLine,
          commitSha: SHA_AFTER,
          staleReason: null,
          previousFilePath: null,
        });
      });

      it("lines shifted by an inserted function: fresh, lines and symbol updated", async () => {
        const before = rowsBeforeFailedIngest.find((r) => r.requirementId === req.get("shifted"))!;
        const sym = await symbolAfter("shifted", "src/shifted.ts");
        expect(sym.startLine).toBeGreaterThan(before.startLine!);
        const link = await linkVia(req.get("shifted")!);
        expect(link).toMatchObject({
          freshness: "fresh",
          filePath: "src/shifted.ts",
          startLine: sym.startLine,
          endLine: sym.endLine,
          codeSymbolId: sym.id,
          previousFilePath: null,
        });
      });

      it("function moved to another file: moved, rewritten in place, old location kept", async () => {
        const before = rowsBeforeFailedIngest.find(
          (r) => r.requirementId === req.get("relocated"),
        )!;
        const sym = await symbolAfter("relocated", "src/destination.ts");
        const link = await linkVia(req.get("relocated")!);
        expect(link).toMatchObject({
          freshness: "moved",
          filePath: "src/destination.ts",
          startLine: sym.startLine,
          endLine: sym.endLine,
          codeSymbolId: sym.id,
          previousFilePath: "src/mover.ts",
          previousStartLine: before.startLine,
          previousEndLine: before.endLine,
          staleReason: null,
        });
        // Rewritten, not duplicated.
        expect(
          await db.requirementCodeMapping.count({ where: { requirementId: req.get("relocated") } }),
        ).toBe(1);
      });

      it("file renamed: moved to the new file", async () => {
        const sym = await symbolAfter("renamedFile", "src/new-name.ts");
        expect(await linkVia(req.get("renamedFile")!)).toMatchObject({
          freshness: "moved",
          filePath: "src/new-name.ts",
          startLine: sym.startLine,
          previousFilePath: "src/old-name.ts",
        });
      });

      it("function body edited: stale, content-changed, location kept", async () => {
        expect(await linkVia(req.get("edited")!)).toMatchObject({
          freshness: "stale",
          staleReason: "content-changed",
          filePath: "src/edited.ts",
          previousFilePath: null,
          // Still the commit it last held at: "changed since <that commit>".
          commitSha: SHA_BEFORE,
        });
      });

      it("file deleted: stale, file-missing", async () => {
        expect(await linkVia(req.get("doomed")!)).toMatchObject({
          freshness: "stale",
          staleReason: "file-missing",
          filePath: "src/deleted.ts",
        });
      });

      it("two same-named functions after a split: stale, never moved to either", async () => {
        const link = await linkVia(req.get("handle")!);
        expect(link).toMatchObject({
          freshness: "stale",
          staleReason: "file-missing",
          filePath: "src/split.ts",
          previousFilePath: null,
        });
      });

      it("file-level links: fresh while the file is there, stale once it is gone", async () => {
        expect(await linkVia(req.get("file:src/unchanged.ts")!)).toMatchObject({
          freshness: "fresh",
          filePath: "src/unchanged.ts",
          codeSymbolId: null,
        });
        expect(await linkVia(req.get("file:src/deleted.ts")!)).toMatchObject({
          freshness: "stale",
          staleReason: "file-missing",
        });
      });

      it("a manual link is flagged, never rewritten", async () => {
        const before = rowsBeforeFailedIngest.find((r) => r.requirementId === manualReq)!;
        const after = await db.requirementCodeMapping.findFirstOrThrow({
          where: { requirementId: manualReq },
        });
        expect(after).toMatchObject({
          freshness: "stale",
          staleReason: "symbol-missing",
          filePath: before.filePath,
          startLine: before.startLine,
          endLine: before.endLine,
          previousFilePath: null,
          source: "manual",
          confidence: 1,
        });
        expect(await db.requirementCodeMapping.count({ where: { requirementId: manualReq } })).toBe(
          1,
        );
      });

      it("repo B's link is untouched by repo A's ingest", async () => {
        const after = await db.requirementCodeMapping.findFirstOrThrow({
          where: { requirementId: bReq },
        });
        expect(after).toEqual(bRowBefore);
        expect(after.codeGraphId).toBe(graph.B);
      });

      it("no model or embedding call was made", () => {
        for (const spy of Object.values(spies)) expect(spy).not.toHaveBeenCalled();
      });
    });

    it(
      "5,000 links re-validate in a bounded number of queries",
      async () => {
        const P = "proj-1831-bulk";
        await db.project.create({ data: { id: P, name: P, slug: P, createdById: USER } });
        await db.analysis.create({ data: { id: "an-bulk", projectId: P, startedById: USER } });
        const g = await db.codeGraph.create({ data: { projectId: P, commitSha: SHA_AFTER } });
        const symbols: Array<{
          id: string;
          name: string;
          filePath: string;
          qualifiedName: string;
          contentHash: string;
        }> = [];
        for (let i = 0; i < 20; i++) {
          symbols.push(
            await db.codeSymbol.create({
              data: {
                codeGraphId: g.id,
                projectId: P,
                kind: "function",
                name: `fn${i}`,
                qualifiedName: `src/f${i}.ts::fn${i}`,
                filePath: `src/f${i}.ts`,
                startLine: 1,
                endLine: 5,
                language: "ts",
                contentHash: `h${i}`,
              },
            }),
          );
        }
        const r = await db.requirement.create({
          data: { projectId: P, analysisId: "an-bulk", title: "bulk", body: "bulk" },
        });
        await db.requirementCodeMapping.createMany({
          data: Array.from({ length: 5000 }, (_, i) => {
            const s = symbols[i % 20];
            return {
              requirementId: r.id,
              projectId: P,
              codeSymbolId: s.id,
              filePath: s.filePath,
              startLine: 1,
              endLine: 5,
              source: "analysis-grounding",
              codeGraphId: g.id,
              freshness: "fresh",
              symbolQualifiedName: s.qualifiedName,
              symbolKind: "function",
              symbolContentHash: s.contentHash,
            };
          }),
        });
        // Half the symbols drift down by ten lines in the "new" graph.
        await db.codeSymbol.updateMany({
          where: { codeGraphId: g.id, name: { in: symbols.slice(0, 10).map((s) => s.name) } },
          data: { startLine: 11, endLine: 15 },
        });

        let queries = 0;
        const counted = db.$extends({
          query: {
            $allOperations({ args, query }) {
              queries++;
              return query(args);
            },
          },
        });
        const summary = await revalidateCodeCitations(
          counted as unknown as Parameters<typeof revalidateCodeCitations>[0],
          g.id,
        );
        expect(summary).toMatchObject({ checked: 5000, fresh: 5000, moved: 0, stale: 0 });
        // 5 reads, then one update per outcome (the unchanged links, and each
        // drifted symbol) in chunks of 500 ids: nowhere near one per link.
        expect(queries).toBeLessThanOrEqual(25);
        const drifted = await db.requirementCodeMapping.count({
          where: { projectId: P, startLine: 11, endLine: 15 },
        });
        expect(drifted).toBe(2500);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );
  },
);

const MIGRATION = "20261114001831_issue1831_citation_symbol_identity";
const NEW_COLUMNS = ["symbolContentHash", "symbolKind", "symbolQualifiedName"] as const;

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1831 — citation symbol-identity migration: up -> reverse -> up",
  () => {
    let sqlite: MigratedSqlite;
    const rollback = readFileSync(
      path.join(SERVER_ROOT, "prisma", "rollbacks", `${MIGRATION}.sql`),
      "utf-8",
    );
    const pgUp = readFileSync(
      path.join(SERVER_ROOT, "prisma", "postgres", "migrations", MIGRATION, "migration.sql"),
      "utf-8",
    );
    const pgDown = readFileSync(
      path.join(SERVER_ROOT, "prisma", "postgres", "rollbacks", `${MIGRATION}.sql`),
      "utf-8",
    );
    const withDb = <T>(fn: (db: Database.Database) => T): T => {
      const db = new Database(sqlite.dbFile);
      try {
        return fn(db);
      } finally {
        db.close();
      }
    };
    const columns = () =>
      withDb((db) =>
        (
          db.prepare(`PRAGMA table_info("requirement_code_mappings")`).all() as Array<{
            name: string;
          }>
        ).map((c) => c.name),
      );
    const row = () =>
      withDb((db) =>
        db
          .prepare(
            `SELECT "id","filePath","freshness","codeGraphId","source" FROM "requirement_code_mappings"`,
          )
          .all(),
      );
    let seeded: unknown;
    let before: string[];

    beforeAll(() => {
      sqlite = createMigratedSqlite("1831-symbol-identity-migration", { stopBefore: MIGRATION });
      withDb((db) => {
        db.pragma("foreign_keys = OFF");
        db.prepare(
          `INSERT INTO "requirement_code_mappings" ("id","requirementId","projectId","filePath","source","freshness","codeGraphId","createdAt")
           VALUES ('m-1','r-1','p-1','src/a.ts','analysis-grounding','fresh','g-1','2026-11-01T00:00:00.000Z')`,
        ).run();
      });
      seeded = row();
      before = columns();
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(() => sqlite?.cleanup());

    it(
      "up adds the three nullable columns; reverse restores the shape; up again re-applies",
      () => {
        for (const c of NEW_COLUMNS) expect(before).not.toContain(c);
        sqlite.apply(MIGRATION);
        expect(columns()).toEqual([...before, ...NEW_COLUMNS]);
        expect(row()).toEqual(seeded);
        withDb((db) => db.exec(rollback));
        expect(columns()).toEqual(before);
        expect(row()).toEqual(seeded);
        sqlite.applyRemaining();
        expect(columns()).toEqual(expect.arrayContaining([...NEW_COLUMNS]));
        expect(row()).toEqual(seeded);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it("the Postgres twin adds and drops the same columns, idempotently", () => {
      for (const c of NEW_COLUMNS) {
        expect(pgUp).toMatch(new RegExp(`ADD COLUMN IF NOT EXISTS "${c}" TEXT`));
        expect(pgDown).toMatch(new RegExp(`DROP COLUMN IF EXISTS "${c}";`));
      }
      expect(pgDown).toMatch(
        new RegExp(`DELETE FROM "_prisma_migrations" WHERE "migration_name" = '${MIGRATION}'`),
      );
    });
  },
);
