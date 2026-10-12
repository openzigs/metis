/**
 * #1071 (PR #1104, review cycle 4) — the Go resolver bounds what it RETAINS,
 * not only what a call costs.
 *
 * Three review rounds bounded and tested time. None measured what the kept
 * tables hold. A member table was a flattened copy of every promoted member,
 * one per type, so resolver memory was types × members; an interface's name
 * set was a copy of every name below it, so a chain of embedded interfaces
 * was quadratic in time and in memory. Measured on that head, through the real
 * walker and `createGoResolver`:
 *
 *   one struct of 3,000 fields, N types embedding it, N calls
 *     2,000 types (131 KB)   732 MB of heap
 *     6,000 types (338 KB) 2,160 MB
 *    24,000 types (1.3 MB)  `JavaScript heap out of memory` at about 4 GB
 *   a chain of N interfaces, each embedding the next
 *     2,000 (140 KB)   206 MB, 0.7 s
 *     8,000 (579 KB) 3,303 MB, 22.7 s
 *
 * with `overBudget` and `skipped` both 0 when the process died. A heap abort
 * cannot be caught, so it sits inside every step budget and the time ceiling.
 *
 * What is pinned here:
 *
 *  1. retained size is LINEAR — asserted on the resolver's own entry counters
 *     (`GoResolver.retained()`), which are exact, on heap growth with a bound
 *     several times under what the old tables took, and on a time ratio
 *     (`tests/helpers/linear-time.ts`), never a wall-clock bound;
 *  2. the two ways a name is looked up — walking a type's layers, and the name
 *     index a wide type keeps — give the same verdicts as each other on the
 *     whole oracle corpus;
 *  3. a type that may keep neither has NO member decided, says `budget`, and
 *     that is a property of the type: the same whatever was asked first.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  createGoResolver,
  GO_TYPE_LAYER_BUDGET,
  GO_TYPE_RETAINED_PER_MEMBER,
  type GoCallVerdict,
  type GoModule,
  type GoResolverOptions,
  type GoResolverRetained,
} from "../../../src/lib/code-graph/go-type-resolution.js";
import { initCodeGraphParsers, parseSource } from "../../../src/lib/code-graph/parsers.js";
import { GO_ORACLE_VIEWS, readOracleView } from "../../helpers/go-oracle.js";
import { goVerdicts, type GoTree, showGoVerdict } from "../../helpers/go-verdicts.js";
import { expectLinearTime } from "../../helpers/linear-time.js";

const MODULE: GoModule[] = [{ dir: "", path: "example.com/app" }];
const MB = 1024 * 1024;

interface Resolved {
  verdicts: GoCallVerdict[];
  retained: GoResolverRetained;
  heapGrowth: number;
}

/** Parse outside the measured call; the call builds a resolver and resolves every call of the tree. */
function prepare(
  tree: GoTree,
  options?: GoResolverOptions,
  modules: GoModule[] = MODULE,
): (order?: "forward" | "reverse") => Resolved {
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
  return (order = "forward") => {
    const before = process.memoryUsage().heapUsed;
    const resolver = createGoResolver(files, modules, options);
    const list = order === "forward" ? calls : [...calls].reverse();
    const verdicts = list.map((c) => resolver.resolveCall(c.file, c.callee));
    const heapGrowth = process.memoryUsage().heapUsed - before;
    return {
      verdicts: order === "forward" ? verdicts : verdicts.reverse(),
      retained: resolver.retained(),
      heapGrowth,
    };
  };
}

const show = (v: GoCallVerdict): string =>
  v.kind === "unknown" && v.why ? `unknown:${v.why}` : showGoVerdict(v);

const tally = (verdicts: GoCallVerdict[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of verdicts) out[show(v)] = (out[show(v)] ?? 0) + 1;
  return out;
};

/** The reviewer's first probe: one struct of `fields` fields, `types` types embedding it, a call on each. */
function wideEmbedded(types: number, fields: number): GoTree {
  let src = "package p\n\ntype W struct {\n";
  for (let i = 0; i < fields; i += 1) src += `\tw${i} int\n`;
  src += "}\n\nfunc (W) M() {}\n\n";
  for (let i = 0; i < types; i += 1) src += `type T${i} struct{ W }\n`;
  for (let i = 0; i < types; i += 1) src += `func f${i}(t T${i}) { t.M() }\n`;
  return { "p/p.go": src };
}

