/**
 * Grouping a project's code symbols into the documentable modules Phase 1
 * reads. Pure (no I/O) so the selection is unit-testable and measurable offline.
 *
 * The directory rules are the long-standing ones (a directory is a module when
 * it has ≥1 class/interface or ≥4 methods/functions and ≥3 symbols; a directory
 * of more than 200 symbols is split per file, and a file qualifies when it has a
 * class/interface and ≥3 symbols; SAS relaxations apply to both). What changed
 * is that nothing is dropped any more:
 *
 *   - Every file the rules leave out — a class-less file inside a split
 *     directory, a small directory, a file whose only symbol is its `module`
 *     row (top-level constants, zod schemas, config objects) — is gathered into
 *     a per-directory module, or joins the directory's module when it has one.
 *     On onyourleft the rules alone left 325 functions in 68 class-less files
 *     and 115 module-level-only files (including the store's `schema.ts`) out
 *     of every module.
 *   - There is no module-count cap (the old top-150-by-size cut): Phase-2
 *     batching reads every module, so a cap only decides which code is never
 *     read.
 */
import type { RepositoryIdentity } from "./repository-identity.js";

/** One code symbol as the grouping sees it. */
export interface GroupableSymbol {
  id: string;
  qualifiedName: string;
  kind: string;
  language?: string | null;
  filePath: string;
  startLine: number;
  endLine: number;
}

/** A documentable module: a directory (or one file of a split directory) and its symbols. */
export interface SymbolModule<S extends GroupableSymbol = GroupableSymbol> {
  repository?: RepositoryIdentity;
  dir: string;
  syms: S[];
}

/**
 * True for a SAS business-logic symbol: SAS programs have no classes, so their
 * `%macro` blocks, DATA steps and PROC steps (all `function` symbols from the
 * SAS parser) are what make a SAS directory documentable.
 */
export function isSasBusinessSymbol(sym: { kind: string; language?: string | null }): boolean {
  return sym.language === "sas" && sym.kind === "function";
}

/** Directory segments whose code is never documented. */
const EXCLUDED_DIR = /\/(test|tests|generated|node_modules|build|target|\.next)\//;

/** Directories with more symbols than this are split into per-file modules. */
export const SPLIT_THRESHOLD = 200;

const isClassLike = (s: GroupableSymbol) => s.kind === "class" || s.kind === "interface";
const isCallable = (s: GroupableSymbol) => s.kind === "method" || s.kind === "function";

/**
 * Group symbols (already filtered of junk paths) into modules.
 *
 * @param keyOf - identity of a (repository, path) pair, so two repositories'
 *   same-named directories never merge.
 */
export function groupSymbolsIntoModules<S extends GroupableSymbol>(
  symbols: readonly S[],
  repositoryOf: (s: S) => RepositoryIdentity | undefined,
  keyOf: (repository: RepositoryIdentity | undefined, path: string) => string,
): SymbolModule<S>[] {
  const dirOf = (fp: string) => fp.split("/").slice(0, -1).join("/");
  // Per directory: the symbols the rules read, and every file's symbols (for leftovers).
  const byDir = new Map<string, { dir: string; repository?: RepositoryIdentity; syms: S[] }>();
  const filesByDir = new Map<string, Map<string, S[]>>();
  for (const sym of symbols) {
    const dir = dirOf(sym.filePath);
    if (EXCLUDED_DIR.test(dir)) continue;
    const repository = repositoryOf(sym);
    const key = keyOf(repository, dir);
    if (!filesByDir.has(key)) filesByDir.set(key, new Map());
    const files = filesByDir.get(key)!;
    if (!files.has(sym.filePath)) files.set(sym.filePath, []);
    files.get(sym.filePath)!.push(sym);
    if (sym.kind === "module" || sym.kind === "type") continue;
    if (!byDir.has(key)) byDir.set(key, { dir, repository, syms: [] });
    byDir.get(key)!.syms.push(sym);
  }

  const modules: SymbolModule<S>[] = [];
  const moduleOfDir = new Map<string, SymbolModule<S>>();
  const covered = new Set<string>();
  const cover = (repository: RepositoryIdentity | undefined, syms: readonly S[]) => {
    for (const s of syms) covered.add(keyOf(repository, s.filePath));
  };
  for (const [key, { dir, repository, syms }] of byDir) {
    if (syms.length <= SPLIT_THRESHOLD) {
      const standard =
        (syms.filter(isClassLike).length >= 1 || syms.filter(isCallable).length >= 4) &&
        syms.length >= 3;
      if (standard || syms.filter(isSasBusinessSymbol).length >= 3) {
        const m = { dir, syms: [...syms], repository };
        modules.push(m);
        moduleOfDir.set(key, m);
        cover(repository, syms);
      }
      continue;
    }
    const byFile = new Map<string, S[]>();
    for (const s of syms) {
      if (!byFile.has(s.filePath)) byFile.set(s.filePath, []);
      byFile.get(s.filePath)!.push(s);
    }
    for (const [filePath, fileSyms] of byFile) {
      const standard = fileSyms.filter(isClassLike).length >= 1 && fileSyms.length >= 3;
      if (standard || fileSyms.filter(isSasBusinessSymbol).length >= 3) {
        // The file path without extension names a per-file module.
        modules.push({ dir: filePath.replace(/\.[^.]+$/, ""), syms: fileSyms, repository });
        cover(repository, fileSyms);
      }
    }
  }

  // Leftovers: every file no module covers joins its directory's module, or a
  // per-directory module made for them. A file contributes its code symbols,
  // or — when it has none — the one symbol that proves it exists (its `module`
  // row), so Phase 1 reads it in full as module-level code.
  for (const [key, files] of filesByDir) {
    for (const [filePath, fileSyms] of files) {
      const repository = repositoryOf(fileSyms[0]);
      if (covered.has(keyOf(repository, filePath))) continue;
      const code = fileSyms.filter((s) => s.kind !== "module" && s.kind !== "type");
      const carried =
        code.length > 0 ? code : [fileSyms.find((s) => s.kind === "module") ?? fileSyms[0]];
      let m = moduleOfDir.get(key);
      if (!m) {
        m = { dir: dirOf(filePath), syms: [], repository };
        modules.push(m);
        moduleOfDir.set(key, m);
      }
      for (const sym of carried) m.syms.push(sym);
      covered.add(keyOf(repository, filePath));
    }
  }

  return modules.sort((a, b) => b.syms.length - a.syms.length);
}

