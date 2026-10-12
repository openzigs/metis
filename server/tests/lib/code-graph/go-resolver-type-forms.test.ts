/**
 * #1071 (PR #1104, review cycle 5) — what the Go resolver retains, for every
 * FORM a wide declaration can be reached through.
 *
 * Cycle 4 made a type that EMBEDS a wide struct keep references instead of a
 * copy, and pinned it with an entry counter. The same copy was still made for
 * a defined type (`type T W`): `structAt` built a fresh field index of W for
 * each T. Measured on that head, real walker and resolver, N types over one
 * 3,000-field struct:
 *
 *     2,000 types (112 KB)    223 MB retained
 *     6,000 types (280 KB)    670 MB
 *    24,000 types (1.08 MB) 2,665 MB
 *    48,000 types (2.15 MB) `JavaScript heap out of memory`
 *
 * and the counter read 48,000 entries at 24,000 types: it counted the
 * structures it was written for. A second shape, found by auditing every
 * cache and not by the review, was worse and the counter DID see it — a
 * defined type over a struct that embeds two hundred others kept two hundred
 * layer references and a 3,000-name index per type, 375 KB each, an abort at
 * about 10,000 types — because its allowance was measured by members it had
 * not declared.
 *
 * So this suite does not test the form the last fix addressed. It tests:
 *
 *  1. every cache is counted — `retained().total` sums them, and no `Map` or
 *     `Set` is created in the resolver except through the helper that counts;
 *  2. for EACH form, the count is linear in the types and holds the wide
 *     declaration a bounded number of times, never once per type;
 *  3. for each form, the HEAP agrees with the count: retained bytes, after a
 *     forced collection, stay under a fixed number per counted entry — so a
 *     structure that grew without being counted would show here.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
  createGoResolver,
  GO_RESOLVER_CACHES,
  GO_TYPE_LAYER_BUDGET,
  GO_TYPE_RETAINED_MAX,
  GO_TYPE_RETAINED_PER_MEMBER,
  type GoCallVerdict,
  type GoModule,
  type GoResolverOptions,
  type GoResolverRetained,
} from "../../../src/lib/code-graph/go-type-resolution.js";
import { initCodeGraphParsers, parseSource } from "../../../src/lib/code-graph/parsers.js";
import { settledHeap } from "../../helpers/force-gc.js";
import { GO_ORACLE_VIEWS, readOracleView } from "../../helpers/go-oracle.js";
import { type GoTree, showGoVerdict } from "../../helpers/go-verdicts.js";
import {
  GO_WIDE_SHAPE_VERDICT,
  GO_WIDE_SHAPES,
  type GoWideShape,
  goOwnFieldsShape,
  goSelectorChainShape,
  goWideShape,
} from "../../helpers/go-wide-shapes.js";

const MODULE: GoModule[] = [{ dir: "", path: "example.com/app" }];
const MB = 1024 * 1024;

const show = (v: GoCallVerdict): string =>
  v.kind === "unknown" && v.why ? `unknown:${v.why}` : showGoVerdict(v);

interface Measured {
  tally: Record<string, number>;
  retained: GoResolverRetained;
  /** The most entries ONE call added to what the resolver keeps. */
  maxCallEntries: number;
  /** Bytes the resolver holds after a forced collection, the parsed facts not counted. */
  heap: number;
  sourceBytes: number;
}

