/**
 * #1071 — the Go ORACLE: what the Go type checker says every call of a
 * checked-in corpus resolves to, and the comparison of METIS's answer with it.
 *
 * Why this exists. The Go walker and resolver read a language, and three
 * mutation passes in a row over PR #1104 each found new one-edit mutants that
 * bound a call to the WRONG function with every hand-written fixture green —
 * after three implementers had counted "all killed". A fixture per rule only
 * pins the rules somebody thought of. So the expected binding is no longer
 * written by hand: `scripts/go-oracle-snapshot/main.go` type-checks the corpus
 * under `tests/fixtures/go-oracle/` with go/types and the result is checked in
 * (`oracle.snapshot.json`). No test runs Go.
 *
 * What is asserted, per call ({@link compareWithOracle}):
 *
 *  - SOUNDNESS, zero tolerance: a call METIS binds by type (`receiver-type`,
 *    `package`, `same-package`) is bound to exactly the function the type
 *    checker resolves it to;
 *  - DECIDED verdicts agree in class ({@link DECIDED_AGREES}): `external`,
 *    `interface`, `func-value` and `conversion` are issued only where the type
 *    checker says so; `external-assumed` and `ambiguous` never where it names
 *    a project function, unless the call is on the allow-list with its reason;
 *  - the walker saw the same calls: every call the type checker lists with a
 *    plain or selector callee is an edge, on that line, from that function;
 *  - RECALL is reported, not asserted: the statically resolvable calls METIS
 *    leaves undecided are a checked-in list, so losing one is a diff.
 *
 * The corpus is written so that no line holds two calls of the same name:
 * `file:line:name` is then a unique key, and a duplicate is itself a finding.
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createGoResolver,
  type GoCallVerdict,
  type GoModule,
  parseGoModulePath,
} from "../../src/lib/code-graph/go-type-resolution.js";
import {
  compileMetisignore,
  DEFAULT_METISIGNORE,
  isIgnored,
} from "../../src/lib/code-graph/metisignore.js";
import { parseSource } from "../../src/lib/code-graph/parsers.js";
import { buildCodeQualifiedName } from "../../src/lib/code-graph/qualified-name.js";

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const GO_ORACLE_FIXTURE = path.join(SERVER_ROOT, "tests", "fixtures", "go-oracle");

export interface OracleFnRef {
  /** Fixture-relative path of the declaring file. */
  file: string;
  /** Receiver base type as written; absent for a function. */
  recv?: string;
  name: string;
}

export type OracleKind =
  "func" | "interface" | "func-value" | "conversion" | "builtin" | "external" | "build-dependent";

export interface OracleAnswer {
  k: OracleKind;
  target?: OracleFnRef;
  /** Where the callee is declared: `project`, `stdlib`, `dependency`, `universe`, … */
  origin?: string;
  detail?: string;
  per?: Array<{ os: string; answer: OracleAnswer }>;
}

export interface OracleCall {
  file: string;
  line: number;
  col: number;
  callee: string;
  form: "ident" | "selector" | "other";
  name?: string;
  from?: OracleFnRef;
  answer: OracleAnswer;
  only?: string[];
}

/** One declaration of the corpus: a function or method, or a type that is not an alias. */
export interface OracleSymbol {
  file: string;
  kind: "function" | "struct" | "interface" | "type";
  recv?: string;
  name: string;
  line: number;
  endLine: number;
}

export interface OracleSnapshot {
  corpusHash: string;
  goVersion: string;
  platforms: string[];
  trees: Array<{ name: string; root: string; calls: OracleCall[]; symbols: OracleSymbol[] }>;
}

export function loadGoOracle(): OracleSnapshot {
  return JSON.parse(
    readFileSync(path.join(GO_ORACLE_FIXTURE, "oracle.snapshot.json"), "utf8"),
  ) as OracleSnapshot;
}

function filesUnder(root: string, dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(next);
      else if (entry.isFile()) out.push(path.relative(root, next).split(path.sep).join("/"));
    }
  };
  walk(path.join(root, dir));
  return out;
}

