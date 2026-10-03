/**
 * Issue #813 — the table-driven test classifier, and the characterization test
 * that pins both legacy `isTestFilePath` callers to their pre-#813 answers.
 */
import { describe, expect, it } from "vitest";
import {
  TEST_CONVENTIONS,
  classifyTestSymbol,
  isTestPath,
  siblingTestPaths,
  subjectMatches,
} from "./test-conventions.js";
import { isTestFilePath as traceabilityIsTestFilePath } from "../analysis/traceability-matrix.js";
import { isTestFilePath as codeGraphIsTestFilePath } from "./call-resolution.js";

// ── Fixtures: the two rule sets exactly as they stood on main before #813 ──

function legacyTraceability(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() ?? normalized;
  if (/\.(test|spec)\./i.test(base)) return true;
  if (/(^|[._-])test[._-]/i.test(base)) return true;
  return /(^|\/)(tests?|__tests__|spec)\//i.test(normalized);
}

function legacyCodeGraph(filePath: string): boolean {
  const p = filePath.replace(/\\/g, "/");
  if (/(^|\/)(tests?|__tests__|__mocks__|e2e)\//.test(p)) return true;
  const base = p.slice(p.lastIndexOf("/") + 1);
  return (
    /\.(test|spec)\.[cm]?[jt]sx?$/.test(base) ||
    /_test\.go$/.test(base) ||
    /^test_.*\.py$/.test(base) ||
    /_test\.py$/.test(base) ||
    /(Tests?|IT)\.java$/.test(base)
  );
}

/** Chosen to hit every rule of both sets, and every place they disagree. */
const CORPUS: readonly string[] = [
  "src/a.ts",
  "src/a.test.ts",
  "src/a.spec.tsx",
  "src/a.test.mjs",
  "src/a.spec.cjs",
  "src/a.Test.ts",
  "src/A.SPEC.TS",
  "src/a.test.json",
  "src/a.spec.md",
  "src/a.test-utils.ts",
  "src/test-utils.ts",
  "src/test_helpers.ts",
  "src/latest.ts",
  "src/contest.go",
  "src/attest.py",
  "src/testimony.py",
  "src/test.ts",
  "src/test",
  "test",
  "test/a.ts",
  "tests/a.ts",
  "Tests/a.ts",
  "TEST/a.ts",
  "src/__tests__/a.ts",
  "src/__TESTS__/a.ts",
  "src/__mocks__/a.ts",
  "src/__Mocks__/a.ts",
  "e2e/a.spec.ts",
  "E2E/a.ts",
  "e2e/helpers.ts",
  "spec/a_spec.rb",
  "Spec/a.rb",
  "specs/a.ts",
  "src/testing/a.ts",
  "src/contests/a.ts",
  "internal/validator/user.go",
  "internal/validator/user_test.go",
  "internal/validator/user_Test.go",
  "internal/validator/USER_TEST.GO",
  "pkg/a_test.go.orig",
  "app/test_models.py",
  "app/Test_models.py",
  "app/models_test.py",
  "app/models.py",
  "app/tests/conftest.py",
  "app/conftest.py",
  "src/main/java/a/Foo.java",
  "src/test/java/a/FooTest.java",
  "src/main/java/a/FooTests.java",
  "src/main/java/a/FooIT.java",
  "src/main/java/a/SplitTest.java",
  "src/main/java/a/Latest.java",
  "src/main/kotlin/a/FooTest.kt",
  "src/main/scala/a/FooTest.scala",
  "src/Test/java/a/Foo.java",
  "Foo.Tests/FooTests.cs",
  "Foo.UnitTests/Bar.cs",
  "Foo/FooTest.cs",
  "crate/tests/integration.rs",
  "crate/src/lib.rs",
  "C:\\repo\\src\\a.test.ts",
  "C:\\repo\\tests\\a.py",
  "C:\\repo\\pkg\\a_test.go",
  "C:\\repo\\pkg\\a.go",
  "a.test.",
  ".test.ts",
  "",
  "prog/payroll.sas",
  "cobol/PAYROLL.cbl",
  "native/test_math.c",
  "native/tests/math.cpp",
];

describe("characterization: both legacy profiles reproduce the pre-#813 rule sets exactly", () => {
  it("covers at least 60 paths, where the two old rule sets disagree", () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(60);
    // The corpus is only useful if it exercises the disagreement, not just agreement.
    expect(
      CORPUS.filter((p) => legacyTraceability(p) !== legacyCodeGraph(p)).length,
    ).toBeGreaterThan(10);
  });

  it.each(CORPUS)("traceability profile: %s", (p) => {
    expect(isTestPath(p, { profile: "traceability" })).toBe(legacyTraceability(p));
    expect(traceabilityIsTestFilePath(p)).toBe(legacyTraceability(p));
  });

  it.each(CORPUS)("code-graph profile: %s", (p) => {
    expect(isTestPath(p, { profile: "code-graph" })).toBe(legacyCodeGraph(p));
    expect(codeGraphIsTestFilePath(p)).toBe(legacyCodeGraph(p));
  });
});