// ============================================================================
// Test / spec / fixture files (DOCS_GEN_PHASE1_INCLUDE_TESTS)
// ============================================================================

/**
 * Directory segments whose files are test code, test doubles or fixtures.
 * `testing` is deliberate: by the convention onyourleft documents in those
 * files ("not exported from anywhere the app imports"), `src/testing/` holds
 * fakes, harnesses and fixture builders used only by tests — e.g.
 * `packages/store/src/testing/fakes.ts` — so it is classified as test even
 * though it sits under `src/`.
 */
const TEST_DIR_SEGMENTS: ReadonlySet<string> = new Set([
  "test",
  "tests",
  "__tests__",
  "__mocks__",
  "mocks",
  "testing",
  // `spec/` is RSpec's convention; `specs/` is NOT listed — it holds product
  // specifications as often as tests (#191: ambiguous → production).
  "spec",
  "e2e",
  "fixtures",
  "__fixtures__",
]);

/** File-name shapes of test code, across the languages the code graph parses. */
const TEST_FILE_PATTERNS: readonly RegExp[] = [
  // foo.test.ts, foo.spec.tsx, game.browser.spec.ts, sounds.a11y.test.tsx —
  // a bare `test.ts` / `spec.ts` is not enough on its own.
  /[^/]\.(test|spec)\.[^/]+$/i,
  // Python / Go
  /^test_[^/]+\.py$/i,
  /_test\.(go|py)$/i,
  // Java / Kotlin / C# / Scala test classes. `*Spec` is NOT matched: Spring Data
  // `Specification`s and DDD specifications (`UserSpec.java`) are production.
  /[a-z0-9](Test|Tests)\.(java|kt|kts|cs|scala|groovy)$/,
  // Maven failsafe integration tests: `UserServiceIT.java`. The JVM convention
  // is strong enough to keep, so a name like `AuditIT.java` is read as an
  // integration test too (documented trade-off); `Audit.java`, `Kit.java`,
  // `ORBIT.java` are production (the suffix is capital `IT` after lower case).
  /[a-z0-9]IT\.(java|kt|kts|groovy|scala)$/,
  // test-double modules by name: testing.ts, audio-testing.ts, match_testing.py
  /(^|[-_.])testing\.[^/]+$/i,
  // fixture files by the double-extension convention only: `user.fixture.ts`,
  // `orders.fixtures.json.ts`. A bare `Fixture.java` / `fixture.ts` /
  // `fixtures.sql` or a `match-fixture.ts` is NOT matched: "fixture" is a
  // business entity in some domains (a sports fixture), and an ambiguous name
  // resolves to production — reading a test file costs a little time, dropping
  // a production file loses its rules. (onyourleft's `pmtiles-fixture.ts` and
  // `cross-client-fixture.ts` are therefore read.)
  /[^/.]\.fixtures?\.[^/]+$/i,
  // test harnesses by name: test-harness.ts, test_harness.py, testharness.js.
  // A bare `harness.ts` / `wire-harness.ts` is NOT matched: "harness" is a
  // domain word (a wiring harness), so the ambiguous name resolves to
  // production (#191). A harness inside a test directory is still test code.
  /(^|[-_.])test[-_.]?harness\.[^/]+$/i,
  // test-runner configuration
  /^(vitest|jest|playwright|karma|cypress)\.config\.[^/]+$/i,
];

