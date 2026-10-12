/**
 * #1071 (PR #1104, review cycle 3, M2) — what the time ceiling on Go binding
 * leaves behind.
 *
 * The ceiling used to degrade silently: an upgrade it interrupted was stamped
 * complete, nothing finished the job, and on an already fully bound graph a
 * later slow run REPLACED correct type bindings with name guesses. The rules
 * pinned here, through the real `ingestCodeGraph` and a real SQLite database:
 *
 *   (a) a call this run did not resolve by type (the ceiling, a step budget, a
 *       throw, a resolver that could not be built) never replaces a stored
 *       answer;
 *   (b) the graph records what the ceiling left (`CodeGraph.goBindingIncomplete`),
 *       the extractor version is not stamped while that stands, and the next
 *       ingest resumes there first — also when no Go file changed — and gets
 *       further every time, whatever the clock says;
 *   (c) the stats say so (`goBinding.incomplete`, `goBinding.resumedFiles`).
 *
 * And, from review cycle 4:
 *
 *   (d) the graph says an ingest is binding Go calls BEFORE the first row that
 *       depends on it, so a run that stops half-way is taken up again;
 *   (e) resuming is monotone: what was never resolved is taken up where it
 *       stopped also when another Go file changed, so an active repository
 *       still finishes; the upgrade mark moves for those calls and no others;
 *   (f) a graph that makes no progress is stamped after a bounded number of
 *       ingests, with the remainder recorded as given up.
 *
 * The ceiling trips MID-run and deterministically: `goBindingNow` is a clock
 * that advances one unit per reading, so `goBindingMaxMs: K` lets exactly K
 * calls through. Nothing here depends on how fast the machine is, nor on the
 * order the file system lists a directory in.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";

const failure = vi.hoisted(() => ({
  /** Callee names whose resolution throws. */
  throwOn: new Set<string>(),
  /** When true, the resolver cannot even be built. */
  build: false,
}));

vi.mock("../src/lib/code-graph/go-type-resolution.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/code-graph/go-type-resolution.js")>();
  return {
    ...actual,
    createGoResolver: (...args: Parameters<typeof actual.createGoResolver>) => {
      if (failure.build) throw new Error("resolver could not be built");
      const real = actual.createGoResolver(...args);
      return {
        resolveCall(filePath: string, callee: Parameters<typeof real.resolveCall>[1]) {
          if (callee.e === "sel" && failure.throwOn.has(callee.name)) {
            throw new RangeError("Maximum call stack size exceeded");
          }
          return real.resolveCall(filePath, callee);
        },
      };
    },
  };
});

const {
  CODE_GRAPH_EXTRACTOR_VERSION,
  GO_BINDING_MAX_MS,
  GO_BINDING_MIN_CALLS,
  GO_BINDING_RESUME_GRACE,
  ingestCodeGraph,
  parseGoBindingIncomplete,
  readGoBindingIncomplete,
} = await import("../src/lib/code-graph/ingest.js");
type IngestOptions = Parameters<typeof ingestCodeGraph>[1];

const GO_MOD = "module example.com/app\n\ngo 1.24\n";

const STORE = `package store

type Store struct{}

func (s *Store) Save() error  { return nil }
func (s *Store) Load() error  { return nil }
func (s *Store) Close() error { return nil }

func Open() *Store { return nil }
`;

/**
 * The lattice of PR #1104's second review: a type `W` whose member set is past
 * the resolver's step budget, so no member of it is decided.
 */
function goLattice(types: number, levels: number): string {
  let src = "package wide\n\n";
  for (let l = 0; l < levels; l += 1) {
    for (let i = 0; i < types; i += 1) {
      src += `type T${l}_${i} struct {\n`;
      if (l + 1 < levels) for (let j = 0; j < types; j += 1) src += `\tT${l + 1}_${j}\n`;
      src += "}\n";
    }
  }
  src += "type W struct {\n";
  for (let j = 0; j < types; j += 1) src += `\tT0_${j}\n`;
  return `${src}}\n`;
}

/**
 * The same three method names on another type: a call that loses its type
 * binding has two candidates by name, so a row replaced by a guess shows.
 */
const CACHE = `package cache

type Cache struct{}

func (c *Cache) Save() error  { return nil }
func (c *Cache) Load() error  { return nil }
func (c *Cache) Close() error { return nil }
`;

/** One caller file: three calls, each bound by the parameter's declared type. */
const caller = (name: string, extra = ""): string => `package api

import "example.com/app/store"

func ${name}(s *store.Store) {
	s.Save()
	s.Load()
	s.Close()
}
${extra}`;

const CALLERS = ["a", "b", "c", "d"] as const;
/** Three calls in each of four files. */
const TOTAL_CALLS = 12;