/**
 * The hash of the corpus as `scripts/gen-go-oracle-snapshot.mjs` computes it
 * (the two must stay identical): every file by path and content, line endings
 * normalised.
 */
export function goOracleCorpusHash(fixture: string = GO_ORACLE_FIXTURE): string {
  const files = [
    "trees.json",
    ...filesUnder(fixture, "corpus"),
    ...filesUnder(fixture, "thirdparty"),
  ].sort();
  const hash = createHash("sha256");
  for (const rel of files) {
    const content = readFileSync(path.join(fixture, rel), "utf8").replace(/\r\n/g, "\n");
    hash.update(`${rel}\u0000${content}\u0000`);
  }
  return hash.digest("hex");
}

/**
 * A directory METIS is given. One oracle tree can be seen from more than one:
 * the tree with no `go.mod` is ingested from its package root (an import is
 * matched by the directory it ENDS in) and from its GOPATH root (by the
 * directory that ends in the whole import path).
 */
export interface OracleView {
  name: string;
  /** The oracle tree whose calls this view holds. */
  tree: string;
  /** Fixture-relative directory handed to the walker. */
  root: string;
}

export const GO_ORACLE_VIEWS: readonly OracleView[] = [
  { name: "modules", tree: "modules", root: "corpus/modules" },
  { name: "legacy-package-root", tree: "legacy", root: "corpus/legacy/src/example.org/legacy" },
  { name: "legacy-gopath-root", tree: "legacy", root: "corpus/legacy" },
];

/** One call as METIS sees it. */
export interface MetisCall {
  /** `file:line:name`, the file relative to the view's root. */
  key: string;
  /** The qualified name of the symbol the call is recorded under. */
  from: string;
  verdict: GoCallVerdict;
}

export interface ViewSource {
  /** View-relative path → source, for every Go file the ingest walk would read. */
  goFiles: Map<string, string>;
  modules: GoModule[];
}

/** The Go files and `go.mod`s of a view, read as an ingest with no `.metisignore` reads them. */
export function readOracleView(view: OracleView, fixture: string = GO_ORACLE_FIXTURE): ViewSource {
  const root = path.join(fixture, view.root);
  const rules = compileMetisignore(DEFAULT_METISIGNORE);
  const goFiles = new Map<string, string>();
  const modules: GoModule[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      const next = path.join(abs, entry.name);
      const rel = path.relative(root, next).split(path.sep).join("/");
      if (isIgnored(rules, rel, entry.isDirectory())) continue;
      if (entry.isDirectory()) walk(next);
      else if (entry.name === "go.mod") {
        const modulePath = parseGoModulePath(readFileSync(next, "utf8"));
        if (modulePath)
          modules.push({ dir: path.posix.dirname(rel).replace(/^\.$/, ""), path: modulePath });
      } else if (entry.name.endsWith(".go")) goFiles.set(rel, readFileSync(next, "utf8"));
    }
  };
  walk(root);
  return { goFiles, modules };
}

/** The code-graph kind the walker gives each kind of Go declaration. */
const SYMBOL_KIND: Record<OracleSymbol["kind"], string> = {
  function: "function",
  struct: "class",
  interface: "interface",
  type: "type",
};

/**
 * Every declaration the type checker's parser lists for a view, as the symbol
 * the walker must record for it: `kind qualifiedName startLine-endLine`.
 */
export function oracleSymbolsFor(snapshot: OracleSnapshot, view: OracleView): string[] {
  const tree = snapshot.trees.find((t) => t.name === view.tree);
  if (!tree) throw new Error(`go-oracle: the snapshot has no tree "${view.tree}"`);
  const prefix = `${view.root}/`;
  return tree.symbols
    .filter((s) => s.file.startsWith(prefix))
    .map(
      (s) =>
        `${SYMBOL_KIND[s.kind]} ${buildCodeQualifiedName(s.file.slice(prefix.length), s.recv ?? "", s.name)} ${s.line}-${s.endLine}`,
    )
    .sort();
}

