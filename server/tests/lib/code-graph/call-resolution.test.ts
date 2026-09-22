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

// PR #64 review, blocking finding 1: steps 1 and 2 of the bare-call rule ran
// before the runtime-import guard and looked up every kind of symbol, so a bare
// `join` imported from `node:path` still bound to a project METHOD `join`.
describe("resolveEdgeTarget — a bare call never reaches a method, and a runtime import always wins", () => {
  const index = build([
    sym("pathUtilsJoin", "src/path-utils.ts", "PathUtils::join", "method"),
    sym("suiteBeforeEach", "src/suite-helpers.ts", "Suite::beforeEach", "method"),
    sym("helperNested", "src/helpers.ts", "outer::inner", "function"),
    sym("helperTop", "src/helpers.ts", "slugify", "function"),
    sym("fixtureTop", "src/fixtures.ts", "beforeEach", "function"),
    // A method declared BEFORE a same-named top-level function in one file.
    sym("mixedMethod", "src/mixed.ts", "Box::wrap", "method"),
    sym("mixedTop", "src/mixed.ts", "wrap", "function"),
    sym("javaSave", "src/main/java/a/Repo.java", "Repo::save", "method", "java"),
    sym("csSave", "src/Repo.cs", "Repo::Save", "method", "cs"),
  ]);

  it("the issue's shape: `import { join } from 'node:path'` beside an imported file with a `join` method", () => {
    const s = site({ importedFiles: ["src/path-utils.ts"], runtimeImports: new Set(["join"]) });
    expect(resolveEdgeTarget("join", undefined, s, index)).toBeNull();
  });

  it("a runtime import wins over a same-file definition too (no self-edge from PathUtils.join)", () => {
    const s = site({ filePath: "src/path-utils.ts", runtimeImports: new Set(["join"]) });
    expect(resolveEdgeTarget("join", undefined, s, index)).toBeNull();
  });

  it("a runtime import wins over an imported top-level function of the same name", () => {
    const s = site({ importedFiles: ["src/fixtures.ts"], runtimeImports: new Set(["beforeEach"]) });
    expect(resolveEdgeTarget("beforeEach", undefined, s, index)).toBeNull();
  });

  it("a bare call never binds to a method in an imported file", () => {
    expect(
      resolveEdgeTarget("join", undefined, site({ importedFiles: ["src/path-utils.ts"] }), index),
    ).toBeNull();
    expect(
      resolveEdgeTarget(
        "beforeEach",
        undefined,
        site({ importedFiles: ["src/suite-helpers.ts"] }),
        index,
      ),
    ).toBeNull();
  });

  it("a bare call never binds to a nested function in an imported file, only a top-level one", () => {
    const s = site({ importedFiles: ["src/helpers.ts"] });
    expect(resolveEdgeTarget("inner", undefined, s, index)).toBeNull();
    expect(resolveEdgeTarget("slugify", undefined, s, index)).toBe("helperTop");
  });

  it("a bare call never binds to a method in its own file (TS/JS/Python)", () => {
    expect(
      resolveEdgeTarget("join", undefined, site({ filePath: "src/path-utils.ts" }), index),
    ).toBeNull();
  });

  it("a same-named method declared first does not hide the top-level function", () => {
    expect(resolveEdgeTarget("wrap", undefined, site({ filePath: "src/mixed.ts" }), index)).toBe(
      "mixedTop",
    );
    expect(
      resolveEdgeTarget("wrap", undefined, site({ importedFiles: ["src/mixed.ts"] }), index),
    ).toBe("mixedTop");
  });

  it("Java and C# bare calls still reach a method of the same file (implicit `this`)", () => {
    const javaSite = site({ filePath: "src/main/java/a/Repo.java", language: "java" });
    expect(resolveEdgeTarget("save", undefined, javaSite, index)).toBe("javaSave");
    const csSite = site({ filePath: "src/Repo.cs", language: "cs" });
    expect(resolveEdgeTarget("Save", undefined, csSite, index)).toBe("csSave");
  });
});