const TREE: Record<string, string> = {
  "go.mod": GO_MOD,
  "store/store.go": STORE,
  "cache/cache.go": CACHE,
  "api/a.go": caller("A"),
  "api/b.go": caller("B"),
  "api/c.go": caller("C"),
  "api/d.go": caller("D"),
};

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1071 — Go binding the time ceiling left incomplete is recorded, resumed, and overwrites nothing",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1071-go-binding-incomplete");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-1071-inc-"));
      await db.user.create({
        data: { id: "u-inc", username: "u-inc", displayName: "u-inc", email: "u-inc@example.test" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    beforeEach(() => {
      failure.throwOn.clear();
      failure.build = false;
    });

    const write = async (root: string, tree: Record<string, string>) => {
      for (const [rel, content] of Object.entries(tree)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), content, "utf8");
      }
    };

    const newProject = async (tree: Record<string, string> = TREE) => {
      seq += 1;
      const project = await db.project.create({
        data: { name: `pinc-${seq}`, slug: `pinc-${seq}`, createdById: "u-inc" },
      });
      const root = path.join(scratch, `tree-${seq}`);
      await write(root, tree);
      return { projectId: project.id, root };
    };

    const ingest = (projectId: string, root: string, extra: Partial<IngestOptions> = {}) =>
      ingestCodeGraph(db, { projectId, rootDir: root, sqlLineageOverride: false, ...extra });

    /**
     * A ceiling that lets exactly `calls` Go calls through: the clock advances
     * one unit per reading, the resolver's build is one unit and so is each call.
     */
    const ceilingAfter = (calls: number, unit = 1): Partial<IngestOptions> => {
      let t = 0;
      return {
        goBindingMaxMs: calls * unit,
        goBindingMinCalls: 0,
        goBindingNow: () => (t += unit),
      };
    };

    /** Every Go `calls` edge as `file > callee → target | NULL (metadata)`, sorted. */
    const calls = async (projectId: string): Promise<string[]> => {
      const edges = await db.codeEdge.findMany({
        where: { projectId, kind: "calls" },
        include: { toSymbol: { select: { qualifiedName: true } } },
      });
      return edges
        .map(
          (e) =>
            `${e.filePath}:${e.line} ${e.toQualifiedName} → ${e.toSymbol?.qualifiedName ?? "NULL"} ${e.metadata ?? "-"}`,
        )
        .sort();
    };

    const graphOf = (projectId: string) => db.codeGraph.findFirstOrThrow({ where: { projectId } });

    const recordOf = async (projectId: string): Promise<Map<string, number>> =>
      parseGoBindingIncomplete((await graphOf(projectId)).goBindingIncomplete);

    /** The whole record: what was never resolved, what is to be resolved again, and the rest. */
    const fullRecordOf = async (projectId: string) =>
      readGoBindingIncomplete((await graphOf(projectId)).goBindingIncomplete);

    /** Calls a record still leaves open, given three calls a file. */
    const callsLeft = (record: Map<string, number>): number =>
      [...record.values()].reduce((sum, at) => sum + (3 - at), 0);

    const touch = async (root: string, rel: string) => {
      await fs.appendFile(path.join(root, rel), "\n// touched\n", "utf8");
    };

    /** Put a graph back as the pre-#1071 extractor left it (names, bindings, no version). */
    const downgrade = async (projectId: string) => {
      for (const s of await db.codeSymbol.findMany({ where: { projectId, kind: "function" } })) {
        await db.codeSymbol.update({
          where: { id: s.id },
          data: { qualifiedName: `${s.filePath}::${s.name}` },
        });
      }
      await db.codeEdge.updateMany({
        where: { projectId, kind: "calls" },
        data: { toSymbolId: null, metadata: null },
      });
      await db.codeGraph.updateMany({ where: { projectId }, data: { extractorVersion: null } });
    };

    const BOUND_BY_TYPE = '{"goResolution":"receiver-type"}';

    it("control: an ingest the ceiling does not reach binds every call by type and records nothing", async () => {
      const { projectId, root } = await newProject();
      const stats = await ingest(projectId, root, { incremental: false });

      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        skipped: 0,
        resumedFiles: 0,
        incomplete: null,
      });
      const got = await calls(projectId);
      expect(got).toHaveLength(TOTAL_CALLS);
      expect(got.every((c) => c.endsWith(BOUND_BY_TYPE))).toBe(true);
      const graph = await graphOf(projectId);
      expect(graph.goBindingIncomplete).toBeNull();
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
    });

    it("the ceiling trips after exactly as many calls as it allows, and the rest are recorded as left open", async () => {
      const { projectId, root } = await newProject();
      const stats = await ingest(projectId, root, { incremental: false, ...ceilingAfter(5) });

      // Five calls through: one whole file, two calls of the next, nothing after.
      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        skipped: TOTAL_CALLS - 5,
        errors: 0,
        overBudget: 0,
        incomplete: { files: 3, calls: TOTAL_CALLS - 5 },
      });
      const got = await calls(projectId);
      expect(got.filter((c) => c.endsWith(BOUND_BY_TYPE))).toHaveLength(5);
      const record = await recordOf(projectId);
      expect([...record.values()].sort()).toEqual([0, 0, 2]);
      expect(callsLeft(record)).toBe(TOTAL_CALLS - 5);

      const graph = await graphOf(projectId);
      expect(JSON.parse(graph.goBindingIncomplete!)).toMatchObject({
        version: CODE_GRAPH_EXTRACTOR_VERSION,
      });
      // Not stamped while binding is incomplete.
      expect(graph.extractorVersion).toBeNull();
    });

    it("the default ceiling is 30 seconds of resolver time", async () => {
      expect(GO_BINDING_MAX_MS).toBe(30_000);
      const { projectId, root } = await newProject();
      // Ten seconds a reading: the build and two calls fit under the default, the third reaches it.
      let t = 0;
      const stats = await ingest(projectId, root, {
        incremental: false,
        goBindingMinCalls: 0,
        goBindingNow: () => (t += 10_000),
      });
      expect(stats.goBinding).toMatchObject({ calls: TOTAL_CALLS, skipped: TOTAL_CALLS - 3 });
    });

    it("resolves a minimum number of calls whatever the clock says, so a ceiling below the build time still converges", async () => {
      expect(GO_BINDING_MIN_CALLS).toBe(2_000);
      const { projectId, root } = await newProject();
      // The default minimum covers this whole tree: a ceiling already passed skips nothing.
      const whole = await ingest(projectId, root, { incremental: false, goBindingMaxMs: -1 });
      expect(whole.goBinding).toMatchObject({ calls: TOTAL_CALLS, skipped: 0, incomplete: null });

      // With a minimum of four, every run closes exactly four more calls.
      const slow = { goBindingMaxMs: -1, goBindingMinCalls: 4 };
      const first = await ingest(projectId, root, { incremental: false, ...slow });
      expect(first.goBinding).toMatchObject({ skipped: TOTAL_CALLS - 4 });
      expect(callsLeft(await recordOf(projectId))).toBe(TOTAL_CALLS - 4);
      const second = await ingest(projectId, root, slow);
      expect(second.goBinding).toMatchObject({ calls: TOTAL_CALLS - 4, skipped: TOTAL_CALLS - 8 });
      expect(callsLeft(await recordOf(projectId))).toBe(TOTAL_CALLS - 8);
      const third = await ingest(projectId, root, slow);
      expect(third.goBinding).toMatchObject({
        calls: TOTAL_CALLS - 8,
        skipped: 0,
        incomplete: null,
      });
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
      expect((await calls(projectId)).every((c) => c.endsWith(BOUND_BY_TYPE))).toBe(true);
    });

    it("a complete graph stays intact when a ceiling-limited ingest touches one file", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);

      await touch(root, "api/b.go");
      const stats = await ingest(projectId, root, ceilingAfter(2));

      // The touched file comes first: two of its calls resolve, every other call is skipped.
      expect(stats.filesRebound).toBe(5);
      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        skipped: TOTAL_CALLS - 2,
        incomplete: { files: 4, calls: TOTAL_CALLS - 2 },
      });
      const after = await calls(projectId);
      // Every stored answer of the UNCHANGED files is exactly what it was.
      const unchanged = (rows: string[]) => rows.filter((c) => !c.startsWith("api/b.go:"));
      expect(unchanged(after)).toEqual(unchanged(complete));
      expect(unchanged(after)).toHaveLength(9);
      // The touched file was re-parsed, so it had no stored answer to keep:
      // two calls by type, the skipped one left to the name rules.
      const touched = after.filter((c) => c.startsWith("api/b.go:"));
      expect(touched.filter((c) => c.endsWith(BOUND_BY_TYPE))).toHaveLength(2);
      expect(touched.filter((c) => c.endsWith("NULL -"))).toHaveLength(1);

      // The touched file has a call NEVER resolved; the unchanged ones are to
      // be resolved AGAIN, each from its first call.
      const record = await fullRecordOf(projectId);
      expect([...record.files]).toEqual([["api/b.go", 2]]);
      expect([...record.again].sort()).toEqual([
        ["api/a.go", 0],
        ["api/c.go", 0],
        ["api/d.go", 0],
      ]);
      expect(record.inFlight).toBe(false);
      // The version it already had is not taken away.
      expect((await graphOf(projectId)).extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);

      // The next ingest, with no file changed, finishes it: the graph is the complete one again.
      const resumed = await ingest(projectId, root);
      expect(resumed.filesParsed).toBe(0);
      expect(resumed.goBinding).toMatchObject({
        // Only what was left: b.go from its third call, the others whole.
        calls: TOTAL_CALLS - 2,
        skipped: 0,
        resumedFiles: 4,
        incomplete: null,
      });
      expect(await calls(projectId)).toEqual(complete);
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();

      // And an ingest after that has nothing left to do.
      expect((await ingest(projectId, root)).goBinding).toBeNull();
    });

    it("an interrupted upgrade is resumed by later ingests with no file change, and stamped only when it is finished", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      const uninterrupted = await calls(projectId);
      const ids = async () =>
        (await db.codeSymbol.findMany({ where: { projectId }, select: { id: true } }))
          .map((s) => s.id)
          .sort();
      const symbolIds = await ids();
      await downgrade(projectId);

      // The upgrade: every Go file is rewritten, the ceiling lets five calls through.
      const first = await ingest(projectId, root, ceilingAfter(5));
      expect(first.filesUpgraded).toBe(6);
      expect(first.goBinding).toMatchObject({
        skipped: TOTAL_CALLS - 5,
        incomplete: { files: 3, calls: TOTAL_CALLS - 5 },
      });
      let graph = await graphOf(projectId);
      expect(graph.extractorVersion).toBeNull();
      expect(callsLeft(await recordOf(projectId))).toBe(TOTAL_CALLS - 5);
      const firstMark = graph.extractorUpgradedAt!.getTime();

      // An ingest that gets nowhere (nothing let through) changes nothing: not
      // the record, not a row, and not the upgrade mark.
      const before = await calls(projectId);
      const stalled = await ingest(projectId, root, ceilingAfter(0));
      expect(stalled.goBinding).toMatchObject({
        calls: TOTAL_CALLS - 5,
        skipped: TOTAL_CALLS - 5,
        incomplete: { files: 3, calls: TOTAL_CALLS - 5 },
      });
      expect(await calls(projectId)).toEqual(before);
      expect(callsLeft(await recordOf(projectId))).toBe(TOTAL_CALLS - 5);
      expect((await graphOf(projectId)).extractorUpgradedAt!.getTime()).toBe(firstMark);

      // Resumed, not restarted: no file is upgraded again, only the open calls are looked at.
      const second = await ingest(projectId, root, ceilingAfter(5));
      expect(second.filesUpgraded).toBe(0);
      expect(second.filesParsed).toBe(0);
      expect(second.goBinding).toMatchObject({
        calls: TOTAL_CALLS - 5,
        skipped: TOTAL_CALLS - 10,
        resumedFiles: 3,
        incomplete: { files: 1, calls: TOTAL_CALLS - 10 },
      });
      graph = await graphOf(projectId);
      expect(graph.extractorVersion).toBeNull();
      expect(callsLeft(await recordOf(projectId))).toBe(TOTAL_CALLS - 10);
      // The rows it wrote are the rest of the upgrade's rewrite: the mark moved with them.
      expect(graph.extractorUpgradedAt!.getTime()).toBeGreaterThan(firstMark);
      const secondMark = graph.extractorUpgradedAt!.getTime();

      const third = await ingest(projectId, root, ceilingAfter(5));
      expect(third.filesUpgraded).toBe(0);
      expect(third.goBinding).toMatchObject({
        calls: TOTAL_CALLS - 10,
        skipped: 0,
        resumedFiles: 1,
        incomplete: null,
      });
      graph = await graphOf(projectId);
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
      expect(graph.goBindingIncomplete).toBeNull();
      expect(graph.extractorUpgradedAt!.getTime()).toBeGreaterThan(secondMark);

      // Edge for edge what an uninterrupted upgrade stores, on the same symbol rows.
      expect(await calls(projectId)).toEqual(uninterrupted);
      expect(await ids()).toEqual(symbolIds);

      // Finished: the next ingest reads no Go at all, and moves no mark.
      expect((await ingest(projectId, root)).goBinding).toBeNull();
      expect((await graphOf(projectId)).extractorUpgradedAt!.getTime()).toBe(
        graph.extractorUpgradedAt!.getTime(),
      );
    });

    it("resuming outside an upgrade does not move the upgrade mark", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      await touch(root, "api/b.go");
      await ingest(projectId, root, ceilingAfter(2));
      expect((await graphOf(projectId)).extractorUpgradedAt).toBeNull();
      const resumed = await ingest(projectId, root);
      expect(resumed.goBinding).toMatchObject({ resumedFiles: 4, incomplete: null });
      expect((await graphOf(projectId)).extractorUpgradedAt).toBeNull();
    });

    it("when a Go file changes, a file left open resumes where it stopped — first — and its earlier calls wait their turn", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      // As an earlier ceiling would have left it: c.go open from its second call.
      await db.codeGraph.updateMany({
        where: { projectId },
        data: {
          goBindingIncomplete: JSON.stringify({
            version: CODE_GRAPH_EXTRACTOR_VERSION,
            files: { "api/c.go": 1 },
          }),
        },
      });
      await db.codeEdge.updateMany({
        where: { projectId, filePath: "api/c.go", kind: "calls" },
        data: { toSymbolId: null, metadata: null },
      });

      await touch(root, "api/a.go");
      const stats = await ingest(projectId, root, ceilingAfter(3));

      // The three calls the ceiling allows: c.go's two never-resolved ones
      // FIRST, from the call it stopped at (not from its first, although a Go
      // file moved — PR #1104 review cycle 4), then one of the changed file.
      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        skipped: TOTAL_CALLS - 3,
        resumedFiles: 1,
        incomplete: { files: 4, calls: TOTAL_CALLS - 3 },
      });
      const record = await fullRecordOf(projectId);
      // Never resolved: the rest of the changed file. c.go is no longer among them.
      expect([...record.files]).toEqual([["api/a.go", 1]]);
      // To be resolved again, because a Go file moved: every unchanged file —
      // c.go's first call among them, which lies before where it resumed.
      expect([...record.again].sort()).toEqual([
        ["api/b.go", 0],
        ["api/c.go", 0],
        ["api/d.go", 0],
      ]);
      const after = await calls(projectId);
      const of = (rows: string[], file: string) => rows.filter((c) => c.startsWith(`${file}:`));
      // c.go: its second and third calls are bound; the first keeps what it held.
      expect(of(after, "api/c.go").slice(1)).toEqual(of(complete, "api/c.go").slice(1));
      expect(of(after, "api/c.go")[0]).toBe("api/c.go:6 Save → NULL -");
      // b.go and d.go were skipped whole and keep what they held.
      expect(of(after, "api/b.go")).toEqual(of(complete, "api/b.go"));
      expect(of(after, "api/d.go")).toEqual(of(complete, "api/d.go"));
      expect(of(after, "api/a.go").filter((c) => c.endsWith(BOUND_BY_TYPE))).toHaveLength(1);
      expect(of(after, "api/a.go").filter((c) => c.endsWith("NULL -"))).toHaveLength(2);

      expect((await ingest(projectId, root)).goBinding).toMatchObject({
        // a.go's two, b.go and d.go whole — and c.go whole: the record keeps
        // one index a file, not a range, so the two calls it resumed with
        // last time are resolved once more. Repeated work, never a lost call.
        calls: 11,
        resumedFiles: 4,
        incomplete: null,
      });
      expect(await calls(projectId)).toEqual(complete);
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
    });

    it("an active repository still finishes: a Go file changes on EVERY ingest and the open calls go down each time", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      const uninterrupted = await calls(projectId);
      await downgrade(projectId);

      // The upgrade, with a ceiling of two calls an ingest.
      await ingest(projectId, root, ceilingAfter(2));
      let left = callsLeft(await recordOf(projectId));
      expect(left).toBe(TOTAL_CALLS - 2);
      expect((await graphOf(projectId)).extractorVersion).toBeNull();

      // Every later ingest finds a changed Go file (one that makes no call, so
      // it adds nothing to bind) and has the same ceiling. Taking the open
      // files up from their first call again each time, the same two calls
      // were resolved for ever and the version never stamped.
      const seen: number[] = [];
      for (let run = 0; run < 5; run += 1) {
        await touch(root, "cache/cache.go");
        const stats = await ingest(projectId, root, ceilingAfter(2));
        expect(stats.filesParsed).toBe(1);
        const now = callsLeft(await recordOf(projectId));
        seen.push(now);
        expect(now).toBe(left - 2);
        left = now;
      }
      expect(seen).toEqual([8, 6, 4, 2, 0]);
      // Nothing is left that was never resolved: the version is stamped, although
      // the unchanged files are still waiting to be resolved AGAIN after the
      // last change — that does not hold it back.
      const graph = await graphOf(projectId);
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
      const record = await fullRecordOf(projectId);
      expect(record.files.size).toBe(0);
      // (The four callers. `store/store.go` is unchanged too, and makes no call.)
      expect([...record.again.keys()].sort()).toEqual(CALLERS.map((c) => `api/${c}.go`));

      // With no further change the rest is taken up, and the graph is the
      // uninterrupted one.
      const last = await ingest(projectId, root);
      expect(last.goBinding).toMatchObject({ incomplete: null });
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
      expect(await calls(projectId)).toEqual(uninterrupted);
    });

    it("the upgrade mark moves for the calls the upgrade left, and for no other re-bind while the version is unstamped", async () => {
      const { projectId, root } = await newProject({
        ...TREE,
        "web/util.ts": "export function helper(): void {}\n",
        "web/app.ts":
          'import { helper } from "./util";\n\nexport function run(): void {\n  helper();\n}\n',
      });
      await ingest(projectId, root, { incremental: false });
      await downgrade(projectId);
      await ingest(projectId, root, ceilingAfter(5));
      const mark = async () => (await graphOf(projectId)).extractorUpgradedAt!.getTime();
      const upgraded = await mark();
      expect((await graphOf(projectId)).extractorVersion).toBeNull();

      // Another language's file changes; no Go call gets through. `web/app.ts`
      // is re-bound in place to the re-created `helper` — a real change of the
      // graph's rows, and nothing to do with the upgrade.
      const tsCall = async () =>
        db.codeEdge.findFirstOrThrow({
          where: { projectId, filePath: "web/app.ts", kind: "calls" },
          select: { toSymbolId: true },
        });
      const before = (await tsCall()).toSymbolId;
      await touch(root, "web/util.ts");
      await ingest(projectId, root, ceilingAfter(0));
      expect((await tsCall()).toSymbolId).not.toBe(before);
      expect((await tsCall()).toSymbolId).not.toBeNull();
      expect(await mark()).toBe(upgraded);

      // A Go file changes, and the ceiling lets the never-resolved calls
      // through and nothing after them: the mark moves, with those.
      await touch(root, "cache/cache.go");
      await ingest(projectId, root, ceilingAfter(TOTAL_CALLS - 5));
      expect((await recordOf(projectId)).size).toBe(0);
      const finished = await mark();
      expect(finished).toBeGreaterThan(upgraded);
      expect((await graphOf(projectId)).extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);

      // What is left is the unchanged files, to be resolved AGAIN. Scrub one
      // of their rows so that pass has something to write: it is a re-bind
      // after a change, not the upgrade, and moves no mark.
      expect((await fullRecordOf(projectId)).again.size).toBeGreaterThan(0);
      await db.codeEdge.updateMany({
        where: { projectId, filePath: "api/a.go", kind: "calls", line: 6 },
        data: { toSymbolId: null, metadata: null },
      });
      await ingest(projectId, root);
      expect((await calls(projectId)).filter((c) => c.endsWith("NULL -"))).toEqual([]);
      expect(await mark()).toBe(finished);
    });

    it("the graph says an ingest is binding Go calls before its first row, and a run that stops is taken up whole", async () => {
      const { projectId, root } = await newProject({
        ...TREE,
        "api/d.go": caller("D", "\nfunc viaA(s *store.Store) {\n\tA(s)\n}\n"),
      });
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      expect(complete).toContain('api/d.go:12 A → api/a.go::A {"goResolution":"same-package"}');

      // b.go changes. The ceiling skips every call, so b.go's new rows hold
      // the name-evidence answer — and then the ingest throws, after
      // `persistParsed` and before the write that ends it (Step 8 opens by
      // counting the graph's symbols).
      await touch(root, "api/b.go");
      const real = db.codeSymbol.count.bind(db.codeSymbol) as (...args: unknown[]) => unknown;
      let thrown = 0;
      const spy = vi.spyOn(db.codeSymbol, "count").mockImplementation(((...args: unknown[]) => {
        if (thrown === 0) {
          thrown += 1;
          throw new Error("the process stopped here");
        }
        return real(...args);
      }) as typeof db.codeSymbol.count);
      try {
        await expect(
          ingest(projectId, root, { goBindingMaxMs: -1, goBindingMinCalls: 0 }),
        ).rejects.toThrow("the process stopped here");
      } finally {
        spy.mockRestore();
      }
      expect(thrown).toBe(1);

      // The rows are those of the half-finished run: b.go re-created, its
      // calls not bound by type. Nothing in the tree differs from the stored
      // hashes any more — so without a record the next ingest would resume
      // nothing, and b.go would keep that answer until some Go file changed.
      const stopped = await calls(projectId);
      expect(stopped.filter((c) => c.startsWith("api/b.go:"))).toEqual([
        "api/b.go:6 Save → NULL -",
        "api/b.go:7 Load → NULL -",
        "api/b.go:8 Close → NULL -",
      ]);
      const flagged = await fullRecordOf(projectId);
      expect(flagged.inFlight).toBe(true);
      expect(flagged.files.size).toBe(0);

      const next = await ingest(projectId, root);
      expect(next.filesParsed).toBe(0);
      // Every Go file is bound again, from its first call.
      expect(next.goBinding).toMatchObject({
        calls: complete.length,
        skipped: 0,
        incomplete: null,
      });
      expect(await calls(projectId)).toEqual(complete);
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
      // And that was once: the ingest after it reads no Go.
      expect((await ingest(projectId, root)).goBinding).toBeNull();
    });

    it("a throw BETWEEN the passes — hashes written, edges not — leaves the flag, and what is left is bound by type again", async () => {
      const { projectId, root } = await newProject({
        ...TREE,
        "api/d.go": caller("D", "\nfunc viaA(s *store.Store) {\n\tA(s)\n}\n"),
      });
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);

      // a.go changes: pass 1 re-creates its symbols (and stores its new hash),
      // which nulls d.go's edge to `A`. The clock is first read after that,
      // when pass 2 builds the resolver — and throws.
      await touch(root, "api/a.go");
      await expect(
        ingest(projectId, root, {
          goBindingNow: () => {
            throw new Error("stopped between the passes");
          },
        }),
      ).rejects.toThrow("stopped between the passes");
      const stopped = await calls(projectId);
      // d.go's row still NAMES a binding and has no target.
      expect(stopped).toContain('api/d.go:12 A → NULL {"goResolution":"same-package"}');
      const flagged = await fullRecordOf(projectId);
      expect(flagged.inFlight).toBe(true);

      const next = await ingest(projectId, root);
      expect(next.filesParsed).toBe(0);
      expect(next.goBinding).toMatchObject({ skipped: 0, incomplete: null });
      const after = await calls(projectId);
      expect(after).toContain('api/d.go:12 A → api/a.go::A {"goResolution":"same-package"}');
      // Every row the stopped run left is what a complete run stores. (a.go's
      // own three edges were deleted with its old rows and never written: a
      // file whose symbols are stored and whose edges are not is the window
      // every language's incremental ingest has had since #313 — the record
      // cannot put back rows that do not exist, and does not claim to.)
      const others = (rows: string[]) => rows.filter((c) => !c.startsWith("api/a.go:"));
      expect(others(after)).toEqual(others(complete));
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
    });

    it("the flag does not survive a run that ends, and is not written by one that binds no Go", async () => {
      const { projectId, root } = await newProject({
        ...TREE,
        "web/util.ts": "export function helper(): void {}\n",
      });
      await ingest(projectId, root, { incremental: false });
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
      // A change to another language's file: no Go is bound, nothing is written to the record.
      const update = vi.spyOn(db.codeGraph, "update");
      // Pass 1 opens by deleting the changed file's old symbols: the first row
      // of the run that depends on the record.
      const wipe = vi.spyOn(db.codeSymbol, "deleteMany");
      try {
        await touch(root, "web/util.ts");
        expect((await ingest(projectId, root)).goBinding).toBeNull();
        const records = update.mock.calls
          .map(
            ([arg]) =>
              (arg as { data: { goBindingIncomplete?: unknown } }).data.goBindingIncomplete,
          )
          .filter((value) => value !== undefined);
        // Only Step 8's, which holds nothing.
        expect(records).toEqual([null]);
        update.mockClear();
        // A change to a Go file: the flag first, then Step 8's.
        wipe.mockClear();
        await touch(root, "api/b.go");
        await ingest(projectId, root);
        // FIRST means before the changed file's rows are touched at all.
        expect(wipe).toHaveBeenCalled();
        const flagAt = update.mock.calls.findIndex(([arg]) =>
          String(
            (arg as { data: { goBindingIncomplete?: unknown } }).data.goBindingIncomplete,
          ).includes('"inFlight":true'),
        );
        expect(flagAt).toBeGreaterThanOrEqual(0);
        expect(update.mock.invocationCallOrder[flagAt]).toBeLessThan(
          wipe.mock.invocationCallOrder[0],
        );
        const goRecords = update.mock.calls
          .map(
            ([arg]) =>
              (arg as { data: { goBindingIncomplete?: unknown } }).data.goBindingIncomplete,
          )
          .filter((value) => value !== undefined);
        expect(goRecords).toEqual([
          JSON.stringify({ version: CODE_GRAPH_EXTRACTOR_VERSION, files: {}, inFlight: true }),
          null,
        ]);
      } finally {
        update.mockRestore();
        wipe.mockRestore();
      }
    });

    it("a graph that makes no progress is stamped after the ingests the floor needs and three more, the remainder given up", async () => {
      expect(GO_BINDING_RESUME_GRACE).toBe(3);
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      await downgrade(projectId);

      // The upgrade resolves five calls and leaves seven. At a floor of five
      // calls an ingest, seven need two ingests; three more are allowed.
      const first = await ingest(projectId, root, { goBindingMaxMs: -1, goBindingMinCalls: 5 });
      expect(first.goBinding).toMatchObject({ skipped: 7, abandonedFiles: 0 });
      expect((await fullRecordOf(projectId)).resumesLeft).toBe(2 + GO_BINDING_RESUME_GRACE);
      const open = [...(await recordOf(projectId))].sort();
      const rows = await calls(projectId);

      // Ingests that close nothing: the record stands, one ingest fewer each time.
      for (let leftAfter = 4; leftAfter >= 1; leftAfter -= 1) {
        const stalled = await ingest(projectId, root, ceilingAfter(0));
        expect(stalled.goBinding).toMatchObject({
          incomplete: { files: 3, calls: 7 },
          abandonedFiles: 0,
        });
        const record = await fullRecordOf(projectId);
        expect(record.resumesLeft).toBe(leftAfter);
        expect([...record.files].sort()).toEqual(open);
        expect((await graphOf(projectId)).extractorVersion).toBeNull();
      }

      // The last one allowed: stamped, nothing left to resume, the remainder recorded.
      const last = await ingest(projectId, root, ceilingAfter(0));
      expect(last.goBinding).toMatchObject({ incomplete: null, abandonedFiles: 3 });
      let graph = await graphOf(projectId);
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
      let record = await fullRecordOf(projectId);
      expect(record.files.size).toBe(0);
      expect(record.again.size).toBe(0);
      expect(record.resumesLeft).toBeNull();
      expect([...record.abandoned].sort()).toEqual(open);
      // No row was touched: the calls given up on hold what they held.
      expect(await calls(projectId)).toEqual(rows);

      // Given up means not resumed: an ingest with nothing changed reads no Go.
      expect((await ingest(projectId, root)).goBinding).toBeNull();
      expect([...(await fullRecordOf(projectId)).abandoned].sort()).toEqual(open);

      // A change to any Go file binds the whole tree again — those files too.
      await touch(root, "cache/cache.go");
      const rebound = await ingest(projectId, root);
      expect(rebound.goBinding).toMatchObject({ incomplete: null, abandonedFiles: 0 });
      graph = await graphOf(projectId);
      expect(graph.goBindingIncomplete).toBeNull();
      record = await fullRecordOf(projectId);
      expect(record.abandoned.size).toBe(0);
      expect(await calls(projectId)).toEqual(complete);
    });

    it("progress inside the allowance is not given up: the floor closes the rest in the ingests it was allowed", async () => {
      const { projectId, root } = await newProject();
      // Twelve calls at a floor of four: the first run leaves eight, allowed 2 + 3 more ingests.
      const slow = { goBindingMaxMs: -1, goBindingMinCalls: 4 };
      await ingest(projectId, root, { incremental: false, ...slow });
      expect((await fullRecordOf(projectId)).resumesLeft).toBe(2 + GO_BINDING_RESUME_GRACE);
      await ingest(projectId, root, slow);
      expect((await fullRecordOf(projectId)).resumesLeft).toBe(1 + GO_BINDING_RESUME_GRACE);
      const done = await ingest(projectId, root, slow);
      expect(done.goBinding).toMatchObject({ incomplete: null, abandonedFiles: 0 });
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
    });

    it("with no Go file changed, a file resumes at its recorded call and files not listed are not looked at", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      const scrub = (file: string, line: number) =>
        db.codeEdge.updateMany({
          where: { projectId, filePath: file, kind: "calls", line },
          data: { toSymbolId: null, metadata: null },
        });
      // c.go open from its third call (line 8); its first call (line 6) is ALSO
      // scrubbed, as a marker: it lies before the recorded index, so a resume
      // must not look at it. d.go is scrubbed and not listed at all.
      await scrub("api/c.go", 8);
      await scrub("api/c.go", 6);
      await scrub("api/d.go", 7);
      await db.codeGraph.updateMany({
        where: { projectId },
        data: {
          goBindingIncomplete: JSON.stringify({
            version: CODE_GRAPH_EXTRACTOR_VERSION,
            files: { "api/c.go": 2 },
          }),
        },
      });

      const stats = await ingest(projectId, root);
      expect(stats.filesRebound).toBe(1);
      expect(stats.goBinding).toMatchObject({
        files: 6,
        calls: 1,
        resumedFiles: 1,
        incomplete: null,
      });
      const after = await calls(projectId);
      expect(after.filter((c) => c.endsWith("NULL -"))).toEqual([
        "api/c.go:6 Save → NULL -",
        "api/d.go:7 Load → NULL -",
      ]);
      expect(after.filter((c) => c.endsWith(BOUND_BY_TYPE))).toHaveLength(TOTAL_CALLS - 2);
      expect(after.filter((c) => !c.endsWith("NULL -"))).toEqual(
        complete.filter((c) => !c.startsWith("api/c.go:6 ") && !c.startsWith("api/d.go:7 ")),
      );
    });

    it("a record written for another extractor version, or unreadable, is nothing recorded", async () => {
      expect(parseGoBindingIncomplete(null).size).toBe(0);
      expect(parseGoBindingIncomplete("{not json").size).toBe(0);
      expect(parseGoBindingIncomplete("null").size).toBe(0);
      expect(
        parseGoBindingIncomplete(
          JSON.stringify({ version: CODE_GRAPH_EXTRACTOR_VERSION + 1, files: { "a.go": 0 } }),
        ).size,
      ).toBe(0);
      expect(
        parseGoBindingIncomplete(JSON.stringify({ version: CODE_GRAPH_EXTRACTOR_VERSION })).size,
      ).toBe(0);
      expect([
        ...parseGoBindingIncomplete(
          JSON.stringify({
            version: CODE_GRAPH_EXTRACTOR_VERSION,
            files: { "a.go": 0, "b.go": 3, "c.go": -1, "d.go": "2", "e.go": 1.5 },
          }),
        ),
      ]).toEqual([
        ["a.go", 0],
        ["b.go", 3],
      ]);

      // The whole record: every part read, anything malformed dropped.
      const whole = readGoBindingIncomplete(
        JSON.stringify({
          version: CODE_GRAPH_EXTRACTOR_VERSION,
          files: { "a.go": 1 },
          again: { "b.go": 0, "c.go": -2 },
          inFlight: true,
          resumesLeft: 4,
          abandoned: { "d.go": 7, "e.go": "x" },
        }),
      );
      expect([...whole.files]).toEqual([["a.go", 1]]);
      expect([...whole.again]).toEqual([["b.go", 0]]);
      expect(whole.inFlight).toBe(true);
      expect(whole.resumesLeft).toBe(4);
      expect([...whole.abandoned]).toEqual([["d.go", 7]]);
      const bare = readGoBindingIncomplete(
        JSON.stringify({
          version: CODE_GRAPH_EXTRACTOR_VERSION,
          files: [],
          inFlight: "yes",
          resumesLeft: 1.5,
        }),
      );
      expect(bare).toMatchObject({ inFlight: false, resumesLeft: null });
      expect(bare.files.size + bare.again.size + bare.abandoned.size).toBe(0);
      // Another version's flag is nothing recorded either.
      expect(
        readGoBindingIncomplete(
          JSON.stringify({ version: CODE_GRAPH_EXTRACTOR_VERSION + 1, files: {}, inFlight: true }),
        ).inFlight,
      ).toBe(false);

      // A graph of an older extractor carrying a stale record is upgraded from the start.
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      await downgrade(projectId);
      await db.codeGraph.updateMany({
        where: { projectId },
        data: {
          goBindingIncomplete: JSON.stringify({
            version: CODE_GRAPH_EXTRACTOR_VERSION - 1,
            files: { "api/c.go": 2 },
          }),
        },
      });
      const stats = await ingest(projectId, root);
      expect(stats.filesUpgraded).toBe(6);
      expect(stats.goBinding).toMatchObject({ calls: TOTAL_CALLS, resumedFiles: 0 });
    });

    it("a full re-ingest starts clean: the record is ignored and replaced", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false, ...ceilingAfter(5) });
      expect((await recordOf(projectId)).size).toBe(3);
      const stats = await ingest(projectId, root, { incremental: false });
      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        resumedFiles: 0,
        incomplete: null,
      });
      const graph = await graphOf(projectId);
      expect(graph.goBindingIncomplete).toBeNull();
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
    });

    it("a file left open that is deleted leaves the record; one that changes is bound again from its first call", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      await db.codeGraph.updateMany({
        where: { projectId },
        data: {
          goBindingIncomplete: JSON.stringify({
            version: CODE_GRAPH_EXTRACTOR_VERSION,
            files: { "api/c.go": 2, "api/d.go": 1 },
          }),
        },
      });
      await fs.rm(path.join(root, "api/c.go"));
      await touch(root, "api/d.go");
      const stats = await ingest(projectId, root);
      expect(stats.goBinding).toMatchObject({ calls: 9, resumedFiles: 1, incomplete: null });
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
      const got = await calls(projectId);
      expect(got).toHaveLength(9);
      expect(got.every((c) => c.endsWith(BOUND_BY_TYPE))).toBe(true);
    });

    it("a file left open that cannot be read stays open, and the stats still say so", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      await db.codeGraph.updateMany({
        where: { projectId },
        data: {
          goBindingIncomplete: JSON.stringify({
            version: CODE_GRAPH_EXTRACTOR_VERSION,
            files: { "api/c.go": 2 },
          }),
        },
      });
      const goFiles = ["store/store.go", "cache/cache.go", ...CALLERS.map((c) => `api/${c}.go`)];
      for (const rel of goFiles) await fs.chmod(path.join(root, rel), 0o000);
      try {
        const stats = await ingest(projectId, root);
        // No Go file could be read, so none was bound — and the record is carried.
        expect(stats.goBinding).toMatchObject({
          files: 0,
          calls: 0,
          incomplete: { files: 1, calls: 0 },
        });
        expect([...(await recordOf(projectId))]).toEqual([["api/c.go", 2]]);
        expect(await calls(projectId)).toEqual(complete);
      } finally {
        for (const rel of goFiles) await fs.chmod(path.join(root, rel), 0o644);
      }
      expect((await ingest(projectId, root)).goBinding).toMatchObject({
        calls: 1,
        resumedFiles: 1,
        incomplete: null,
      });
    });

    it("a stored binding whose target is gone is not kept: the skipped call gets the name-evidence answer", async () => {
      const { projectId, root } = await newProject({
        ...TREE,
        "api/d.go": caller("D", "\nfunc viaA(s *store.Store) {\n\tA(s)\n\tstore.Open()\n}\n"),
      });
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      expect(complete).toContain('api/d.go:12 A → api/a.go::A {"goResolution":"same-package"}');
      expect(complete).toContain(
        'api/d.go:13 Open → store/store.go::Open {"goResolution":"package"}',
      );
      /** A row that still NAMES a binding and has no target: an answer that is no answer. */
      const orphans = (rows: string[]) =>
        rows.filter((c) =>
          /→ NULL \{"goResolution":"(package|same-package|receiver-type|name)"\}$/.test(c),
        );
      const skipAll = { goBindingMaxMs: -1, goBindingMinCalls: 0 };

      // a.go is re-parsed, so `A` is a new symbol row and d.go's edge to the
      // old one points nowhere. Every call is skipped.
      await touch(root, "api/a.go");
      const stats = await ingest(projectId, root, skipAll);
      expect(stats.goBinding).toMatchObject({ calls: 14, skipped: 14 });
      const after = await calls(projectId);
      expect(orphans(after)).toEqual([]);
      // Not left saying `same-package` with no target: the name rules answer.
      expect(after).toContain('api/d.go:12 A → api/a.go::A {"goResolution":"name"}');
      // The rows whose target still stands are kept as they were.
      expect(
        after.filter((c) => c.startsWith("api/d.go:") && c.endsWith(BOUND_BY_TYPE)),
      ).toHaveLength(3);

      // The same again: now the row whose target goes is one the NAME rules bound.
      await touch(root, "api/a.go");
      await ingest(projectId, root, skipAll);
      const again = await calls(projectId);
      expect(again).toContain('api/d.go:12 A → api/a.go::A {"goResolution":"name"}');
      expect(orphans(again)).toEqual([]);

      // And when the package every caller binds into is re-parsed: the
      // `receiver-type` rows and the `package` one lose their targets alike.
      await touch(root, "store/store.go");
      await ingest(projectId, root, skipAll);
      const storeGone = await calls(projectId);
      expect(orphans(storeGone)).toEqual([]);
      // Two types declare `Save`: the name rules bind neither.
      expect(storeGone).toContain("api/d.go:6 Save → NULL -");
      expect(storeGone.filter((c) => c.endsWith(BOUND_BY_TYPE))).toEqual([]);

      const resumed = await ingest(projectId, root);
      expect(resumed.goBinding).toMatchObject({ incomplete: null });
      expect(await calls(projectId)).toEqual(complete);
    });

    it("a DECIDED verdict is a stored answer too: a skipped call keeps `external` rather than losing it", async () => {
      const { projectId, root } = await newProject({
        "go.mod": GO_MOD,
        "p/p.go":
          'package p\n\nimport "fmt"\n\ntype T struct{}\n\nfunc (T) Run() {}\n\n' +
          'func use(t T) {\n\tfmt.Println("x")\n\tt.Run()\n}\n',
        "p/q.go": "package p\n\nfunc Q() {}\n",
      });
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      expect(complete).toEqual([
        'p/p.go:10 Println → NULL {"goResolution":"external"}',
        'p/p.go:11 Run → p/p.go::T::Run {"goResolution":"receiver-type"}',
      ]);
      await touch(root, "p/q.go");
      const stats = await ingest(projectId, root, { goBindingMaxMs: -1, goBindingMinCalls: 0 });
      expect(stats.goBinding).toMatchObject({ calls: 2, skipped: 2 });
      expect(await calls(projectId)).toEqual(complete);
    });

    it("a call that runs out of the resolver's step budget keeps its stored answer, and is not work to resume", async () => {
      const { projectId, root } = await newProject({
        "go.mod": GO_MOD,
        "wide/types.go": "package wide\n\ntype W struct{}\n",
        "wide/m.go": "package wide\n\nfunc (w *W) N0() {}\n",
        "wide/use.go": "package wide\n\nfunc f(w *W) {\n\tw.N0()\n}\n",
      });
      await ingest(projectId, root, { incremental: false });
      const bound = ['wide/use.go:4 N0 → wide/m.go::W::N0 {"goResolution":"receiver-type"}'];
      expect(await calls(projectId)).toEqual(bound);

      // W now embeds 330 types a level, three levels deep: past the budget.
      await write(root, { "wide/types.go": goLattice(330, 3) });
      const stats = await ingest(projectId, root);
      expect(stats.goBinding).toMatchObject({
        calls: 1,
        overBudget: 1,
        skipped: 0,
        incomplete: null,
      });
      expect(await calls(projectId)).toEqual(bound);
      const graph = await graphOf(projectId);
      expect(graph.goBindingIncomplete).toBeNull();
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
    });

    it("an unchanged Go file that cannot be re-read leaves its directory incomplete: nothing there is ruled out", async () => {
      const { projectId, root } = await newProject({
        "go.mod": GO_MOD,
        "x/a.go": "package x\n\nfunc A() {\n\thelper()\n}\n",
        "x/b.go": "package x\n\nfunc helper() {}\n",
      });
      await ingest(projectId, root, { incremental: false });
      expect(await calls(projectId)).toEqual([
        'x/a.go:4 helper → x/b.go::helper {"goResolution":"same-package"}',
      ]);

      // a.go changes; b.go is unchanged for the walk (its first read) and gone
      // when the binding step reads it again for its declarations.
      await touch(root, "x/a.go");
      const real = fs.readFile.bind(fs) as (...args: unknown[]) => Promise<unknown>;
      let reads = 0;
      const spy = vi.spyOn(fs, "readFile").mockImplementation(((...args: unknown[]) => {
        if (String(args[0]).endsWith(path.join("x", "b.go")) && (reads += 1) > 1) {
          return Promise.reject(new Error("ENOENT"));
        }
        return real(...args);
      }) as typeof fs.readFile);
      try {
        await ingest(projectId, root);
      } finally {
        spy.mockRestore();
      }
      expect(reads).toBe(2);
      // `helper` is not among the declarations in hand — but its file was not
      // read, so it is NOT `external`: undecided by type, bound by name.
      expect(await calls(projectId)).toEqual([
        'x/a.go:4 helper → x/b.go::helper {"goResolution":"name"}',
      ]);
    });

    it("a call whose resolution throws keeps its stored answer, and is not recorded as work to resume", async () => {
      const { projectId, root } = await newProject();
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);

      failure.throwOn.add("Load");
      await touch(root, "api/b.go");
      const stats = await ingest(projectId, root);
      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        errors: 4,
        skipped: 0,
        incomplete: null,
      });
      const after = await calls(projectId);
      const unchanged = (rows: string[]) => rows.filter((c) => !c.startsWith("api/b.go:"));
      // The three unchanged files keep `Load` bound by type although resolving it threw.
      expect(unchanged(after)).toEqual(unchanged(complete));
      // The re-parsed file had nothing to keep.
      expect(after).toContain("api/b.go:7 Load → NULL -");
      const graph = await graphOf(projectId);
      expect(graph.goBindingIncomplete).toBeNull();
      expect(graph.extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
    });

    it("a resolver that cannot be built keeps every stored answer, and what was left open stays open", async () => {
      const { projectId, root } = await newProject({
        ...TREE,
        "web/util.ts": "export function helper(): void {}\n",
        "web/app.ts":
          'import { helper } from "./util";\n\nexport function run(): void {\n  helper();\n}\n',
      });
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      const tsCall = "web/app.ts:4 helper → web/util.ts::helper -";
      expect(complete).toContain(tsCall);
      await db.codeGraph.updateMany({
        where: { projectId },
        data: {
          goBindingIncomplete: JSON.stringify({
            version: CODE_GRAPH_EXTRACTOR_VERSION,
            files: { "api/c.go": 2 },
          }),
        },
      });

      failure.build = true;
      await touch(root, "api/b.go");
      // Another language's file changes in the same run: its callers are
      // re-bound as ever — only Go calls have nothing to be decided by.
      await touch(root, "web/util.ts");
      const stats = await ingest(projectId, root);
      expect(stats.goBinding).toMatchObject({
        calls: 0,
        errors: 1,
        incomplete: { files: 1, calls: 0 },
      });
      const after = await calls(projectId);
      const unchanged = (rows: string[]) => rows.filter((c) => !c.startsWith("api/b.go:"));
      expect(unchanged(after)).toEqual(unchanged(complete));
      expect([...(await recordOf(projectId))]).toEqual([["api/c.go", 2]]);

      failure.build = false;
      const resumed = await ingest(projectId, root);
      // b.go is unchanged now, so only the recorded file is looked at — from its third call.
      expect(resumed.goBinding).toMatchObject({ calls: 1, resumedFiles: 1, incomplete: null });
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
    });
  },
);