/** The symbols the walker records for a view, in the same form (the per-file `module` symbol aside). */
export function metisSymbolsOfView(source: ViewSource): string[] {
  const out: string[] = [];
  for (const [filePath, src] of source.goFiles) {
    for (const s of parseSource(filePath, src, "go").symbols) {
      if (s.kind !== "module") out.push(`${s.kind} ${s.qualifiedName} ${s.startLine}-${s.endLine}`);
    }
  }
  return out.sort();
}

/**
 * Run the real walker and resolver over a view. Two calls sharing a key are
 * reported in `duplicates` rather than silently merged.
 */
export function metisCallsOfView(source: ViewSource): {
  calls: Map<string, MetisCall>;
  duplicates: string[];
} {
  const parsed = [...source.goFiles]
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([filePath, src]) => parseSource(filePath, src, "go"));
  for (const p of parsed) {
    if (!p.goFacts) throw new Error(`go-oracle: ${p.filePath} did not parse`);
  }
  const resolver = createGoResolver(
    parsed.map((p) => ({
      filePath: p.filePath,
      facts: p.goFacts!,
      isTest: p.filePath.endsWith("_test.go"),
    })),
    source.modules,
  );
  const calls = new Map<string, MetisCall>();
  const duplicates: string[] = [];
  for (const p of parsed) {
    for (const e of p.edges) {
      if (e.kind !== "calls") continue;
      const key = `${p.filePath}:${e.line}:${e.toQualifiedName}`;
      if (calls.has(key)) duplicates.push(key);
      calls.set(key, {
        key,
        from: e.fromQualifiedName,
        verdict: resolver.resolveCall(p.filePath, e.goCallee!),
      });
    }
  }
  return { calls, duplicates };
}

/** A verdict as one comparable string. */
export function showVerdict(v: GoCallVerdict): string {
  if (v.kind === "bound") return `${v.via} ${v.qualifiedName}`;
  return v.kind === "unbound" ? `unbound ${v.reason}` : "unknown";
}

/** An oracle answer as one comparable string, with a project target named as METIS names it. */
export function showAnswer(answer: OracleAnswer, view: OracleView): string {
  if (answer.k === "func") return `func ${qualifiedNameOf(answer.target!, view)}`;
  if (answer.k === "build-dependent") {
    return `build-dependent (${answer.per!.map((p) => `${p.os}: ${showAnswer(p.answer, view)}`).join("; ")})`;
  }
  return answer.origin ? `${answer.k} (${answer.origin})` : answer.k;
}

/** The qualified name METIS gives a function the oracle names. */
export function qualifiedNameOf(ref: OracleFnRef, view: OracleView): string {
  return buildCodeQualifiedName(viewPath(ref.file, view), ref.recv ?? "", ref.name);
}

function viewPath(fixtureRelative: string, view: OracleView): string {
  const prefix = `${view.root}/`;
  if (!fixtureRelative.startsWith(prefix)) {
    throw new Error(`go-oracle: ${fixtureRelative} is outside the view ${view.root}`);
  }
  return fixtureRelative.slice(prefix.length);
}

/**
 * Which oracle answers a DECIDED verdict of METIS may stand for.
 *
 *  - `external` says the callee is declared outside the project: a function or
 *    concrete method of the standard library or a dependency, a builtin, or a
 *    conversion to a type declared outside it (`string(x)`, `time.Duration(x)`
 *    — the resolver does not read those packages, so a type and a function of
 *    one are told apart by nothing it has);
 *  - `conversion`, `func-value` and `interface` mean exactly that;
 *  - `external-assumed` (the receiver is a value from outside the project whose
 *    type was not examined) and `ambiguous` (declarations this module will not
 *    choose between) claim only that no project function is bound here: they
 *    are wrong where the type checker names one. `ambiguous` is exactly right
 *    where the platforms disagree.
 */
export function decidedAgrees(reason: string, answer: OracleAnswer): boolean {
  switch (reason) {
    case "external":
      return (
        answer.k === "external" ||
        answer.k === "builtin" ||
        (answer.k === "conversion" && answer.origin !== "project")
      );
    case "conversion":
      return answer.k === "conversion";
    case "func-value":
      return answer.k === "func-value";
    case "interface":
      return answer.k === "interface";
    case "external-assumed":
      return answer.k !== "func" && answer.k !== "build-dependent";
    case "ambiguous":
      return answer.k === "build-dependent";
    default:
      return false;
  }
}

