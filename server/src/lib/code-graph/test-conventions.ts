/**
 * Issue #813 — one table-driven classifier for "is this code-graph file or symbol
 * a test, and what does it test?". The foundation for "Tested by" (#814).
 *
 * Everything language-specific lives in {@link TEST_CONVENTIONS}: adding a
 * language is a table entry plus a test, with no change to the functions below.
 * Every function here is pure and synchronous, with no I/O.
 *
 * Two legacy heuristics are kept bit-for-bit as **profiles** of {@link isTestPath}:
 *
 * - `traceability` — `analysis/traceability-matrix.ts:isTestFilePath` (impact
 *   analysis, the traceability matrix): case-insensitive, any `test`/`tests`/
 *   `__tests__`/`spec` directory, and a `test` token bounded by `._-`.
 * - `code-graph` — `code-graph/call-resolution.ts:isTestFilePath` (the code
 *   overview): case-sensitive, per-language file names, and `__mocks__`/`e2e`
 *   directories.
 *
 * The two disagree (`spec/`, `__mocks__/`, `e2e/`, `test_helpers.ts`,
 * `FooTest.java` vs `FooTest.kt`, case). **Merging them is a separate decision**:
 * it changes what impact analysis counts as an affected test and what the code
 * overview hides, so it needs its own issue and its own before/after
 * measurement. Until then each caller keeps exactly the answers it gave before
 * #813, pinned by a characterization test against copies of the old rule sets.
 *
 * `docs-gen/module-grouping.ts:isTestSourcePath` is deliberately NOT a profile:
 * it answers "should docs-gen read this file?" (fixtures, harnesses, runner
 * configs included), not "is this a test?".
 */

/** A rule that recognises a test symbol by name. */
export interface TestSymbolRule {
  /**
   * Matched against the symbol's bare name. Capture group 1, when present and
   * non-empty, is the subject hint (`TestValidatePassword` → `ValidatePassword`).
   */
  pattern: RegExp;
  /** Symbol kinds the rule applies to; omitted = any kind. */
  kinds?: readonly string[];
  /**
   * `case` — a test case itself (`isTestSymbol: true`).
   * `suite` — a container of tests (`FooTest` class): yields a subject hint but
   * is not itself a test case.
   */
  role: "case" | "suite";
}

/** One language's or framework's test convention. */
export interface TestConvention {
  /** Stable id reported as `TestClassification.convention`. */
  id: string;
  /** `Language` values (`code-graph/parsers.ts`) this convention covers. */
  languages: readonly string[];
  /** Lower-case file extensions, without the dot, used when no language is given. */
  extensions: readonly string[];
  /** Test file names, matched against the basename. */
  fileNamePatterns: readonly RegExp[];
  /** Test locations, matched against the whole `/`-normalised path. */
  pathPatterns: readonly RegExp[];
  /** Basenames that look like tests but are production code (checked first). */
  productionNamePatterns?: readonly RegExp[];
  /** Test-symbol name rules, first match wins. */
  symbolRules: readonly TestSymbolRule[];
  /** Conventional test-file locations for a production file (dir has no trailing `/`; `''` = root). */
  siblings: (p: { dir: string; stem: string; ext: string }) => string[];
  /** Known blind spots, kept next to the rule they limit. */
  limitations?: string;
}

const join = (dir: string, file: string): string => (dir ? `${dir}/${file}` : file);

/** TypeScript declaration files (`types.d.ts`) hold no code to test. */
const TS_DECLARATION = /\.d$/i;

/**
 * JVM / .NET classes named for an A/B-test feature, not for testing a class
 * (`SplitTest.java`); shared with `config/key-registry.ts` DOCS_GEN_PHASE1_INCLUDE_TESTS.
 * `PaymentSplitTest.java` tests `PaymentSplit` and stays a test.
 */
const AB_TEST_FEATURE_CLASS = /^(Split|Ab|AB|Multivariate)Tests?\.[^/.]+$/;

/** Go: subject = the first `_`-separated segment after the prefix (`TestUser_Validate` → `User`). */
const GO_TEST_FUNC = /^(?!TestMain$)(?:Test|Benchmark|Fuzz|Example)(?![a-z])_?([^_]*)/;