/** The reviewer's second probe: `count` interfaces, each embedding the next, a call through each. */
function interfaceChain(count: number): GoTree {
  let src = "package p\n\n";
  for (let i = 0; i < count; i += 1) {
    src += `type I${i} interface {\n${i + 1 < count ? `\tI${i + 1}\n` : ""}\tM${i}()\n}\n`;
  }
  for (let i = 0; i < count; i += 1) src += `func f${i}(v I${i}) { v.M${i}() }\n`;
  return { "p/p.go": src };
}

beforeAll(async () => {
  await initCodeGraphParsers();
});

describe("N types embedding one wide struct: what is kept does not grow with the struct", () => {
  it("every call binds, and each type keeps two layer references and the one name asked", () => {
    const small = prepare(wideEmbedded(500, 3_000))();
    expect(tally(small.verdicts)).toEqual({ "receiver-type p/p.go::W::M": 500 });
    // T<i> and W: two layer types. No copy of W's 3,001 members anywhere.
    expect(small.retained).toMatchObject({
      tables: 500,
      layerTypes: 1_000,
      indexedNames: 0,
      askedNames: 500,
      overRetained: 0,
      entries: 1_500,
    });
    // The same tree with a struct a tenth the width keeps exactly as much.
    expect(prepare(wideEmbedded(500, 300))().retained).toEqual(small.retained);
  });

  it("four times the types is four times the entries, whatever the struct holds", () => {
    const large = prepare(wideEmbedded(2_000, 3_000))();
    expect(tally(large.verdicts)).toEqual({ "receiver-type p/p.go::W::M": 2_000 });
    expect(large.retained.entries).toBe(6_000);
  });

  it("2,000 types over a 3,000-field struct stay far under the 732 MB the flattened tables took", () => {
    const run = prepare(wideEmbedded(2_000, 3_000));
    // No collection is forced (the suite does not run with `--expose-gc`), so
    // this includes garbage: the bound is a seventh of the old figure, and
    // about ten times what the layers measure with one.
    expect(run().heapGrowth).toBeLessThan(100 * MB);
  });

  it("time is linear when the types and the struct's fields grow together", () => {
    // Types × fields is the product that was retained: both scale with the
    // input here, so the old tables cost sixteen times as much at four times
    // the size.
    expectLinearTime(
      "Go resolver, types embedding one wide struct",
      (size) => {
        const run = prepare(wideEmbedded(size, size));
        return () => run();
      },
      2_000,
    );
  });
});

describe("a chain of embedded interfaces: neither time nor memory is quadratic", () => {
  it("every call is dispatched through its interface", () => {
    expect(tally(prepare(interfaceChain(40))().verdicts)).toEqual({ "unbound interface": 40 });
  });

  it("an interface keeps at most thirteen references — itself and twelve links down — however long the chain", () => {
    const of = (count: number) => prepare(interfaceChain(count))().retained;
    const small = of(1_000);
    const large = of(4_000);
    // The last twelve interfaces of a chain have fewer below them.
    const chain = (count: number) => 13 * count - (12 * 13) / 2;
    expect(small.interfaceLayers).toBe(chain(1_000));
    expect(large.interfaceLayers).toBe(chain(4_000));
    expect(large.entries).toBeLessThan(4.1 * small.entries);
  });

  it("4,000 interfaces stay far under the 584 MB the name sets took", () => {
    expect(prepare(interfaceChain(4_000))().heapGrowth).toBeLessThan(100 * MB);
  });

  it("time is linear in the length of the chain", () => {
    expectLinearTime(
      "Go resolver, a chain of embedded interfaces",
      (size) => {
        const run = prepare(interfaceChain(size));
        return () => run();
      },
      4_000,
    );
  });

  it("a chain longer than twelve links is not read to its end: a name from below is undecided, never ruled out", () => {
    // I0 embeds I1 … embeds I<n>; `Deep` is declared by the last one only. A
    // struct embeds I0 beside a struct that declares nothing: `Deep` can only
    // be I0's, and is dispatched — as long as the chain can be read.
    const tree = (links: number): GoTree => {
      let src = "package p\n\n";
      for (let i = 0; i <= links; i += 1) {
        src += `type I${i} interface {\n${i < links ? `\tI${i + 1}\n` : "\tDeep()\n"}\tM${i}()\n}\n`;
      }
      src += "type Plain struct{}\n\ntype S struct {\n\tI0\n\tPlain\n}\n\n";
      src += "func f(s S) {\n\ts.Deep()\n\ts.M0()\n\ts.Missing()\n}\n";
      return { "p/p.go": src };
    };
    const at = (links: number) => prepare(tree(links))().verdicts.map(show);
    // Twelve links: the whole set is read. `Missing` is in nobody's.
    expect(at(12)).toEqual(["unbound interface", "unbound interface", "unknown"]);
    // Thirteen: `Deep` is past what is read, so the set is OPEN — any name may
    // be the interface's, and `Missing` is no longer known to be absent.
    expect(at(13)).toEqual(["unbound interface", "unbound interface", "unbound interface"]);
  });

  it("an interface reaching more interfaces than the layer budget is open too", () => {
    const tree = (embedded: number): GoTree => {
      let src = "package p\n\ntype Top interface {\n";
      for (let i = 0; i < embedded; i += 1) src += `\tE${i}\n`;
      src += "}\n";
      for (let i = 0; i < embedded; i += 1) src += `type E${i} interface{ M${i}() }\n`;
      src += "func f(t Top) {\n\tt.M0()\n\tt.Missing()\n}\n";
      return { "p/p.go": src };
    };
    // Top and 63 others: 64 in all, read whole.
    expect(prepare(tree(GO_TYPE_LAYER_BUDGET - 1))().verdicts.map(show)).toEqual([
      "unbound interface",
      "unknown",
    ]);
    expect(prepare(tree(GO_TYPE_LAYER_BUDGET))().verdicts.map(show)).toEqual([
      "unbound interface",
      "unbound interface",
    ]);
  });
});

