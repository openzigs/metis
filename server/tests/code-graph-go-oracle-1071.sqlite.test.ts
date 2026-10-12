/**
 * #1071 — the Go oracle corpus through a REAL ingest.
 *
 * `tests/lib/code-graph/go-oracle-corpus.test.ts` compares the walker and the
 * resolver with the Go type checker. This suite does the same for what an
 * ingest STORES — the binding step of `ingest.ts` sits between a verdict and a
 * row, and a mutant there (a decided verdict sent on to the name rules, a
 * `_test.go` file not treated as one) changes rows without changing a verdict.
 * Against a real SQLite database built from the migration chain, for every
 * view of the corpus:
 *
 *  1. each `calls` row is exactly what the resolver's verdict says: a bound
 *     verdict stores its target and how it was bound; a decided one stores its
 *     reason and NO target; an undecided one stores a target only through the
 *     name rules, labelled `name`;
 *  2. the rows, read back as verdicts, pass the oracle comparison: no row
 *     bound by type points anywhere but at the type checker's target;
 *  3. what the name rules bound — the part of the graph no type decided — is a
 *     checked-in list with the type checker's answer beside each, so a change
 *     in what they guess is a diff. It is reported, not asserted correct.
 *
 * And an incremental ingest that re-binds unchanged files stores the same rows.
 */
import { cpSync, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  GO_RESOLUTION_KEY,
  type GoBinding,
  type GoCallVerdict,
  type GoUnboundReason,
} from "../src/lib/code-graph/go-type-resolution.js";
import { ingestCodeGraph } from "../src/lib/code-graph/ingest.js";
import {
  compareWithOracle,
  GO_ORACLE_ALLOW,
  GO_ORACLE_FIXTURE,
  GO_ORACLE_VIEWS,
  loadGoOracle,
  type MetisCall,
  metisCallsOfView,
  oracleCallsFor,
  type OracleView,
  qualifiedNameOf,
  readOracleView,
  showAnswer,
} from "./helpers/go-oracle.js";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const BINDINGS: readonly string[] = [
  "package",
  "same-package",
  "receiver-type",
] satisfies GoBinding[];
const REASONS: readonly string[] = [
  "external",
  "external-assumed",
  "interface",
  "func-value",
  "conversion",
  "ambiguous",
] satisfies GoUnboundReason[];

interface StoredCall {
  from: string;
  to: string | null;
  /** `metadata.goResolution`, or null when the row carries none. */
  how: string | null;
}

/** What a verdict must be stored as; an undecided call may be bound by the name rules, or not. */
function expectedRow(verdict: GoCallVerdict, row: StoredCall): string | null {
  if (verdict.kind === "bound") {
    return row.to === verdict.qualifiedName && row.how === verdict.via
      ? null
      : `bound ${verdict.via} ${verdict.qualifiedName}`;
  }
  if (verdict.kind === "unbound") {
    return row.to === null && row.how === verdict.reason
      ? null
      : `unbound ${verdict.reason}, no target`;
  }
  const byName = row.to !== null && row.how === "name";
  const open = row.to === null && row.how === null;
  return byName || open ? null : "undecided: no target and no verdict, or a target labelled `name`";
}

