/**
 * #1071 (PR #1104, review cycle 2, B1b) — the Go resolver bounds the WORK of a
 * call, not only its depth.
 *
 * The first recursion audit capped how deep one call could go. It did not ask
 * how much one call could cost: promotion looked through every embedded field
 * of every type on a level, for every call, and kept nothing. A file of K types
 * a level, each embedding all K of the next, made one `w.Missing()` cost
 * K × K × levels lookups — and every call paid it again, so a 665 KB file took
 * the Go binding step of a real ingest from 0.47 s to 36.8 s, uncancellable and
 * with nothing counted.
 *
 * Two things are pinned here:
 *
 *  1. cost is LINEAR in declarations plus calls — asserted as a scaling ratio
 *     (`tests/helpers/linear-time.ts`), never as a wall-clock bound;
 *  2. what is left per call, and per type, is budgeted: past the budget the
 *     answer is `unknown` with `why: "budget"`, never a guess, and the same
 *     whatever was asked first.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  createGoResolver,
  GO_CALL_STEP_BUDGET,
  GO_TYPE_STEP_BUDGET,
  type GoCallVerdict,
  type GoModule,
} from "../../../src/lib/code-graph/go-type-resolution.js";
import { initCodeGraphParsers, parseSource } from "../../../src/lib/code-graph/parsers.js";
import { showGoVerdict } from "../../helpers/go-verdicts.js";
import { expectLinearTime } from "../../helpers/linear-time.js";

const MODULE: GoModule[] = [{ dir: "", path: "example.com/app" }];

/**
 * The reviewer's generator (`genwide.cjs`), as a fixture builder: `types`
 * struct types on each of `levels` levels, every one embedding EVERY type of
 * the next level; a type `W` embedding the whole first level; and `calls`
 * calls `w.N<i>()`, which no type declares — so each call has to look through
 * the whole lattice. `extra` is appended (declarations and calls of a test's own).
 */
function goLattice(types: number, levels: number, calls: number, extra = ""): string {
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
  src += "}\n\nfunc f(w *W) {\n";
  for (let i = 0; i < calls; i += 1) src += `\tw.N${i}()\n`;
  return `${src}}\n${extra}`;
}

/** Steps building W's member set costs: every type, each of its fields twice (as a member, as an embedding). */
const latticeSteps = (types: number, levels: number): number =>
  1 + 2 * types + types * levels + 2 * types * types * (levels - 1);

interface Parsed {
  resolveAll: (order?: "forward" | "reverse") => GoCallVerdict[];
  calls: number;
}

function parseOne(src: string, filePath = "wide/wide.go"): Parsed {
  const parsed = parseSource(filePath, src, "go");
  if (!parsed.goFacts) throw new Error("the fixture did not parse");
  const callees = parsed.edges.filter((e) => e.kind === "calls").map((e) => e.goCallee!);
  return {
    calls: callees.length,
    resolveAll: (order = "forward") => {
      const resolver = createGoResolver(
        [{ filePath, facts: parsed.goFacts!, isTest: false }],
        MODULE,
      );
      const list = order === "forward" ? callees : [...callees].reverse();
      const out = list.map((c) => resolver.resolveCall(filePath, c));
      return order === "forward" ? out : out.reverse();
    },
  };
}

const tally = (verdicts: GoCallVerdict[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const v of verdicts) {
    const key = v.kind === "unknown" && v.why ? `unknown:${v.why}` : showGoVerdict(v);
    out[key] = (out[key] ?? 0) + 1;
  }
  return out;
};

beforeAll(async () => {
  await initCodeGraphParsers();
});