/** A disagreement that is known, counted and explained. */
export interface OracleAllowance {
  view: string;
  key: string;
  /** METIS's verdict, as {@link showVerdict} prints it. */
  metis: string;
  /** The oracle's answer, as {@link showAnswer} prints it. */
  oracle: string;
  reason: string;
}

const BUILD_CONSTRAINT =
  "The resolver does not evaluate build constraints. `shared` is declared once behind " +
  "`//go:build !windows` and once in `shared_windows.go`; a caller that is itself " +
  "platform-specific reaches exactly one of them, but telling which needs the constraint " +
  "of BOTH files. Refusing (`ambiguous`) binds nothing wrong; the edge is lost.";

/**
 * Calls where METIS gives a DECIDED verdict the type checker does not share,
 * each with the reason it is accepted. The list is exact: an entry that stops
 * being needed fails the suite, and so does a disagreement that is not here.
 */
export const GO_ORACLE_ALLOW: readonly OracleAllowance[] = [
  {
    view: "modules",
    key: "app/ext/ext.go:99:OnError",
    metis: "unbound external",
    oracle: "func-value (dependency)",
    reason:
      "`queue.OnError` is a package-level func VARIABLE of a dependency. A dependency is " +
      "never read, so `pkg.Name()` cannot be told from a call of its function `Name`; both " +
      "are decided and bind nothing. (For the standard library the generated list of func " +
      "variables settles it: `flag.Usage()` is `func-value`.)",
  },
  {
    view: "modules",
    key: "app/platform/plat_linux.go:8:shared",
    metis: "unbound ambiguous",
    oracle: "func app/platform/shared_unix.go::shared",
    reason: BUILD_CONSTRAINT,
  },
  {
    view: "modules",
    key: "app/platform/plat_other.go:10:shared",
    metis: "unbound ambiguous",
    oracle: "func app/platform/shared_unix.go::shared",
    reason: BUILD_CONSTRAINT,
  },
  {
    view: "modules",
    key: "app/platform/plat_windows.go:8:shared",
    metis: "unbound ambiguous",
    oracle: "func app/platform/shared_windows.go::shared",
    reason: BUILD_CONSTRAINT,
  },
];

export interface OracleFinding {
  rule: "keys" | "from" | "soundness" | "decided" | "allow-list";
  key: string;
  detail: string;
}

export interface OracleComparison {
  findings: OracleFinding[];
  /** Calls the oracle resolves to a project function that METIS left without a by-type binding. */
  recallMisses: string[];
  stats: {
    calls: number;
    /** Calls the oracle lists that METIS records no edge for by design: the callee is neither a name nor a selector. */
    otherForm: number;
    boundAgreeing: number;
    decidedAgreeing: number;
    allowed: number;
    undecided: number;
    /** Statically resolvable by the oracle (a project function). */
    resolvable: number;
  };
}

/**
 * Compare METIS's calls for one view with the oracle's. Pure, so the checker
 * itself can be shown to fail on a wrong binding.
 */
