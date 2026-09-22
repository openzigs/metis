/**
 * Issue #17 — unit tests for the call-target resolver. The end-to-end fixtures
 * (parser → ingest → persisted edges) live in `ingest.test.ts`; these pin each
 * rule in isolation, including the ones a fixture reaches only incidentally.
 */
import { describe, expect, it } from "vitest";
import {
  COMPLEX_RECEIVER,
  createResolutionIndex,
  indexSymbol,
  isRuntimeOrTestModule,
  isTestFilePath,
  resolveEdgeTarget,
  type ResolvableSymbol,
  type ResolutionSite,
} from "../../../src/lib/code-graph/call-resolution.js";

function sym(
  id: string,
  filePath: string,
  qualifiedTail: string,
  kind: string,
  language = "ts",
): ResolvableSymbol {
  const name = qualifiedTail.split("::").pop()!;
  return { id, name, qualifiedName: `${filePath}::${qualifiedTail}`, filePath, kind, language };
}

function build(symbols: ResolvableSymbol[]) {
  const index = createResolutionIndex();
  for (const s of symbols) indexSymbol(index, s);
  return index;
}

const site = (over: Partial<ResolutionSite> = {}): ResolutionSite => ({
  filePath: "src/caller.ts",
  language: "ts",
  importedFiles: [],
  ...over,
});

describe("resolveEdgeTarget — bare calls", () => {
  const index = build([
    sym("helper", "src/util.ts", "helper", "function"),
    sym("pyHelper", "pkg/util.py", "only_py", "function", "py"),
    sym("beforeEach", "src/fixtures.ts", "beforeEach", "function"),
    sym("joinFn", "src/strings.ts", "join", "function"),
  ]);

  it("binds a project-unique name in the same language family", () => {
    expect(resolveEdgeTarget("helper", undefined, site(), index)).toBe("helper");
    expect(resolveEdgeTarget("helper", undefined, site({ language: "js" }), index)).toBe("helper");
  });

  it("never binds across language families", () => {
    expect(resolveEdgeTarget("only_py", undefined, site(), index)).toBeNull();
  });

  it("never binds a runtime / test-framework global by name alone", () => {
    expect(resolveEdgeTarget("beforeEach", undefined, site(), index)).toBeNull();
  });

  it("never binds a name the caller imports from the runtime or a test framework", () => {
    const s = site({ runtimeImports: new Set(["join"]) });
    expect(resolveEdgeTarget("join", undefined, s, index)).toBeNull();
    expect(resolveEdgeTarget("join", undefined, site(), index)).toBe("joinFn");
  });

  it("still binds a same-file or imported definition of a global name (lexical evidence)", () => {
    expect(
      resolveEdgeTarget("beforeEach", undefined, site({ filePath: "src/fixtures.ts" }), index),
    ).toBe("beforeEach");
    expect(
      resolveEdgeTarget(
        "beforeEach",
        undefined,
        site({ importedFiles: ["src/fixtures.ts"] }),
        index,
      ),
    ).toBe("beforeEach");
  });
});