// ── The table ──

describe("TEST_CONVENTIONS", () => {
  it("has unique ids and one entry per language", () => {
    const ids = TEST_CONVENTIONS.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    const langs = TEST_CONVENTIONS.flatMap((c) => c.languages);
    expect(new Set(langs).size).toBe(langs.length);
    expect(ids).toEqual(
      expect.arrayContaining([
        "go-testing",
        "jest-vitest",
        "pytest",
        "junit",
        "dotnet",
        "cargo-test",
      ]),
    );
  });
});

describe("isTestPath (convention table, no profile)", () => {
  it.each([
    // Go
    ["internal/validator/user_test.go", true],
    ["internal\\validator\\user_test.go", true],
    ["internal/validator/User_Test.GO", true],
    ["internal/validator/user.go", false],
    ["src/contest.go", false],
    // TS / JS
    ["src/a.test.ts", true],
    ["src/a.spec.jsx", true],
    ["src/A.Test.TS", true],
    ["src/__tests__/a.ts", true],
    ["src/latest.ts", false],
    ["src/test.ts", false],
    ["src/test-utils.ts", false],
    // Python
    ["app/test_models.py", true],
    ["app/models_test.py", true],
    ["app/tests/conftest.py", true],
    ["app/testimony.py", false],
    ["app/models.py", false],
    // JVM
    ["src/main/java/a/FooTest.java", true],
    ["src/main/kotlin/a/FooTests.kt", true],
    ["src/main/scala/a/FooIT.scala", true],
    ["src/test/java/a/Helper.java", true],
    ["src/main/java/a/SplitTest.java", false],
    ["src/main/kotlin/a/AbTests.kt", false],
    ["src/main/java/a/PaymentSplitTest.java", true],
    ["src/main/java/a/Latest.java", false],
    ["src/main/java/a/Foo.java", false],
    // C#
    ["Foo/FooTests.cs", true],
    ["Foo/FooTest.cs", true],
    ["Foo.Tests/Helper.cs", true],
    ["Foo.UnitTests/Helper.cs", true],
    ["Foo/Foo.cs", false],
    ["Foo/SplitTest.cs", false],
    // Rust
    ["crate/tests/integration.rs", true],
    ["crate/src/lib.rs", false],
    // No convention
    ["prog/payroll.sas", false],
    ["cobol/PAYROLL.cbl", false],
    ["native/tests/math.c", false],
    ["native/test_math.cpp", false],
    ["Makefile", false],
  ])("%s → %s", (p, expected) => {
    expect(isTestPath(p)).toBe(expected);
  });
});