// PR #64 review, finding 3: the built-in method-name guard ran before the
// imported-file lookup, so `repo.update()` on an imported project class never bound.
describe("resolveEdgeTarget — collection-style method names bind on receiver-named evidence", () => {
  const index = build([
    sym("repoUpdate", "src/repo.ts", "Repo::update", "method"),
    sym("repoGet", "src/repo.ts", "Repo::get", "method"),
    sym("cacheGet", "src/cache.ts", "Cache::get", "method"),
    sym("cfgGet", "src/config-service.ts", "ConfigService::get", "method"),
    sym("dialogJoin", "src/dialog.tsx", "join", "method"),
    sym(
      "mapperInsert",
      "src/main/java/a/OrderMapper.java",
      "OrderMapper::insert",
      "method",
      "java",
    ),
  ]);

  it("`repo.update()` binds to the imported class's method", () => {
    const s = site({ importedFiles: ["src/repo.ts"] });
    expect(resolveEdgeTarget("update", "repo", s, index)).toBe("repoUpdate");
    expect(resolveEdgeTarget("get", "Repo", s, index)).toBe("repoGet");
  });

  it("import evidence alone is not enough: `analyses.get()` on a local Map stays unbound", () => {
    const s = site({ importedFiles: ["src/config-service.ts"] });
    expect(resolveEdgeTarget("get", "analyses", s, index)).toBeNull();
    expect(resolveEdgeTarget("get", COMPLEX_RECEIVER, s, index)).toBeNull();
    expect(resolveEdgeTarget("get", "configService", s, index)).toBe("cfgGet");
  });

  it("a Java mapper's `insert` binds through the import", () => {
    const s = site({
      filePath: "src/main/java/a/OrderService.java",
      language: "java",
      importedFiles: ["src/main/java/a/OrderMapper.java"],
    });
    expect(resolveEdgeTarget("insert", "orderMapper", s, index)).toBe("mapperInsert");
  });

  it("but not from the defining file on an unknown receiver (`map.get()` inside Cache)", () => {
    expect(resolveEdgeTarget("get", "map", site({ filePath: "src/cache.ts" }), index)).toBeNull();
    expect(resolveEdgeTarget("get", "this", site({ filePath: "src/cache.ts" }), index)).toBe(
      "cacheGet",
    );
  });

  it("the receiver-named class must be in an imported file", () => {
    expect(resolveEdgeTarget("update", "repo", site(), index)).toBeNull();
  });

  it("strictly built-in names (`join`) stay unbound even with import evidence", () => {
    const s = site({ importedFiles: ["src/dialog.tsx"] });
    expect(resolveEdgeTarget("join", "parts", s, index)).toBeNull();
  });
});

// PR #64 review, findings 4 and 5: the global-name and global-receiver lists
// applied to every language.
describe("resolveEdgeTarget — global names and receivers are scoped by language", () => {
  const index = build([
    sym("tsOpen", "src/dialog-state.ts", "open", "function"),
    sym("tsFilter", "src/query.ts", "filter", "function"),
    sym("tsRender", "src/render.ts", "render", "function"),
    sym("errNotFound", "src/errors.ts", "notFound", "function"),
    sym("jsonParse", "src/json.ts", "parseLoose", "function"),
    sym("goStrings", "internal/strings/strings.go", "Pad", "function", "go"),
  ]);

  it("a Python builtin name does not block a TS project's own top-level function", () => {
    expect(resolveEdgeTarget("open", undefined, site(), index)).toBe("tsOpen");
    expect(resolveEdgeTarget("filter", undefined, site(), index)).toBe("tsFilter");
  });

  it("…and still blocks the Python builtin from binding to a Python project function", () => {
    const pyIndex = build([sym("pyOpen", "pkg/files.py", "open", "function", "py")]);
    const py = site({ filePath: "pkg/main.py", language: "py" });
    expect(resolveEdgeTarget("open", undefined, py, pyIndex)).toBeNull();
  });

  it("a test-library helper name that is always imported is not a bare global", () => {
    expect(resolveEdgeTarget("render", undefined, site(), index)).toBe("tsRender");
    expect(
      resolveEdgeTarget("render", undefined, site({ runtimeImports: new Set(["render"]) }), index),
    ).toBeNull();
  });

  it("test-framework globals stay blocked in JS/TS", () => {
    const idx = build([sym("d", "src/x.ts", "describe", "function")]);
    expect(resolveEdgeTarget("describe", undefined, site(), idx)).toBeNull();
  });

  it("a Go/Python namespace name is not a runtime receiver in TS", () => {
    expect(resolveEdgeTarget("notFound", "errors", site(), index)).toBe("errNotFound");
    expect(resolveEdgeTarget("parseLoose", "json", site(), index)).toBe("jsonParse");
  });

  it("…but is one in its own language", () => {
    const goSite = site({ filePath: "cmd/main.go", language: "go" });
    expect(resolveEdgeTarget("Pad", "strings", goSite, index)).toBeNull();
  });

  it("an imported project module overrides a runtime receiver name", () => {
    const idx = build([sym("pj", "src/lib/path.ts", "join", "function")]);
    expect(resolveEdgeTarget("join", "path", site(), idx)).toBeNull();
    expect(
      resolveEdgeTarget("join", "path", site({ importedFiles: ["src/lib/path.ts"] }), idx),
    ).toBe("pj");
    // …unless the file also imports that name from the runtime.
    expect(
      resolveEdgeTarget(
        "join",
        "path",
        site({ importedFiles: ["src/lib/path.ts"], runtimeImports: new Set(["path"]) }),
        idx,
      ),
    ).toBeNull();
  });
});