describe("what a type may keep is decided from the type, and past it nothing is decided", () => {
  /**
   * `W` embeds `embedded` structs, each with one method; `T` embeds `W` and
   * declares nothing else. `W` is wide because it says so; `T` reaches as many
   * types through one line.
   */
  const reach = (embedded: number): GoTree => {
    let src = "package p\n\ntype W struct {\n";
    for (let i = 0; i < embedded; i += 1) src += `\tE${i}\n`;
    src += "}\n\ntype T struct{ W }\n\n";
    for (let i = 0; i < embedded; i += 1)
      src += `type E${i} struct{}\n\nfunc (E${i}) M${i}() {}\n\n`;
    src +=
      "func onW(w W) {\n\tw.M0()\n\tw.Missing()\n}\n\nfunc onT(t T) {\n\tt.M0()\n\tt.W.M0()\n}\n";
    return { "p/p.go": src };
  };

  it("up to the layer budget a type is answered by walking its layers", () => {
    // T, W and 62 embedded types: 64 layer types.
    const run = prepare(reach(GO_TYPE_LAYER_BUDGET - 2))();
    expect(run.verdicts.map(show)).toEqual([
      "receiver-type p/p.go::E0::M0",
      "unknown",
      "receiver-type p/p.go::E0::M0",
      "receiver-type p/p.go::E0::M0",
    ]);
    expect(run.retained).toMatchObject({ overRetained: 0, indexedNames: 0 });
  });

  it("one more, and the one-line type has no member decided — while the type that declares the embeddings keeps an index", () => {
    const embedded = GO_TYPE_LAYER_BUDGET - 1;
    const run = prepare(reach(embedded))();
    expect(run.verdicts.map(show)).toEqual([
      "receiver-type p/p.go::E0::M0",
      "unknown",
      // T: 65 layer types, and it declares one member itself.
      "unknown:budget",
      // `t.W` is a field of T, so it is undecided too: nothing about T is.
      "unknown:budget",
    ]);
    // W (1 + 63 layer types, within the budget) is walked; nothing is kept for T.
    expect(run.retained).toMatchObject({ tables: 2, overRetained: 1, layerTypes: 64 });
  });

  it("a type wide by its own declaration keeps a name index, and every lookup is one step", () => {
    const embedded = 200;
    const run = prepare(reach(embedded))();
    expect(run.verdicts.map(show)).toEqual([
      "receiver-type p/p.go::E0::M0",
      "unknown",
      "unknown:budget",
      "unknown:budget",
    ]);
    // W: 201 layer types and 400 names (200 embedded fields, 200 methods),
    // against 16 × the 200 members it declares.
    expect(run.retained).toMatchObject({ layerTypes: 201, indexedNames: 400, overRetained: 1 });
  });

  it("the index is allowed exactly sixteen entries for each member the type declares", () => {
    // `Wide` declares `own` embedded fields; each embedded type has `each`
    // methods, so the index would hold own × (1 + each) names over own + 1
    // layer types.
    const wide = (own: number, each: number): GoTree => {
      let src = "package p\n\ntype Wide struct {\n";
      for (let i = 0; i < own; i += 1) src += `\tE${i}\n`;
      src += "}\n\n";
      for (let i = 0; i < own; i += 1) {
        src += `type E${i} struct{}\n\n`;
        for (let j = 0; j < each; j += 1) src += `func (E${i}) M${i}_${j}() {}\n`;
      }
      src += "func f(w Wide) {\n\tw.M0_0()\n}\n";
      return { "p/p.go": src };
    };
    const own = GO_TYPE_LAYER_BUDGET + 6;
    const full = prepare(wide(own, GO_TYPE_RETAINED_PER_MEMBER - 1))();
    expect(full.verdicts.map(show)).toEqual(["receiver-type p/p.go::E0::M0_0"]);
    expect(full.retained.indexedNames).toBe(own * GO_TYPE_RETAINED_PER_MEMBER);
    const over = prepare(wide(own, GO_TYPE_RETAINED_PER_MEMBER))();
    expect(over.verdicts.map(show)).toEqual(["unknown:budget"]);
    expect(over.retained).toMatchObject({ indexedNames: 0, layerTypes: 0, overRetained: 1 });
  });

  it("layer types count against the allowance too, not only names", () => {
    // `E` embeds a type named `X` from each of `packages` packages: one field
    // name between them, so the names stay few while the layers do not. `T`
    // declares twenty fields and `E`: 21 members, an allowance of 336.
    const tree = (packages: number): GoTree => {
      const out: GoTree = {};
      let imports = "";
      let embedded = "";
      for (let i = 0; i < packages; i += 1) {
        out[`x${i}/x.go`] = `package x${i}\n\ntype X struct{}\n`;
        imports += `\t"example.com/app/x${i}"\n`;
        embedded += `\tx${i}.X\n`;
      }
      let fields = "";
      for (let i = 0; i < 20; i += 1) fields += `\tf${i} int\n`;
      out["p/p.go"] =
        `package p\n\nimport (\n${imports})\n\ntype E struct {\n${embedded}}\n\n` +
        `func (E) Own() {}\n\ntype T struct {\n${fields}\tE\n}\n\nfunc f(t T) {\n\tt.Own()\n}\n`;
      return out;
    };
    const allowance = GO_TYPE_RETAINED_PER_MEMBER * 21;
    // T, E and the rest: exactly the allowance, then one more.
    const within = prepare(tree(allowance - 2))();
    expect(within.verdicts.map(show)).toEqual(["receiver-type p/p.go::E::Own"]);
    expect(within.retained).toMatchObject({ layerTypes: allowance, overRetained: 0 });
    const over = prepare(tree(allowance - 1))();
    expect(over.verdicts.map(show)).toEqual(["unknown:budget"]);
    expect(over.retained).toMatchObject({ layerTypes: 0, indexedNames: 0, overRetained: 1 });
  });

  it("gives the same verdicts whatever was asked first", () => {
    for (const embedded of [10, GO_TYPE_LAYER_BUDGET - 1, 200]) {
      const run = prepare(reach(embedded));
      expect(run("reverse").verdicts.map(show)).toEqual(run("forward").verdicts.map(show));
    }
  });

  it("10,000 one-line types reaching a wide struct's embeddings keep nothing, and cost a bounded walk each", () => {
    const tree = (types: number): GoTree => {
      let src = "package p\n\ntype W struct {\n";
      for (let i = 0; i < 200; i += 1) src += `\tE${i}\n`;
      src += "}\n\n";
      for (let i = 0; i < 200; i += 1) src += `type E${i} struct{}\n\nfunc (E${i}) M() {}\n\n`;
      for (let i = 0; i < types; i += 1) src += `type T${i} struct{ W }\n`;
      for (let i = 0; i < types; i += 1) src += `func f${i}(t T${i}) { t.M() }\n`;
      return { "p/p.go": src };
    };
    const run = prepare(tree(2_500))();
    expect(tally(run.verdicts)).toEqual({ "unknown:budget": 2_500 });
    expect(run.retained).toMatchObject({ tables: 2_500, overRetained: 2_500, entries: 0 });
    expectLinearTime(
      "Go resolver, one-line types over a wide struct",
      (size) => {
        const sized = prepare(tree(size));
        return () => sized();
      },
      10_000,
    );
  });
});