describe("classifyTestSymbol", () => {
  it("issue example: Go TestValidatePassword", () => {
    expect(
      classifyTestSymbol({
        filePath: "internal/validator/user_test.go",
        name: "TestValidatePassword",
        kind: "function",
        language: "go",
      }),
    ).toEqual({
      isTestFile: true,
      isTestSymbol: true,
      convention: "go-testing",
      subjectHint: "ValidatePassword",
    });
  });

  it.each([
    // [filePath, name, kind, language, isTestSymbol, subjectHint]
    ["a/x_test.go", "BenchmarkParse", "function", "go", true, "Parse"],
    ["a/x_test.go", "FuzzParse", "function", "go", true, "Parse"],
    ["a/x_test.go", "ExampleParse", "function", "go", true, "Parse"],
    ["a/x_test.go", "Test_validatePassword", "function", "go", true, "validatePassword"],
    ["a/x_test.go", "TestUser_Validate", "method", "go", true, "User"],
    ["a/x_test.go", "Example", "function", "go", true, null],
    ["a/x_test.go", "TestMain", "function", "go", false, null],
    ["a/x_test.go", "Testify", "function", "go", false, null],
    ["a/x_test.go", "newFixture", "function", "go", false, null],
    ["a/x_test.go", "TestThing", "type", "go", false, null],
    ["a/x.go", "TestValidatePassword", "function", "go", false, null],
    ["tests/test_user.py", "test_validate_password", "function", "py", true, "validate_password"],
    ["tests/test_user.py", "testValidate", "method", "py", true, "Validate"],
    ["tests/test_user.py", "TestUser", "class", "py", false, "User"],
    ["tests/test_user.py", "make_user", "function", "py", false, null],
    ["tests/test_user.py", "testing", "function", "py", false, null],
    ["app/user.py", "test_validate_password", "function", "py", false, null],
    ["src/test/java/a/FooTest.java", "FooTest", "class", "java", false, "Foo"],
    ["src/test/java/a/FooTests.java", "FooTests", "class", "java", false, "Foo"],
    ["src/test/java/a/FooIT.java", "FooIT", "class", "java", false, "Foo"],
    ["src/test/java/a/FooTest.java", "testParse", "method", "java", true, "Parse"],
    ["src/test/java/a/FooTest.java", "testing", "method", "java", false, null],
    ["src/test/java/a/FooTest.java", "parsesInput", "method", "java", false, null],
    ["src/test/kotlin/a/FooTest.kt", "FooTest", "class", "kt", false, "Foo"],
    ["Foo.Tests/FooTests.cs", "FooTests", "class", "cs", false, "Foo"],
    ["Foo.Tests/FooTests.cs", "ParsesInput", "method", "cs", false, null],
    ["crate/tests/parse.rs", "test_parse", "function", "rs", true, "parse"],
    ["src/a.test.ts", "helper", "function", "ts", false, null],
  ] as const)(
    "%s %s (%s) → case=%s subject=%s",
    (filePath, name, kind, language, isCase, subject) => {
      const r = classifyTestSymbol({ filePath, name, kind, language });
      expect(r.isTestSymbol).toBe(isCase);
      expect(r.subjectHint).toBe(subject);
    },
  );

  it("classifies the file alone when no name is given", () => {
    expect(classifyTestSymbol({ filePath: "src/a.test.ts" })).toEqual({
      isTestFile: true,
      isTestSymbol: false,
      convention: "jest-vitest",
      subjectHint: null,
    });
  });

  it("matches a symbol rule regardless of kind when kind is omitted", () => {
    expect(classifyTestSymbol({ filePath: "a/x_test.go", name: "TestX" }).isTestSymbol).toBe(true);
  });

  it("reports no convention for a production file", () => {
    expect(classifyTestSymbol({ filePath: "a/x.go", name: "TestX", language: "go" })).toEqual({
      isTestFile: false,
      isTestSymbol: false,
      convention: null,
      subjectHint: null,
    });
  });

  it.each(["sas", "cbl", "c", "cpp"])(
    "language %s has no convention and classifies as non-test",
    (language) => {
      const r = classifyTestSymbol({ filePath: "tests/test_x.src", name: "test_x", language });
      expect(r).toEqual({
        isTestFile: false,
        isTestSymbol: false,
        convention: null,
        subjectHint: null,
      });
    },
  );

  it("prefers the declared language over the extension, falling back when it is unknown", () => {
    expect(classifyTestSymbol({ filePath: "a/x_test.go", language: "py" }).isTestFile).toBe(false);
    expect(classifyTestSymbol({ filePath: "a/x_test.go", language: "nope" }).convention).toBe(
      "go-testing",
    );
    expect(classifyTestSymbol({ filePath: "a/x_test.go", language: null }).convention).toBe(
      "go-testing",
    );
  });

  it("rejects the A/B-test feature class SplitTest", () => {
    expect(
      classifyTestSymbol({
        filePath: "src/main/java/a/SplitTest.java",
        name: "SplitTest",
        kind: "class",
      }),
    ).toMatchObject({ isTestFile: false, subjectHint: null });
    // Inside a test tree the file is a test, but SplitTest still names no subject.
    expect(
      classifyTestSymbol({
        filePath: "src/test/java/a/SplitTest.java",
        name: "SplitTest",
        kind: "class",
      }),
    ).toMatchObject({ isTestFile: true, isTestSymbol: false, subjectHint: null });
    expect(
      classifyTestSymbol({ filePath: "Foo.Tests/AbTests.cs", name: "AbTests", kind: "class" }),
    ).toMatchObject({ isTestFile: true, subjectHint: null });
  });
});

