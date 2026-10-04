/**
 * #856 — a repository refresh on an unchanged commit must leave the code graph
 * that docs generation fingerprints untouched.
 *
 * In #706 run 3 a scheduled `refresh-repo-connector` on the same SHA
 * (`filesChanged 0`) re-created all 3,859 symbols and 28,232 edges. The trigger
 * was not the refresh as such: a database connector had been added since the
 * last ingest, so the SQL-lineage inputs changed and the #721 lineage backfill
 * re-parsed and re-persisted every file. Re-creating a symbol gives it a new id,
 * and `onDelete: SetNull` unlinks everything that pointed at the old one — the
 * rationale findings among them, which docs generation fingerprints by symbol
 * id. So the in-flight BRD's inputs "changed" although no file had.
 *
 * The fix re-extracts only the lineage of unchanged files on a backfill and
 * keeps their parser rows. Proven against a REAL SQLite database built from the
 * migration chain, because the `SetNull` and `Cascade` behaviour that loses the
 * findings and embeddings is database behaviour a mock cannot reproduce. The
 * fingerprint is the production `captureGenerationInputs` the commit fence in
 * `routes/generated-docs.ts` compares.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  ExtractUsageParams,
  ExtractUsageResult,
} from "../src/lib/code-graph/sql-lineage-client.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const state = vi.hoisted(() => {
  process.env.AI_OFFLINE = "1";
  return {
    db: null as unknown,
    lineageOn: true,
    responder: (_p: unknown): unknown => null,
  };
});

// `captureGenerationInputs` reads through the global client; point it at the
// migrated file. Ingest itself takes the client as an argument.
vi.mock("../src/lib/prisma.js", async () => {
  const { Prisma } = await import("@prisma/client");
  return {
    get prisma() {
      return state.db;
    },
    Prisma,
  };
});

// A scripted SQL-lineage sidecar: no network, a toggleable feature gate.
vi.mock("../src/lib/code-graph/sql-lineage-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/code-graph/sql-lineage-client.js")>();
  return {
    ...actual,
    isSqlLineageEnabled: () => state.lineageOn,
    extractUsageSafe: async (params: ExtractUsageParams) =>
      state.lineageOn ? state.responder(params) : null,
    probeSqlLineageSidecar: async () => true,
  };
});

const { ingestCodeGraph } = await import("../src/lib/code-graph/ingest.js");
const { captureGenerationInputs } = await import("../src/lib/docs-gen/generation-inputs.js");

const USER = "u-856";
const SCHEMA = { public: { users: { id: "INT", email: "TEXT" } } };

/** `SELECT * FROM users`: table-level without a schema, per column with one (#317). */
const usersResponder = (p: ExtractUsageParams): ExtractUsageResult => {
  if (/refresh_users/i.test(p.sql))
    return {
      tables: [],
      columns: [],
      lineage_edges: [],
      uncertain: [],
      routines: [{ schema: "", name: "refresh_users", qualifiedName: "refresh_users" }],
    };
  if (!/users/i.test(p.sql))
    return { tables: [], columns: [], lineage_edges: [], uncertain: [], routines: [] };
  const columns = p.schema
    ? (["id", "email"] as const).map((column) => ({
        table: "users",
        column,
        qualifiedName: `users.${column}`,
        access: "read" as const,
      }))
    : [];
  return {
    tables: [{ schema: "", name: "users", qualifiedName: "users", access: "read" }],
    columns,
    lineage_edges: [],
    uncertain: [],
    routines: [],
  };
};
/** The same answer whatever the schema: a backfill that changes no lineage. */
const schemaBlindResponder = (p: ExtractUsageParams): ExtractUsageResult =>
  usersResponder({ ...p, schema: null });