describe("walking the layers and the name index answer alike", () => {
  /** Every type walked however many layers it has; every type indexed however few. */
  const WALK: GoResolverOptions = { budgets: { layerTypes: Number.POSITIVE_INFINITY } };
  const INDEX: GoResolverOptions = {
    budgets: { layerTypes: 0, retainedPerMember: Number.POSITIVE_INFINITY },
  };

  it.each(GO_ORACLE_VIEWS.map((v) => [v.name, v] as const))(
    "on the oracle corpus, view %s",
    (_name, view) => {
      const source = readOracleView(view);
      const tree = Object.fromEntries(source.goFiles);
      const plain = prepare(tree, undefined, source.modules)();
      const walked = prepare(tree, WALK, source.modules)();
      const indexed = prepare(tree, INDEX, source.modules)();
      expect(plain.verdicts.length).toBeGreaterThan(5);
      expect(walked.verdicts.map(show)).toEqual(plain.verdicts.map(show));
      expect(indexed.verdicts.map(show)).toEqual(plain.verdicts.map(show));
      // The corpus is hand-written Go: no type of it comes near a budget.
      expect(plain.retained.overRetained).toBe(0);
      expect(plain.retained.indexedNames).toBe(0);
      // And the two forced forms did take the two different routes.
      expect(walked.retained.indexedNames).toBe(0);
      if (view.name === "modules") expect(indexed.retained.indexedNames).toBeGreaterThan(100);
    },
  );

  /**
   * Promotion's own rules on one tree: a shallower member wins, two at one
   * depth are ambiguous, a field and a method of one name are twins, an open
   * interface beside a declarer leaves the name open, and a test file's view.
   */
  const RULES: GoTree = {
    "p/p.go": `package p

import "io"

type Deep struct{}

func (Deep) Log()   {}
func (Deep) Shade() {}

type Mid struct{ Deep }

func (Mid) Shade() {}

type Left struct{}

func (Left) Both() {}
func (Left) Twin() {}

type Right struct{ Twin int }

func (Right) Both() {}

type Store interface {
	io.Closer
	Save()
}

type Closed interface{ Load() }

type Svc struct {
	Store
	Mid
}

type Pair struct {
	Left
	Right
}

type Shut struct {
	Closed
	Mid
}

type Lone struct {
	Store
	Left
}

func f(s Svc, p Pair, c Shut, l Lone) {
	s.Save()
	s.Shade()
	s.Log()
	s.Close()
	p.Both()
	p.Twin()
	c.Load()
	c.Log()
	c.Missing()
	l.Close()
	l.Both()
	l.Deep()
}
`,
    "p/export_test.go":
      "package p\n\nfunc (Mid) Probe() {}\n\nfunc (Deep) Probe() {}\n\nfunc (Left) Both2() {}\n",
    "p/p_test.go": "package p\n\nfunc g(s Svc, c Shut) {\n\ts.Probe()\n\tc.Probe()\n\tc.Log()\n}\n",
  };

  const EXPECTED = [
    // p/p.go
    "unbound interface", // s.Save: Store declares it
    "unknown", // s.Shade: Mid declares it, beside an interface whose set is open
    // s.Log: declared one level DOWN, under Mid. In Go it binds — `Log` is not
    // in Store's method set — but whether it is, is what an open set leaves
    // unknown. It used to be answered `interface` (review cycle 4).
    "unknown",
    "unknown", // s.Close: io.Closer's, through Store — or something under Mid
    "unbound ambiguous", // p.Both: Left and Right, one depth
    "unbound ambiguous", // p.Twin: a method of Left, a field of Right
    "unbound interface", // c.Load
    "receiver-type p/p.go::Deep::Log", // c.Log: a closed interface does not have it
    "unknown", // c.Missing
    // Lone's other embedded type embeds nothing: a name nobody declares can
    // only be the open interface's.
    "unbound interface", // l.Close
    "unknown", // l.Both: Left declares it, beside the open interface
    "unbound interface", // l.Deep
    // p/p_test.go
    "unknown", // s.Probe: Mid's test-file method, at the open interface's depth
    "receiver-type p/export_test.go::Mid::Probe", // c.Probe: shallower than Deep's
    "receiver-type p/p.go::Deep::Log",
  ];

  it("on a tree of promotion's own rules, by either route", () => {
    for (const options of [undefined, WALK, INDEX]) {
      // Sorted by file: `export_test.go` makes no call.
      const got = goVerdicts(RULES, MODULE, options);
      expect(
        got
          .entries()
          .filter(([key]) => key.startsWith("p/p.go:"))
          .map(([, v]) => v)
          .concat(
            got
              .entries()
              .filter(([key]) => key.startsWith("p/p_test.go:"))
              .map(([, v]) => v),
          ),
      ).toEqual(EXPECTED);
    }
  });

  it("a test file's method is placed in the layers from either side: the receivers that declare it, or the layers", () => {
    // Five types of one directory declare a test-file method `Probe`. `One`
    // embeds a single one of them (two layer types, fewer than the five
    // receivers: the layers are read); `All` embeds every one (six, more than
    // five: each receiver is looked up).
    let lib = "package q\n\n";
    let test = "package q\n\n";
    for (let i = 0; i < 5; i += 1) {
      lib += `type E${i} struct{}\n\n`;
      test += `func (E${i}) Probe() {}\n\n`;
    }
    lib += "type One struct{ E3 }\n\ntype All struct {\n\tE0\n\tE1\n\tE2\n\tE3\n\tE4\n}\n";
    const tree: GoTree = {
      "q/q.go": lib,
      "q/export_test.go": test,
      "q/q_test.go": "package q\n\nfunc g(o One, a All) {\n\to.Probe()\n\ta.Probe()\n}\n",
      "q/use.go": "package q\n\nfunc h(o One) {\n\to.Probe()\n}\n",
    };
    for (const options of [undefined, WALK, INDEX]) {
      const got = goVerdicts(tree, MODULE, options);
      expect(got.get("q/q_test.go:4:Probe")).toBe("receiver-type q/export_test.go::E3::Probe");
      expect(got.get("q/q_test.go:5:Probe")).toBe("unbound ambiguous");
      // What ships has no such method.
      expect(got.get("q/use.go:4:Probe")).toBe("unknown");
    }
  });
});