describe("resolving every call of a file is linear in its declarations plus its calls", () => {
  // Both the embedded fields (types² × levels) and the calls grow with the
  // file, which is what made the old lookup quadratic: four times the bytes was
  // sixteen times the time.
  const LEVELS = 10;
  const latticeOf = (chars: number): string => {
    const types = Math.max(2, Math.round(Math.sqrt(chars / (8 * LEVELS))));
    return goLattice(types, LEVELS, Math.round(chars / 220));
  };

  it("a lattice whose member set fits the budget: every call is looked up, none re-walks the lattice", () => {
    // 350,000 characters is 66 types a level and about 1,600 calls.
    expect(latticeSteps(66, LEVELS)).toBeLessThan(GO_TYPE_STEP_BUDGET);
    const full = parseOne(latticeOf(350_000));
    expect(full.calls).toBeGreaterThan(1_500);
    // No type declares any `N<i>`: undecided, and NOT for want of budget.
    expect(tally(full.resolveAll())).toEqual({ unknown: full.calls });
    expectLinearTime(
      "Go resolver over an embedding lattice (within the type budget)",
      (chars) => {
        const parsed = parseOne(latticeOf(chars));
        return () => parsed.resolveAll();
      },
      350_000,
    );
  });

  it("the reviewer's 665 KB lattice (100 types × 10 levels, 3,000 calls): past the type budget, still linear", () => {
    expect(latticeSteps(100, LEVELS)).toBeGreaterThan(GO_TYPE_STEP_BUDGET);
    const src = goLattice(100, LEVELS, 3_000);
    expect(src.length).toBeGreaterThan(600_000);
    const full = parseOne(src);
    expect(tally(full.resolveAll())).toEqual({ "unknown:budget": 3_000 });
    expectLinearTime(
      "Go resolver over the reviewer's lattice",
      (chars) => {
        const scale = chars / src.length;
        const parsed = parseOne(
          goLattice(Math.round(100 * Math.sqrt(scale)), LEVELS, Math.round(3_000 * scale)),
        );
        return () => parsed.resolveAll();
      },
      src.length,
    );
  });

  it("calls on MANY receiver types are linear too: a member set is built once per type", () => {
    // Every type of the first level is a receiver, so each has its own set.
    const many = (chars: number): string => {
      const types = Math.max(2, Math.round(Math.sqrt(chars / (8 * 4))));
      let extra = "";
      for (let i = 0; i < types; i += 1) {
        extra += `\nfunc g${i}(t *T0_${i}) {\n`;
        for (let c = 0; c < 20; c += 1) extra += `\tt.M${c}()\n`;
        extra += "}\n";
      }
      return goLattice(types, 4, 0, extra);
    };
    expectLinearTime(
      "Go resolver over many receiver types",
      (chars) => {
        const parsed = parseOne(many(chars));
        return () => parsed.resolveAll();
      },
      120_000,
    );
  });
});

describe("promotion through a lattice still follows Go's shallowest-depth rule", () => {
  const withMethods = (methods: string, calls: string): string =>
    goLattice(12, 5, 0, `${methods}\nfunc g(w *W) {\n${calls}}\n`);

  it("binds a method only ONE type of the deepest level declares", () => {
    const v = parseOne(withMethods("func (t T4_7) Deep() {}\n", "\tw.Deep()\n")).resolveAll();
    expect(v.map(showGoVerdict)).toEqual(["receiver-type wide/wide.go::T4_7::Deep"]);
  });

  it("is ambiguous when two types of one level declare it, and takes the shallower when levels differ", () => {
    const v = parseOne(
      withMethods(
        "func (t T4_1) Twice() {}\nfunc (t T4_2) Twice() {}\n" +
          "func (t T1_3) Near() {}\nfunc (t T3_3) Near() {}\n",
        "\tw.Twice()\n\tw.Near()\n\tw.Missing()\n",
      ),
    ).resolveAll();
    expect(v.map(showGoVerdict)).toEqual([
      "unbound ambiguous",
      "receiver-type wide/wide.go::T1_3::Near",
      "unknown",
    ]);
  });

  it("an embedded field is itself a member, at its own depth", () => {
    const v = parseOne(
      withMethods("", "\tw.T0_3.T1_2.T2_1()\n\tw.T0_3()\n\tw.T2_1()\n"),
    ).resolveAll();
    expect(v.map(showGoVerdict)).toEqual([
      // A FIELD is a value, not a function: calling it is a call through a value.
      "unbound func-value",
      "unbound func-value",
      // Every type of level 1 embeds `T2_1`: twelve fields of that name at one depth.
      "unbound ambiguous",
    ]);
  });
});