export function compareWithOracle(
  view: OracleView,
  oracle: readonly OracleCall[],
  metis: ReadonlyMap<string, MetisCall>,
  allow: readonly OracleAllowance[] = [],
  duplicates: readonly string[] = [],
): OracleComparison {
  const findings: OracleFinding[] = [];
  const recallMisses: string[] = [];
  const stats = {
    calls: 0,
    otherForm: 0,
    boundAgreeing: 0,
    decidedAgreeing: 0,
    allowed: 0,
    undecided: 0,
    resolvable: 0,
  };
  for (const key of duplicates) {
    findings.push({ rule: "keys", key, detail: "two calls of one name on one line" });
  }
  const allowed = new Map<string, OracleAllowance>();
  for (const a of allow) if (a.view === view.name) allowed.set(a.key, a);
  const usedAllowances = new Set<string>();
  const seen = new Set<string>();
  const prefix = `${view.root}/`;
  for (const call of oracle) {
    if (!call.file.startsWith(prefix)) continue;
    if (call.form === "other") {
      stats.otherForm += 1;
      continue;
    }
    const file = call.file.slice(prefix.length);
    const key = `${file}:${call.line}:${call.name}`;
    if (seen.has(key)) {
      findings.push({ rule: "keys", key, detail: "the oracle lists two calls under this key" });
      continue;
    }
    seen.add(key);
    stats.calls += 1;
    const oracleShown = showAnswer(call.answer, view);
    if (call.answer.k === "func") stats.resolvable += 1;
    const mine = metis.get(key);
    if (!mine) {
      findings.push({ rule: "keys", key, detail: `no call edge (oracle: ${oracleShown})` });
      continue;
    }
    const from = call.from ? qualifiedNameOf(call.from, view) : file;
    if (mine.from !== from) {
      findings.push({
        rule: "from",
        key,
        detail: `recorded under ${mine.from}, written in ${from}`,
      });
    }
    const shown = showVerdict(mine.verdict);
    const verdict = mine.verdict;
    if (verdict.kind === "bound") {
      if (
        call.answer.k === "func" &&
        verdict.qualifiedName === qualifiedNameOf(call.answer.target!, view)
      ) {
        stats.boundAgreeing += 1;
      } else {
        findings.push({ rule: "soundness", key, detail: `METIS ${shown}; oracle ${oracleShown}` });
      }
      continue;
    }
    if (call.answer.k === "func") recallMisses.push(`${key} -> ${oracleShown.slice(5)} [${shown}]`);
    if (verdict.kind === "unknown") {
      stats.undecided += 1;
      continue;
    }
    if (decidedAgrees(verdict.reason, call.answer)) {
      stats.decidedAgreeing += 1;
      continue;
    }
    const allowance = allowed.get(key);
    if (allowance && allowance.metis === shown && allowance.oracle === oracleShown) {
      usedAllowances.add(key);
      stats.allowed += 1;
      continue;
    }
    findings.push({ rule: "decided", key, detail: `METIS ${shown}; oracle ${oracleShown}` });
  }
  for (const key of metis.keys()) {
    if (!seen.has(key)) {
      findings.push({ rule: "keys", key, detail: "a call edge the oracle does not list" });
    }
  }
  for (const a of allowed.values()) {
    if (!usedAllowances.has(a.key)) {
      findings.push({
        rule: "allow-list",
        key: a.key,
        detail: `listed as "${a.metis}" against "${a.oracle}" but no longer needed: remove the entry`,
      });
    }
  }
  recallMisses.sort();
  return { findings, recallMisses, stats };
}

/**
 * Every call of a view as one line: METIS's verdict beside the type checker's
 * answer. The findings above say where the two CONTRADICT each other; this is
 * the whole behaviour, for a diff — a call that goes from `interface` to
 * undecided, or from `external` to `external-assumed`, contradicts nothing and
 * still changes what later readers do with the edge.
 */
export function verdictTable(
  view: OracleView,
  oracle: readonly OracleCall[],
  metis: ReadonlyMap<string, MetisCall>,
): string[] {
  const prefix = `${view.root}/`;
  const lines: string[] = [];
  for (const call of oracle) {
    if (call.form === "other" || !call.file.startsWith(prefix)) continue;
    const key = `${call.file.slice(prefix.length)}:${call.line}:${call.name}`;
    const mine = metis.get(key);
    lines.push(
      `${key} = ${mine ? showVerdict(mine.verdict) : "(no edge)"} | go: ${showAnswer(call.answer, view)}`,
    );
  }
  return lines.sort();
}

/** The oracle's calls for a view's tree. */
export function oracleCallsFor(snapshot: OracleSnapshot, view: OracleView): OracleCall[] {
  const tree = snapshot.trees.find((t) => t.name === view.tree);
  if (!tree) throw new Error(`go-oracle: the snapshot has no tree "${view.tree}"`);
  return tree.calls;
}
