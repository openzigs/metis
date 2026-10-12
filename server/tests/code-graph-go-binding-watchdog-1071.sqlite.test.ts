/**
 * #1071 (PR #1104, review cycle 5) — the last resort of the Go binding step,
 * and what a graph holds once its binding is given up.
 *
 * Twice a review found the resolver retaining more than it counted, and each
 * time 1 to 2 MB of Go ended the process with `JavaScript heap out of memory`
 * — an abort, which nothing catches. So the ingest no longer relies on the
 * resolver's own accounting alone. Pinned here, through the real
 * `ingestCodeGraph` and a real SQLite database:
 *
 *   (a) the heap watchdog: sampled every `GO_BINDING_HEAP_SAMPLE_CALLS` calls
 *       and whenever the resolver has kept `GO_BINDING_HEAP_SAMPLE_ENTRIES`
 *       more entries (so one call that keeps a lot cannot outrun it), it stops the step when the heap has grown past the limit — exactly as
 *       the time ceiling does (stored answers kept, the graph recorded
 *       incomplete, the version not stamped) but with no floor, and says so
 *       (`goBinding.stopReason: "memory"`);
 *   (b) the allowance of ingests a graph may end incomplete is sized again
 *       when a Go change re-plans the work, so an active repository is not
 *       given up early — and is NOT renewed while the calls never resolved by
 *       type stand still;
 *   (c) a call given up on does not keep a type binding older than the tree.
 *
 * The watchdog trips deterministically: `goBindingHeapUsed` is a reader that
 * returns what the test says at each sample. One test uses the real heap.
 */
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";
import { PrismaClient } from "@prisma/client";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { readGeneratedClientProvider } from "./lib/db/generated-client-provider.js";
import { forceGc, retainedHeap } from "./helpers/force-gc.js";
import { goSelectorChainShape } from "./helpers/go-wide-shapes.js";
import {
  createMigratedSqlite,
  type MigratedSqlite,
  MIGRATED_SQLITE_HOOK_TIMEOUT_MS,
} from "./helpers/sqlite-migrated-db.js";
import {
  CODE_GRAPH_EXTRACTOR_VERSION,
  defaultGoBindingHeapLimit,
  GO_BINDING_HEAP_SAMPLE_CALLS,
  GO_BINDING_HEAP_SAMPLE_ENTRIES,
  GO_BINDING_MAX_HEAP_GROWTH,
  GO_BINDING_MIN_CALLS,
  GO_BINDING_RESUME_GRACE,
  ingestCodeGraph,
  readGoBindingIncomplete,
} from "../src/lib/code-graph/ingest.js";

type IngestOptions = Parameters<typeof ingestCodeGraph>[1];

/** The resolvers the ingests of this file built, held WEAKLY: whether one is still alive can be asked. */
const built = vi.hoisted(() => ({
  resolvers: [] as Array<WeakRef<object>>,
  /** When true, no resolver can be built. */
  fail: false,
}));

vi.mock("../src/lib/code-graph/go-type-resolution.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../src/lib/code-graph/go-type-resolution.js")>();
  return {
    ...actual,
    createGoResolver: (...args: Parameters<typeof actual.createGoResolver>) => {
      if (built.fail) throw new Error("resolver could not be built");
      const resolver = actual.createGoResolver(...args);
      built.resolvers.push(new WeakRef(resolver));
      return resolver;
    },
  };
});

const MB = 1024 * 1024;
const GO_MOD = "module example.com/app\n\ngo 1.24\n";

const STORE = `package store

type Store struct{}

func (s *Store) Save() error  { return nil }
func (s *Store) Load() error  { return nil }
func (s *Store) Close() error { return nil }
`;

/** The same method names on another type: a call that loses its type binding has two candidates by name. */
const CACHE = `package cache

type Cache struct{}

func (c *Cache) Save() error  { return nil }
func (c *Cache) Load() error  { return nil }
func (c *Cache) Close() error { return nil }
`;

/** One caller file of `calls` calls, each bound by the parameter's declared type. */
const caller = (name: string, calls: number): string => {
  let src = `package api\n\nimport "example.com/app/store"\n\nfunc ${name}(s *store.Store) {\n`;
  for (let i = 0; i < calls; i += 1) src += "\ts.Save()\n";
  return `${src}}\n`;
};

const CALLERS = ["a", "b", "c", "d"] as const;
const PER_FILE = 200;
/** Four files of 200 calls: three samples of the watchdog and a remainder. */
const TOTAL_CALLS = CALLERS.length * PER_FILE;