describe("a type whose member set is past the budget has NO member decided", () => {
  // 80 types on nine levels: W reaches 80 × 80 × 8 embedded fields, each visited twice.
  const TYPES = 80;
  const LEVELS = 9;
  const src = goLattice(
    TYPES,
    LEVELS,
    3,
    `
type Small struct{ W }

func (s *Small) Own() {}
func (w *W) OnW() {}
func (t T0_0) OnFirst() {}

type Alone struct{}

func (a *Alone) Run() {}

func g(w *W, s *Small, a *Alone) {
	w.OnW()
	w.OnFirst()
	s.Own()
	s.N0()
	a.Run()
	a.Missing()
}
`,
  );

  it("every call selecting from it is unknown BECAUSE of the budget — its own method included", () => {
    expect(latticeSteps(TYPES, LEVELS)).toBeGreaterThan(GO_TYPE_STEP_BUDGET);
    const v = parseOne(src).resolveAll();
    expect(v.slice(0, 5)).toEqual([
      { kind: "unknown", why: "budget" },
      { kind: "unknown", why: "budget" },
      { kind: "unknown", why: "budget" },
      // `w.OnW()` is W's own method — but a member set is decided whole or not at all,
      // so the answer never depends on how far the walk got.
      { kind: "unknown", why: "budget" },
      { kind: "unknown", why: "budget" },
    ]);
  });

  it("a type that EMBEDS it is past the budget too; a type that does not is untouched", () => {
    const v = parseOne(src).resolveAll();
    // s.Own(), s.N0(): Small embeds W. a.Run(), a.Missing(): Alone does not.
    expect(v.slice(5)).toEqual([
      { kind: "unknown", why: "budget" },
      { kind: "unknown", why: "budget" },
      { kind: "bound", qualifiedName: "wide/wide.go::Alone::Run", via: "receiver-type" },
      { kind: "unknown" },
    ]);
  });

  it("gives the same verdicts whatever was asked first", () => {
    const parsed = parseOne(src);
    expect(parsed.resolveAll("reverse")).toEqual(parsed.resolveAll("forward"));
  });

  it("one step under the budget, the same shape resolves", () => {
    // 78 types × 9 levels is the largest lattice of this depth inside the budget.
    expect(latticeSteps(78, LEVELS)).toBeLessThanOrEqual(GO_TYPE_STEP_BUDGET);
    expect(latticeSteps(79, LEVELS)).toBeGreaterThan(GO_TYPE_STEP_BUDGET);
    const extra = "\nfunc (w *W) OnW() {}\n\nfunc g(w *W) {\n\tw.OnW()\n\tw.Missing()\n}\n";
    const inside = parseOne(goLattice(78, LEVELS, 0, extra)).resolveAll();
    expect(inside).toEqual([
      { kind: "bound", qualifiedName: "wide/wide.go::W::OnW", via: "receiver-type" },
      { kind: "unknown" },
    ]);
    const outside = parseOne(goLattice(79, LEVELS, 0, extra)).resolveAll();
    expect(outside).toEqual([
      { kind: "unknown", why: "budget" },
      { kind: "unknown", why: "budget" },
    ]);
  });
});

