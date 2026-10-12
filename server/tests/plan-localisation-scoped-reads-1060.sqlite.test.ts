/**
 * #1060 — the scoped reads of the plan localisation against a REAL SQLite
 * code graph.
 *
 * The walk reads only what it follows: the Go calls out of its frontier, the
 * callee names of the retrieved functions and of their possible twins, the
 * readers of a table, the functions of a retrieved file. The claim for each is
 * "the same answer as the whole-project read, for less", and the unit tests
 * state it against a mocked Prisma whose queries return what the test hands
 * them, often `[]`.
 *
 * A mocked query that returns nothing cannot show an excluded item coming back
 * THROUGH that query. PR #1094's second review found exactly that: a retrieved
 * function the callee-name pool had left out was returned by the candidate
 * query (it shares names with the pool), read back in and compared, under a
 * note saying it had not been. The unit test mocked `groupBy` to `[]`. So each
 * scoped read has a case here, where the database decides what comes back.
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

const { loadResolvedGoCalls, loadResolvedGoCallsFrom } =
  await import("../src/lib/impact-analysis/go-call-resolution.js");
const { findStructuralTwins, MAX_TWIN_SEEDS } =
  await import("../src/lib/impact-analysis/structural-twins.js");
const {
  createDefaultPlanLocalisationSource,
  TWIN_MAX_CANDIDATES,
  TWIN_MAX_CANDIDATE_CALL_EDGES,
  TWIN_MAX_POOLED_CALLEE_NAMES,
} = await import("../src/lib/spec-kit/plan-localisation.js");

/** A fixed sequence: the same graph and the same samples on every run. */
function sequence(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

interface SymbolRow {
  id: string;
  codeGraphId: string;
  projectId: string;
  kind: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  startLine: number;
  endLine: number;
  language: string;
  contentHash: string;
}
interface EdgeRow {
  codeGraphId: string;
  projectId: string;
  kind: string;
  fromSymbolId: string;
  toSymbolId: string | null;
  toQualifiedName: string | null;
  filePath: string;
  line: number;
}

const fn = (projectId: string, id: string, filePath: string, name = id): SymbolRow => ({
  id,
  codeGraphId: `g-${projectId}`,
  projectId,
  kind: "function",
  name,
  qualifiedName: `${filePath}::${name}`,
  filePath,
  startLine: 1,
  endLine: 9,
  language: "go",
  contentHash: id,
});
const call = (projectId: string, from: string, callee: string): EdgeRow => ({
  codeGraphId: `g-${projectId}`,
  projectId,
  kind: "calls",
  fromSymbolId: from,
  toSymbolId: null,
  toQualifiedName: callee,
  filePath: `x/${from}.go`,
  line: 1,
});

const GO = "p-go";
const OTHER = "p-other";
const POOL = "p-pool";
const POOL_FIXED = "p-pool-fixed";
const MANY = "p-many";
const HEAVY = "p-heavy";
const CHUNK = "p-chunk";
const PROJECTS = [GO, OTHER, POOL, POOL_FIXED, MANY, HEAVY, CHUNK];

/**
 * Directories chosen to break a scoped read that is not exact: one that is a
 * prefix of another, two that differ only by a LIKE wildcard (`%`, `_`), two
 * that differ only by case, and the repository root.
 */
const DIRS = [
  "",
  "internal/storage",
  "internal/store_x",
  "internal/storeYx",
  "internal/ui",
  "internal/ui/sub",
  "internal/api",
  "other/storage",
  "pkg/a%b",
  "pkg/aZZb",
  "internal/UI",
];
const NAMES = Array.from({ length: 40 }, (_, i) => `Fn${i}`);

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1060 — the plan localisation's scoped reads on a real SQLite code graph",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    /** The Go functions of {@link GO}. */
    const goFunctionIds: string[] = [];

    async function insert(symbols: SymbolRow[], edges: EdgeRow[]): Promise<void> {
      for (let i = 0; i < symbols.length; i += 200) {
        await db.codeSymbol.createMany({ data: symbols.slice(i, i + 200) });
      }
      for (let i = 0; i < edges.length; i += 200) {
        await db.codeEdge.createMany({ data: edges.slice(i, i + 200) });
      }
    }

    /**
     * A Go project where one name is declared in up to eleven packages, twice in
     * some, and called bare, through a field (`h.store.X`) and through a package
     * (`storage.X`). Built twice, in two projects, with the same paths and names.
     */
    function goGraph(projectId: string, rnd: () => number) {
      const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
      const graph = `g-${projectId}`;
      const symbols: SymbolRow[] = [];
      const edges: EdgeRow[] = [];
      const functions: Array<{ id: string; path: string }> = [];
      let n = 0;
      for (const dir of DIRS) {
        for (const file of ["a.go", "b.go", "c_test.go"]) {
          const path = dir === "" ? file : `${dir}/${file}`;
          const moduleId = `${projectId}-m${n++}`;
          symbols.push({
            ...fn(projectId, moduleId, path, file),
            kind: "module",
            qualifiedName: path,
            endLine: 999,
          });
          for (let k = 0; k < 3; k++) {
            const imported = pick(DIRS);
            if (!imported) continue;
            edges.push({
              codeGraphId: graph,
              projectId,
              kind: "imports",
              fromSymbolId: moduleId,
              toSymbolId: null,
              toQualifiedName: `example.com/m/${imported}`,
              filePath: path,
              line: 1,
            });
          }
          const declared = 4 + Math.floor(rnd() * 8);
          for (let k = 0; k < declared; k++) {
            const id = `${projectId}-f${n++}`;
            symbols.push({
              ...fn(projectId, id, path, pick(NAMES)),
              kind: rnd() < 0.2 ? "method" : "function",
              startLine: k * 20 + 1,
              endLine: k * 20 + 15,
            });
            functions.push({ id, path });
          }
        }
      }
      // Functions built from a few shared templates, so structural twins exist.
      const templates = Array.from({ length: 12 }, () =>
        Array.from({ length: 6 + Math.floor(rnd() * 8) }, () => pick(NAMES)),
      );
      for (const f of functions) {
        const template =
          rnd() < 0.6
            ? pick(templates)
            : Array.from({ length: Math.floor(rnd() * 10) }, () => pick(NAMES));
        const callees = template.filter(() => rnd() < 0.9);
        if (rnd() < 0.5) callees.push(pick(NAMES));
        if (rnd() < 0.3 && callees.length > 0) callees.push(callees[0] as string);
        for (const callee of callees) {
          const shape = rnd();
          const written =
            shape < 0.4
              ? callee
              : shape < 0.6
                ? `h.store.${callee}`
                : shape < 0.7
                  ? `storage.${callee}`
                  : callee;
          edges.push({
            codeGraphId: graph,
            projectId,
            kind: "calls",
            fromSymbolId: f.id,
            toSymbolId: rnd() < 0.15 ? pick(functions).id : null,
            toQualifiedName: rnd() < 0.03 ? null : written,
            filePath: f.path,
            line: 1,
          });
        }
      }
      return { symbols, edges, functionIds: functions.map((f) => f.id) };
    }

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1060-scoped-reads");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      state.db = db;
      await db.user.create({
        data: { id: "u", username: "u", displayName: "U", email: "u@example.test" },
      });
      for (const id of PROJECTS) {
        await db.project.create({
          data: { id, name: id, slug: id, description: "", createdById: "u" },
        });
        await db.codeGraph.create({ data: { id: `g-${id}`, projectId: id } });
      }
      const rnd = sequence(12345);
      for (const projectId of [GO, OTHER]) {
        const g = goGraph(projectId, rnd);
        await insert(g.symbols, g.edges);
        if (projectId === GO) goFunctionIds.push(...g.functionIds);
      }
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
    });

    it("Go calls: the frontier-scoped read equals the whole-project resolution filtered by caller", async () => {
      const rnd = sequence(777);
      const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
      const key = (c: { fromSymbolId: string; toSymbolId: string }) =>
        `${c.fromSymbolId}>${c.toSymbolId}`;
      const whole = await loadResolvedGoCalls(db, GO);
      // The fixture does bind calls: an empty answer on both sides proves nothing.
      expect(whole.length).toBeGreaterThan(50);
      let bound = 0;
      for (let t = 0; t < 60; t++) {
        const frontier =
          t === 0
            ? [...goFunctionIds]
            : [
                ...new Set(
                  Array.from({ length: 1 + Math.floor(rnd() * 60) }, () => pick(goFunctionIds)),
                ),
              ];
        const wanted = new Set(frontier);
        const expected = whole
          .filter((c) => wanted.has(c.fromSymbolId))
          .map(key)
          .sort();
        const scoped = (await loadResolvedGoCallsFrom(db, GO, frontier)).map(key).sort();
        expect(scoped, `frontier ${t}`).toEqual(expected);
        bound += expected.length;
      }
      expect(bound).toBeGreaterThan(100);
    }, 60_000);

    it("twins: the scoped callee-name read finds the whole-project twins, past MAX_TWIN_SEEDS too", async () => {
      const rnd = sequence(4242);
      const pick = <T>(a: readonly T[]): T => a[Math.floor(rnd() * a.length)] as T;
      const rows = await db.codeEdge.findMany({
        where: { projectId: GO, kind: "calls", toQualifiedName: { not: null } },
        select: { fromSymbolId: true, toQualifiedName: true },
      });
      const whole = new Map<string, Set<string>>();
      for (const r of rows) {
        whole.set(
          r.fromSymbolId,
          (whole.get(r.fromSymbolId) ?? new Set<string>()).add(r.toQualifiedName as string),
        );
      }
      const source = createDefaultPlanLocalisationSource(GO);
      let twins = 0;
      let overSeedCap = 0;
      for (let t = 0; t < 60; t++) {
        const seeds = [
          ...new Set(
            Array.from({ length: 1 + Math.floor(rnd() * (t % 5 === 0 ? 110 : 20)) }, () =>
              pick(goFunctionIds),
            ),
          ),
        ];
        if (seeds.length > MAX_TWIN_SEEDS) overSeedCap++;
        const load = await source.calleeNameSets(seeds);
        expect(load.skipped).toBeUndefined();
        expect(load.notes).toEqual([]);
        const expected = findStructuralTwins(seeds, whole);
        expect(findStructuralTwins(seeds, load.sets), `seed set ${t}`).toEqual(expected);
        twins += expected.length;
      }
      expect(twins).toBeGreaterThan(50);
      // Seeds past the 60th are never read as seeds, and the database does return
      // them as candidates of the first 60: the result still has to be the same.
      expect(overSeedCap).toBeGreaterThan(0);
    }, 60_000);

    describe("TWIN_MAX_POOLED_CALLEE_NAMES", () => {
      const A = Array.from({ length: 500 }, (_, i) => `a${i}`);
      const B = Array.from({ length: 494 }, (_, i) => `b${i}`);

      it("a retrieved function left out of the pool is not compared at all, as the note says", async () => {
        // s1 fills 500 of the 900 pooled names. s2 calls six of them and 494 of
        // its own, so it does not fit (500 + 494 > 900), and the candidate query
        // returns it all the same: it shares six pooled names.
        expect(A.length + B.length).toBeGreaterThan(TWIN_MAX_POOLED_CALLEE_NAMES);
        const callees: Record<string, string[]> = {
          s1: A,
          s2: [...A.slice(0, 6), ...B],
          // Calls exactly what s2 calls: found through the six shared names.
          t2: [...A.slice(0, 6), ...B],
          // 98.8% like s2 and shares no pooled name: no query can find it.
          t3: B,
          // A twin of s1, which was pooled: still found.
          t1: A,
        };
        await insert(
          Object.keys(callees).map((id) => fn(POOL, id, `x/${id}.go`)),
          Object.entries(callees).flatMap(([id, names]) => names.map((n) => call(POOL, id, n))),
        );
        const load = await createDefaultPlanLocalisationSource(POOL).calleeNameSets(["s1", "s2"]);
        expect(load.notes).toEqual([
          `1 retrieved function was not compared for twins (the retrieved code calls more than ${TWIN_MAX_POOLED_CALLEE_NAMES} distinct names)`,
        ]);
        // What the note says is what happened: s2 has no callee set to compare.
        expect(load.sets.has("s2")).toBe(false);
        const twins = findStructuralTwins(["s1", "s2"], load.sets);
        expect(twins.filter((t) => t.seedId === "s2")).toEqual([]);
        // Not half a result either: t2 without t3 would look complete and is not.
        expect(twins.map((t) => t.id)).toEqual(["t1"]);
        expect(twins[0]).toMatchObject({ id: "t1", seedId: "s1", similarity: 1 });
      });

      it("a later retrieved function that still fits is compared", async () => {
        const callees: Record<string, string[]> = {
          q1: A,
          q2: [...A.slice(0, 6), ...B],
          // After q2 was left out, q3's names all fit: they are q1's.
          q3: A.slice(0, 10),
          u3: A.slice(0, 10),
        };
        await insert(
          Object.keys(callees).map((id) => fn(POOL_FIXED, id, `x/${id}.go`)),
          Object.entries(callees).flatMap(([id, names]) =>
            names.map((n) => call(POOL_FIXED, id, n)),
          ),
        );
        const seeds = ["q1", "q2", "q3"];
        const load = await createDefaultPlanLocalisationSource(POOL_FIXED).calleeNameSets(seeds);
        expect(load.notes).toHaveLength(1);
        expect(load.sets.has("q2")).toBe(false);
        expect(findStructuralTwins(seeds, load.sets)).toEqual([
          { id: "u3", seedId: "q3", similarity: 1 },
        ]);
      });
    });

    it("TWIN_MAX_CANDIDATES: exactly that many candidates are compared, the ones sharing most, and the note says so", async () => {
      const six = ["n0", "n1", "n2", "n3", "n4", "n5"];
      // The retrieved function's id sorts before every candidate's: the candidate
      // query returns it first, and it must not take a candidate's place.
      const seed = "a-seed";
      const full = Array.from(
        { length: TWIN_MAX_CANDIDATES },
        (_, i) => `c${String(i).padStart(4, "0")}`,
      );
      const partial = ["d0", "d1", "d2"];
      await insert(
        [seed, ...full, ...partial].map((id) => fn(MANY, id, `x/${id}.go`)),
        [
          ...[seed, ...full].flatMap((id) => six.map((n) => call(MANY, id, n))),
          // Six callees of which five are the seed's: found, and sharing less.
          ...partial.flatMap((id) => [...six.slice(0, 5), "other"].map((n) => call(MANY, id, n))),
        ],
      );
      const load = await createDefaultPlanLocalisationSource(MANY).calleeNameSets([seed]);
      expect(load.skipped).toBeUndefined();
      expect(load.notes).toEqual([
        "more than 2,000 functions share callee names with the retrieved code: only the 2,000 sharing most were compared for twins",
      ]);
      const compared = [...load.sets.keys()].filter((id) => id !== seed).sort();
      expect(compared).toEqual(full);

      // Without the three that shared less, the candidates fit: 2,000 of them and
      // the retrieved function, which the candidate query returns as well and
      // which is not one of them. No note.
      await db.codeSymbol.deleteMany({ where: { projectId: MANY, id: { in: partial } } });
      const fits = await createDefaultPlanLocalisationSource(MANY).calleeNameSets([seed]);
      expect(fits.notes).toEqual([]);
      expect(fits.sets.size).toBe(TWIN_MAX_CANDIDATES + 1);
    }, 60_000);

    it("TWIN_MAX_CANDIDATE_CALL_EDGES: gives up on a candidate set with more call edges than the limit, and says so", async () => {
      const six = ["n0", "n1", "n2", "n3", "n4", "n5"];
      await insert(
        ["s", "big"].map((id) => fn(HEAVY, id, `x/${id}.go`)),
        ["s", "big"].flatMap((id) => six.map((n) => call(HEAVY, id, n))),
      );
      // One candidate that calls the limit's worth of other names besides. One
      // statement: 100,000 rows through `createMany` would take the test's time.
      const graph = `g-${HEAVY}`;
      await db.$executeRaw`
        INSERT INTO code_edges (id, codeGraphId, projectId, kind, fromSymbolId, toQualifiedName, filePath, line)
        WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ${TWIN_MAX_CANDIDATE_CALL_EDGES - 1})
        SELECT 'heavy-' || i, ${graph}, ${HEAVY}, 'calls', 'big', 'x' || i, 'x/big.go', 1 FROM n`;
      const load = await createDefaultPlanLocalisationSource(HEAVY).calleeNameSets(["s"]);
      expect(load.skipped).toBe(
        "structural twins skipped: the 1 candidate function has over 100,000 call edges",
      );
      expect(load.sets.size).toBe(0);
    }, 60_000);

    it("readers of a table and functions of a file: every id is asked for past one IN list, in this project only", async () => {
      const n = 501;
      const columns = Array.from({ length: n }, (_, i) => `col${i}`);
      const files = Array.from({ length: n }, (_, i) => `pkg/f${i}.go`);
      const symbols: SymbolRow[] = [];
      const edges: EdgeRow[] = [];
      for (const projectId of [CHUNK, HEAVY]) {
        const own = (id: string) => `${projectId}-${id}`;
        for (let i = 0; i < n; i++) {
          symbols.push({
            ...fn(projectId, own(columns[i]!), "db/schema.sql", `t.${columns[i]}`),
            kind: "column",
            qualifiedName: `t.${columns[i]}`,
            language: "sql",
          });
          symbols.push(fn(projectId, own(`r${i}`), files[i]!, `Read${i}`));
          edges.push({
            codeGraphId: `g-${projectId}`,
            projectId,
            kind: "reads",
            fromSymbolId: own(`r${i}`),
            toSymbolId: own(columns[i]!),
            toQualifiedName: null,
            filePath: files[i]!,
            line: 1,
          });
          // A write of the same column is not a read of it.
          edges.push({
            codeGraphId: `g-${projectId}`,
            projectId,
            kind: "writes",
            fromSymbolId: own(`r${i}`),
            toSymbolId: own(columns[i]!),
            toQualifiedName: null,
            filePath: files[i]!,
            line: 2,
          });
        }
      }
      await insert(symbols, edges);
      const source = createDefaultPlanLocalisationSource(CHUNK);
      const mine = columns.map((c) => `${CHUNK}-${c}`);
      const theirs = columns.map((c) => `${HEAVY}-${c}`);

      const readers = await source.getReaderEdgesTo([...mine, ...theirs]);
      expect(readers.map((e) => e.toSymbolId).sort()).toEqual([...mine].sort());
      expect(new Set(readers.map((e) => e.fromSymbolId)).size).toBe(n);

      // The same paths exist in the other project.
      const functions = await source.getFunctionsInFiles(files);
      expect(functions.map((f) => f.filePath).sort()).toEqual([...files].sort());
      expect(functions.every((f) => f.id.startsWith(`${CHUNK}-`))).toBe(true);
    }, 60_000);
  },
);