const WIDE_TREE: Record<string, string> = {
  "go.mod": GO_MOD,
  "store/store.go": STORE,
  "cache/cache.go": CACHE,
  ...Object.fromEntries(CALLERS.map((c) => [`api/${c}.go`, caller(c.toUpperCase(), PER_FILE)])),
};

/** `types.S` is an alias the callers go through: change it, and every caller's callee moves. */
const typesFile = (pkg: "store" | "cache", type: "Store" | "Cache"): string =>
  `package types\n\nimport "example.com/app/${pkg}"\n\ntype S = ${pkg}.${type}\n`;

const aliasCaller = (name: string): string => `package api

import "example.com/app/types"

func ${name}(s *types.S) {
	s.Save()
	s.Load()
	s.Close()
}
`;

const ALIAS_TREE: Record<string, string> = {
  "go.mod": GO_MOD,
  "store/store.go": STORE,
  "cache/cache.go": CACHE,
  "types/types.go": typesFile("store", "Store"),
  ...Object.fromEntries(CALLERS.map((c) => [`api/${c}.go`, aliasCaller(c.toUpperCase())])),
};

describe("#1071 — the heap watchdog's default limit", () => {
  it("is 512 MB, sampled every 256 calls and every 16,384 entries kept, and a quarter of a smaller heap", () => {
    expect(GO_BINDING_MAX_HEAP_GROWTH).toBe(512 * MB);
    expect(GO_BINDING_HEAP_SAMPLE_CALLS).toBe(256);
    expect(GO_BINDING_HEAP_SAMPLE_ENTRIES).toBe(16_384);
    expect(defaultGoBindingHeapLimit(4096 * MB)).toBe(512 * MB);
    expect(defaultGoBindingHeapLimit(2048 * MB)).toBe(512 * MB);
    expect(defaultGoBindingHeapLimit(1024 * MB)).toBe(256 * MB);
    expect(defaultGoBindingHeapLimit(300 * MB + 2)).toBe(75 * MB);
    // This process's own: never more than the constant, never nothing.
    expect(defaultGoBindingHeapLimit()).toBeGreaterThan(8 * MB);
    expect(defaultGoBindingHeapLimit()).toBeLessThanOrEqual(GO_BINDING_MAX_HEAP_GROWTH);
  });
});