describe("one call has a step budget of its own", () => {
  const withDotImports = (count: number): string => {
    let src = "package p\n\nimport (\n";
    for (let i = 0; i < count; i += 1) src += `\t. "example.com/app/d${i}"\n`;
    return `${src})\n\nfunc declared() {}\n\nfunc f() {\n\tmissing()\n\tdeclared()\n\tlen("x")\n}\n`;
  };

  it("a bare name that would consult more dot imports than the budget allows is unknown, and says why", () => {
    const v = parseOne(withDotImports(GO_CALL_STEP_BUDGET + 1), "p/p.go").resolveAll();
    expect(v).toEqual([
      { kind: "unknown", why: "budget" },
      // A name the package declares is found before any dot import is consulted.
      { kind: "bound", qualifiedName: "p/p.go::declared", via: "same-package" },
      { kind: "unknown", why: "budget" },
    ]);
  });

  it("inside the budget the same call is plainly undecided: a dot import may declare it", () => {
    const v = parseOne(withDotImports(40), "p/p.go").resolveAll();
    expect(v[0]).toEqual({ kind: "unknown" });
    expect(v[1]).toEqual({ kind: "bound", qualifiedName: "p/p.go::declared", via: "same-package" });
    // A builtin is external whatever a dot import could add.
    expect(v[2]).toEqual({ kind: "unbound", reason: "external" });
  });

  it("the budget is per call: a costly call does not use up the next one's", () => {
    const parsed = parseOne(withDotImports(GO_CALL_STEP_BUDGET + 1), "p/p.go");
    expect(parsed.resolveAll("reverse")).toEqual(parsed.resolveAll("forward"));
  });
});

describe("what is kept between calls never changes an answer", () => {
  // A chain of 14 aliases down to a struct: a type name is followed through 12.
  const chain = (() => {
    let src = "package p\n\ntype Base struct{}\n\nfunc (b Base) M() {}\n\ntype A14 = Base\n";
    for (let i = 13; i >= 0; i -= 1) src += `type A${i} = A${i + 1}\n`;
    return src;
  })();
  const calls = (order: number[]): string =>
    `${chain}\n${order.map((n) => `func f${n}(x A${n}) {\n\tx.M()\n}\n`).join("\n")}`;
  const BOUND = "receiver-type p/p.go::Base::M";

  it("an alias chain resolves through 12 links and not 13, entered anywhere", () => {
    const v = parseOne(calls([14, 3, 2, 1, 0]), "p/p.go")
      .resolveAll()
      .map(showGoVerdict);
    // A14 → Base is 1 link, A3 → Base is 12, A2 → Base is 13.
    expect(v).toEqual([BOUND, BOUND, "unknown", "unknown", "unknown"]);
  });

  it("and the answer for one name does not depend on which name was resolved first", () => {
    const forward = parseOne(calls([0, 1, 2, 3, 4, 14]), "p/p.go");
    const expected = ["unknown", "unknown", "unknown", BOUND, BOUND, BOUND];
    expect(forward.resolveAll("forward").map(showGoVerdict)).toEqual(expected);
    expect(forward.resolveAll("reverse").map(showGoVerdict)).toEqual(expected);
  });

  it("a defined type over an alias chain counts the link it adds, kept answers or not", () => {
    // `Base` has a field; a type DEFINED as an alias of it has that field too,
    // one link further than the alias itself.
    const src = `${chain.replace("type Base struct{}", "type Base struct{ self *Base }")}
type D4 A4
type D3 A3

func g(viaAlias A3, d4 D4, d3 D3) {
	viaAlias.self.M()
	d4.self.M()
	d3.self.M()
}
`;
    const parsed = parseOne(src, "p/p.go");
    // A3 → Base is 12 links: the alias resolves, and so does D4 (1 + 11).
    // D3 would be 1 + 12.
    const expected = [BOUND, BOUND, "unknown"];
    expect(parsed.resolveAll("forward").map(showGoVerdict)).toEqual(expected);
    expect(parsed.resolveAll("reverse").map(showGoVerdict)).toEqual(expected);
  });

  it("the same type asked from a test file and from a non-test file is answered for each", () => {
    const type = parseSource("p/t.go", "package p\n\ntype T struct{}\n", "go");
    const method = parseSource("p/t_test.go", "package p\n\nfunc (t T) OnlyInTest() {}\n", "go");
    const use = (file: string) =>
      parseSource(file, "package p\n\nfunc use(t T) {\n\tt.OnlyInTest()\n}\n", "go");
    const fromTest = use("p/use_test.go");
    const fromCode = use("p/use.go");
    const files = [
      { filePath: "p/t.go", facts: type.goFacts!, isTest: false },
      { filePath: "p/t_test.go", facts: method.goFacts!, isTest: true },
      { filePath: "p/use_test.go", facts: fromTest.goFacts!, isTest: true },
      { filePath: "p/use.go", facts: fromCode.goFacts!, isTest: false },
    ];
    const callee = (p: typeof fromTest) => p.edges.find((e) => e.kind === "calls")!.goCallee!;
    for (const first of ["test", "code"] as const) {
      const resolver = createGoResolver(files, MODULE);
      const ask = {
        test: () => showGoVerdict(resolver.resolveCall("p/use_test.go", callee(fromTest))),
        code: () => showGoVerdict(resolver.resolveCall("p/use.go", callee(fromCode))),
      };
      const one = ask[first]();
      const other = ask[first === "test" ? "code" : "test"]();
      const got = first === "test" ? { test: one, code: other } : { test: other, code: one };
      // A non-test file never reaches a method declared in a `_test.go` file.
      expect(got).toEqual({ test: "receiver-type p/t_test.go::T::OnlyInTest", code: "unknown" });
    }
  });
});