describe("siblingTestPaths", () => {
  it("issue example: Go", () => {
    expect(siblingTestPaths("internal/validator/user.go")).toContain(
      "internal/validator/user_test.go",
    );
  });

  it.each([
    ["internal\\validator\\user.go", "go", ["internal/validator/user_test.go"]],
    ["user.go", undefined, ["user_test.go"]],
    ["src/x.ts", undefined, ["src/x.test.ts", "src/x.spec.ts", "src/__tests__/x.test.ts"]],
    ["src/x.jsx", "js", ["src/x.test.jsx", "src/x.spec.jsx", "src/__tests__/x.test.jsx"]],
    ["pkg/x.py", "py", ["pkg/test_x.py", "pkg/tests/test_x.py", "pkg/x_test.py"]],
    [
      "src/main/java/a/Foo.java",
      "java",
      ["src/test/java/a/FooTest.java", "src/test/java/a/FooTests.java"],
    ],
    [
      "mod/src/main/kotlin/a/Foo.kt",
      "kt",
      ["mod/src/test/kotlin/a/FooTest.kt", "mod/src/test/kotlin/a/FooTests.kt"],
    ],
    [
      "src/main/scala/a/Foo.scala",
      undefined,
      ["src/test/scala/a/FooTest.scala", "src/test/scala/a/FooTests.scala"],
    ],
    ["lib/a/Foo.java", "java", ["lib/a/FooTest.java", "lib/a/FooTests.java"]],
    ["Foo/Bar.cs", "cs", ["Foo/BarTests.cs", "Foo/BarTest.cs"]],
    ["crate/src/lib.rs", "rs", []],
    ["prog/payroll.sas", "sas", []],
    ["native/math.c", "c", []],
    ["README", undefined, []],
  ] as const)("%s (%s)", (p, lang, expected) => {
    expect(siblingTestPaths(p, lang)).toEqual(expected);
  });

  it("returns nothing for a file that is already a test", () => {
    expect(siblingTestPaths("internal/validator/user_test.go")).toEqual([]);
    expect(siblingTestPaths("src/x.test.ts")).toEqual([]);
  });
});

describe("subjectMatches", () => {
  it.each([
    ["ValidatePassword", "ValidatePassword", true],
    ["ValidatePassword", "validatePassword", true],
    ["validate_password", "validatePassword", true],
    ["validate_password", "ValidatePassword", true],
    ["ValidatePassword", "ValidatePasswords", false],
    ["ValidatePassword", "Validate", false],
    ["", "", false],
    ["_", "", false],
  ])("%s vs %s → %s", (hint, name, expected) => {
    expect(subjectMatches(hint, name)).toBe(expected);
  });
});