/** A stored row read back as the verdict it records. */
function asVerdict(row: StoredCall): GoCallVerdict {
  if (row.how !== null && BINDINGS.includes(row.how) && row.to !== null) {
    return { kind: "bound", qualifiedName: row.to, via: row.how as GoBinding };
  }
  if (row.how !== null && REASONS.includes(row.how)) {
    return { kind: "unbound", reason: row.how as GoUnboundReason };
  }
  return { kind: "unknown" };
}

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1071 — the Go oracle corpus through a real ingest",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;
    const snapshot = loadGoOracle();

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1071-go-oracle");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-1071-oracle-"));
      await db.user.create({
        data: {
          id: "u-oracle",
          username: "u-oracle",
          displayName: "u-oracle",
          email: "u-oracle@example.test",
        },
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
        data: { name: `oracle-${seq}`, slug: `oracle-${seq}`, createdById: "u-oracle" },
      });
      return p.id;
    };

    const ingest = (projectId: string, root: string, incremental = true) =>
      ingestCodeGraph(db, { projectId, rootDir: root, incremental, sqlLineageOverride: false });

    /** Every stored Go `calls` row, by `file:line:name`; a second row under a key is reported. */
    const storedCalls = async (
      projectId: string,
    ): Promise<{ rows: Map<string, StoredCall>; duplicates: string[] }> => {
      const edges = await db.codeEdge.findMany({
        where: { projectId, kind: "calls" },
        include: {
          toSymbol: { select: { qualifiedName: true } },
          fromSymbol: { select: { qualifiedName: true } },
        },
        orderBy: { id: "asc" },
      });
      const rows = new Map<string, StoredCall>();
      const duplicates: string[] = [];
      for (const e of edges) {
        const key = `${e.filePath}:${e.line}:${e.toQualifiedName}`;
        if (rows.has(key)) duplicates.push(key);
        rows.set(key, {
          from: e.fromSymbol.qualifiedName,
          to: e.toSymbol?.qualifiedName ?? null,
          how: e.metadata
            ? ((JSON.parse(e.metadata) as Record<string, string>)[GO_RESOLUTION_KEY] ?? null)
            : null,
        });
      }
      return { rows, duplicates };
    };

    /** The three assertions for one ingested view; returns the name-bound report. */
    const check = (
      view: OracleView,
      stored: { rows: Map<string, StoredCall>; duplicates: string[] },
    ): string[] => {
      const pure = metisCallsOfView(readOracleView(view)).calls;
      expect(stored.duplicates).toEqual([]);
      expect([...stored.rows.keys()].sort()).toEqual([...pure.keys()].sort());

      // 1. Every row is what the resolver's verdict says.
      const miswired: string[] = [];
      for (const [key, call] of pure) {
        const row = stored.rows.get(key)!;
        const want = expectedRow(call.verdict, row);
        if (want)
          miswired.push(`${key}: stored ${row.to ?? "NULL"} (${row.how ?? "-"}); want ${want}`);
        if (row.from !== call.from)
          miswired.push(`${key}: stored under ${row.from}; want ${call.from}`);
      }
      expect(miswired).toEqual([]);

      // 2. The rows pass the oracle comparison themselves.
      const asCalls = new Map<string, MetisCall>();
      for (const [key, row] of stored.rows) {
        asCalls.set(key, { key, from: row.from, verdict: asVerdict(row) });
      }
      const oracle = oracleCallsFor(snapshot, view);
      const cmp = compareWithOracle(view, oracle, asCalls, GO_ORACLE_ALLOW);
      expect(cmp.findings).toEqual([]);
      expect(cmp.stats.boundAgreeing).toBeGreaterThan(0);

      // 3. What the name rules bound, with the type checker's answer.
      const answers = new Map<string, string>();
      const prefix = `${view.root}/`;
      for (const c of oracle) {
        if (c.form === "other" || !c.file.startsWith(prefix)) continue;
        const agreed =
          c.answer.k === "func"
            ? qualifiedNameOf(c.answer.target!, view)
            : showAnswer(c.answer, view);
        answers.set(`${c.file.slice(prefix.length)}:${c.line}:${c.name}`, agreed);
      }
      const byName: string[] = [];
      for (const [key, row] of stored.rows) {
        if (row.how !== "name") continue;
        const truth = answers.get(key)!;
        byName.push(
          `${key} -> ${row.to} [${truth === row.to ? "agrees" : `type checker: ${truth}`}]`,
        );
      }
      return byName.sort();
    };

    it("every view: the stored rows are the resolver's verdicts and agree with the type checker", async () => {
      const report: Record<string, unknown> = {};
      for (const view of GO_ORACLE_VIEWS) {
        const projectId = await newProject();
        const stats = await ingest(projectId, path.join(GO_ORACLE_FIXTURE, view.root));
        expect(stats.goBinding?.errors).toBe(0);
        expect(stats.goBinding?.overBudget).toBe(0);
        expect(stats.goBinding?.skipped).toBe(0);
        const stored = await storedCalls(projectId);
        expect(stats.goBinding?.calls).toBe(stored.rows.size);
        const byName = check(view, stored);
        const agreeing = byName.filter((l) => l.endsWith("[agrees]")).length;
        report[view.name] = {
          calls: stored.rows.size,
          boundByName: byName.length,
          boundByNameAgreeing: agreeing,
          boundByName_list: byName,
        };
      }
      await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot(
        path.join(GO_ORACLE_FIXTURE, "name-bound.snapshot.json"),
      );
    }, 120_000);

    it("an incremental ingest that re-binds unchanged files stores the same rows", async () => {
      const view = GO_ORACLE_VIEWS[0];
      const root = path.join(scratch, "modules");
      cpSync(path.join(GO_ORACLE_FIXTURE, view.root), root, { recursive: true });
      const projectId = await newProject();
      await ingest(projectId, root);
      const first = await storedCalls(projectId);
      // One Go file changes without changing a declaration or a call's line:
      // every other Go file is re-bound in place (pass 3).
      await fs.appendFile(path.join(root, "app/model/model.go"), "\n// touched\n");
      const stats = await ingest(projectId, root);
      expect(stats.filesParsed).toBe(1);
      expect(stats.filesRebound).toBeGreaterThan(30);
      const second = await storedCalls(projectId);
      const byKey = (rows: Map<string, StoredCall>) =>
        [...rows].sort(([a], [b]) => (a < b ? -1 : 1));
      expect(byKey(second.rows)).toEqual(byKey(first.rows));
      check(view, second);
    }, 120_000);
  },
);