describe("the walker costs what the file is long, whatever its shape", () => {
  // The same question asked of the walker: is any work per identifier or per
  // call proportional to the size of what surrounds it? A local is looked up
  // through the scopes around it; the parser gives up on nesting long before
  // that could matter, and these pin the shapes it does accept.
  const parse = (src: string) => () => parseSource("p/t.go", src, "go");
  const HEAD = "package p\n\ntype T struct{}\n\nfunc (t *T) M() {}\n\n";

  it("calls on an outer local inside 200 nested blocks", () => {
    const nested = (chars: number): string => {
      const calls = Math.round(chars / 6);
      return `${HEAD}func f(x *T) {\n${"{\n".repeat(200)}${"x.M()\n".repeat(calls)}${"}\n".repeat(200)}}\n`;
    };
    const parsed = parseSource("p/t.go", nested(6_000), "go");
    expect(parsed.unparseable).toBeFalsy();
    expect(parsed.edges.filter((e) => e.kind === "calls")).toHaveLength(1_000);
    expectLinearTime("Go walker, nested scopes", (chars) => parse(nested(chars)), 400_000);
  });

  it("functions with hundreds of parameters, one call on each", () => {
    const wide = (chars: number): string => {
      const params = Math.max(4, Math.round(Math.sqrt(chars / 20)));
      let src = HEAD;
      for (let f = 0; f < params; f += 1) {
        src += `func f${f}(`;
        for (let p = 0; p < params; p += 1) src += `p${p} *T, `;
        src += ") {\n";
        for (let p = 0; p < params; p += 1) src += `p${p}.M()\n`;
        src += "}\n";
      }
      return src;
    };
    expectLinearTime("Go walker, wide parameter lists", (chars) => parse(wide(chars)), 400_000);
  });
});
describe("placing a directory or an import path costs its own length, not the size of the tree", () => {
  // PR #1104, review cycle 3 (M1). Matching one import against the directories
  // no `go.mod` covers filtered ALL of them, for every import of a file, inside
  // one `resolveCall` and outside every budget: 5.8 s for one call on a
  // 20,001-file tree, 23 s at 40,001. Placing a directory in its module, and an
  // import path in the most specific module, scanned every `go.mod`: 1.2 s to
  // build a resolver over 24,000 of them and 7.7 s to resolve. These are the
  // reviewer's two generator shapes (`gen2.cjs`: `orphans`, `modules`).
  type Tree = Array<[string, string]>;

  /** Parse outside the timed call; the timed call builds a resolver and resolves every call. */
  const resolveAll = (tree: Tree, modules: GoModule[]): (() => Record<string, number>) => {
    const parsed = tree.map(([filePath, src]) => parseSource(filePath, src, "go"));
    const files = parsed.map((p) => ({
      filePath: p.filePath,
      facts: p.goFacts!,
      isTest: p.filePath.endsWith("_test.go"),
    }));
    return () => {
      const resolver = createGoResolver(files, modules);
      const out: GoCallVerdict[] = [];
      for (const p of parsed) {
        for (const e of p.edges) {
          if (e.kind === "calls") out.push(resolver.resolveCall(p.filePath, e.goCallee!));
        }
      }
      return tally(out);
    };
  };

  /** `dirs` directories of one `package x` file each, no go.mod, and one file importing a path per directory. */
  const orphans = (dirs: number): Tree => {
    const tree: Tree = [];
    let main = "package main\n\nimport (\n";
    for (let i = 0; i < dirs; i += 1) {
      tree.push([`d${i}/x/a.go`, "package x\n"]);
      main += `\ta${i} "q/r${i}/x"\n`;
    }
    main += ")\n\nfunc main() {\n";
    for (let i = 0; i < dirs; i += 1) main += `\ta${i}.Go()\n`;
    tree.push(["cmd/main.go", `${main}}\n`]);
    return tree;
  };

  /** The same tree where each import DOES end in one of the directories: every call binds. */
  const orphansThatMatch = (dirs: number): Tree => {
    const tree: Tree = [];
    let main = "package main\n\nimport (\n";
    for (let i = 0; i < dirs; i += 1) {
      tree.push([`d${i}/x/a.go`, "package x\n\nfunc Go() {}\n"]);
      main += `\ta${i} "example.org/app/d${i}/x"\n`;
    }
    main += ")\n\nfunc main() {\n";
    for (let i = 0; i < dirs; i += 1) main += `\ta${i}.Go()\n`;
    tree.push(["cmd/main.go", `${main}}\n`]);
    return tree;
  };

  /** `count` modules, each one file importing a path outside all of them. */
  const manyModules = (count: number): { tree: Tree; modules: GoModule[] } => {
    const tree: Tree = [];
    const modules: GoModule[] = [];
    for (let i = 0; i < count; i += 1) {
      modules.push({ dir: `m${i}`, path: `m${i}` });
      tree.push([`m${i}/a.go`, `package a\n\nimport "q/z${i}"\n\nfunc A() {\n\tz${i}.Go()\n}\n`]);
    }
    return { tree, modules };
  };

  it("no go.mod: what each shape resolves to", () => {
    expect(resolveAll(orphans(40), [])()).toEqual({ "unbound external": 40 });
    const matched = resolveAll(orphansThatMatch(40), [])();
    expect(Object.keys(matched)).toHaveLength(40);
    expect(Object.keys(matched).every((k) => k.startsWith("package d"))).toBe(true);
  });

  it("no go.mod: 8,000 directories and 8,000 imports of one file", () => {
    expectLinearTime(
      "Go resolver, imports matched by spelling",
      (dirs) => resolveAll(orphans(dirs), []),
      8_000,
    );
  });

  it("no go.mod: the same when every import matches a directory", () => {
    expectLinearTime(
      "Go resolver, imports matched to directories",
      (dirs) => resolveAll(orphansThatMatch(dirs), []),
      8_000,
    );
  });

  it("12,000 go.mod files: building the resolver and resolving one import from each", () => {
    const small = manyModules(30);
    expect(resolveAll(small.tree, small.modules)()).toEqual({
      "unbound external": 30,
    });
    expectLinearTime(
      "Go resolver, many modules",
      (count) => {
        const { tree, modules } = manyModules(count);
        return resolveAll(tree, modules);
      },
      12_000,
    );
  });
});

