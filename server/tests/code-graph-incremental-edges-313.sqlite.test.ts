/**
 * #313 — an INCREMENTAL code-graph ingest must bind cross-file edges exactly as
 * a full ingest of the same tree would.
 *
 * Before the fix, the incremental path resolved edges only against the files it
 * re-parsed, so:
 *   1. a changed caller's edges into an UNCHANGED file came out `toSymbolId = NULL`;
 *   2. an unchanged caller's edges into a CHANGED file were nulled by the
 *      `onDelete: SetNull` cascade when the callee's symbols were re-created, and
 *      nothing re-bound them;
 *   3. a deleted file's symbols stayed in the graph, so edges kept pointing at code
 *      that no longer exists.
 *
 * Proven against a REAL SQLite database built from the migration chain — the
 * `SetNull` cascade is database behaviour a mock cannot reproduce. Each scenario
 * ingests tree v1 fully, rewrites it to v2, ingests incrementally, and compares
 * the edge table against a FRESH full ingest of v2 in a second project. Edges are
 * compared by the identity of their endpoints (file + qualified name + line),
 * never by raw ids, which differ between the two graphs.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ingestCodeGraph } from "../src/lib/code-graph/ingest.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

type Tree = Record<string, string | null>;

/** COBOL fixed format: sequence number, indicator (column 7), text from column 8. */
const fixed = (lines: string[]) =>
  lines.map((l, i) => `${String(i + 1).padStart(6, "0")}${l}`).join("\n");

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#313 — incremental ingest binds cross-file edges exactly as a full ingest does",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("313-incremental-edges");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-313-"));
      await db.user.create({
        data: { id: "u-313", username: "u-313", displayName: "u-313", email: "u-313@example.test" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    const newProject = async (): Promise<string> => {
      seq += 1;
      const p = await db.project.create({
        data: { name: `p313-${seq}`, slug: `p313-${seq}`, createdById: "u-313" },
      });
      return p.id;
    };

    /** Apply `tree` to `root`: a string writes the file, `null` deletes it. */
    const applyTree = async (root: string, tree: Tree) => {
      for (const [rel, content] of Object.entries(tree)) {
        const abs = path.join(root, rel);
        if (content === null) {
          await fs.rm(abs, { force: true });
          continue;
        }
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, content, "utf8");
      }
    };

    /** The graph's edges as endpoint identities, sorted — comparable across graphs. */
    const edgeTable = async (projectId: string): Promise<string[]> => {
      const symbols = await db.codeSymbol.findMany({
        where: { projectId },
        select: { id: true, filePath: true, qualifiedName: true, startLine: true },
      });
      const ident = new Map(
        symbols.map((s) => [s.id, `${s.filePath}|${s.qualifiedName}@${s.startLine}`]),
      );
      const edges = await db.codeEdge.findMany({ where: { projectId } });
      return edges
        .map((e) =>
          [
            e.kind,
            ident.get(e.fromSymbolId) ?? `DANGLING:${e.fromSymbolId}`,
            e.toQualifiedName,
            e.toSymbolId === null ? "NULL" : (ident.get(e.toSymbolId) ?? "DANGLING"),
            e.filePath,
            e.line,
          ].join(" | "),
        )
        .sort();
    };

    const symbolTable = async (projectId: string): Promise<string[]> =>
      (
        await db.codeSymbol.findMany({
          where: { projectId },
          select: { kind: true, filePath: true, qualifiedName: true, startLine: true },
        })
      )
        .map((s) => `${s.kind} ${s.filePath}|${s.qualifiedName}@${s.startLine}`)
        .sort();

    /**
     * Full-ingest `v1`, apply `v2`, ingest incrementally; full-ingest the final
     * tree into a fresh project. Returns both edge tables and the incremental stats.
     */
    const runScenario = async (v1: Tree, v2: Tree) => {
      seq += 1;
      const liveRoot = path.join(scratch, `live-${seq}`);
      const freshRoot = path.join(scratch, `fresh-${seq}`);
      await applyTree(liveRoot, v1);
      const live = await newProject();
      await ingestCodeGraph(db, { projectId: live, rootDir: liveRoot, incremental: false });
      await applyTree(liveRoot, v2);
      const stats = await ingestCodeGraph(db, { projectId: live, rootDir: liveRoot });

      await applyTree(freshRoot, { ...v1, ...v2 });
      const fresh = await newProject();
      await ingestCodeGraph(db, { projectId: fresh, rootDir: freshRoot, incremental: false });
      return {
        stats,
        incremental: await edgeTable(live),
        full: await edgeTable(fresh),
        incrementalSymbols: await symbolTable(live),
        fullSymbols: await symbolTable(fresh),
      };
    };

    const bound = (table: string[], kind: string, fromFile: string, toName: string) =>
      table.filter((row) => {
        const [k, from, , to] = row.split(" | ");
        return k === kind && from.startsWith(`${fromFile}|`) && to === toName;
      });

    // ── TS / JS ─────────────────────────────────────────────────────────────
    const TS_V1: Tree = {
      // Shape 2 — unchanged caller `a.ts`, callee `b.ts` changes.
      "src/b.ts": "export function helper() { return 1; }\n",
      "src/a.ts": 'import { helper } from "./b";\nexport function main() { return helper(); }\n',
      // Shape 1 — caller `f.ts` changes, callee `g.ts` does not.
      "src/g.ts": "export function util() { return 2; }\n",
      // A second `util`: only f.ts's import of ./g says which one it calls.
      "src/g2.ts": "export function util() { return 8; }\n",
      "src/f.ts": 'import { util } from "./g";\nexport function f() { return util(); }\n',
      // Deleted callee: `c.ts` calls into `d.ts`, which v2 removes.
      "src/d.ts": "export function gone() { return 3; }\n",
      "src/c.ts": 'import { gone } from "./d";\nexport function useGone() { return gone(); }\n',
      // New callee: `e.ts` calls a name no file defines until v2 adds `h.ts`.
      "src/e.ts": "export function callsLater() { return later(); }\n",
      // Newly ambiguous: `k.ts` binds `uniq` project-wide until v2 adds a second one.
      "src/i.ts": "export function uniq() { return 4; }\n",
      "src/k.ts": "export function k() { return uniq(); }\n",
      // An untouched pair that must stay exactly as it was.
      "src/y.ts": "export function stable() { return 5; }\n",
      "src/x.ts": 'import { stable } from "./y";\nexport function x() { return stable(); }\n',
    };
    const TS_V2: Tree = {
      // New symbols shift ids and lines inside b.ts.
      "src/b.ts": "export function added() { return 0; }\nexport function helper() { return 1; }\n",
      "src/f.ts":
        'import { util } from "./g";\n// edited\nexport function f() { return util() + 1; }\n',
      "src/d.ts": null,
      "src/h.ts": "export function later() { return 6; }\n",
      "src/j.ts": "export function uniq() { return 7; }\n",
    };

    it(
      "TS: the incremental edge table equals a fresh full ingest of the final tree",
      async () => {
        const r = await runScenario(TS_V1, TS_V2);
        expect(r.incremental).toEqual(r.full);
        expect(r.incrementalSymbols).toEqual(r.fullSymbols);
        // No duplicate rows (the sort above would hide nothing: compare as a multiset).
        expect(new Set(r.incremental).size).toBe(r.incremental.length);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it(
      "TS shape 1: a changed caller's edge into an unchanged file binds",
      async () => {
        const { incremental } = await runScenario(TS_V1, TS_V2);
        expect(bound(incremental, "calls", "src/f.ts", "src/g.ts|src/g.ts::util@1")).toHaveLength(
          1,
        );
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it(
      "TS shape 2: an unchanged caller's edge into a changed file is re-bound to the new symbol",
      async () => {
        const { incremental } = await runScenario(TS_V1, TS_V2);
        expect(bound(incremental, "calls", "src/a.ts", "src/b.ts|src/b.ts::helper@2")).toHaveLength(
          1,
        );
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it(
      "TS: edges into a deleted file unbind, a newly-defined callee binds, a newly-ambiguous one unbinds",
      async () => {
        const { incremental, incrementalSymbols } = await runScenario(TS_V1, TS_V2);
        expect(incrementalSymbols.some((s) => s.includes("src/d.ts"))).toBe(false);
        expect(bound(incremental, "calls", "src/c.ts", "NULL")).toHaveLength(1);
        expect(bound(incremental, "calls", "src/e.ts", "src/h.ts|src/h.ts::later@1")).toHaveLength(
          1,
        );
        expect(bound(incremental, "calls", "src/k.ts", "NULL")).toHaveLength(1);
        expect(bound(incremental, "calls", "src/x.ts", "src/y.ts|src/y.ts::stable@1")).toHaveLength(
          1,
        );
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    // ── COBOL ───────────────────────────────────────────────────────────────
    const program = (id: string, body: string[]) =>
      fixed([" IDENTIFICATION DIVISION.", ` PROGRAM-ID. ${id}.`, ...body]);
    const COBOL_V1: Tree = {
      // Shape 2 — unchanged ORDERS copies CUSTREC and PERFORMs ERRPARA's paragraph;
      // both copybooks change.
      "legacy/ORDERS.cbl": program("ORDERS", [
        " DATA DIVISION.",
        " WORKING-STORAGE SECTION.",
        "     COPY CUSTREC.",
        " PROCEDURE DIVISION.",
        " MAIN-PARA.",
        "     PERFORM ERROR-PARA",
        "     CALL 'PRICING'",
        "     GOBACK.",
        " CHECK-PARA.",
        "     COPY ERRPARA.",
      ]),
      "legacy/copy/CUSTREC.cpy": fixed([" 01  CUSTOMER-REC.", "     05 CU-ID PIC 9(8)."]),
      "legacy/copy/ERRPARA.cpy": fixed([" ERROR-PARA.", "     DISPLAY 'ERROR'."]),
      // Shape 1 — BILLING changes, the PRICING program it CALLs does not.
      "legacy/PRICING.cob": program("PRICING", [" PROCEDURE DIVISION.", " P1.", "     GOBACK."]),
      "legacy/BILLING.cbl": program("BILLING", [
        " DATA DIVISION.",
        " WORKING-STORAGE SECTION.",
        "     COPY CUSTREC.",
        " PROCEDURE DIVISION.",
        " B1.",
        "     CALL 'PRICING'",
        "     GOBACK.",
      ]),
      // Unchanged ONLYCOPY references nothing but the changed copybook's FILE —
      // no name it uses is defined by a changed file.
      "legacy/ONLYCOPY.cbl": program("ONLYCOPY", [
        " DATA DIVISION.",
        " WORKING-STORAGE SECTION.",
        "     COPY CUSTREC.",
      ]),
      // Unchanged LATE copies a copybook that only v2 adds: no symbol it could
      // name changes, only the file set the COPY resolves against.
      "legacy/LATE.cbl": program("LATE", [
        " DATA DIVISION.",
        " WORKING-STORAGE SECTION.",
        "     COPY NEWBOOK.",
      ]),
    };
    const COBOL_V2: Tree = {
      "legacy/copy/NEWBOOK.cpy": fixed([" 01  NEW-REC.", "     05 NR-ID PIC 9(4)."]),
      "legacy/copy/CUSTREC.cpy": fixed([
        " 01  CUSTOMER-REC.",
        "     05 CU-ID PIC 9(8).",
        "     05 CU-NAME PIC X(30).",
      ]),
      "legacy/copy/ERRPARA.cpy": fixed([
        " PRE-PARA.",
        "     DISPLAY 'PRE'.",
        " ERROR-PARA.",
        "     DISPLAY 'ERROR'.",
      ]),
      "legacy/BILLING.cbl": program("BILLING", [
        " DATA DIVISION.",
        " WORKING-STORAGE SECTION.",
        "     COPY CUSTREC.",
        " PROCEDURE DIVISION.",
        " B1.",
        "     DISPLAY 'BILLING'",
        "     CALL 'PRICING'",
        "     GOBACK.",
      ]),
    };

    it(
      "COBOL: the incremental edge table equals a fresh full ingest of the final tree",
      async () => {
        const r = await runScenario(COBOL_V1, COBOL_V2);
        expect(r.incremental).toEqual(r.full);
        expect(r.incrementalSymbols).toEqual(r.fullSymbols);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it(
      "COBOL: COPY and PERFORM from an unchanged program re-bind to changed copybooks; a changed program's CALL binds to an unchanged one",
      async () => {
        const { incremental } = await runScenario(COBOL_V1, COBOL_V2);
        const copy = incremental.filter(
          (r) => r.startsWith("imports | legacy/ORDERS.cbl|") && r.includes("| CUSTREC |"),
        );
        expect(copy).toHaveLength(1);
        expect(copy[0]).toContain("legacy/copy/CUSTREC.cpy|");
        const perform = incremental.filter(
          (r) => r.startsWith("calls | legacy/ORDERS.cbl|") && r.includes("| ERROR-PARA |"),
        );
        expect(perform).toHaveLength(1);
        expect(perform[0]).toContain("legacy/copy/ERRPARA.cpy|");
        const billingCopy = incremental.filter(
          (r) => r.startsWith("imports | legacy/BILLING.cbl|") && r.includes("| CUSTREC |"),
        );
        expect(billingCopy[0]).toContain("legacy/copy/CUSTREC.cpy|");
        const call = incremental.filter(
          (r) => r.startsWith("calls | legacy/BILLING.cbl|") && r.includes("| PRICING |"),
        );
        expect(call).toHaveLength(1);
        expect(call[0]).toContain("legacy/PRICING.cob|");
        const onlyCopy = incremental.filter(
          (r) => r.startsWith("imports | legacy/ONLYCOPY.cbl|") && r.includes("| CUSTREC |"),
        );
        expect(onlyCopy).toHaveLength(1);
        expect(onlyCopy[0]).toContain("legacy/copy/CUSTREC.cpy|");
        const late = incremental.filter(
          (r) => r.startsWith("imports | legacy/LATE.cbl|") && r.includes("| NEWBOOK |"),
        );
        expect(late).toHaveLength(1);
        expect(late[0]).toContain("legacy/copy/NEWBOOK.cpy|");
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );

    it(
      "a second incremental run with no changes leaves the edge table unchanged",
      async () => {
        seq += 1;
        const root = path.join(scratch, `noop-${seq}`);
        await applyTree(root, TS_V1);
        const projectId = await newProject();
        await ingestCodeGraph(db, { projectId, rootDir: root, incremental: false });
        const before = await edgeTable(projectId);
        const stats = await ingestCodeGraph(db, { projectId, rootDir: root });
        expect(stats.filesParsed).toBe(0);
        expect(stats.filesRebound).toBe(0);
        expect(await edgeTable(projectId)).toEqual(before);
      },
      MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
    );
  },
);