describe("`//go:build` followed by a TAB is the same directive", () => {
  // The Go toolchain accepts a space or a tab after `//go:build`
  // (`go/build/constraint`). The oracle corpus cannot carry the case — its
  // generator refuses any file `gofmt -l` lists, and gofmt rewrites the tab
  // to a space — so it is pinned by hand. (An independent mutation pass on PR
  // #1104 found that reading the wrong character after the marker survived
  // every test.)
  const file = (directive: string): string =>
    `${directive}\n\npackage main\n\nfunc main() {\n\thelper()\n}\n`;
  const ignored = (directive: string): boolean =>
    parseSource("a/gen.go", file(directive), "go").goFacts?.buildIgnored === true;

  it("a tab, a space, and several of either are read alike", () => {
    expect(ignored("//go:build\tignore")).toBe(true);
    expect(ignored("//go:build ignore")).toBe(true);
    expect(ignored("//go:build \t ignore")).toBe(true);
    expect(ignored("// +build\tignore")).toBe(true);
  });

  it("the marker is still a word: a letter after it is an ordinary comment", () => {
    expect(ignored("//go:buildignore")).toBe(false);
    expect(ignored("//go:buildx\tignore")).toBe(false);
    expect(ignored("//go:build\tlinux")).toBe(false);
  });

  it("and the file is then a package of its own, as with a space", () => {
    const tree = (directive: string): GoTree => ({
      "a/gen.go": file(directive),
      "a/lib.go": "package a\n\nfunc helper() {}\n",
    });
    // Ignored: `helper` is not this single-file package's, and is ruled out.
    expect(goVerdicts(tree("//go:build\tignore")).get("a/gen.go:6:helper")).toBe(
      "unbound external",
    );
    expect(goVerdicts(tree("//go:build ignore")).get("a/gen.go:6:helper")).toBe("unbound external");
  });
});