describe("a type reached from the tests of many directories is still searched once", () => {
  // The members a test file sees differ from everyone else's only by the
  // methods ITS directory's `_test.go` files declare. Working that out must
  // not repeat the promotion search per directory: one type embedding a type
  // from each of N packages, called from a test in each, would cost N × N.
  const fan = (count: number): Array<[string, string]> => {
    const tree: Array<[string, string]> = [];
    let big = "package big\n\nimport (\n";
    for (let i = 0; i < count; i += 1) big += `\t"example.com/app/e${i}"\n`;
    big += ")\n\ntype Big struct {\n";
    for (let i = 0; i < count; i += 1) {
      big += `\te${i}.E${i}\n`;
      tree.push([`e${i}/e.go`, `package e${i}\n\ntype E${i} struct{}\n`]);
      tree.push([`e${i}/export_test.go`, `package e${i}\n\nfunc (E${i}) T${i}() {}\n`]);
      tree.push([
        `e${i}/x_test.go`,
        `package e${i}_test\n\nimport "example.com/app/big"\n\nfunc probe(b big.Big) {\n\tb.T${i}()\n}\n`,
      ]);
    }
    tree.push(["big/big.go", `${big}}\n`]);
    return tree;
  };
  const resolveFan = (count: number): (() => string[]) => {
    const parsed = fan(count).map(([filePath, src]) => parseSource(filePath, src, "go"));
    const files = parsed.map((p) => ({
      filePath: p.filePath,
      facts: p.goFacts!,
      isTest: p.filePath.endsWith("_test.go"),
    }));
    return () => {
      const resolver = createGoResolver(files, MODULE);
      const out: string[] = [];
      for (const p of parsed) {
        for (const e of p.edges) {
          if (e.kind === "calls")
            out.push(showGoVerdict(resolver.resolveCall(p.filePath, e.goCallee!)));
        }
      }
      return out;
    };
  };

  it("each test reaches the method its own directory's test file declares", () => {
    expect(resolveFan(3)()).toEqual([
      "receiver-type e0/export_test.go::E0::T0",
      "receiver-type e1/export_test.go::E1::T1",
      "receiver-type e2/export_test.go::E2::T2",
    ]);
  });

  it("3,000 directories, a test in each", () => {
    expect(3 * 3_000 + 2).toBeLessThan(GO_TYPE_STEP_BUDGET);
    expectLinearTime("Go resolver, test views of one type", (count) => resolveFan(count), 3_000);
  });
});
describe("what counts as a step, pinned exactly on small trees", () => {
  // The budgets are large on purpose, so that no real file meets them — which
  // also means no small fixture does. `GoResolverOptions.budgets` lowers them
  // for a test: the count below each fixture is the number of steps it takes,
  // and a budget of exactly that many is enough while one fewer is not.
  type Tree = Record<string, string>;
  const ask = (
    tree: Tree,
    budgets: { callSteps?: number; typeSteps?: number },
    order: "forward" | "reverse" = "forward",
  ): GoCallVerdict[] => {
    const parsed = Object.entries(tree).map(([filePath, src]) => parseSource(filePath, src, "go"));
    const resolver = createGoResolver(
      parsed.map((p) => ({
        filePath: p.filePath,
        facts: p.goFacts!,
        isTest: false,
      })),
      MODULE,
      { budgets },
    );
    const calls = parsed.flatMap((p) =>
      p.edges
        .filter((e) => e.kind === "calls")
        .map((e) => ({ file: p.filePath, callee: e.goCallee! })),
    );
    const list = order === "forward" ? calls : [...calls].reverse();
    const out = list.map((c) => resolver.resolveCall(c.file, c.callee));
    return order === "forward" ? out : out.reverse();
  };
  const BUDGET: GoCallVerdict = { kind: "unknown", why: "budget" };

  describe("one call: a node of the callee, and each dot-imported package consulted for a bare name", () => {
    /** `count` dot imports of DISTINCT project packages, none declaring `missing`. */
    const dots = (count: number): Tree => {
      const tree: Tree = {};
      let src = "package p\n\nimport (\n";
      for (let i = 0; i < count; i += 1) {
        src += `\t. "example.com/app/d${i}"\n`;
        tree[`d${i}/l.go`] = `package d${i}\n\nfunc L${i}() {}\n`;
      }
      tree["p/p.go"] =
        `${src})\n\nfunc declared() {}\n\nfunc f() {\n\tmissing()\n\tdeclared()\n\tlen("x")\n\tL0()\n}\n`;
      return tree;
    };
    const DECLARED: GoCallVerdict = {
      kind: "bound",
      qualifiedName: "p/p.go::declared",
      via: "same-package",
    };
    const L0: GoCallVerdict = {
      kind: "bound",
      qualifiedName: "d0/l.go::L0",
      via: "package",
    };

    it("1 + 7 steps in a budget of 8: every dot import is consulted, and the answer is plain", () => {
      expect(ask(dots(7), { callSteps: 8 })).toEqual([
        // Undecided because a dot import MAY declare it elsewhere — not for want of budget.
        { kind: "unknown" },
        DECLARED,
        { kind: "unbound", reason: "external" },
        L0,
      ]);
    });

    it("1 + 8 steps in a budget of 8: undecided, and it says why", () => {
      expect(ask(dots(8), { callSteps: 8 })).toEqual([
        BUDGET,
        // Found in the package itself, before any dot import is consulted.
        DECLARED,
        BUDGET,
        // Found in the first dot import: 1 + 1 steps.
        L0,
      ]);
    });

    it("the budget is per call: a costly call does not use up the next one's, in either order", () => {
      expect(ask(dots(8), { callSteps: 8 }, "reverse")).toEqual(ask(dots(8), { callSteps: 8 }));
    });

    it("a chain costs one step a link", () => {
      const chain: Tree = {
        "p/p.go":
          "package p\n\ntype T struct{ F *T }\n\nfunc (T) M() {}\n\nfunc f(x T) {\n\tx.F.F.M()\n}\n",
      };
      // M, F, F and x: four nodes.
      expect(ask(chain, { callSteps: 4 })).toEqual([
        { kind: "bound", qualifiedName: "p/p.go::T::M", via: "receiver-type" },
      ]);
      expect(ask(chain, { callSteps: 3 })).toEqual([BUDGET]);
    });

    it("an import block one longer than the budget is not read; one that fits is", () => {
      const named = (count: number): Tree => {
        let src = "package p\n\nimport (\n";
        for (let i = 0; i < count; i += 1) src += `\ta${i} "q/r${i}"\n`;
        return { "p/p.go": `${src})\n\nfunc f() {\n\ta0.Go()\n}\n` };
      };
      expect(ask(named(6), { callSteps: 6 })).toEqual([{ kind: "unbound", reason: "external" }]);
      expect(ask(named(7), { callSteps: 6 })).toEqual([BUDGET]);
    });
  });

  describe("one type: each type, field, method, interface method and embedding visited", () => {
    const STRUCTS: Tree = {
      "p/p.go": `package p

type E struct{}

func (E) N() {}

type T struct {
	a int
	b int
	E
}

func (T) M1() {}

func (T) M2() {}

func use(t T) {
	t.M1()
	t.N()
}
`,
    };
    const M1: GoCallVerdict = {
      kind: "bound",
      qualifiedName: "p/p.go::T::M1",
      via: "receiver-type",
    };
    const N: GoCallVerdict = {
      kind: "bound",
      qualifiedName: "p/p.go::E::N",
      via: "receiver-type",
    };

    it("T: itself 1, fields a b E 3, methods 2, the embedding 1; E: itself 1, method 1 — nine", () => {
      expect(ask(STRUCTS, { typeSteps: 9 })).toEqual([M1, N]);
    });

    it("eight is one too few: NOTHING about the type is decided, not even its own method", () => {
      expect(ask(STRUCTS, { typeSteps: 8 })).toEqual([BUDGET, BUDGET]);
      // And the same whichever call asks first.
      expect(ask(STRUCTS, { typeSteps: 8 }, "reverse")).toEqual([BUDGET, BUDGET]);
    });

    it("the first level alone is six: a budget of five stops there", () => {
      expect(ask(STRUCTS, { typeSteps: 6 })).toEqual([BUDGET, BUDGET]);
      expect(ask(STRUCTS, { typeSteps: 5 })).toEqual([BUDGET, BUDGET]);
    });

    const INTERFACE: Tree = {
      "p/p.go": `package p

type I interface {
	A()
	B()
}

type S struct{ I }

func use(s S) {
	s.A()
}
`,
    };

    it("S: itself 1, field I 1, the embedding 1; I: itself 1, methods A B 2 — six", () => {
      expect(ask(INTERFACE, { typeSteps: 6 })).toEqual([{ kind: "unbound", reason: "interface" }]);
      expect(ask(INTERFACE, { typeSteps: 5 })).toEqual([BUDGET]);
    });
  });
});