describe.skipIf(readGeneratedClientProvider() !== "sqlite")(
  "#1071 — the Go binding step stops on heap growth, and a graph given up holds no stale type binding",
  () => {
    let sqlite: MigratedSqlite;
    let db: PrismaClient;
    let scratch: string;
    let seq = 0;

    beforeAll(async () => {
      sqlite = createMigratedSqlite("1071-go-binding-watchdog");
      db = new PrismaClient({ adapter: new PrismaBetterSqlite3({ url: sqlite.url }) });
      scratch = await fs.mkdtemp(path.join(os.tmpdir(), "metis-1071-wd-"));
      await db.user.create({
        data: { id: "u-wd", username: "u-wd", displayName: "u-wd", email: "u-wd@example.test" },
      });
    }, MIGRATED_SQLITE_HOOK_TIMEOUT_MS);

    afterAll(async () => {
      await db?.$disconnect();
      sqlite?.cleanup();
      if (scratch) await fs.rm(scratch, { recursive: true, force: true });
    });

    const write = async (root: string, tree: Record<string, string>) => {
      for (const [rel, content] of Object.entries(tree)) {
        await fs.mkdir(path.dirname(path.join(root, rel)), { recursive: true });
        await fs.writeFile(path.join(root, rel), content, "utf8");
      }
    };

    const newProject = async (tree: Record<string, string>) => {
      seq += 1;
      const project = await db.project.create({
        data: { name: `pwd-${seq}`, slug: `pwd-${seq}`, createdById: "u-wd" },
      });
      const root = path.join(scratch, `tree-${seq}`);
      await write(root, tree);
      return { projectId: project.id, root };
    };

    const ingest = (projectId: string, root: string, extra: Partial<IngestOptions> = {}) =>
      ingestCodeGraph(db, { projectId, rootDir: root, sqlLineageOverride: false, ...extra });

    /**
     * A heap that reads `grown` bytes over its baseline from the sample numbered
     * `tripAt` on (0: the one before the first call) and nothing before it. The
     * step reads it once for the baseline, then once per sample.
     */
    const heapTrippingAt = (
      tripAt: number,
      grown = 700 * MB,
    ): Partial<IngestOptions> & { readings: () => number } => {
      let readings = 0;
      return {
        goBindingHeapUsed: () => {
          readings += 1;
          // Reading 1 is the baseline; reading 2 is sample 0.
          return readings - 2 >= tripAt ? 1_000 + grown : 1_000;
        },
        readings: () => readings,
      };
    };

    /** Every Go `calls` edge as `file:line callee → target | NULL metadata`, sorted. */
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
    const recordOf = async (projectId: string) =>
      readGoBindingIncomplete((await graphOf(projectId)).goBindingIncomplete);

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

    it("control: under the limit the watchdog reads the heap and stops nothing", async () => {
      const { projectId, root } = await newProject(WIDE_TREE);
      const heap = heapTrippingAt(Number.POSITIVE_INFINITY);
      const stats = await ingest(projectId, root, { incremental: false, ...heap });
      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        skipped: 0,
        stopReason: null,
        heapGrowthMb: null,
        incomplete: null,
      });
      // The baseline, then one sample before calls 0, 256, 512 and 768.
      expect(heap.readings()).toBe(1 + Math.ceil(TOTAL_CALLS / GO_BINDING_HEAP_SAMPLE_CALLS));
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
      const rows = await calls(projectId);
      expect(rows).toHaveLength(TOTAL_CALLS);
      expect(rows.every((r) => r.endsWith(BOUND_BY_TYPE))).toBe(true);
    });

    it("growth past the limit stops the step at that sample — below the floor — and every stored answer is kept", async () => {
      const { projectId, root } = await newProject(WIDE_TREE);
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);

      // A Go file changes (one that makes no call), so every caller is bound
      // again from its first call; the heap passes the limit at the third
      // sample, when 512 calls have been resolved.
      await touch(root, "cache/cache.go");
      const heap = heapTrippingAt(2, 700 * MB);
      const stats = await ingest(projectId, root, heap);
      expect(GO_BINDING_MIN_CALLS).toBeGreaterThan(512);
      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        skipped: TOTAL_CALLS - 512,
        stopReason: "memory",
        heapGrowthMb: 700,
        errors: 0,
        overBudget: 0,
        incomplete: { files: 2, calls: TOTAL_CALLS - 512 },
      });
      // Once tripped it is not read again.
      expect(heap.readings()).toBe(4);
      const record = await recordOf(projectId);
      expect([...record.again]).toEqual([
        ["api/c.go", 512 - 2 * PER_FILE],
        ["api/d.go", 0],
      ]);
      expect(record.files.size).toBe(0);
      // No row lost its answer: the calls not looked at hold what they held.
      expect(await calls(projectId)).toEqual(complete);

      // The next ingest, under the limit, finishes — with a new resolver.
      const next = await ingest(projectId, root);
      expect(next.goBinding).toMatchObject({
        skipped: 0,
        stopReason: null,
        resumedFiles: 2,
        incomplete: null,
      });
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
      expect(await calls(projectId)).toEqual(complete);
    });

    it("the resolver is RELEASED when the watchdog trips: its caches are collectable while the ingest is still writing", async () => {
      const { projectId, root } = await newProject(WIDE_TREE);
      await ingest(projectId, root, { incremental: false });
      await touch(root, "cache/cache.go");

      // After the plan the step re-binds each unchanged file's rows, reading
      // them first. At each such read — the step still running, its closures
      // alive — collect, and ask whether this run's resolver is still held.
      const aliveDuringWrites = async (heap: Partial<IngestOptions>): Promise<boolean[]> => {
        const seen: boolean[] = [];
        const real = db.codeEdge.findMany.bind(db.codeEdge) as (...a: unknown[]) => unknown;
        const from = built.resolvers.length;
        const turn = () => new Promise<void>((resolve) => setImmediate(resolve));
        const spy = vi.spyOn(db.codeEdge, "findMany").mockImplementation((async (
          ...a: unknown[]
        ) => {
          if (built.resolvers.length > from) {
            // A WeakRef's target is kept to the end of the job that read it:
            // let that job end before collecting and asking again.
            await turn();
            await turn();
            forceGc();
            seen.push(built.resolvers[built.resolvers.length - 1].deref() !== undefined);
          }
          return real(...a);
        }) as typeof db.codeEdge.findMany);
        try {
          await ingest(projectId, root, heap);
        } finally {
          spy.mockRestore();
        }
        return seen;
      };

      const stopped = await aliveDuringWrites(heapTrippingAt(1));
      expect(stopped.length).toBeGreaterThan(0);
      expect(stopped).not.toContain(true);

      // Control: with no stop the step holds its resolver to the end, so the
      // check above can see one that is not released.
      await touch(root, "cache/cache.go");
      const whole = await aliveDuringWrites(heapTrippingAt(Number.POSITIVE_INFINITY));
      expect(whole.length).toBeGreaterThan(0);
      expect(whole).toContain(true);
    });

    it("a limit exactly met is not passed; one byte more is", async () => {
      const { projectId, root } = await newProject(WIDE_TREE);
      const at = await ingest(projectId, root, {
        incremental: false,
        goBindingMaxHeapGrowth: 5 * MB,
        ...heapTrippingAt(0, 5 * MB),
      });
      expect(at.goBinding).toMatchObject({ skipped: 0, stopReason: null });
      const over = await ingest(projectId, root, {
        incremental: false,
        goBindingMaxHeapGrowth: 5 * MB,
        ...heapTrippingAt(1, 5 * MB + 1),
      });
      expect(over.goBinding).toMatchObject({
        skipped: TOTAL_CALLS - GO_BINDING_HEAP_SAMPLE_CALLS,
        stopReason: "memory",
        heapGrowthMb: 5,
      });
    });

    it("an interrupted upgrade is recorded, the version is not stamped, and a later ingest finishes it", async () => {
      const { projectId, root } = await newProject(WIDE_TREE);
      await ingest(projectId, root, { incremental: false });
      const complete = await calls(projectId);
      await downgrade(projectId);

      // The resolver's own build is already over the limit: no call is resolved.
      const stats = await ingest(projectId, root, heapTrippingAt(0));
      expect(stats.goBinding).toMatchObject({
        calls: TOTAL_CALLS,
        skipped: TOTAL_CALLS,
        stopReason: "memory",
        incomplete: { files: 4, calls: TOTAL_CALLS },
      });
      expect((await graphOf(projectId)).extractorVersion).toBeNull();
      const record = await recordOf(projectId);
      expect([...record.files].sort()).toEqual(CALLERS.map((c) => [`api/${c}.go`, 0]));
      // 800 calls at the floor of 2,000 an ingest: one ingest, and three more.
      expect(record.resumesLeft).toBe(1 + GO_BINDING_RESUME_GRACE);

      const done = await ingest(projectId, root);
      expect(done.goBinding).toMatchObject({ stopReason: null, incomplete: null });
      expect((await graphOf(projectId)).extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
      expect(await calls(projectId)).toEqual(complete);
    });

    it("a tree that trips the watchdog on every ingest is given up after the allowance, and the graph is stamped", async () => {
      const { projectId, root } = await newProject(WIDE_TREE);
      await ingest(projectId, root, { incremental: false });
      await downgrade(projectId);
      const left: Array<number | null> = [];
      let last = await ingest(projectId, root, heapTrippingAt(0));
      left.push((await recordOf(projectId)).resumesLeft);
      for (let run = 0; run < 1 + GO_BINDING_RESUME_GRACE; run += 1) {
        expect(last.goBinding).toMatchObject({ stopReason: "memory", abandonedFiles: 0 });
        expect((await graphOf(projectId)).extractorVersion).toBeNull();
        last = await ingest(projectId, root, heapTrippingAt(0));
        left.push((await recordOf(projectId)).resumesLeft);
      }
      expect(left).toEqual([4, 3, 2, 1, null]);
      expect(last.goBinding).toMatchObject({
        stopReason: "memory",
        incomplete: null,
        abandonedFiles: 4,
      });
      expect((await graphOf(projectId)).extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
      expect([...(await recordOf(projectId)).abandoned.keys()].sort()).toEqual(
        CALLERS.map((c) => `api/${c}.go`),
      );
    });

    it("the real heap: a limit the step's own growth passes stops it, and the default limit does not", async () => {
      // Twenty files of 300 calls. What the step retains for them — the
      // resolver, and a planned verdict per call — is measured after a forced
      // collection at every sample, so the reading is growth and not garbage.
      const tree: Record<string, string> = {
        "go.mod": GO_MOD,
        "store/store.go": STORE,
        ...Object.fromEntries(
          Array.from({ length: 20 }, (_, i) => [`api/f${i}.go`, caller(`F${i}`, 300)]),
        ),
      };
      const { projectId, root } = await newProject(tree);
      const stopped = await ingest(projectId, root, {
        incremental: false,
        goBindingHeapUsed: retainedHeap,
        goBindingMaxHeapGrowth: 64 * 1024,
      });
      expect(stopped.goBinding).toMatchObject({ calls: 6_000, stopReason: "memory" });
      expect(stopped.goBinding!.skipped).toBeGreaterThan(0);
      expect(stopped.goBinding!.skipped % GO_BINDING_HEAP_SAMPLE_CALLS).toBe(
        6_000 % GO_BINDING_HEAP_SAMPLE_CALLS,
      );
      expect(stopped.goBinding!.incomplete!.calls).toBe(stopped.goBinding!.skipped);
      expect((await graphOf(projectId)).extractorVersion).toBeNull();

      // Nothing injected: the process's own heap, against the default limit.
      const whole = await ingest(projectId, root, { incremental: false });
      expect(whole.goBinding).toMatchObject({
        calls: 6_000,
        skipped: 0,
        stopReason: null,
        heapGrowthMb: null,
        incomplete: null,
      });
      expect((await graphOf(projectId)).extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
    }, 60_000);

    // PR #1104 review cycle 6. A reading every 256 calls is only as good as
    // the worst single call: 160 calls that each kept 25 MB aborted the
    // process before the second reading. So the heap is read on GROWTH too —
    // whenever the resolver has kept `GO_BINDING_HEAP_SAMPLE_ENTRIES` more
    // entries — and both trees below, which make fewer than 256 calls in all,
    // are stopped. On the head before this (`9df1109b`) each was read once,
    // before its first call, and ran to the end.
    it.each([
      // The reviewer's tree, scaled: `t.N.N.N.N.N.F()` through types of 2,000
      // fields over a W that embeds 3,000 structs. Past the absolute cap now,
      // so what grows is each type's own field index.
      // One type's fields are read per call: the first table is refused.
      {
        name: "the reviewer's chained selectors",
        calls: 160,
        fields: 2_000,
        embedded: 3_000,
        limitMb: 4,
        perCall: 2_000 + 64,
      },
      // The same chain through types that sit exactly AT the cap, so every hop
      // resolves and keeps a full table: the most one call can legitimately keep.
      // Six types a call, each its fields and a table of 64 layer types.
      {
        name: "a chain of types at the cap",
        calls: 100,
        fields: 1_500,
        embedded: 62,
        limitMb: 16,
        perCall: 6 * (1_500 + 6 * 64),
      },
    ])(
      "the real heap, fewer than 256 calls ($name): stopped on growth, within the documented overshoot",
      async ({ calls, fields, embedded, limitMb, perCall }) => {
        expect(calls).toBeLessThan(GO_BINDING_HEAP_SAMPLE_CALLS);
        const { projectId, root } = await newProject({
          "go.mod": GO_MOD,
          ...goSelectorChainShape(calls, 5, fields, embedded),
        });
        let readings = 0;
        const stopped = await ingest(projectId, root, {
          incremental: false,
          goBindingHeapUsed: () => {
            readings += 1;
            return retainedHeap();
          },
          goBindingMaxHeapGrowth: limitMb * MB,
        });
        expect(stopped.goBinding).toMatchObject({ calls, stopReason: "memory" });
        // Stopped part-way, by a reading the call count alone never asks for.
        expect(stopped.goBinding!.skipped).toBeGreaterThan(0);
        expect(stopped.goBinding!.skipped).toBeLessThan(calls);
        expect(readings).toBeGreaterThan(2);
        // …and no more often than the growth asks: the baseline, the reading
        // before the first call, then one for every 16,384 entries kept — not
        // one a call from the first threshold on.
        const resolved = calls - stopped.goBinding!.skipped;
        expect(readings).toBeLessThanOrEqual(
          3 + Math.ceil((resolved * perCall) / GO_BINDING_HEAP_SAMPLE_ENTRIES),
        );
        expect(readings).toBeLessThan(resolved);
        // What the heap may pass the limit by is documented on
        // GO_BINDING_HEAP_SAMPLE_ENTRIES: about 8 MB. (Run to the end, either
        // tree grows by several times limit + 8 MB.)
        expect(stopped.goBinding!.heapGrowthMb).toBeGreaterThanOrEqual(limitMb);
        expect(stopped.goBinding!.heapGrowthMb).toBeLessThanOrEqual(limitMb + 8);
        expect((await graphOf(projectId)).extractorVersion).toBeNull();
      },
      120_000,
    );

    it("the time ceiling says `time`", async () => {
      const { projectId, root } = await newProject(WIDE_TREE);
      let t = 0;
      const stats = await ingest(projectId, root, {
        incremental: false,
        goBindingMaxMs: 10,
        goBindingMinCalls: 0,
        goBindingNow: () => (t += 1),
      });
      expect(stats.goBinding).toMatchObject({ stopReason: "time", heapGrowthMb: null });
      expect(stats.goBinding!.skipped).toBeGreaterThan(0);
    });

    // ── The allowance ───────────────────────────────────────────────────────

    it("a Go change that re-plans the work sizes the allowance again; an ingest that only resumes counts down", async () => {
      const { projectId, root } = await newProject(ALIAS_TREE);
      // Twelve calls at a floor of four an ingest: eight left, two ingests and three more.
      const slow = { goBindingMaxMs: -1, goBindingMinCalls: 4 };
      await ingest(projectId, root, { incremental: false, ...slow });
      expect((await recordOf(projectId)).resumesLeft).toBe(2 + GO_BINDING_RESUME_GRACE);

      // A Go file changes: the four never-resolved calls this run closes are
      // progress, and every unchanged caller is back on the list from its
      // first call. Counting on down would leave 4 ingests for 8 open calls
      // sized as if nothing had been added.
      await touch(root, "cache/cache.go");
      const replanned = await ingest(projectId, root, slow);
      const open = replanned.goBinding!.incomplete!.calls;
      expect(open).toBe(8);
      expect((await recordOf(projectId)).resumesLeft).toBe(
        Math.ceil(open / 4) + GO_BINDING_RESUME_GRACE,
      );

      // No change: the same work, one ingest fewer.
      await ingest(projectId, root, slow);
      expect((await recordOf(projectId)).resumesLeft).toBe(
        Math.ceil(open / 4) + GO_BINDING_RESUME_GRACE - 1,
      );
    });

    it("an active repository is not given up: a Go file changes on every ingest, each closes its share, and nothing is abandoned", async () => {
      const { projectId, root } = await newProject(ALIAS_TREE);
      const slow = { goBindingMaxMs: -1, goBindingMinCalls: 4 };
      await ingest(projectId, root, { incremental: false, ...slow });
      // Five ingests were allowed for the first eight calls. Twice as many
      // follow, each with a changed Go file: the work never fits, because the
      // change puts it back — which is not being stuck.
      for (let run = 0; run < 2 * (2 + GO_BINDING_RESUME_GRACE); run += 1) {
        await touch(root, "cache/cache.go");
        const stats = await ingest(projectId, root, slow);
        expect(stats.goBinding).toMatchObject({ abandonedFiles: 0 });
        const record = await recordOf(projectId);
        expect(record.abandoned.size).toBe(0);
        expect(record.again.size).toBeGreaterThan(0);
        expect(record.resumesLeft).toBeGreaterThan(GO_BINDING_RESUME_GRACE);
      }
      // What was never resolved by type is long done, so the graph is stamped.
      expect((await recordOf(projectId)).files.size).toBe(0);
      expect((await graphOf(projectId)).extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
      // Left alone it finishes, and is the graph an uninterrupted ingest builds.
      for (let run = 0; run < 3; run += 1) await ingest(projectId, root, slow);
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
      const rows = await calls(projectId);
      const fresh = await newProject(ALIAS_TREE);
      await ingest(fresh.projectId, fresh.root, { incremental: false });
      expect(rows).toEqual((await calls(fresh.projectId)).map((r) => r.replace("// touched", "")));
    });

    it("the allowance is NOT renewed while the calls never resolved by type stand still, whatever changes", async () => {
      const { projectId, root } = await newProject(ALIAS_TREE);
      // Nothing is ever resolved: the build alone is over the heap limit.
      await ingest(projectId, root, { incremental: false, ...heapTrippingAt(0) });
      const first = (await recordOf(projectId)).resumesLeft!;
      expect(first).toBe(Math.ceil(12 / GO_BINDING_MIN_CALLS) + GO_BINDING_RESUME_GRACE);
      const pending = [...(await recordOf(projectId)).files].sort();
      expect(pending).toHaveLength(4);
      // A Go file changes on every ingest — and the four open files do not move.
      for (let left = first - 1; left >= 1; left -= 1) {
        await touch(root, "cache/cache.go");
        await ingest(projectId, root, heapTrippingAt(0));
        const record = await recordOf(projectId);
        expect(record.resumesLeft).toBe(left);
        expect([...record.files].sort()).toEqual(pending);
        expect((await graphOf(projectId)).extractorVersion).toBeNull();
      }
      await touch(root, "cache/cache.go");
      const last = await ingest(projectId, root, heapTrippingAt(0));
      expect(last.goBinding).toMatchObject({ abandonedFiles: 4, incomplete: null });
      expect((await graphOf(projectId)).extractorVersion).toBe(CODE_GRAPH_EXTRACTOR_VERSION);
    });

    // ── What a call given up on holds ───────────────────────────────────────

    /** A complete graph, then a change that moves every caller's callee, never re-bound: given up. */
    const givenUpAfterMove = async (
      beforeLast?: (root: string, projectId: string) => Promise<void>,
    ) => {
      const { projectId, root } = await newProject(ALIAS_TREE);
      await ingest(projectId, root, { incremental: false });
      const before = await calls(projectId);
      // Every call is bound, by type, to `store.Store`.
      expect(before).toHaveLength(12);
      expect(
        before.every((r) => r.includes("→ store/store.go::Store::") && r.endsWith(BOUND_BY_TYPE)),
      ).toBe(true);

      // `types.S` now names `cache.Cache`: in Go every one of those calls
      // moved. `store.Store` and its methods are still there.
      await fs.writeFile(path.join(root, "types/types.go"), typesFile("cache", "Cache"), "utf8");
      // Twelve open calls at a floor of twelve: one ingest and three more —
      // and the watchdog stops every one of them before its first call.
      const stuck = () => ({ goBindingMinCalls: 12, ...heapTrippingAt(0) });
      await ingest(projectId, root, stuck());
      expect((await recordOf(projectId)).resumesLeft).toBe(1 + GO_BINDING_RESUME_GRACE);
      // Still waiting to be resolved again: the old answer stands meanwhile.
      expect(await calls(projectId)).toEqual(before);
      for (let run = 0; run < GO_BINDING_RESUME_GRACE; run += 1) {
        await ingest(projectId, root, stuck());
        expect(await calls(projectId)).toEqual(before);
      }
      await beforeLast?.(root, projectId);
      const last = await ingest(projectId, root, stuck());
      expect(last.goBinding).toMatchObject({ abandonedFiles: 4, incomplete: null });
      return { projectId, root };
    };

    it("a call given up on does not keep the type binding it had before the change", async () => {
      const { projectId, root } = await givenUpAfterMove();
      const record = await recordOf(projectId);
      expect([...record.abandoned.keys()].sort()).toEqual(CALLERS.map((c) => `api/${c}.go`));
      expect(record.again.size).toBe(0);

      const rows = await calls(projectId);
      expect(rows).toHaveLength(12);
      // Not one still says `receiver-type`, nor any other type verdict, and
      // none points at the function the change moved it away from. Two types
      // declare each name, so the name rules bind none of them either.
      expect(rows.filter((r) => r.includes("goResolution"))).toEqual([]);
      expect(rows.filter((r) => r.includes("store/store.go::Store::"))).toEqual([]);
      expect(rows.every((r) => r.endsWith("→ NULL -"))).toBe(true);

      // Given up is not resumed…
      expect((await ingest(projectId, root)).goBinding).toBeNull();
      expect(await calls(projectId)).toEqual(rows);
      // …and the next change to a Go file binds the whole tree, to where the calls now go.
      await touch(root, "cache/cache.go");
      const rebound = await ingest(projectId, root);
      expect(rebound.goBinding).toMatchObject({ incomplete: null, abandonedFiles: 0 });
      const now = await calls(projectId);
      expect(
        now.every((r) => r.includes("→ cache/cache.go::Cache::") && r.endsWith(BOUND_BY_TYPE)),
      ).toBe(true);
      expect((await graphOf(projectId)).goBindingIncomplete).toBeNull();
    });

    it("given up in a file that cannot be read: its type verdicts go with it, unbound and unlabelled", async () => {
      const unreadable = "api/d.go";
      let rootDir = "";
      try {
        const { projectId } = await givenUpAfterMove(async (root) => {
          rootDir = root;
          await fs.chmod(path.join(root, unreadable), 0o000);
        });
        const rows = await calls(projectId);
        expect(rows).toHaveLength(12);
        expect(rows.filter((r) => r.includes("goResolution"))).toEqual([]);
        expect(rows.every((r) => r.endsWith("→ NULL -"))).toBe(true);
        expect([...(await recordOf(projectId)).abandoned.keys()].sort()).toEqual(
          CALLERS.map((c) => `api/${c}.go`),
        );
      } finally {
        if (rootDir) await fs.chmod(path.join(rootDir, unreadable), 0o644);
      }
    });

    it("given up in a file that cannot be read: ANOTHER graph's rows for that path, and a row the name rules labelled, are not touched", async () => {
      // Two where-clauses nothing pinned (PR #1104 review cycle 6): the graph
      // — without it every project holding a file of that path loses its
      // verdicts — and the type-metadata filter.
      const unreadable = "api/d.go";
      const other = await newProject(ALIAS_TREE);
      await ingest(other.projectId, other.root, { incremental: false });
      const otherBefore = await calls(other.projectId);
      expect(otherBefore.filter((r) => r.startsWith(unreadable))).toHaveLength(3);
      expect(otherBefore.every((r) => r.endsWith(BOUND_BY_TYPE))).toBe(true);

      const BY_NAME = '{"goResolution":"name"}';
      let rootDir = "";
      let named = { id: "", toSymbolId: null as string | null };
      try {
        const { projectId } = await givenUpAfterMove(async (root, mine) => {
          rootDir = root;
          await fs.chmod(path.join(root, unreadable), 0o000);
          // One of the file's rows as the NAME rules leave a row: bound, labelled `name`.
          const row = await db.codeEdge.findFirstOrThrow({
            where: { projectId: mine, filePath: unreadable, kind: "calls" },
            orderBy: { line: "asc" },
          });
          expect(row.toSymbolId).not.toBeNull();
          await db.codeEdge.update({ where: { id: row.id }, data: { metadata: BY_NAME } });
          named = { id: row.id, toSymbolId: row.toSymbolId };
        });
        // The row no type verdict labelled keeps its target and its label…
        const kept = await db.codeEdge.findUniqueOrThrow({ where: { id: named.id } });
        expect({ toSymbolId: kept.toSymbolId, metadata: kept.metadata }).toEqual({
          toSymbolId: named.toSymbolId,
          metadata: BY_NAME,
        });
        // …while the file's type verdicts went.
        const mine = (await calls(projectId)).filter((r) => r.startsWith(unreadable));
        expect(mine).toHaveLength(3);
        expect(mine.filter((r) => r.endsWith("→ NULL -"))).toHaveLength(2);
        // And the other graph holds every answer it held, for the same path too.
        expect(await calls(other.projectId)).toEqual(otherBefore);
      } finally {
        if (rootDir) await fs.chmod(path.join(rootDir, unreadable), 0o644);
      }
    });

    it("given up in a file open in BOTH parts: the calls waiting to be resolved again are written undecided, the never-resolved tail is not touched", async () => {
      const { projectId, root } = await newProject(ALIAS_TREE);
      await ingest(projectId, root, { incremental: false });
      const before = await calls(projectId);
      // As a ceiling would leave it: after a Go change `api/a.go` was re-bound
      // up to its first call, its third call was never resolved by type, and
      // one ingest is allowed.
      await db.codeGraph.updateMany({
        where: { projectId },
        data: {
          goBindingIncomplete: JSON.stringify({
            version: CODE_GRAPH_EXTRACTOR_VERSION,
            files: { "api/a.go": 2 },
            again: { "api/a.go": 1 },
            resumesLeft: 1,
          }),
        },
      });
      const last = await ingest(projectId, root, heapTrippingAt(0));
      expect(last.goBinding).toMatchObject({ abandonedFiles: 1, incomplete: null });
      const rows = await calls(projectId);
      const ofA = (list: string[]) => list.filter((r) => r.startsWith("api/a.go:"));
      // Its first call was resolved after the change: that answer stands.
      expect(ofA(rows)[0]).toBe(ofA(before)[0]);
      expect(ofA(rows)[0]).toContain(BOUND_BY_TYPE);
      // Its second was still waiting: the type answer from before the change goes.
      expect(ofA(rows)[1].endsWith("→ NULL -")).toBe(true);
      // And the third, which belongs to the other part, keeps its row.
      expect(ofA(rows)[2]).toBe(ofA(before)[2]);
      // No other file was touched.
      expect(rows.filter((r) => !r.startsWith("api/a.go:"))).toEqual(
        before.filter((r) => !r.startsWith("api/a.go:")),
      );
    });

    it("given up by an ingest that could not build a resolver at all: the stale type binding still goes", async () => {
      try {
        const { projectId } = await givenUpAfterMove(async () => {
          built.fail = true;
        });
        const rows = await calls(projectId);
        expect(rows).toHaveLength(12);
        expect(rows.filter((r) => r.includes("goResolution"))).toEqual([]);
        expect(rows.every((r) => r.endsWith("→ NULL -"))).toBe(true);
      } finally {
        built.fail = false;
      }
    });

    it("a call NEVER resolved by type keeps what it held when it is given up: no row is written", async () => {
      const { projectId, root } = await newProject(ALIAS_TREE);
      // A first ingest that resolves nothing: every call has the name-evidence answer.
      await ingest(projectId, root, { incremental: false, ...heapTrippingAt(0) });
      const rows = await calls(projectId);
      expect(rows.filter((r) => r.includes("receiver-type"))).toEqual([]);
      const allowance = (await recordOf(projectId)).resumesLeft!;
      let last = await ingest(projectId, root, heapTrippingAt(0));
      for (let run = 1; run < allowance; run += 1) {
        last = await ingest(projectId, root, heapTrippingAt(0));
      }
      expect(last.goBinding).toMatchObject({ abandonedFiles: 4 });
      expect(await calls(projectId)).toEqual(rows);
    });
  },
);
