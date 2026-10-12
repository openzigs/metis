/**
 * #1071 — the Go walker and resolver against the Go TYPE CHECKER.
 *
 * `tests/fixtures/go-oracle/` holds a Go corpus that compiles, and
 * `oracle.snapshot.json` holds what go/types says each of its calls resolves
 * to (`scripts/go-oracle-snapshot/main.go`; regenerate with
 * `node scripts/gen-go-oracle-snapshot.mjs`). This suite runs the real
 * tree-sitter walker and the real resolver over the same files and compares,
 * call by call. No Go runs here. `tests/helpers/go-oracle.ts` states the rules;
 * `tests/code-graph-go-oracle-1071.sqlite.test.ts` repeats the comparison on
 * the rows a real ingest stores.
 *
 * This is the main guard against a WRONG binding. The hand-written fixtures in
 * the neighbouring `go-type-resolution*.test.ts` files stay, as the readable
 * statement of each rule — but three mutation passes showed that they do not
 * add up to "every bound target is the right one", and this does not rely on
 * anyone having thought of the case: to cover a construct, write it in the
 * corpus and regenerate.
 */
import { cpSync, appendFileSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { initCodeGraphParsers } from "../../../src/lib/code-graph/parsers.js";
import {
  compareWithOracle,
  decidedAgrees,
  GO_ORACLE_ALLOW,
  GO_ORACLE_FIXTURE,
  GO_ORACLE_VIEWS,
  goOracleCorpusHash,
  loadGoOracle,
  type MetisCall,
  metisCallsOfView,
  metisSymbolsOfView,
  type OracleAllowance,
  type OracleCall,
  type OracleComparison,
  oracleCallsFor,
  oracleSymbolsFor,
  type OracleView,
  readOracleView,
  showAnswer,
  showVerdict,
  verdictTable,
} from "../../helpers/go-oracle.js";

const snapshot = loadGoOracle();

function compare(view: OracleView): OracleComparison {
  const { calls, duplicates } = metisCallsOfView(readOracleView(view));
  return compareWithOracle(
    view,
    oracleCallsFor(snapshot, view),
    calls,
    GO_ORACLE_ALLOW,
    duplicates,
  );
}

const of = (cmp: OracleComparison, rule: string): string[] =>
  cmp.findings.filter((f) => f.rule === rule).map((f) => `${f.key}: ${f.detail}`);

describe("#1071 — the Go oracle corpus", () => {
  beforeAll(async () => {
    await initCodeGraphParsers();
  });

  it("the snapshot was generated from the corpus as it is checked in", () => {
    // Fails when a corpus file changed and `node scripts/gen-go-oracle-snapshot.mjs` was not run.
    expect(goOracleCorpusHash()).toBe(snapshot.corpusHash);
  });

  it("the allow-list holds four calls, of two kinds, and no more", () => {
    // Raising this number is a decision to accept a decided verdict the type
    // checker contradicts: say why in the entry, and in the PR.
    expect(GO_ORACLE_ALLOW.map((a) => `${a.view} ${a.key} ${a.metis}`)).toEqual([
      "modules app/ext/ext.go:99:OnError unbound external",
      "modules app/platform/plat_linux.go:8:shared unbound ambiguous",
      "modules app/platform/plat_other.go:10:shared unbound ambiguous",
      "modules app/platform/plat_windows.go:8:shared unbound ambiguous",
    ]);
    for (const a of GO_ORACLE_ALLOW) expect(a.reason.length).toBeGreaterThan(40);
  });

  it("the corpus is large enough to mean something", () => {
    const calls = snapshot.trees.flatMap((t) => t.calls);
    expect(calls.length).toBeGreaterThan(400);
    const kinds = new Set(calls.map((c) => c.answer.k));
    expect([...kinds].sort()).toEqual([
      "build-dependent",
      "builtin",
      "conversion",
      "external",
      "func",
      "func-value",
      "interface",
    ]);
  });

  describe.each(GO_ORACLE_VIEWS.map((v) => [v.name, v] as const))("view %s", (_name, view) => {
    let cmp: OracleComparison;
    beforeAll(() => {
      cmp = compare(view);
    });

    it("SOUNDNESS: every call bound by type is bound to the type checker's target", () => {
      expect(of(cmp, "soundness")).toEqual([]);
      expect(cmp.stats.boundAgreeing).toBeGreaterThan(0);
    });

    it("a decided verdict is issued only where the type checker agrees with its class", () => {
      expect(of(cmp, "decided")).toEqual([]);
    });

    it("the allow-list is exact: no entry is stale", () => {
      expect(of(cmp, "allow-list")).toEqual([]);
    });

    it("the walker records every call the type checker lists, on its line", () => {
      expect(of(cmp, "keys")).toEqual([]);
    });

    it("every call is recorded under the function it is written in", () => {
      expect(of(cmp, "from")).toEqual([]);
    });

    it("the walker's symbols are the declarations Go's parser lists: kind, name, lines", () => {
      const mine = metisSymbolsOfView(readOracleView(view));
      expect(mine.length).toBeGreaterThan(3);
      expect(mine).toEqual(oracleSymbolsFor(snapshot, view));
    });
  });

  it("RECALL: the statically resolvable calls METIS leaves unbound are a checked-in list", async () => {
    // Reported, not asserted to be empty. A change that silently loses a
    // binding shows up as a diff of this file; re-record with `vitest -u`
    // after reading the diff.
    const report: Record<string, unknown> = {};
    for (const view of GO_ORACLE_VIEWS) {
      const cmp = compare(view);
      report[view.name] = { ...cmp.stats, unbound: cmp.recallMisses };
    }
    await expect(`${JSON.stringify(report, null, 2)}\n`).toMatchFileSnapshot(
      path.join(GO_ORACLE_FIXTURE, "recall.snapshot.json"),
    );
  });

  it("every verdict, beside the type checker's answer, is a checked-in line", async () => {
    // Not an assertion of correctness — the rules above are — but of SAMENESS:
    // any verdict that changes, in either direction, is a diff to read against
    // the type checker's answer printed next to it. Re-record with `vitest -u`.
    const table: Record<string, string[]> = {};
    for (const view of GO_ORACLE_VIEWS) {
      const { calls } = metisCallsOfView(readOracleView(view));
      table[view.name] = verdictTable(view, oracleCallsFor(snapshot, view), calls);
    }
    await expect(`${JSON.stringify(table, null, 1)}\n`).toMatchFileSnapshot(
      path.join(GO_ORACLE_FIXTURE, "verdicts.snapshot.json"),
    );
  });

  // ── Shapes that once survived every test (PR #1104, review cycle 4). ──────
  //
  // An independent mutation pass changed ten lines of the resolver and the
  // walker with every test green; nine of the ten changed an answer on Go that
  // compiles. Each shape is in the corpus now, where the rules above judge it
  // against the type checker. The verdicts are ALSO stated here, because two
  // of them are a call left undecided — which no rule above objects to, and
  // which the checked-in table alone would let a careless `vitest -u` accept.
  describe("the shapes an independent mutation pass found unpinned", () => {
    const verdictsOf = (name: string): Map<string, string> => {
      const view = GO_ORACLE_VIEWS.find((v) => v.name === name)!;
      const { calls } = metisCallsOfView(readOracleView(view));
      return new Map([...calls].map(([key, call]) => [key, showVerdict(call.verdict)]));
    };
    const answersOf = (name: string): Map<string, string> => {
      const view = GO_ORACLE_VIEWS.find((v) => v.name === name)!;
      const prefix = `${view.root}/`;
      return new Map(
        oracleCallsFor(snapshot, view).map((c) => [
          `${c.file.slice(prefix.length)}:${c.line}:${c.name}`,
          c.answer.k,
        ]),
      );
    };

    it("a dependency whose import path ends like a project directory is not that directory", () => {
      // `github.com/acme/storage` beside the module `example.com/app` and its
      // own `storage/`: as long before the last segment as the module path.
      const v = verdictsOf("modules");
      expect(v.get("app/thirdstore/dep.go:8:Save")).toBe("unbound external");
      expect(v.get("app/thirdstore/dep.go:9:Ping")).toBe("unbound external-assumed");
      expect(v.get("app/thirdstore/own.go:6:Save")).toBe("package app/storage/storage.go::Save");
      expect(v.get("app/thirdstore/own.go:7:Ping")).toBe(
        "receiver-type app/storage/storage.go::Conn::Ping",
      );
      expect(answersOf("modules").get("app/thirdstore/dep.go:8:Save")).toBe("external");
    });

    it("the result of a func type the source does not let it read is undecided — never external, and never a throw", () => {
      const v = verdictsOf("modules");
      // `type Factory = func() *Made`: an alias of a func type.
      expect(v.get("app/values/factory.go:19:Save")).toBe("unknown");
      // `type Opts = struct{ M *Made }`: an alias of a struct type written in place.
      expect(v.get("app/values/factory.go:23:Save")).toBe("unknown");
      // `type Hook func() *Dev`, declared once per platform.
      expect(v.get("app/platform/use.go:21:Name")).toBe("unknown");
      // The type checker binds all three: undecided is the honest answer, a
      // decided one would be wrong.
      const go = answersOf("modules");
      expect(go.get("app/values/factory.go:19:Save")).toBe("func");
      expect(go.get("app/values/factory.go:23:Save")).toBe("func");
      expect(go.get("app/platform/use.go:21:Name")).toBe("func");
    });

    it("an element of a slice held in a FIELD is called through its value", () => {
      // `s.handlers[i](1)`: the grammar reads it as a conversion to a generic
      // type `s.handlers[i]`; what `s` is says otherwise.
      const v = verdictsOf("modules");
      expect(v.get("app/values/factory.go:27:handlers")).toBe("unbound func-value");
      expect(v.get("app/values/factory.go:28:handlers")).toBe("unbound func-value");
      expect(answersOf("modules").get("app/values/factory.go:27:handlers")).toBe("func-value");
    });

    it("twins declared in TEST files only: each caller's own file declares its callee", () => {
      const v = verdictsOf("modules");
      for (const goos of ["linux", "windows", "darwin"]) {
        const file = `app/twintest/twin_${goos}_test.go`;
        expect(v.get(`${file}:9:setup`)).toBe(`same-package ${file}::setup`);
        expect(v.get(`${file}:10:Base`)).toBe("same-package app/twintest/twintest.go::Base");
      }
    });

    it("a conversion from the external test package to a type only `export_test.go` declares keeps its methods", () => {
      const v = verdictsOf("modules");
      expect(v.get("app/embed/embed_x_test.go:20:TestOnly")).toBe("unbound conversion");
      expect(v.get("app/embed/embed_x_test.go:20:Probe")).toBe(
        "receiver-type app/embed/export_test.go::TestOnly::Probe",
      );
    });

    it("two directories an import path ends in, with no go.mod: Go means the SHORTER one, and METIS binds neither", () => {
      // `example.org/legacy/internal/storage`, in a tree whose root is that
      // package root and which also holds `legacy/internal/storage/`. The
      // longer directory used to be bound — a wrong target, by the type
      // checker's own answer (PR #1104, review cycle 4).
      const fromPackageRoot = verdictsOf("legacy-package-root");
      expect(fromPackageRoot.get("cmd/app/main.go:26:Open")).toBe("unknown");
      const view = GO_ORACLE_VIEWS.find((v) => v.name === "legacy-package-root")!;
      const oracle = oracleCallsFor(snapshot, view).find(
        (c) => c.file.endsWith("cmd/app/main.go") && c.line === 26,
      )!;
      expect(showAnswer(oracle.answer, view)).toBe("func internal/storage/storage.go::Open");
      // A one-segment directory the path ends in is a second reading as well.
      expect(fromPackageRoot.get("cmd/app/main.go:16:Save")).toBe("unknown");
      expect(fromPackageRoot.get("cmd/app/main.go:18:Save")).toBe("unknown");
      // From the GOPATH root the directory that HOLDS the whole path is the
      // only reading there is.
      expect(
        verdictsOf("legacy-gopath-root").get("src/example.org/legacy/cmd/app/main.go:26:Open"),
      ).toBe("package src/example.org/legacy/internal/storage/storage.go::Open");
    });
  });

  // ── The checker itself: each rule must be able to fail. ───────────────────
  describe("the comparison fails when METIS is wrong (positive controls)", () => {
    const view = GO_ORACLE_VIEWS[0];
    let oracle: OracleCall[];
    let metis: Map<string, MetisCall>;
    beforeAll(() => {
      oracle = oracleCallsFor(snapshot, view);
      metis = metisCallsOfView(readOracleView(view)).calls;
    });

    const rules = (
      calls: Map<string, MetisCall>,
      allow: readonly OracleAllowance[] = GO_ORACLE_ALLOW,
    ): string[] => compareWithOracle(view, oracle, calls, allow).findings.map((f) => f.rule);

    /** A bound call and the key of another one bound elsewhere. */
    const twoBound = (): [MetisCall, MetisCall] => {
      const bound = [...metis.values()].filter((c) => c.verdict.kind === "bound");
      const first = bound[0];
      const other = bound.find((c) => showsDifferentTarget(c, first))!;
      return [first, other];
    };
    const showsDifferentTarget = (a: MetisCall, b: MetisCall): boolean =>
      a.verdict.kind === "bound" &&
      b.verdict.kind === "bound" &&
      a.verdict.qualifiedName !== b.verdict.qualifiedName;

    it("unchanged, it finds nothing", () => {
      expect(rules(metis)).toEqual([]);
    });

    it("a call bound to ANOTHER project function is a soundness finding", () => {
      const [first, other] = twoBound();
      const wrong = new Map(metis);
      wrong.set(first.key, { ...first, verdict: other.verdict });
      expect(rules(wrong)).toEqual(["soundness"]);
    });

    it("a call bound where the type checker names no project function is a soundness finding", () => {
      const [first] = twoBound();
      const dispatched = oracle.find((c) => c.answer.k === "interface" && c.form !== "other")!;
      const key = `${dispatched.file.slice(view.root.length + 1)}:${dispatched.line}:${dispatched.name}`;
      const wrong = new Map(metis);
      wrong.set(key, { ...metis.get(key)!, verdict: first.verdict });
      expect(rules(wrong)).toEqual(["soundness"]);
    });

    it.each([
      "external",
      "external-assumed",
      "ambiguous",
      "interface",
      "func-value",
      "conversion",
    ] as const)("a project call decided `%s` is a decided-verdict finding", (reason) => {
      const [first] = twoBound();
      const wrong = new Map(metis);
      wrong.set(first.key, { ...first, verdict: { kind: "unbound", reason } });
      expect(rules(wrong)).toEqual(["decided"]);
    });

    it("an allow-list entry excuses exactly the disagreement it names, and is stale otherwise", () => {
      const [first] = twoBound();
      const wrong = new Map(metis);
      wrong.set(first.key, { ...first, verdict: { kind: "unbound", reason: "ambiguous" } });
      const entry: OracleAllowance = {
        view: view.name,
        key: first.key,
        metis: "unbound ambiguous",
        oracle: `func ${first.verdict.kind === "bound" ? first.verdict.qualifiedName : ""}`,
        reason: "control",
      };
      expect(rules(wrong, [...GO_ORACLE_ALLOW, entry])).toEqual([]);
      // The same entry against a tree that needs no excuse is reported.
      expect(rules(metis, [...GO_ORACLE_ALLOW, entry])).toEqual(["allow-list"]);
      // And it does not excuse a DIFFERENT wrong verdict on that call.
      wrong.set(first.key, { ...first, verdict: { kind: "unbound", reason: "external" } });
      expect(rules(wrong, [...GO_ORACLE_ALLOW, entry]).sort()).toEqual(["allow-list", "decided"]);
    });

    it("a missing call edge, an extra one and a duplicate key are findings", () => {
      const [first] = twoBound();
      const missing = new Map(metis);
      missing.delete(first.key);
      expect(rules(missing)).toEqual(["keys"]);
      const extra = new Map(metis);
      extra.set("nowhere.go:1:f", { ...first, key: "nowhere.go:1:f" });
      expect(rules(extra)).toEqual(["keys"]);
      expect(
        compareWithOracle(view, oracle, metis, GO_ORACLE_ALLOW, [first.key]).findings.map(
          (f) => f.rule,
        ),
      ).toEqual(["keys"]);
    });

    it("a call recorded under the wrong function is a finding", () => {
      const [first] = twoBound();
      const wrong = new Map(metis);
      wrong.set(first.key, { ...first, from: `${first.from}::elsewhere` });
      expect(rules(wrong)).toEqual(["from"]);
    });

    it("an undecided call is never a finding, and is counted as lost recall", () => {
      const [first] = twoBound();
      const undecided = new Map(metis);
      undecided.set(first.key, { ...first, verdict: { kind: "unknown" } });
      const cmp = compareWithOracle(view, oracle, undecided, GO_ORACLE_ALLOW);
      const base = compareWithOracle(view, oracle, metis, GO_ORACLE_ALLOW);
      expect(cmp.findings).toEqual([]);
      expect(cmp.recallMisses.length).toBe(base.recallMisses.length + 1);
    });

    it("the class table: what each decided verdict may stand for", () => {
      const a = (k: OracleCall["answer"]["k"], origin?: string) => ({ k, origin });
      expect(decidedAgrees("external", a("external", "stdlib"))).toBe(true);
      expect(decidedAgrees("external", a("builtin"))).toBe(true);
      expect(decidedAgrees("external", a("conversion", "universe"))).toBe(true);
      expect(decidedAgrees("external", a("conversion", "project"))).toBe(false);
      expect(decidedAgrees("external", a("interface", "stdlib"))).toBe(false);
      expect(decidedAgrees("external", a("func-value", "stdlib"))).toBe(false);
      expect(decidedAgrees("interface", a("interface", "project"))).toBe(true);
      expect(decidedAgrees("interface", a("external", "stdlib"))).toBe(false);
      expect(decidedAgrees("func-value", a("func-value", "project"))).toBe(true);
      expect(decidedAgrees("func-value", a("conversion", "project"))).toBe(false);
      expect(decidedAgrees("conversion", a("conversion", "project"))).toBe(true);
      expect(decidedAgrees("conversion", a("func-value", "project"))).toBe(false);
      expect(decidedAgrees("external-assumed", a("interface", "dependency"))).toBe(true);
      expect(decidedAgrees("external-assumed", a("func"))).toBe(false);
      expect(decidedAgrees("external-assumed", a("build-dependent"))).toBe(false);
      expect(decidedAgrees("ambiguous", a("build-dependent"))).toBe(true);
      expect(decidedAgrees("ambiguous", a("interface", "project"))).toBe(false);
      expect(decidedAgrees("no-such-verdict", a("external", "stdlib"))).toBe(false);
    });

    it("the drift check: changing one corpus file changes the hash", () => {
      const copy = mkdtempSync(path.join(os.tmpdir(), "metis-go-oracle-"));
      try {
        cpSync(GO_ORACLE_FIXTURE, copy, { recursive: true });
        expect(goOracleCorpusHash(copy)).toBe(snapshot.corpusHash);
        appendFileSync(path.join(copy, "corpus/modules/app/model/model.go"), "\n// changed\n");
        expect(goOracleCorpusHash(copy)).not.toBe(snapshot.corpusHash);
      } finally {
        rmSync(copy, { recursive: true, force: true });
      }
    });
  });
});