const TREE = {
  "repo.py": [
    "def load_users():",
    '    """Load every user row."""',
    '    return db.query("SELECT * FROM users")',
    "",
    "# No enclosing function: these hang off synthetic sql@/exec@ origins.",
    'TOTAL = db.query("SELECT * FROM users")',
    'db.execute("CALL refresh_users()")',
    "",
  ].join("\n"),
  "main.py": [
    "from repo import load_users",
    "",
    "def main():",
    '    """Entry point."""',
    "    return load_users()",
    "",
  ].join("\n"),
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#856 — a same-SHA refresh leaves the fingerprinted code graph untouched (real SQLite)",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("856-same-sha-refresh");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-856-"));
      await db.user.create({
        data: { id: USER, username: USER, displayName: USER, email: `${USER}@example.test` },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    beforeEach(() => {
      state.lineageOn = true;
      state.responder = usersResponder as (p: unknown) => unknown;
    });

    const fixture = async (
      tree: Record<string, string> = TREE,
    ): Promise<{ projectId: string; root: string }> => {
      seq += 1;
      const project = await db.project.create({
        data: { name: `p856-${seq}`, slug: `p856-${seq}`, createdById: USER },
      });
      const root = path.join(scratch, `tree-${seq}`);
      for (const [rel, content] of Object.entries(tree)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), content, "utf8");
      }
      return { projectId: project.id, root };
    };

    const ingest = (
      projectId: string,
      root: string,
      extra: Partial<Parameters<typeof ingestCodeGraph>[1]> = {},
    ) =>
      ingestCodeGraph(db, {
        projectId,
        rootDir: root,
        commitSha: "c4d54f87",
        triggeredByUserId: USER,
        ...extra,
      });

    /** Every row id, by table — what a requirement mapping or embedding points at. */
    const snapshot = async (projectId: string) => {
      const symbols = await db.codeSymbol.findMany({
        where: { projectId },
        select: { id: true, source: true, language: true, kind: true },
        orderBy: { id: "asc" },
      });
      const edges = await db.codeEdge.findMany({
        where: { projectId },
        select: { id: true, source: true },
        orderBy: { id: "asc" },
      });
      const parser = (r: { source: string | null }) => r.source === null;
      // What Step 6 writes per statement and rewrites on a backfill: the
      // synthetic `sql@`/`exec@` origins and the routines it invokes.
      const rewritten = (s: { kind: string; language: string }) =>
        s.language === "sql" && (s.kind === "method" || s.kind === "procedure");
      return {
        symbolIds: symbols.map((s) => s.id),
        keptSymbolIds: symbols.filter((s) => !rewritten(s)).map((s) => s.id),
        edgeIds: edges.map((e) => e.id),
        parserSymbolIds: symbols.filter((s) => parser(s) && s.language !== "sql").map((s) => s.id),
        parserEdgeIds: edges.filter(parser).map((e) => e.id),
        embeddings: (
          await db.codeSymbolEmbedding.findMany({
            where: { projectId },
            select: { id: true, symbolId: true },
            orderBy: { id: "asc" },
          })
        ).map((e) => `${e.id}>${e.symbolId}`),
        linkedFindings: (
          await db.finding.findMany({
            where: { symbolId: { not: null }, agentResult: { analysis: { projectId } } },
            select: { id: true, symbolId: true },
            orderBy: { id: "asc" },
          })
        ).map((f) => `${f.id}>${f.symbolId}`),
      };
    };

    /** The docs-gen inputs fingerprint the generated-docs commit fence compares. */
    const fingerprint = async (projectId: string): Promise<string> => {
      const graph = await db.codeGraph.findFirstOrThrow({ where: { projectId } });
      const snap = await captureGenerationInputs(
        { projectId, title: "BRD", scope: "project", scopeFilter: "{}", evidencePolicy: null },
        {
          projectId,
          generatedDocumentId: "g-856",
          actor: { userId: USER, role: "admin" },
          aclSubjects: [{ kind: "user", value: USER }],
          codeGraphId: graph.id,
          sharedDocumentIds: [],
          allowWebResearch: false,
        },
      );
      return snap.fingerprint;
    };

    /** Lineage rows as endpoint identities: comparable across two graphs. */
    const lineageTable = async (projectId: string): Promise<string[]> => {
      const symbols = await db.codeSymbol.findMany({ where: { projectId } });
      const ident = new Map(symbols.map((s) => [s.id, `${s.kind}:${s.qualifiedName}`]));
      const edges = await db.codeEdge.findMany({ where: { projectId, source: "sqlglot" } });
      const schemaSymbols = symbols
        .filter((s) => s.language === "sql")
        .map((s) => `symbol ${s.kind}:${s.qualifiedName} @${s.filePath}`);
      return [
        ...schemaSymbols,
        ...edges.map(
          (e) =>
            `edge ${e.kind} ${ident.get(e.fromSymbolId)} -> ${
              e.toSymbolId ? ident.get(e.toSymbolId) : "NULL"
            } @${e.filePath}:${e.line}`,
        ),
      ].sort();
    };

    it("an unchanged refresh changes no row, id or fingerprint", async () => {
      const { projectId, root } = await fixture();
      await ingest(projectId, root);
      const before = await snapshot(projectId);
      const fpBefore = await fingerprint(projectId);

      const stats = await ingest(projectId, root);

      expect(stats.filesParsed).toBe(0);
      expect(stats.lineageBackfill).toBe(false);
      expect(await snapshot(projectId)).toEqual(before);
      expect(await fingerprint(projectId)).toBe(fpBefore);
    });

    it("a lineage backfill on the same SHA keeps every parser id, link and the fingerprint", async () => {
      state.responder = schemaBlindResponder as (p: unknown) => unknown;
      const { projectId, root } = await fixture();
      await ingest(projectId, root);
      const before = await snapshot(projectId);
      const fpBefore = await fingerprint(projectId);
      // The run-3 shape: findings linked to the symbols they were extracted from.
      expect(before.linkedFindings.length).toBeGreaterThan(0);
      expect(before.embeddings.length).toBeGreaterThan(0);

      // A database connector was added: the lineage inputs change, the files do not.
      const stats = await ingest(projectId, root, { introspectedSchema: SCHEMA });

      expect(stats.lineageBackfill).toBe(true);
      expect(stats.filesParsed).toBe(0);
      expect(stats.filesLineageRefreshed).toBe(2);
      const after = await snapshot(projectId);
      expect(after.parserSymbolIds).toEqual(before.parserSymbolIds);
      expect(after.parserEdgeIds).toEqual(before.parserEdgeIds);
      // Lineage table/column symbols are reused too, not re-created. Only the
      // lineage edges and the per-statement origins and routines are rewritten.
      expect(after.keptSymbolIds).toEqual(before.keptSymbolIds);
      expect(after.symbolIds).toHaveLength(before.symbolIds.length);
      expect(after.edgeIds).toHaveLength(before.edgeIds.length);
      expect(after.embeddings).toEqual(before.embeddings);
      expect(after.linkedFindings).toEqual(before.linkedFindings);
      expect(await fingerprint(projectId)).toBe(fpBefore);
    });

    it("a lineage backfill writes the same lineage a fresh full ingest does, with no duplicates", async () => {
      const { projectId, root } = await fixture();
      await ingest(projectId, root);
      const tableLevel = await lineageTable(projectId);

      const stats = await ingest(projectId, root, { introspectedSchema: SCHEMA });
      expect(stats.lineageBackfill).toBe(true);

      const fresh = await fixture();
      await ingest(fresh.projectId, fresh.root, { introspectedSchema: SCHEMA });
      const lineage = await lineageTable(projectId);
      expect(lineage).toEqual(await lineageTable(fresh.projectId));
      // The schema expanded SELECT * into per-column reads.
      expect(lineage.length).toBeGreaterThan(tableLevel.length);
      // Every kind of Step 6 row is in play: synthetic origins and a routine.
      expect(lineage).toContain("symbol method:repo.py::sql@6 @repo.py");
      expect(lineage).toContain("symbol method:repo.py::exec@7 @repo.py");
      expect(lineage).toContain("symbol procedure:refresh_users @repo.py");

      // Back to no schema: the column rows the schema produced are gone again.
      await ingest(projectId, root, { introspectedSchema: null });
      expect(await lineageTable(projectId)).toEqual(tableLevel);
    });

    it("#867 — a backfill never leaves a catalog-deps edge pointing at a deleted routine", async () => {
      // A catalog dependency into the routine repo.py invokes: the writer files
      // `refresh_users` under repo.py, and the catalog edge reuses that symbol.
      const dependencies = [
        {
          schema: "",
          name: "nightly_job",
          type: "PROCEDURE",
          referencedSchema: "",
          referencedName: "refresh_users",
          referencedType: "PROCEDURE",
        },
      ];
      const dangling = (projectId: string) =>
        db.codeEdge.count({ where: { projectId, source: "catalog-deps", toSymbolId: null } });
      const { projectId, root } = await fixture();
      await ingest(projectId, root, { dependencies });
      const routine = await db.codeSymbol.findFirstOrThrow({
        where: { projectId, kind: "procedure", qualifiedName: "refresh_users" },
      });
      const catalogEdges = await db.codeEdge.findMany({
        where: { projectId, source: "catalog-deps" },
      });
      expect(catalogEdges.map((e) => e.toSymbolId)).toContain(routine.id);
      expect(routine.filePath).toBe("repo.py");
      expect(await dangling(projectId)).toBe(0);

      // Backfill with the catalog pass re-run, then one where it is not.
      for (const extra of [
        { dependencies, introspectedSchema: SCHEMA },
        { introspectedSchema: null },
      ]) {
        const stats = await ingest(projectId, root, extra);
        expect(stats.lineageBackfill).toBe(true);
        expect(await dangling(projectId)).toBe(0);
      }
    });

    it("#867 — a backfill refreshes an unchanged SAS file's PROC SQL lineage", async () => {
      const sas = "report.sas";
      const { projectId, root } = await fixture({
        ...TREE,
        [sas]: [
          "/* Nightly user report. */",
          "proc sql;",
          "  create table work.report as select * from users;",
          "quit;",
          "",
        ].join("\n"),
      });
      const sasLineage = async () => (await lineageTable(projectId)).filter((r) => r.includes(sas));
      await ingest(projectId, root);
      const tableLevel = await sasLineage();
      expect(tableLevel.some((r) => r.startsWith("edge") && r.includes("table:users"))).toBe(true);
      expect(tableLevel.some((r) => r.includes("column:users."))).toBe(false);

      // A schema arrives: the SAS file is unchanged, so only its lineage is redone.
      const stats = await ingest(projectId, root, { introspectedSchema: SCHEMA });

      expect(stats.lineageBackfill).toBe(true);
      expect(stats.filesParsed).toBe(0);
      expect(stats.filesLineageRefreshed).toBe(3);
      const refreshed = await sasLineage();
      // The schema expanded its SELECT * into per-column reads, as a fresh ingest would.
      expect(refreshed.some((r) => r.startsWith("edge") && r.includes("column:users.email"))).toBe(
        true,
      );
      const fresh = await fixture({ [sas]: await fs.readFile(path.join(root, sas), "utf8") });
      await ingest(fresh.projectId, fresh.root, { introspectedSchema: SCHEMA });
      const freshEdges = (await lineageTable(fresh.projectId)).filter((r) => r.startsWith("edge"));
      expect(refreshed.filter((r) => r.startsWith("edge"))).toEqual(freshEdges);
    });

    it("turning lineage off drops every lineage row and keeps the parser ids", async () => {
      const { projectId, root } = await fixture();
      await ingest(projectId, root, { introspectedSchema: SCHEMA });
      const before = await snapshot(projectId);
      expect(await lineageTable(projectId)).not.toHaveLength(0);

      state.lineageOn = false;
      const stats = await ingest(projectId, root, { introspectedSchema: SCHEMA });

      expect(stats.lineageBackfill).toBe(true);
      expect(await lineageTable(projectId)).toEqual([]);
      const after = await snapshot(projectId);
      expect(after.parserSymbolIds).toEqual(before.parserSymbolIds);
      expect(after.parserEdgeIds).toEqual(before.parserEdgeIds);
    });

    it("a changed file still re-parses; a forced full ingest still rebuilds every row", async () => {
      const { projectId, root } = await fixture();
      await ingest(projectId, root);
      const before = await snapshot(projectId);

      await fs.appendFile(path.join(root, "main.py"), "\ndef extra():\n    return 1\n", "utf8");
      const changed = await ingest(projectId, root, { commitSha: "0ddba11" });
      expect(changed.filesParsed).toBe(1);
      const afterChange = await snapshot(projectId);
      expect(afterChange.symbolIds).not.toEqual(before.symbolIds);
      expect(afterChange.symbolIds.length).toBe(before.symbolIds.length + 1);

      const forced = await ingest(projectId, root, { commitSha: "0ddba11", incremental: false });
      expect(forced.filesParsed).toBe(2);
      const afterForced = await snapshot(projectId);
      expect(
        afterForced.parserSymbolIds.some((id) => afterChange.parserSymbolIds.includes(id)),
      ).toBe(false);
    });
  },
);