describe("resolveEdgeTarget — member calls", () => {
  const index = build([
    sym("svcPlace", "src/service.ts", "OrderService::placeOrder", "method"),
    sym("svcValidate", "src/service.ts", "OrderService::validate", "method"),
    sym("baseSave", "src/base.ts", "Base::save", "method"),
    sym("childSave", "src/child.ts", "Child::save", "method"),
    sym("errFrom", "src/errors.ts", "AppError::from", "method"),
    sym("apiGet", "src/api.ts", "fetchAll", "function"),
    sym("idxFn", "src/billing/index.ts", "charge", "function"),
    sym("goRun", "pkg/runner/run.go", "Run", "function", "go"),
    sym("goMethod", "pkg/runner/run.go", "Start", "function", "go"),
    sym("dialogJoin", "src/dialog.tsx", "join", "method"),
    sym("localFn", "src/caller.ts", "placeOrderFn", "function"),
  ]);

  it("this./self. bind within the file, then the files it imports", () => {
    const inService = site({ filePath: "src/service.ts" });
    expect(resolveEdgeTarget("validate", "this", inService, index)).toBe("svcValidate");
    expect(resolveEdgeTarget("validate", "self", inService, index)).toBe("svcValidate");
    const child = site({ filePath: "src/child.ts", importedFiles: ["src/base.ts"] });
    expect(resolveEdgeTarget("save", "this", child, index)).toBe("childSave");
  });

  it("super./base. skip the overriding method in the same file", () => {
    const child = site({ filePath: "src/child.ts", importedFiles: ["src/base.ts"] });
    expect(resolveEdgeTarget("save", "super", child, index)).toBe("baseSave");
    expect(resolveEdgeTarget("save", "base", child, index)).toBe("baseSave");
  });

  it("Class.member binds to that class's member", () => {
    expect(resolveEdgeTarget("from", "AppError", site(), index)).toBe("errFrom");
  });

  it("module.fn binds by module stem, index files by their directory, Go by package dir", () => {
    expect(resolveEdgeTarget("fetchAll", "api", site(), index)).toBe("apiGet");
    expect(resolveEdgeTarget("charge", "billing", site(), index)).toBe("idxFn");
    expect(
      resolveEdgeTarget("Run", "runner", site({ filePath: "cmd/main.go", language: "go" }), index),
    ).toBe("goRun");
  });

  it("an unknown receiver binds only to a method in this file or an imported one", () => {
    expect(resolveEdgeTarget("placeOrder", "svc", site(), index)).toBeNull();
    expect(
      resolveEdgeTarget("placeOrder", "svc", site({ importedFiles: ["src/service.ts"] }), index),
    ).toBe("svcPlace");
    expect(
      resolveEdgeTarget(
        "placeOrder",
        COMPLEX_RECEIVER,
        site({ importedFiles: ["src/service.ts"] }),
        index,
      ),
    ).toBe("svcPlace");
    // A plain function is never the target of `x.fn()` on an unknown receiver.
    expect(resolveEdgeTarget("placeOrderFn", "svc", site(), index)).toBeNull();
  });

  it("Go treats functions as member-capable (receiver methods are recorded as functions)", () => {
    const goSite = site({ filePath: "pkg/runner/run.go", language: "go" });
    expect(resolveEdgeTarget("Start", "s", goSite, index)).toBe("goMethod");
  });

  it("refuses when two imported files define the method", () => {
    const s = site({ importedFiles: ["src/base.ts", "src/child.ts"] });
    expect(resolveEdgeTarget("save", "repo", s, index)).toBeNull();
  });

  it("never binds a built-in method name on an unknown receiver, even in the defining file", () => {
    const inDialog = site({ filePath: "src/dialog.tsx" });
    expect(resolveEdgeTarget("join", "parts", inDialog, index)).toBeNull();
    expect(resolveEdgeTarget("join", COMPLEX_RECEIVER, inDialog, index)).toBeNull();
    expect(resolveEdgeTarget("join", "this", inDialog, index)).toBe("dialogJoin");
  });

  it("never binds a call on a runtime/test global or a runtime-imported namespace", () => {
    const withService = site({ importedFiles: ["src/service.ts"] });
    expect(resolveEdgeTarget("placeOrder", "vi", withService, index)).toBeNull();
    expect(resolveEdgeTarget("placeOrder", "JSON", withService, index)).toBeNull();
    const s = site({ importedFiles: ["src/service.ts"], runtimeImports: new Set(["nodePath"]) });
    expect(resolveEdgeTarget("placeOrder", "nodePath", s, index)).toBeNull();
  });

  it("a qualified receiver that matches two classes prefers the imported one", () => {
    const twin = build([
      sym("a", "src/a/errors.ts", "AppError::from", "method"),
      sym("b", "src/b/errors.ts", "AppError::from", "method"),
    ]);
    expect(resolveEdgeTarget("from", "AppError", site(), twin)).toBeNull();
    expect(
      resolveEdgeTarget("from", "AppError", site({ importedFiles: ["src/b/errors.ts"] }), twin),
    ).toBe("b");
  });
});

describe("isTestFilePath", () => {
  it.each([
    "ui/tests/test-utils.tsx",
    "server/src/lib/foo.test.ts",
    "src/app.spec.tsx",
    "e2e/fixtures/no-double-api-prefix.ts",
    "pkg/__tests__/x.js",
    "pkg/__mocks__/fs.ts",
    "service/handler_test.go",
    "app/test_models.py",
    "app/models_test.py",
    "src/test/java/com/acme/OrderServiceTest.java",
    "src/main/java/com/acme/OrderIT.java",
  ])("%s is a test file", (p) => expect(isTestFilePath(p)).toBe(true));

  it.each([
    "server/src/middleware/error-handler.ts",
    "ui/src/lib/api-client.ts",
    "src/testing-utils/format.ts",
    "src/contest.ts",
    "src/main/java/com/acme/Attestation.java",
  ])("%s is product code", (p) => expect(isTestFilePath(p)).toBe(false));
});

describe("isRuntimeOrTestModule", () => {
  it.each([
    "node:path",
    "path",
    "fs/promises",
    "vitest",
    "@jest/globals",
    "@testing-library/react",
    "@playwright/test",
  ])("%s is runtime or test", (s) => expect(isRuntimeOrTestModule(s)).toBe(true));
  it.each(["react", "./path", "@/lib/api", "pathfinder", "vitest-extra", "@metis/shared"])(
    "%s is not",
    (s) => expect(isRuntimeOrTestModule(s)).toBe(false),
  );
});

describe("resolveEdgeTarget — project-wide fallback reaches top-level declarations only", () => {
  const index = build([
    sym("setErr", "ui/src/picker.tsx", "Props::setError", "method"),
    sym("topMethod", "ui/src/page.tsx", "useEffect", "method"),
    sym("nested", "src/routes/auth.ts", "adminAuthRouter::p", "function"),
    sym("top", "src/lib/audit.ts", "audit", "function"),
  ]);

  it("does not bind a bare call to another file's method or nested function", () => {
    expect(resolveEdgeTarget("setError", undefined, site(), index)).toBeNull();
    expect(resolveEdgeTarget("useEffect", undefined, site(), index)).toBeNull();
    expect(resolveEdgeTarget("p", undefined, site(), index)).toBeNull();
    expect(resolveEdgeTarget("audit", undefined, site(), index)).toBe("top");
  });

  it("a nested function still binds from inside its own file", () => {
    expect(resolveEdgeTarget("p", undefined, site({ filePath: "src/routes/auth.ts" }), index)).toBe(
      "nested",
    );
  });
});