/** The real walker, then a resolver over its facts and every call of the tree resolved once. */
function measure(
  tree: GoTree,
  modules: GoModule[] = MODULE,
  options?: GoResolverOptions,
): Measured {
  const parsed = Object.entries(tree).map(([filePath, src]) => parseSource(filePath, src, "go"));
  const files = parsed.map((p) => {
    if (!p.goFacts) throw new Error(`${p.filePath} did not parse`);
    return { filePath: p.filePath, facts: p.goFacts, isTest: p.filePath.endsWith("_test.go") };
  });
  const calls = parsed.flatMap((p) =>
    p.edges
      .filter((e) => e.kind === "calls")
      .map((e) => ({ file: p.filePath, callee: e.goCallee! })),
  );
  // Both readings are the least of three forced collections: a baseline that
  // still held garbage made the growth read too small, and "the heap grows
  // with the types" then failed once on code that had not changed (PR #1104
  // review cycle 6). No bound below is any looser for it.
  const before = settledHeap();
  const resolver = createGoResolver(files, modules, options);
  const tally: Record<string, number> = {};
  let maxCallEntries = 0;
  let last = resolver.retainedTotal();
  for (const c of calls) {
    const key = show(resolver.resolveCall(c.file, c.callee));
    tally[key] = (tally[key] ?? 0) + 1;
    const total = resolver.retainedTotal();
    maxCallEntries = Math.max(maxCallEntries, total - last);
    last = total;
  }
  const heap = settledHeap() - before;
  // The resolver is alive until here: `retained()` is read after the heap.
  const retained = resolver.retained();
  // The running sum ingest's watchdog reads before every call is that total.
  expect(resolver.retainedTotal()).toBe(retained.total);
  expect(last).toBe(retained.total);
  return {
    tally,
    retained,
    maxCallEntries,
    heap,
    sourceBytes: Object.values(tree).reduce((n, s) => n + s.length, 0),
  };
}

beforeAll(async () => {
  await initCodeGraphParsers();
});