export const TEST_CONVENTIONS: readonly TestConvention[] = [
  {
    id: "go-testing",
    languages: ["go"],
    extensions: ["go"],
    fileNamePatterns: [/_test\.go$/i],
    pathPatterns: [],
    symbolRules: [{ pattern: GO_TEST_FUNC, kinds: ["function", "method"], role: "case" }],
    siblings: ({ dir, stem }) => [join(dir, `${stem}_test.go`)],
    limitations:
      "`TestMain` is setup, not a case. A name whose suffix starts lower-case (`Testify`) is not a test, as in `go test`.",
  },
  {
    id: "jest-vitest",
    languages: ["ts", "js"],
    extensions: ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"],
    fileNamePatterns: [/[^/]\.(test|spec)\.[cm]?[jt]sx?$/i],
    pathPatterns: [/(^|\/)__tests__\//i],
    symbolRules: [],
    siblings: ({ dir, stem, ext }) =>
      TS_DECLARATION.test(stem) && /^[cm]?ts$/i.test(ext)
        ? []
        : [
            join(dir, `${stem}.test.${ext}`),
            join(dir, `${stem}.spec.${ext}`),
            join(dir, `__tests__/${stem}.test.${ext}`),
          ],
    limitations:
      "Test cases are anonymous `it()`/`test()` callbacks, not named symbols, so no TS/JS symbol is ever a test case.",
  },
  {
    id: "pytest",
    languages: ["py"],
    extensions: ["py"],
    fileNamePatterns: [/^test_[^/]*\.py$/i, /[^/]_test\.py$/i],
    pathPatterns: [/(^|\/)tests?\//i],
    symbolRules: [
      { pattern: /^test_(.+)$/, kinds: ["function", "method"], role: "case" },
      { pattern: /^test([A-Z].*)$/, kinds: ["function", "method"], role: "case" },
      { pattern: /^Test([A-Z]\w*)$/, kinds: ["class"], role: "suite" },
    ],
    siblings: ({ dir, stem }) => [
      join(dir, `test_${stem}.py`),
      join(dir, `tests/test_${stem}.py`),
      join(dir, `${stem}_test.py`),
    ],
  },
  {
    id: "junit",
    languages: ["java", "kt", "scala"],
    extensions: ["java", "kt", "kts", "scala"],
    // The suffix must follow an identifier character, so an acronym class
    // (`JSONTest`, `DAOIT`) is a test but a bare `Test.java` (JUnit's own
    // annotation) is not. A/B-feature classes are vetoed by name, below.
    fileNamePatterns: [/[\w$](Tests?|IT)\.(java|kts?|scala)$/],
    pathPatterns: [
      /(^|\/)src\/test\//i,
      // Gradle/Android source sets: androidTest, integrationTest, jvmTest, testFixtures, …
      // Case-sensitive, so a `src/latest/` production package is not one.
      /(^|\/)src\/(testFixtures|[a-z]\w*Test)\//,
    ],
    productionNamePatterns: [AB_TEST_FEATURE_CLASS],
    symbolRules: [
      { pattern: /^test(?=[A-Z_])_?(.+)$/, kinds: ["method", "function"], role: "case" },
      {
        pattern: /^(?!(?:Split|Ab|AB|Multivariate)Tests?$)(.+?)(?:Tests?|IT)$/,
        kinds: ["class"],
        role: "suite",
      },
    ],
    siblings: ({ dir, stem, ext }) => {
      const testDir = dir.replace(/(^|\/)src\/main(\/|$)/, "$1src/test$2");
      return [join(testDir, `${stem}Test.${ext}`), join(testDir, `${stem}Tests.${ext}`)];
    },
    limitations:
      "JUnit 4/5 test methods are marked by `@Test`, which a name cannot show; only JUnit-3-style `testX` methods classify as cases. An all-caps production class ending in `IT` (`AUDIT.java`) reads as an integration test, as it did in the legacy code-graph rule.",
  },
  {
    id: "dotnet",
    languages: ["cs"],
    extensions: ["cs", "csx"],
    // As for JUnit: `APITests.cs` is a test, a bare `Tests.cs` is not.
    fileNamePatterns: [/\wTests?\.cs$/],
    pathPatterns: [/(^|\/)[^/]+\.(Unit|Integration|Functional|Acceptance)?Tests?\//i],
    productionNamePatterns: [AB_TEST_FEATURE_CLASS],
    symbolRules: [
      {
        pattern: /^(?!(?:Split|Ab|AB|Multivariate)Tests?$)(.+?)Tests?$/,
        kinds: ["class"],
        role: "suite",
      },
    ],
    siblings: ({ dir, stem }) => [join(dir, `${stem}Tests.cs`), join(dir, `${stem}Test.cs`)],
    limitations:
      "xUnit/NUnit/MSTest cases are marked by attributes (`[Fact]`, `[Test]`), which a name cannot show; no C# method classifies as a case.",
  },
  {
    id: "cargo-test",
    languages: ["rs"],
    extensions: ["rs"],
    fileNamePatterns: [],
    pathPatterns: [/(^|\/)tests\//i],
    symbolRules: [{ pattern: /^test_(.+)$/, kinds: ["function"], role: "case" }],
    siblings: () => [],
    limitations:
      "In-file `#[cfg(test)] mod tests` cannot be seen from a path: only integration tests under `tests/` classify as test files.",
  },
  // `sas`, `cbl`, `c` and `cpp` have no convention: they classify as non-test.
];

/** Legacy path rule sets, kept as data so each caller's answers stay byte-identical. */
interface LegacyPathProfile {
  /** Matched against the whole `/`-normalised path. */
  path: RegExp;
  /** Matched against the basename; any match ⇒ test. */
  basename: readonly RegExp[];
}

const LEGACY_PROFILES: Record<"traceability" | "code-graph", LegacyPathProfile> = {
  traceability: {
    path: /(^|\/)(tests?|__tests__|spec)\//i,
    basename: [/\.(test|spec)\./i, /(^|[._-])test[._-]/i],
  },
  "code-graph": {
    path: /(^|\/)(tests?|__tests__|__mocks__|e2e)\//,
    basename: [
      /\.(test|spec)\.[cm]?[jt]sx?$/,
      /_test\.go$/,
      /^test_.*\.py$/,
      /_test\.py$/,
      /(Tests?|IT)\.java$/,
    ],
  },
};

export type TestPathProfile = keyof typeof LEGACY_PROFILES;

export interface TestClassification {
  isTestFile: boolean;
  /** A test case itself, not a helper in a test file. */
  isTestSymbol: boolean;
  /** Table entry id, e.g. "go-testing", "jest-vitest", "pytest", "junit". */
  convention: string | null;
  /** "ValidatePassword" for TestValidatePassword. */
  subjectHint: string | null;
}

const normalize = (filePath: string): string => filePath.replace(/\\/g, "/");

function splitPath(filePath: string): { dir: string; base: string; stem: string; ext: string } {
  const p = normalize(filePath);
  const slash = p.lastIndexOf("/");
  const dir = slash === -1 ? "" : p.slice(0, slash);
  const base = p.slice(slash + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0
    ? { dir, base, stem: base, ext: "" }
    : { dir, base, stem: base.slice(0, dot), ext: base.slice(dot + 1) };
}

function conventionFor(filePath: string, language?: string | null): TestConvention | null {
  if (language) {
    const byLang = TEST_CONVENTIONS.find((c) => c.languages.includes(language));
    if (byLang) return byLang;
  }
  const ext = splitPath(filePath).ext.toLowerCase();
  return ext ? (TEST_CONVENTIONS.find((c) => c.extensions.includes(ext)) ?? null) : null;
}

function matchesConvention(c: TestConvention, filePath: string): boolean {
  const p = normalize(filePath);
  const { base } = splitPath(p);
  // A test location wins; a production-looking name only vetoes the file-name rules.
  if (c.pathPatterns.some((r) => r.test(p))) return true;
  if (c.productionNamePatterns?.some((r) => r.test(base))) return false;
  return c.fileNamePatterns.some((r) => r.test(base));
}

/**
 * True when `filePath` holds tests. With a `profile`, reproduces one legacy
 * caller's rule set exactly; without one, applies the {@link TEST_CONVENTIONS}
 * entry selected by the file's extension (none ⇒ `false`).
 */
export function isTestPath(filePath: string, opts?: { profile?: TestPathProfile }): boolean {
  const p = normalize(filePath);
  if (opts?.profile) {
    const profile = LEGACY_PROFILES[opts.profile];
    if (profile.path.test(p)) return true;
    const base = p.slice(p.lastIndexOf("/") + 1);
    return profile.basename.some((r) => r.test(base));
  }
  const c = conventionFor(p);
  return c !== null && matchesConvention(c, p);
}

/** Classify a code-graph symbol (or, with no `name`, just its file). */
export function classifyTestSymbol(s: {
  filePath: string;
  name?: string;
  kind?: string;
  language?: string | null;
}): TestClassification {
  const none: TestClassification = {
    isTestFile: false,
    isTestSymbol: false,
    convention: null,
    subjectHint: null,
  };
  const c = conventionFor(s.filePath, s.language);
  if (!c || !matchesConvention(c, s.filePath)) return none;
  const result: TestClassification = { ...none, isTestFile: true, convention: c.id };
  if (!s.name) return result;
  for (const rule of c.symbolRules) {
    if (s.kind && rule.kinds && !rule.kinds.includes(s.kind)) continue;
    const m = rule.pattern.exec(s.name);
    if (!m) continue;
    result.isTestSymbol = rule.role === "case";
    result.subjectHint = m[1] ? m[1] : null;
    break;
  }
  return result;
}

/**
 * Conventional locations of the tests for production file `filePath`, `/`-separated.
 * Empty for a file that is already a test, a TypeScript declaration file, or a
 * language with no convention. Every path returned classifies as a test under
 * the same convention: one a production-name veto would reject (`SplitTest.java`
 * beside `Split.java`) is dropped rather than proposed.
 */
export function siblingTestPaths(filePath: string, language?: string | null): string[] {
  const c = conventionFor(filePath, language);
  if (!c || matchesConvention(c, filePath)) return [];
  const { dir, stem, ext } = splitPath(filePath);
  return c.siblings({ dir, stem, ext }).filter((p) => matchesConvention(c, p));
}

const fold = (s: string): string => s.replace(/[_-]/g, "").toLowerCase();

/** `ValidatePassword` matches `validatePassword` and `validate_password`. */
export function subjectMatches(subjectHint: string, symbolName: string): boolean {
  const hint = fold(subjectHint);
  return hint.length > 0 && hint === fold(symbolName);
}