/**
 * `*-testing.*` names that are production features, not test doubles
 * (`ab-testing.ts`, `load-testing.ts` …).
 */
const PRODUCTION_TESTING_FEATURE =
  /^(ab|a-b|split|multivariate|load|stress|perf|performance|canary|usability|penetration)[-_]testing\./i;

/**
 * JVM / .NET class names that end in `Test` because they model an A/B test
 * (`SplitTest.java`, `AbTest.java`, `MultivariateTests.kt`), not because they
 * test a class (#191). Only the bare feature name: `PaymentSplitTest.java`
 * tests `PaymentSplit` and stays test code.
 */
const PRODUCTION_TEST_FEATURE_CLASS = /^(Split|Ab|AB|Multivariate)Tests?\.[^/.]+$/;

/** A directory segment of test code: see {@link TEST_DIR_SEGMENTS}, plus C# test projects and fixture dirs. */
function isTestDirSegment(seg: string): boolean {
  return (
    TEST_DIR_SEGMENTS.has(seg.toLowerCase()) ||
    // C# / .NET test projects: Foo.Tests/, Foo.UnitTests/, Foo.IntegrationTests/, Foo.Test/
    /\.(Unit|Integration|Functional|Acceptance)?Tests?$/i.test(seg) ||
    // fixture directories: `fixtures/` (in TEST_DIR_SEGMENTS), any `*-fixtures/`
    // or `*_fixtures/` (test-fixtures/, sports-fixtures/ — a plural fixtures
    // directory is test data by convention), and fixture corpora/data
    // (`fixture-corpus/`). A singular `fixture/` directory is production.
    /[-_]fixtures$/i.test(seg) ||
    /^fixtures?[-_](corpus|data|files)$/i.test(seg)
  );
}

/**
 * True for a test, spec, test-double or fixture file. Deliberately NOT matched:
 * a production module whose name merely contains "test" or "fixture" (e.g.
 * onyourleft's `packages/fit/src/synthetic-test-regions.ts`, which the package's
 * public index exports; `fixture-service.ts`; `ab-testing.ts`; `UserSpec.java`).
 */
export function isTestSourcePath(filePath: string): boolean {
  const parts = filePath.split("/");
  const base = parts.pop() ?? "";
  if (parts.some(isTestDirSegment)) return true;
  if (PRODUCTION_TESTING_FEATURE.test(base) || PRODUCTION_TEST_FEATURE_CLASS.test(base))
    return false;
  return TEST_FILE_PATTERNS.some((p) => p.test(base));
}

/** What {@link excludeTestFiles} removed, for the coverage log. */
export interface ExcludedByPolicy {
  modules: number;
  files: number;
  functions: number;
}

/**
 * Remove test/spec/fixture files ({@link isTestSourcePath}) from every module;
 * a module left with no symbols is dropped. Used when
 * DOCS_GEN_PHASE1_INCLUDE_TESTS is off: the files are then neither read by the
 * model nor mined, and are reported as excluded by policy — not as missing.
 */
export function excludeTestFiles<S extends GroupableSymbol, M extends SymbolModule<S>>(
  modules: readonly M[],
): { modules: M[]; excluded: ExcludedByPolicy } {
  const excluded: ExcludedByPolicy = { modules: 0, files: 0, functions: 0 };
  const kept: M[] = [];
  for (const m of modules) {
    const test = m.syms.filter((s) => isTestSourcePath(s.filePath));
    if (test.length === 0) {
      kept.push(m);
      continue;
    }
    excluded.files += new Set(test.map((s) => s.filePath)).size;
    excluded.functions += test.filter(isCallable).length;
    const rest = m.syms.filter((s) => !isTestSourcePath(s.filePath));
    if (rest.length === 0) excluded.modules += 1;
    else kept.push({ ...m, syms: rest });
  }
  return { modules: kept, excluded };
}

/**
 * Safety bound on directories visited per repository by the SQL-only-directory
 * scan (holistic-synthesizer `discoverSqlOnlyModules`) and by the regeneration
 * input fingerprint, so a pathological clone cannot run away. Far above any
 * realistic source tree (the scans skip node_modules/.git/build/vendor/test
 * dirs); reaching it raises a document warning. There is NO cap on the SQL-only
 * modules found: the old 24-module / 2,000-directory caps dropped whole SQL-only
 * directories silently.
 */
export const SQL_SCAN_DIR_CAP = 100_000;