describe("every cache of the resolver is counted", () => {
  const SOURCE = readFileSync(
    fileURLToPath(new URL("../../../src/lib/code-graph/go-type-resolution.ts", import.meta.url)),
    "utf8",
  ).split("\n");

  it("no Map or Set is created in the resolver except through the counting helper, or marked as not a cache", () => {
    // A cache added with a bare `new Map()` is exactly how a per-type copy hid
    // from `retained()`. Every creation is `keptMap(…)` / `keptSet(…)`, or
    // says on its own line or the line above why it is not held: `transient`
    // (dies with the call), `counted` (added to a cache by hand), `constant`.
    const marker = /\/\/ (transient|counted|constant):/;
    const creation = /\bnew (Map|Set|WeakMap|WeakSet)\s*[<(]/;
    const unmarked = SOURCE.flatMap((line, i) =>
      creation.test(line) && !marker.test(line) && !marker.test(SOURCE[i - 1] ?? "")
        ? [`${i + 1}: ${line.trim()}`]
        : [],
    );
    expect(unmarked).toEqual([]);
    // And the check can fail: the helper's own classes are the only bare ones.
    expect(SOURCE.filter((l) => /class Kept(Map|Set)</.test(l))).toHaveLength(2);
    expect(creation.test("    const cache = new Map<string, string>();")).toBe(true);
    expect(SOURCE.filter((l) => creation.test(l)).length).toBeGreaterThan(5);
  });

  it("`total` is the sum of the caches, and a real tree fills every one of them", () => {
    const view = readOracleView(GO_ORACLE_VIEWS.find((v) => v.name === "modules")!);
    const all = (budgets?: Parameters<typeof createGoResolver>[2]): GoResolverRetained => {
      const parsed = [...view.goFiles].map(([fp, src]) => parseSource(fp, src, "go"));
      const resolver = createGoResolver(
        parsed.map((p) => ({
          filePath: p.filePath,
          facts: p.goFacts!,
          isTest: p.filePath.endsWith("_test.go"),
        })),
        view.modules,
        budgets,
      );
      for (const p of parsed) {
        for (const e of p.edges) if (e.goCallee) resolver.resolveCall(p.filePath, e.goCallee);
      }
      return resolver.retained();
    };
    const retained = all();
    expect(Object.keys(retained.caches).sort()).toEqual([...GO_RESOLVER_CACHES].sort());
    expect(retained.total).toBe(Object.values(retained.caches).reduce((a, b) => a + b, 0));
    const empty = GO_RESOLVER_CACHES.filter((c) => retained.caches[c] === 0);
    // No type of the corpus is wider than the layer budget, so none keeps an index…
    expect(empty).toEqual(["indexedNames"]);
    // …until every type is made to.
    const indexed = all({
      budgets: { layerTypes: 0, retainedPerMember: 1_000_000, retainedMax: 1_000_000 },
    });
    expect(indexed.caches.indexedNames).toBeGreaterThan(100);
    expect(indexed.total).toBe(Object.values(indexed.caches).reduce((a, b) => a + b, 0));
    // The figures the cycle-4 suite pins are the reach-dependent part of the same count.
    expect(retained.caches.askedNames).toBe(retained.askedNames);
    expect(retained.caches.memberTables).toBe(retained.tables);
    // (`layers` holds each layer type twice — the type and its declaration.)
    expect(retained.caches.layers).toBeGreaterThanOrEqual(retained.layerTypes);
  });

  it("a struct's fields are counted once, whoever asks, and not at all until someone does", () => {
    const tree = goWideShape("defined", 50, 400);
    const parsed = Object.entries(tree).map(([fp, src]) => parseSource(fp, src, "go"));
    const resolver = createGoResolver(
      parsed.map((p) => ({ filePath: p.filePath, facts: p.goFacts!, isTest: false })),
      MODULE,
    );
    expect(resolver.retained().caches.structs).toBe(0);
    const calls = parsed.flatMap((p) => p.edges.filter((e) => e.goCallee));
    resolver.resolveCall("p/p.go", calls[0].goCallee!);
    // W itself: one declaration, its 401 field names (`F` and `w0`…`w399`).
    const one = resolver.retained().caches.structs;
    expect(one).toBe(1 + 401);
    for (const e of calls) resolver.resolveCall("p/p.go", e.goCallee!);
    // Forty-nine more defined types over it add nothing.
    expect(resolver.retained().caches.structs).toBe(one);
  });
});

describe("the counts made by hand: a list is counted where it is built", () => {
  // Maps and sets count themselves; a list is counted by the line that builds
  // it. One small tree that makes the resolver build every such list, with
  // each cache's count worked out — so that dropping one of those lines fails.
  const TREE: GoTree = {
    "base/base.go": [
      "package base",
      "",
      "type Inner struct{}",
      "",
      "func (Inner) Deep() {}",
      "",
      "type Outer struct {",
      "\tInner",
      "\tn int",
      "}",
      "",
      "type Reader interface {",
      "\tRead()",
      "}",
      "",
      "type ReadCloser interface {",
      "\tReader",
      "\tClose()",
      "}",
      "",
      "func Make() Outer { return Outer{} }",
      "",
    ].join("\n"),
    "base/export_test.go": "package base\n\nfunc (Outer) Probe() {}\n",
    "app/app.go": [
      "package app",
      "",
      "import (",
      '\t"example.com/app/base"',
      '\t. "example.com/app/base"',
      ")",
      "",
      "func run(o base.Outer, rc base.ReadCloser) {",
      "\to.Deep()",
      "\trc.Read()",
      "\tMake()",
      "}",
      "",
    ].join("\n"),
  };

  it("every cache holds exactly what this tree makes it hold", () => {
    const { tally, retained } = measure(TREE);
    expect(tally).toEqual({
      "receiver-type base/base.go::Inner::Deep": 1,
      "unbound interface": 1,
      "package base/base.go::Make": 1,
    });
    expect(retained.caches).toEqual(EXPECTED_CACHES);
    expect(retained.total).toBe(Object.values(retained.caches).reduce((a, b) => a + b, 0));
  });
});

/** What the tree above makes each cache hold, and why. */
const EXPECTED_CACHES: GoResolverRetained["caches"] = {
  // 2 packages; a list of one package for each of 2 directories (the entry
  // and its element); 2 directories; 3 files.
  packages: 2 + 2 * 2 + 2 + 3,
  // A name is one entry, and each declaration of it one more in `all` and —
  // outside a test file — one in `nonTest`.
  //   base types (Inner, Outer, Reader, ReadCloser): 4 × 3
  //   base funcs (Make): 3
  //   base methods: 2 receivers, Deep (3), Probe (2: a test file's)
  //   the test method by directory, by name and by receiver: 3
  //   app funcs (run): 3
  declarations: 12 + 3 + (2 + 3 + 2) + 3 + 3,
  // One module: by directory, by path, and in that path's list; 2 directories placed.
  placing: 3 + 2,
  // The importing module and the one path it resolved; app.go's named import
  // and its dot import.
  imports: 2 + 1 + 1,
  // `base.Outer` and `base.ReadCloser` as app.go writes them; `Inner` and
  // `Reader` as base.go does.
  typeNames: 4,
  // Outer, Inner and ReadCloser, as a file that is not a test sees them.
  typeInfos: 3,
  // Outer: the declaration, its 2 fields, its 1 embedded type. Inner: the declaration.
  structs: 4 + 1,
  // ReadCloser: the declaration, 1 method, 1 embedded interface. Reader: the
  // declaration, 1 method.
  interfaces: 3 + 2,
  // ReadCloser's method set: the entry, and the 2 interfaces in it.
  interfaceSets: 1 + 2,
  // Outer and ReadCloser were selected from.
  memberTables: 2,
  // Outer's layers [Outer] [Inner] and ReadCloser's [ReadCloser]: each type
  // once as a name and once as its declaration.
  layers: 2 * 3,
  indexedNames: 0,
  // `Deep` of Outer, `Read` of ReadCloser.
  askedNames: 2,
};

/** What the tally of a shape is, for `count` types. */
function expectedTally(shape: GoWideShape, count: number): Record<string, number> {
  if (shape === "alias-chain") {
    // Twelve aliases are followed; a longer chain is undecided, never guessed.
    return { "unbound func-value": 12, unknown: count - 12 };
  }
  if (shape === "test-view") {
    // `p.go` calls F on each type; `p_test.go` calls Probe and F on each.
    return { "unbound func-value": 2 * count };
  }
  return { [GO_WIDE_SHAPE_VERDICT[shape]]: count };
}

describe.each(GO_WIDE_SHAPES.map((s) => [s] as const))(
  "one wide declaration reached through %s",
  (shape) => {
    const WIDTH = 3_000;
    let small: Measured;
    let large: Measured;
    let narrow: Measured;
    beforeAll(() => {
      small = measure(goWideShape(shape, 500, WIDTH));
      large = measure(goWideShape(shape, 2_000, WIDTH));
      narrow = measure(goWideShape(shape, 500, WIDTH / 10));
    }, 60_000);

    it("resolves every call as the form should (a refusal is not a bound)", () => {
      const want = expectedTally(shape, 2_000);
      if (shape === "test-view") {
        // Each Probe binds to its own type's method: 2,000 distinct targets.
        const probes = Object.entries(large.tally).filter(([k]) => k.includes("::Probe"));
        expect(probes).toHaveLength(2_000);
        expect(probes.every(([, n]) => n === 1)).toBe(true);
        expect(large.tally["unbound func-value"]).toBe(want["unbound func-value"]);
      } else expect(large.tally).toEqual(want);
    });

    it("what is kept grows with the TYPES, not with types × the declaration's width", () => {
      // Four times the types: at most four times the entries, plus nothing.
      expect(large.retained.total).toBeLessThanOrEqual(4 * small.retained.total);
      // Ten times the width, same types: the difference is the declaration
      // itself, held a bounded number of times (once per view of it, and the
      // facts indexed once) — on the cycle-4 head a defined type added the
      // whole width once PER TYPE, 500 × 2,700 here.
      const perWidth = (small.retained.total - narrow.retained.total) / (WIDTH - WIDTH / 10);
      expect(perWidth).toBeLessThanOrEqual(4);
      // And per type it is a small constant, whatever the form.
      const perType = (large.retained.total - small.retained.total) / 1_500;
      expect(perType).toBeLessThanOrEqual(40);
    });

    it("the heap agrees with the count: no structure grows that is not counted", () => {
      // 2,000 types over a 3,000-member declaration. With a copy per type this
      // was 223 MB (750 MB for the embedder); the layers measure 5 to 9 MB.
      expect(large.heap).toBeLessThan(40 * MB);
      // Bytes per counted entry: 150 to 250 measured. An uncounted per-type
      // copy of the declaration is thousands.
      expect(large.heap / large.retained.total).toBeLessThan(800);
      // And the heap grows with the types as the count does.
      expect(large.heap).toBeLessThan(4 * small.heap + 4 * MB);
    });
  },
);

describe("a defined type is as wide as what IT declares, not as what it is defined over", () => {
  /** W embeds `embedded` one-method structs; D is `type D W` with `methods` methods of its own. */
  const tree = (embedded: number, methods = 0): GoTree => {
    let src = "package p\n\n";
    for (let j = 0; j < embedded; j += 1)
      src += `type E${j} struct{}\n\nfunc (E${j}) M${j}() {}\n\n`;
    src += "type W struct {\n";
    for (let j = 0; j < embedded; j += 1) src += `\tE${j}\n`;
    src += "}\n\ntype D W\n\n";
    for (let m = 0; m < methods; m += 1) src += `func (D) Own${m}() {}\n`;
    src += "func fw(w W) {\n\tw.M0()\n}\n\nfunc fd(d D) {\n\td.M0()\n}\n";
    return { "p/p.go": src };
  };

  it("up to the layer budget it is answered like the struct it is defined over", () => {
    const within = measure(tree(GO_TYPE_LAYER_BUDGET - 1));
    expect(within.tally).toEqual({ "receiver-type p/p.go::E0::M0": 2 });
    expect(within.retained.overRetained).toBe(0);
  });

  // The per-member rule on its own: the absolute cap ({@link GO_TYPE_RETAINED_MAX},
  // pinned further down and in `go-resolver-retained.test.ts`) is lifted.
  const UNCAPPED: GoResolverOptions = { budgets: { retainedMax: Number.POSITIVE_INFINITY } };

  it("past it the struct — which wrote its embeddings — keeps an index, and the one-line type over it is undecided", () => {
    const past = measure(tree(GO_TYPE_LAYER_BUDGET + 6), MODULE, UNCAPPED);
    expect(past.tally).toEqual({ "receiver-type p/p.go::E0::M0": 1, "unknown:budget": 1 });
    expect(past.retained.overRetained).toBe(1);
    // W's index: its 70 embedded field names and their 70 methods.
    expect(past.retained.indexedNames).toBe(140);
  });

  it("its own methods are its own: enough of them and it may keep the index too", () => {
    // 71 layer types and 150 names (70 fields, 70 promoted methods, its own
    // ten): ten methods allow 160 of each.
    const own = measure(tree(GO_TYPE_LAYER_BUDGET + 6, 10), MODULE, UNCAPPED);
    expect(own.tally).toEqual({ "receiver-type p/p.go::E0::M0": 2 });
    expect(own.retained.overRetained).toBe(0);
  });
});

/**
 * PR #1104 review cycle 6. Every shape above varies the width of the
 * declaration UNDERNEATH; none reached the term that dominated — the
 * allowance a type earns from the members it declares itself, times the
 * tables one call builds. These two do.
 */
describe("N types × K cheap own fields over a W that embeds many structs", () => {
  /** As many embedded structs as sixteen names a member used to allow a type with `fields` fields. */
  const earned = (fields: number): number =>
    GO_TYPE_RETAINED_PER_MEMBER * (fields + 1) - (fields + 1) - 2;
  /** As many as put a type exactly AT the cap: itself, W and the rest. */
  const AT_CAP = GO_TYPE_RETAINED_MAX - 2;
  /** What one table may hold at most: four entries a layer type, a name each, itself. */
  const TABLE = 5 * GO_TYPE_RETAINED_MAX + 2;

  it.each([
    ["8 fields, 133 embedded (560 MB at 24,000 types before the cap)", 8, earned(8), false],
    ["40 fields, 613 embedded (2,333 MB)", 40, earned(40), false],
    ["8 fields, 133 embedded, test callers (1,091 MB)", 8, earned(8), true],
  ] as const)(
    "%s: past the cap, undecided, and a few entries a type",
    (_name, fields, embedded, tests) => {
      const small = measure(goOwnFieldsShape(500, fields, embedded, tests));
      const large = measure(goOwnFieldsShape(2_000, fields, embedded, tests));
      expect(large.tally).toEqual({ "unknown:budget": tests ? 4_000 : 2_000 });
      expect(large.retained).toMatchObject({ indexedNames: 0, layerTypes: 0 });
      // Per type: its declaration and its own fields, indexed once. Before the
      // cap it was a 143-name index and 135 layer types — 433 entries a type
      // at eight fields, 1,937 at forty.
      const perType = (large.retained.total - small.retained.total) / 1_500;
      // (A test caller is a second view of the type: a second, empty, table.)
      expect(perType).toBeLessThanOrEqual(fields + (tests ? 24 : 16));
      expect(large.heap).toBeLessThan(16 * MB);
      expect(large.heap).toBeLessThan(4 * small.heap + 4 * MB);
    },
    60_000,
  );

  it.each([
    ["no test callers", false],
    ["test callers: a second view of each type", true],
  ] as const)(
    "tuned to sit exactly AT the cap (%s): resolved, and one bounded table a type and view",
    (_name, tests) => {
      const small = measure(goOwnFieldsShape(500, 8, AT_CAP, tests));
      const large = measure(goOwnFieldsShape(2_000, 8, AT_CAP, tests));
      expect(large.tally).toEqual({ "unbound func-value": tests ? 4_000 : 2_000 });
      expect(large.retained).toMatchObject({
        indexedNames: 0,
        overRetained: 0,
        layerTypes: (tests ? 2 : 1) * 2_000 * GO_TYPE_RETAINED_MAX,
      });
      const perType = (large.retained.total - small.retained.total) / 1_500;
      expect(perType).toBeLessThanOrEqual((tests ? 2 : 1) * TABLE);
      // 24,000 such types measure 90 MB (149 MB with test callers): 4 to 7 KB each.
      expect(large.heap).toBeLessThan(24 * MB);
      expect(large.heap).toBeLessThan(4 * small.heap + 4 * MB);
      // One more embedded struct and every type is past the cap.
      const past = measure(goOwnFieldsShape(50, 8, AT_CAP + 1, tests));
      expect(past.tally).toEqual({ "unknown:budget": tests ? 100 : 50 });
    },
    60_000,
  );

  it("the fields a type declares are counted once each — they multiply nothing", () => {
    const few = measure(goOwnFieldsShape(1_000, 8, AT_CAP));
    const many = measure(goOwnFieldsShape(1_000, 40, AT_CAP));
    const perField = (many.retained.total - few.retained.total) / (1_000 * 32);
    expect(perField).toBeLessThanOrEqual(2);
  });
});

describe("one call selecting through H wide types", () => {
  it("the reviewer's chain, scaled: every type is past the cap, and a call keeps its types' own fields and no more", () => {
    // `t.N.N.N.N.N.F()` through six types of 200 fields over a W embedding
    // 3,000 structs. Sixteen names a member allowed each a 3,200-name index,
    // six of them a call: 714,732 entries (33 MB) a call at the reviewer's size.
    const HOPS = 5;
    const FIELDS = 200;
    const EMBEDDED = 3_000;
    const run = measure(goSelectorChainShape(40, HOPS, FIELDS, EMBEDDED));
    expect(run.tally).toEqual({ "unknown:budget": 40 });
    expect(run.retained).toMatchObject({ indexedNames: 0, layerTypes: 0 });
    // What a call keeps is the first reading of the declarations it reaches —
    // each field once — and nothing per name per table.
    expect(run.maxCallEntries).toBeLessThanOrEqual(3 * EMBEDDED + (HOPS + 1) * (FIELDS + 16));
    expect(run.retained.total).toBeLessThanOrEqual(
      3 * EMBEDDED + 40 * (HOPS + 1) * (FIELDS + 16) + 1_000,
    );
  });

  it("the worst one call can keep in tables is the documented constant", () => {
    // Sixty hops, each a type exactly at the cap that no earlier call reached:
    // sixty-one tables from one call. `GO_TYPE_RETAINED_MAX`'s comment gives
    // 64 tables × 322 entries; measured, 9,098.
    const run = measure(goSelectorChainShape(20, 60, 8, GO_TYPE_RETAINED_MAX - 2));
    expect(run.tally).toEqual({ "unbound func-value": 20 });
    expect(run.retained.tables).toBe(20 * 61);
    expect(run.maxCallEntries).toBeGreaterThan(61 * 2 * GO_TYPE_RETAINED_MAX);
    expect(run.maxCallEntries).toBeLessThanOrEqual(64 * (5 * GO_TYPE_RETAINED_MAX + 2));
    // And the bytes that go with it: under a megabyte a call.
    expect(run.heap / 20).toBeLessThan(1 * MB);
  });
});
