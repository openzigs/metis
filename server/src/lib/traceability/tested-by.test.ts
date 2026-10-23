/**
 * "Tested by" resolver tests — Issue #814.
 *
 * An in-memory fake Prisma that honours exactly the `where` filters the
 * resolver sends (project scope included), so a missing scope or a wrong
 * filter shows up as a wrong answer rather than passing over a stub.
 */
import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TESTED_BY_ENTRY_POINT_MIN_TEST_CALLERS,
  DEFAULT_TESTED_BY_HUB_MIN_FOREIGN_TEST_DIRS,
  listUntestedRequirements,
  matchTestSubject,
  resolveTestedBy,
  type TestedByDeps,
} from "./tested-by.js";

interface Sym {
  id: string;
  projectId: string;
  name: string;
  qualifiedName: string;
  filePath: string;
  kind: string;
  language: string;
  startLine: number;
  endLine?: number;
}
interface Fixture {
  analyses?: Array<{ id: string; projectId: string }>;
  requirements?: Array<{
    id: string;
    projectId: string;
    title: string;
    body?: string;
    analysisId?: string;
    deletedAt?: Date | null;
  }>;
  codeMappings?: Array<{
    requirementId: string;
    projectId: string;
    codeSymbolId: string | null;
    filePath: string;
    startLine?: number | null;
    endLine?: number | null;
    /** `semantic` (the schema default), `manual`, or the seeder's `analysis-grounding`. */
    source?: string;
  }>;
  specMappings?: Array<{ requirementId: string; projectId: string; specDocumentId: string }>;
  specCode?: Array<{
    specDocumentId: string;
    projectId: string;
    codeSymbolId: string | null;
    filePath: string;
    startLine?: number | null;
  }>;
  symbols?: Sym[];
  edges?: Array<{
    projectId: string;
    kind: string;
    fromSymbolId: string;
    /** Null for an edge the ingest left unresolved (#1034). */
    toSymbolId: string | null;
    /** The callee or import path as parsed; read only for unresolved and `imports` edges. */
    toQualifiedName?: string;
    /** The edge's own file; read only for unresolved and `imports` edges. */
    filePath?: string;
  }>;
}

type Where = Record<string, unknown>;
const inList = (cond: unknown, v: unknown): boolean => {
  if (cond === undefined) return true;
  if (cond && typeof cond === "object" && "in" in cond)
    return (cond as { in: unknown[] }).in.includes(v);
  return cond === v;
};
const pick = <T extends object>(row: T, select: Record<string, unknown>) =>
  Object.fromEntries(Object.keys(select).map((k) => [k, (row as Record<string, unknown>)[k]]));

function fakePrisma(f: Fixture) {
  const symbols = f.symbols ?? [];
  const symWhere = (s: Sym, w: Where): boolean => {
    if (s.projectId !== w.projectId) return false;
    if (w.OR) return (w.OR as Where[]).some((o) => symWhere(s, { ...o, projectId: w.projectId }));
    return (
      inList(w.id, s.id) &&
      inList(w.filePath, s.filePath) &&
      inList(w.language, s.language) &&
      inList(w.kind, s.kind)
    );
  };
  const prisma = {
    analysis: {
      findFirst: vi.fn(
        async ({ where }: { where: Where }) =>
          (f.analyses ?? []).find((a) => a.id === where.id && a.projectId === where.projectId) ??
          null,
      ),
    },
    requirement: {
      findMany: vi.fn(
        async ({ where, select }: { where: Where; select: Record<string, unknown> }) =>
          (f.requirements ?? [])
            .filter(
              (r) =>
                r.projectId === where.projectId &&
                inList(where.id, r.id) &&
                inList(where.analysisId, r.analysisId) &&
                (where.deletedAt !== null || !r.deletedAt),
            )
            .map((r) => pick({ body: "", analysisId: null, ...r }, select)),
      ),
    },
    requirementCodeMapping: {
      findMany: vi.fn(
        async ({ where, select }: { where: Where; select: Record<string, unknown> }) =>
          (f.codeMappings ?? [])
            .filter(
              (m) =>
                m.projectId === where.projectId && inList(where.requirementId, m.requirementId),
            )
            .map((m) => pick({ startLine: null, endLine: null, source: "semantic", ...m }, select)),
      ),
    },
    requirementSpecMapping: {
      findMany: vi.fn(
        async ({ where, select }: { where: Where; select: Record<string, unknown> }) =>
          (f.specMappings ?? [])
            .filter(
              (m) =>
                m.projectId === where.projectId && inList(where.requirementId, m.requirementId),
            )
            .map((m) => pick(m, select)),
      ),
    },
    specCodeMapping: {
      findMany: vi.fn(
        async ({ where, select }: { where: Where; select: Record<string, unknown> }) =>
          (f.specCode ?? [])
            .filter(
              (m) =>
                m.projectId === where.projectId && inList(where.specDocumentId, m.specDocumentId),
            )
            .map((m) => pick({ startLine: null, ...m }, select)),
      ),
    },
    codeSymbol: {
      findMany: vi.fn(
        async ({ where, select }: { where: Where; select: Record<string, unknown> }) =>
          symbols.filter((s) => symWhere(s, where)).map((s) => pick(s, select)),
      ),
    },
    codeEdge: {
      findMany: vi.fn(async ({ where }: { where: Where }) => {
        // #1034 — the Go call resolver's two reads: unresolved calls, and imports.
        if (where.toSymbolId === null || where.kind === "imports") {
          const suffix = (where.filePath as { endsWith: string }).endsWith;
          return (f.edges ?? [])
            .filter(
              (e) =>
                e.projectId === where.projectId &&
                e.kind === where.kind &&
                (where.toSymbolId !== null || e.toSymbolId === null) &&
                (e.filePath ?? "").endsWith(suffix) &&
                inList(where.toQualifiedName, e.toQualifiedName),
            )
            .map((e) => ({
              fromSymbolId: e.fromSymbolId,
              filePath: e.filePath,
              toQualifiedName: e.toQualifiedName ?? null,
            }));
        }
        const fromScope = (where.fromSymbol as Where | undefined)?.projectId;
        return (f.edges ?? [])
          .filter(
            (e) =>
              e.projectId === where.projectId &&
              inList(where.kind, e.kind) &&
              inList(where.toSymbolId, e.toSymbolId),
          )
          .map((e) => ({ e, from: symbols.find((s) => s.id === e.fromSymbolId) }))
          .filter(({ from }) => from && (fromScope === undefined || from.projectId === fromScope))
          .map(({ e, from }) => ({ toSymbolId: e.toSymbolId, fromSymbol: from }));
      }),
    },
  };
  return prisma;
}

function deps(f: Fixture, extra: Partial<TestedByDeps> = {}) {
  const prisma = fakePrisma(f);
  return { prisma, deps: { prisma: prisma as unknown as TestedByDeps["prisma"], ...extra } };
}

function totalCalls(p: ReturnType<typeof fakePrisma>): number {
  return Object.values(p).reduce(
    (n, model) => n + Object.values(model).reduce((m, fn) => m + fn.mock.calls.length, 0),
    0,
  );
}

const P = "proj-a";
const sym = (id: string, filePath: string, name: string, extra: Partial<Sym> = {}): Sym => ({
  id,
  projectId: P,
  name,
  qualifiedName: `${filePath}::${name}`,
  filePath,
  kind: "function",
  language: filePath.endsWith(".go") ? "go" : filePath.endsWith(".py") ? "py" : "ts",
  startLine: 1,
  ...extra,
  endLine: extra.endLine ?? (extra.startLine ?? 1) + 5,
});
const req = (id: string, title: string, body = "") => ({
  id,
  projectId: P,
  title,
  body,
  analysisId: "an-1",
});
const fileMap = (requirementId: string, filePath: string, codeSymbolId: string | null = null) => ({
  requirementId,
  projectId: P,
  codeSymbolId,
  filePath,
});
/** A file-level row carrying a line range: the cited lines, not the whole file (#955). */
const rangeMap = (requirementId: string, filePath: string, startLine: number, endLine: number) => ({
  ...fileMap(requirementId, filePath),
  startLine,
  endLine,
});

const USER = "internal/validator/user.go";
const USER_TEST = "internal/validator/user_test.go";
const validatorSymbols = [
  sym("v-pw", USER, "validatePassword", { startLine: 10 }),
  sym("v-un", USER, "validateUsername", { startLine: 30 }),
  sym("t-pw", USER_TEST, "TestValidatePassword", { startLine: 55 }),
  sym("t-un", USER_TEST, "TestValidateUsername", { startLine: 80 }),
];

describe("matchTestSubject", () => {
  const c = (name: string, qualifiedName = `f.go::${name}`) => ({ name, qualifiedName });

  it("picks the longest symbol that prefixes a descriptive test name", () => {
    const cands = [c("Validate"), c("ValidatePassword")];
    expect(
      matchTestSubject("TestValidatePasswordRejectsEmpty", "ValidatePasswordRejectsEmpty", cands),
    ).toEqual(cands[1]);
  });

  it("matches a Go Type_Method test to the method over the type", () => {
    const cands = [c("User"), c("Validate", "f.go::User.Validate")];
    expect(matchTestSubject("TestUser_Validate", "User", cands)).toEqual(cands[1]);
  });

  it("matches a Go Type_Method test to a method stored as <file>::Type::method (#1071)", () => {
    // What ingest writes for `func (u *User) Validate()` and `func (a *Admin) Validate()`.
    const cands = [
      c("User"),
      c("Validate", "f.go::Admin::Validate"),
      c("Validate", "f.go::User::Validate"),
    ];
    expect(matchTestSubject("TestUser_Validate", "User", cands)).toEqual(cands[2]);
    expect(matchTestSubject("TestAdmin_ValidateRejectsEmpty", "Admin", cands)).toEqual(cands[1]);
  });

  it("matches pytest snake_case names", () => {
    const cands = [c("validate_password")];
    expect(
      matchTestSubject(
        "test_validate_password_rejects_empty",
        "validate_password_rejects_empty",
        cands,
      ),
    ).toEqual(cands[0]);
  });

  it("refuses a prefix that ends mid-word or is too short", () => {
    expect(matchTestSubject("TestValidatePassword", "ValidatePassword", [c("Val")])).toBeNull();
    expect(matchTestSubject("TestValidatePassword", "ValidatePassword", [c("Validat")])).toBeNull();
    expect(matchTestSubject("TestGo", "Go", [c("Go")])).toBeNull();
  });

  it("matches an exact name case- and underscore-insensitively", () => {
    expect(
      matchTestSubject("TestValidatePassword", "ValidatePassword", [c("validatePassword")]),
    ).not.toBeNull();
  });

  it("returns null without a hint", () => {
    expect(matchTestSubject("helper", null, [c("helper")])).toBeNull();
  });
});

describe("resolveTestedBy", () => {
  it("links a file-only mapping by naming, ranking the requirement's own test first", async () => {
    // Ranged: a rangeless whole-file row needs the title's words (#955, below).
    const { deps: d } = deps({
      requirements: [req("r1", "Password must be at least 6 characters")],
      codeMappings: [rangeMap("r1", USER, 1, 40)],
      symbols: validatorSymbols,
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out.map((t) => [t.name, t.relation])).toEqual([
      ["TestValidatePassword", "naming"],
      ["TestValidateUsername", "naming"],
    ]);
    expect(out[0]).toMatchObject({
      codeSymbolId: "t-pw",
      filePath: USER_TEST,
      symbol: `${USER_TEST}::TestValidatePassword`,
      startLine: 55,
      convention: "go-testing",
      subject: { filePath: USER, symbol: `${USER}::validatePassword` },
    });
    expect(out[0].score).toBeGreaterThan(out[1].score);
    expect(out[0].score).toBeLessThanOrEqual(0.6);
  });

  it("prefers exercises over naming for the same test and dedupes it", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "Password must be at least 6 characters")],
      codeMappings: [rangeMap("r1", USER, 1, 40)],
      symbols: validatorSymbols,
      edges: [{ projectId: P, kind: "calls", fromSymbolId: "t-pw", toSymbolId: "v-pw" }],
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out.map((t) => [t.name, t.relation])).toEqual([
      ["TestValidatePassword", "exercises"],
      ["TestValidateUsername", "naming"],
    ]);
    expect(out[0].score).toBe(0.8);
  });

  it("ignores imports edges and edges from non-test files", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "x")],
      codeMappings: [fileMap("r1", "pkg/a.ts", "a")],
      symbols: [
        sym("a", "pkg/a.ts", "doThing"),
        sym("b", "pkg/b.ts", "caller"),
        sym("t", "pkg/other.test.ts", "suite"),
      ],
      edges: [
        { projectId: P, kind: "imports", fromSymbolId: "t", toSymbolId: "a" },
        { projectId: P, kind: "calls", fromSymbolId: "b", toSymbolId: "a" },
      ],
    });
    expect((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")).toEqual([]);
  });

  it("follows a references edge from a TS test file into a mapped symbol", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "x")],
      codeMappings: [fileMap("r1", "pkg/a.ts", "a")],
      symbols: [sym("a", "pkg/a.ts", "doThing"), sym("t", "pkg/a.test.ts", "suite")],
      edges: [{ projectId: P, kind: "references", fromSymbolId: "t", toSymbolId: "a" }],
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      relation: "exercises",
      convention: "jest-vitest",
      subject: { filePath: "pkg/a.ts", symbol: "pkg/a.ts::doThing" },
    });
  });

  it("caps a file-only target's symbol expansion", async () => {
    const f: Fixture = {
      requirements: [req("r1", "x")],
      codeMappings: [rangeMap("r1", "pkg/a.ts", 1, 10)],
      symbols: [
        sym("a1", "pkg/a.ts", "first", { startLine: 1 }),
        sym("a2", "pkg/a.ts", "second", { startLine: 2 }),
        sym("t", "pkg/a.test.ts", "suite"),
      ],
      edges: [{ projectId: P, kind: "calls", fromSymbolId: "t", toSymbolId: "a2" }],
    };
    expect((await resolveTestedBy(P, ["r1"], undefined, deps(f).deps)).get("r1")).toHaveLength(1);
    const capped = deps(f, { maxSymbolsPerFile: 1 });
    expect((await resolveTestedBy(P, ["r1"], undefined, capped.deps)).get("r1")).toEqual([]);
    const edgeWhere = capped.prisma.codeEdge.findMany.mock.calls[0][0].where;
    expect(edgeWhere.toSymbolId).toEqual({ in: ["a1"] });
  });

  it("returns a mapped test file as direct, by symbol and file-only", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "x")],
      codeMappings: [fileMap("r1", USER_TEST, "t-pw"), fileMap("r1", "tests/test_login.py")],
      symbols: validatorSymbols,
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out.map((t) => [t.symbol, t.relation, t.subject, t.convention])).toEqual([
      [`${USER_TEST}::TestValidatePassword`, "direct", null, "go-testing"],
      ["tests/test_login.py", "direct", null, "pytest"],
    ]);
    expect(out[1]).toMatchObject({ name: "test_login.py", codeSymbolId: null });
    // Base 1.0; the query ("x") matches nothing, so relevance 0 folds it to 0.8.
    expect(out[0].score).toBe(0.8);
  });

  it("links a file-only target's sibling test by a shared requirement token alone", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "Password policy enforcement")],
      codeMappings: [fileMap("r1", "pkg/auth.go")],
      symbols: [
        sym("a", "pkg/auth.go", "check"),
        sym("t1", "pkg/auth_test.go", "TestPasswordPolicy"),
        sym("t2", "pkg/auth_test.go", "TestSessionExpiry"),
      ],
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      name: "TestPasswordPolicy",
      relation: "naming",
      subject: { filePath: "pkg/auth.go", symbol: null },
    });
  });

  it("matches a symbol-mapped target by subject but not by token share", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "Username rules")],
      codeMappings: [fileMap("r1", USER, "v-pw")],
      symbols: validatorSymbols,
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    // TestValidateUsername shares "username" with the title, but the target is a
    // specific symbol (validatePassword), so only its own test is linked.
    expect(out.map((t) => t.name)).toEqual(["TestValidatePassword"]);
  });

  it("reaches code through requirement → spec → code", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "x")],
      specMappings: [{ requirementId: "r1", projectId: P, specDocumentId: "s1" }],
      specCode: [{ specDocumentId: "s1", projectId: P, codeSymbolId: "v-pw", filePath: USER }],
      symbols: validatorSymbols,
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out.map((t) => t.name)).toEqual(["TestValidatePassword"]);
  });

  it("honours limit", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "x")],
      codeMappings: [rangeMap("r1", USER, 1, 40)],
      symbols: validatorSymbols,
    });
    expect((await resolveTestedBy(P, ["r1"], { limit: 1 }, d)).get("r1")).toHaveLength(1);
  });

  it("issues a constant number of queries however many requirements it resolves", async () => {
    const make = (n: number) => {
      const ids = Array.from({ length: n }, (_, i) => `r${i}`);
      return deps({
        requirements: ids.map((id) => req(id, "Password")),
        codeMappings: ids.flatMap((id) => [fileMap(id, USER), fileMap(id, USER, "v-un")]),
        specMappings: ids.map((id) => ({
          requirementId: id,
          projectId: P,
          specDocumentId: `s-${id}`,
        })),
        specCode: ids.map((id) => ({
          specDocumentId: `s-${id}`,
          projectId: P,
          codeSymbolId: "v-pw",
          filePath: USER,
        })),
        symbols: validatorSymbols,
        edges: [{ projectId: P, kind: "calls", fromSymbolId: "t-pw", toSymbolId: "v-pw" }],
      });
    };
    const one = make(1);
    const many = make(25);
    const resOne = await resolveTestedBy(P, ["r0"], undefined, one.deps);
    const resMany = await resolveTestedBy(
      P,
      Array.from({ length: 25 }, (_, i) => `r${i}`),
      undefined,
      many.deps,
    );
    expect(resOne.get("r0")!.length).toBeGreaterThan(0);
    expect(resMany.size).toBe(25);
    // requirement, code mappings, spec mappings, spec code, target symbols, edges, siblings,
    // and — a Go target only — the call resolver's callables, unresolved calls and imports (#1034).
    expect(totalCalls(one.prisma)).toBe(10);
    expect(totalCalls(many.prisma)).toBe(10);
  });

  it("never reads another project's symbols or edges for a shared file path", async () => {
    const other = "proj-b";
    const { prisma, deps: d } = deps({
      requirements: [req("r1", "Password must be at least 6 characters")],
      codeMappings: [fileMap("r1", USER)],
      symbols: [
        sym("v-pw", USER, "validatePassword"),
        { ...sym("b-pw", USER, "validatePassword"), projectId: other },
        { ...sym("b-t", USER_TEST, "TestValidatePassword"), projectId: other },
      ],
      edges: [{ projectId: other, kind: "calls", fromSymbolId: "b-t", toSymbolId: "v-pw" }],
    });
    expect((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")).toEqual([]);
    for (const model of [prisma.codeSymbol, prisma.codeEdge, prisma.requirementCodeMapping]) {
      for (const [arg] of model.findMany.mock.calls) expect(arg.where.projectId).toBe(P);
    }
  });

  it("does no work for no ids, and omits requirements outside the project", async () => {
    const empty = deps({});
    expect((await resolveTestedBy(P, [], undefined, empty.deps)).size).toBe(0);
    expect(totalCalls(empty.prisma)).toBe(0);

    const { deps: d } = deps({
      requirements: [
        { ...req("r1", "x"), projectId: "proj-b" },
        { ...req("r2", "y"), deletedAt: new Date() },
      ],
    });
    expect((await resolveTestedBy(P, ["r1", "r2"], undefined, d)).size).toBe(0);
  });
});

describe("resolveTestedBy — Go calls the ingest left unresolved (#1034)", () => {
  const STORE = "internal/storage/entry.go";
  const API_TEST = "internal/api/entry_test.go";
  const API = "internal/api/api.go";
  const storeSymbols = [
    sym("s-set", STORE, "SetEntriesStatus", { startLine: 100 }),
    sym("s-trunc", STORE, "truncateStringForTSVectorField", { startLine: 300 }),
    sym("h", API, "updateEntries", { startLine: 10 }),
    sym("t-api", API_TEST, "TestUpdateEntriesHandler", { startLine: 20 }),
  ];
  /**
   * `h.store.SetEntriesStatus(…)` from the handler test: unresolved at ingest,
   * and stored as the parser writes it, by the bare field name.
   */
  const methodCall = {
    projectId: P,
    kind: "calls",
    fromSymbolId: "t-api",
    toSymbolId: null,
    toQualifiedName: "SetEntriesStatus",
    filePath: API_TEST,
  };
  const importsStorage = {
    projectId: P,
    kind: "imports",
    fromSymbolId: "h",
    toSymbolId: null,
    toQualifiedName: "miniflux.app/v2/internal/storage",
    filePath: API,
  };
  const names = (out: Array<{ name: string; relation: string }>) =>
    out.map((t) => [t.name, t.relation]);

  it("lists a test that reaches the mapped method through a struct field", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "Mark entries as read")],
      codeMappings: [fileMap("r1", STORE, "s-set")],
      symbols: storeSymbols,
      edges: [methodCall, importsStorage],
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(names(out)).toEqual([["TestUpdateEntriesHandler", "inferred-call"]]);
    expect(out[0]).toMatchObject({
      codeSymbolId: "t-api",
      filePath: API_TEST,
      subject: { filePath: STORE, symbol: `${STORE}::SetEntriesStatus` },
    });
  });

  it("lists a same-package test that calls the mapped method on a receiver", async () => {
    // The issue's case: `client.CreateBookmark(…)` inside a linktaco test.
    const LT = "internal/integration/linktaco/linktaco.go";
    const LT_TEST = "internal/integration/linktaco/linktaco_test.go";
    const { deps: d } = deps({
      requirements: [req("r1", "Require API token and organization slug")],
      codeMappings: [fileMap("r1", LT, "lt-create")],
      symbols: [
        sym("lt-create", LT, "CreateBookmark"),
        // Another integration's method of the same name: not visible from linktaco.
        sym("ld-create", "internal/integration/linkding/linkding.go", "CreateBookmark"),
        sym("lt-test", LT_TEST, "TestMissingCredentials", { startLine: 200 }),
      ],
      edges: [
        {
          projectId: P,
          kind: "calls",
          fromSymbolId: "lt-test",
          toSymbolId: null,
          toQualifiedName: "CreateBookmark",
          filePath: LT_TEST,
        },
      ],
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(names(out)).toEqual([["TestMissingCredentials", "inferred-call"]]);
  });

  it("follows the resolved call into a ranged file target", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "Mark entries as read")],
      codeMappings: [{ ...fileMap("r1", STORE), startLine: 100, endLine: 105 }],
      symbols: storeSymbols,
      edges: [methodCall, importsStorage],
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(names(out)).toEqual([["TestUpdateEntriesHandler", "inferred-call"]]);
  });

  it("does not follow it into a rangeless whole-file target (#955, #1004)", async () => {
    // A whole-file row expands to every symbol of entry.go; binding the call
    // graph's gap there would link every handler test that touches storage.
    const { deps: d } = deps({
      requirements: [req("r1", "Mark entries as read")],
      codeMappings: [fileMap("r1", STORE)],
      symbols: storeSymbols,
      edges: [methodCall, importsStorage],
    });
    expect((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")).toEqual([]);

    // Still not followed when another requirement's symbol mapping loads the
    // very same bound call in the same batch.
    const batch = deps({
      requirements: [req("r1", "Mark entries as read"), req("r2", "Mark entries as read")],
      codeMappings: [fileMap("r1", STORE), fileMap("r2", STORE, "s-set")],
      symbols: storeSymbols,
      edges: [methodCall, importsStorage],
    });
    const out = await resolveTestedBy(P, ["r1", "r2"], undefined, batch.deps);
    expect(out.get("r1")).toEqual([]);
    expect(names(out.get("r2")!)).toEqual([["TestUpdateEntriesHandler", "inferred-call"]]);
  });

  it("reads no Go call graph for a batch whose only Go target is a rangeless file row", async () => {
    // The load-time copy of the rangeless guard: without it the answer is the
    // same (the resolve-time guard drops the links) and only the cost shows.
    const { prisma, deps: d } = deps({
      requirements: [req("r1", "Mark entries as read")],
      codeMappings: [fileMap("r1", STORE)],
      symbols: storeSymbols,
      edges: [methodCall, importsStorage],
    });
    expect((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")).toEqual([]);
    // Not vacuous: the ingest-edge read did run for the file's symbols.
    expect(prisma.codeEdge.findMany.mock.calls.length).toBeGreaterThan(0);
    for (const [arg] of prisma.codeEdge.findMany.mock.calls) {
      expect(arg.where.toSymbolId).not.toBeNull();
      expect(arg.where.kind).not.toBe("imports");
    }
    // Nor the resolver's read of the project's Go callables.
    for (const [arg] of prisma.codeSymbol.findMany.mock.calls) {
      expect(arg.where.language).toBeUndefined();
    }
  });

  it("reads only the unresolved calls to the targets' own names", async () => {
    const noise = Array.from({ length: 50 }, (_, i) => ({
      ...methodCall,
      toQualifiedName: `Unrelated${i}`,
    }));
    const { prisma, deps: d } = deps({
      requirements: [req("r1", "Mark entries as read")],
      codeMappings: [fileMap("r1", STORE, "s-set")],
      symbols: storeSymbols,
      edges: [methodCall, importsStorage, ...noise],
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(names(out)).toEqual([["TestUpdateEntriesHandler", "inferred-call"]]);
    const unresolvedReads = prisma.codeEdge.findMany.mock.calls.filter(
      ([arg]) => arg.where.toSymbolId === null,
    );
    expect(unresolvedReads).toHaveLength(1);
    expect(unresolvedReads[0][0].where.toQualifiedName).toEqual({ in: ["SetEntriesStatus"] });
    const rows = await prisma.codeEdge.findMany.mock.results.find(
      (_, i) => prisma.codeEdge.findMany.mock.calls[i][0].where.toSymbolId === null,
    )!.value;
    expect(rows).toHaveLength(1);
  });

  it("does not guess when the callee is ambiguous or out of reach", async () => {
    const base = {
      requirements: [req("r1", "Mark entries as read")],
      codeMappings: [fileMap("r1", STORE, "s-set")],
    };
    // No import of the storage package from the caller's package.
    const unreachable = deps({ ...base, symbols: storeSymbols, edges: [methodCall] });
    expect((await resolveTestedBy(P, ["r1"], undefined, unreachable.deps)).get("r1")).toEqual([]);
    // Two visible candidates of the same name.
    const ambiguous = deps({
      ...base,
      symbols: [...storeSymbols, sym("h-set", API, "SetEntriesStatus", { startLine: 50 })],
      edges: [methodCall, importsStorage],
    });
    expect((await resolveTestedBy(P, ["r1"], undefined, ambiguous.deps)).get("r1")).toEqual([]);
  });

  it("ignores a resolved call from a non-test file", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "Mark entries as read")],
      codeMappings: [fileMap("r1", STORE, "s-set")],
      symbols: storeSymbols,
      edges: [{ ...methodCall, fromSymbolId: "h", filePath: API }, importsStorage],
    });
    expect((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")).toEqual([]);
  });

  describe("an inferred call is labelled apart and never promoted", () => {
    const STORE_TEST = "internal/storage/entry_test.go";
    const FEVER_TEST = "internal/fever/handler_test.go";
    const feverCall = { ...methodCall, fromSymbolId: "t-fever", filePath: FEVER_TEST };
    const feverImport = { ...importsStorage, filePath: "internal/fever/handler.go" };
    const symbols = [...storeSymbols, sym("t-fever", FEVER_TEST, "TestFeverMarkRead")];
    /** With the storage package's own test, which is also a `naming` match. */
    const withOwnTest = [...symbols, sym("t-own", STORE_TEST, "TestSetEntriesStatus")];
    /** What the ingest resolved itself: the own-package test and ONE foreign test. */
    const ingestEdges = [
      { projectId: P, kind: "calls", fromSymbolId: "t-own", toSymbolId: "s-set" },
      { projectId: P, kind: "calls", fromSymbolId: "t-api", toSymbolId: "s-set" },
    ];
    const base = {
      requirements: [req("r1", "Password length policy for accounts")],
      codeMappings: [fileMap("r1", STORE, "s-set")],
      symbols,
    };

    it("scores below every ingest-derived relation and sorts last", async () => {
      const { deps: d } = deps({
        ...base,
        symbols: withOwnTest,
        edges: [ingestEdges[0], feverCall, feverImport],
      });
      const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
      expect(names(out)).toEqual([
        ["TestSetEntriesStatus", "exercises"],
        ["TestFeverMarkRead", "inferred-call"],
      ]);
      // 0.6 is `naming`'s base: an inferred call can never outscore one.
      expect(out[1].score).toBeLessThan(0.6);
      expect(out[1].score).toBeGreaterThan(0);
    });

    it("keeps the ingest's own relation when the same test is also bound by name", async () => {
      const { deps: d } = deps({
        ...base,
        edges: [ingestEdges[1], methodCall, importsStorage],
      });
      const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
      expect(names(out)).toEqual([["TestUpdateEntriesHandler", "exercises"]]);
    });

    it("does not count toward the hub guard, so it cannot hide a listed test (#860)", async () => {
      // The review's probe. Before: own-package + one foreign test, both `exercises`.
      const own = { ...base, symbols: withOwnTest };
      const before = deps({ ...own, edges: ingestEdges });
      const listed = [
        ["TestUpdateEntriesHandler", "exercises"],
        ["TestSetEntriesStatus", "exercises"],
      ];
      expect(names((await resolveTestedBy(P, ["r1"], undefined, before.deps)).get("r1")!)).toEqual(
        listed,
      );
      // Add a bound call from a SECOND foreign package. Counted, it would make
      // the target a hub: neither test nor callee shares the title's words, so
      // the foreign test would vanish and the own test fall back to `naming`.
      const after = deps({ ...own, edges: [...ingestEdges, feverCall, feverImport] });
      expect(names((await resolveTestedBy(P, ["r1"], undefined, after.deps)).get("r1")!)).toEqual([
        ...listed,
        ["TestFeverMarkRead", "inferred-call"],
      ]);
    });

    it("alone, bound calls from any number of packages never make a hub", async () => {
      const { deps: d } = deps({
        ...base,
        edges: [methodCall, importsStorage, feverCall, feverImport],
      });
      expect(names((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!).sort()).toEqual([
        ["TestFeverMarkRead", "inferred-call"],
        ["TestUpdateEntriesHandler", "inferred-call"],
      ]);
    });

    it("is filtered like any caller once the ingest's own edges make the target a hub", async () => {
      const READER_TEST = "internal/reader/handler_test.go";
      const hubFixture = {
        ...base,
        symbols: [...symbols, sym("t-reader", READER_TEST, "TestReaderRefresh")],
        // Two foreign directories resolved at ingest: a hub with no help from the bound call.
        edges: [
          ingestEdges[1],
          { projectId: P, kind: "calls", fromSymbolId: "t-reader", toSymbolId: "s-set" },
          feverCall,
          feverImport,
        ],
      };
      const hub = deps(hubFixture);
      expect((await resolveTestedBy(P, ["r1"], undefined, hub.deps)).get("r1")).toEqual([]);
      // Not vacuous: out of the hub's reach, all three are listed.
      const noHub = deps(hubFixture, { hubMinForeignTestDirs: 99 });
      expect(
        names((await resolveTestedBy(P, ["r1"], undefined, noHub.deps)).get("r1")!).sort(),
      ).toEqual([
        ["TestFeverMarkRead", "inferred-call"],
        ["TestReaderRefresh", "exercises"],
        ["TestUpdateEntriesHandler", "exercises"],
      ]);
    });
  });

  describe("a bound call is kept only when its name is evidence", () => {
    const STORAGE = "internal/storage/storage.go";
    const STORAGE_TEST = "internal/storage/storage_test.go";
    const call = (fromSymbolId: string, filePath: string, toQualifiedName: string) => ({
      projectId: P,
      kind: "calls",
      fromSymbolId,
      toSymbolId: null,
      toQualifiedName,
      filePath,
    });
    const one = async (f: Parameters<typeof deps>[0]) =>
      names((await resolveTestedBy(P, ["r1"], undefined, deps(f).deps)).get("r1")!);

    it("does not read a stray Close() in a handler test as testing storage.Close", async () => {
      // The review's probe: `resp.Body.Close()` is stored as an unresolved `Close`,
      // internal/api imports storage, and storage declares the only visible `Close`.
      const fixture = {
        requirements: [req("r1", "Close the database connection pool")],
        codeMappings: [fileMap("r1", STORAGE, "s-close")],
        symbols: [
          sym("s-close", STORAGE, "Close"),
          sym("h", API, "updateEntries"),
          sym("t-icon", API_TEST, "TestFetchFeedIcon"),
        ],
        edges: [call("t-icon", API_TEST, "Close"), importsStorage],
      };
      expect(await one(fixture)).toEqual([]);
      const gaps = await listUntestedRequirements(P, undefined, deps(fixture).deps);
      expect(gaps.tested).toBe(0);
      expect(gaps.untested.map((g) => g.requirementId)).toEqual(["r1"]);
    });

    it("does not bind a well-known compound stdlib name (context.WithTimeout)", async () => {
      const FETCH = "internal/reader/fetcher/request_builder.go";
      const FETCH_TEST = "internal/reader/fetcher/response_handler_test.go";
      expect(
        await one({
          requirements: [req("r1", "Request timeout")],
          codeMappings: [fileMap("r1", FETCH, "f-timeout")],
          symbols: [
            sym("f-timeout", FETCH, "WithTimeout"),
            sym("t-ctx", FETCH_TEST, "TestResponseHandlerCancelled"),
          ],
          edges: [call("t-ctx", FETCH_TEST, "WithTimeout")],
        }),
      ).toEqual([]);
    });

    it("binds a one-word name when a same-package test is named for it", async () => {
      // Miniflux: TestValidateCertFileAndKeyFile calls configParser.options.Validate().
      const PARSER = "internal/config/parser.go";
      const OPTS_TEST = "internal/config/options_parsing_test.go";
      const fixture = {
        requirements: [req("r1", "Reject an invalid configuration")],
        codeMappings: [fileMap("r1", PARSER, "c-validate")],
        symbols: [
          sym("c-validate", PARSER, "Validate"),
          sym("t-validate", OPTS_TEST, "TestValidateCertFileAndKeyFile"),
          // Same package, same call, but not named for it: `err.Validate()` of anything.
          sym("t-other", OPTS_TEST, "TestHTTPClientProxyOptionParsing"),
        ],
        edges: [call("t-validate", OPTS_TEST, "Validate"), call("t-other", OPTS_TEST, "Validate")],
      };
      expect(await one(fixture)).toEqual([["TestValidateCertFileAndKeyFile", "inferred-call"]]);
    });

    it("does not take a test's name as evidence from another package", async () => {
      // Miniflux: internal/api's TestVersionHandler calls runtime.Version(), and
      // client/client.go declares the only visible project `Version`.
      const CLIENT = "client/client.go";
      expect(
        await one({
          requirements: [req("r1", "Report the server version")],
          codeMappings: [fileMap("r1", CLIENT, "c-version")],
          symbols: [
            sym("c-version", CLIENT, "Version"),
            sym("h", API, "versionHandler"),
            sym("t-version", API_TEST, "TestVersionHandler"),
          ],
          edges: [
            call("t-version", API_TEST, "Version"),
            { ...importsStorage, toQualifiedName: "miniflux.app/v2/client" },
          ],
        }),
      ).toEqual([]);
    });

    it("binds an unexported name only from its own package", async () => {
      const symbols = [
        sym("s-dedupe", STORAGE, "removeDuplicateEntries"),
        sym("h", API, "updateEntries"),
        sym("t-far", API_TEST, "TestUpdateEntriesHandler"),
        sym("t-near", STORAGE_TEST, "TestEntryCleanup"),
      ];
      const base = {
        requirements: [req("r1", "Deduplicate entries")],
        codeMappings: [fileMap("r1", STORAGE, "s-dedupe")],
        symbols,
      };
      // A local closure of the same name in a package that imports storage.
      expect(
        await one({
          ...base,
          edges: [call("t-far", API_TEST, "removeDuplicateEntries"), importsStorage],
        }),
      ).toEqual([]);
      expect(
        await one({ ...base, edges: [call("t-near", STORAGE_TEST, "removeDuplicateEntries")] }),
      ).toEqual([["TestEntryCleanup", "inferred-call"]]);
    });
  });

  it("reads no Go call graph for a project whose targets are not Go", async () => {
    const { prisma, deps: d } = deps({
      requirements: [req("r1", "x")],
      codeMappings: [fileMap("r1", "pkg/a.ts", "a")],
      symbols: [sym("a", "pkg/a.ts", "doThing"), sym("t", "pkg/a.test.ts", "suite")],
      edges: [{ projectId: P, kind: "calls", fromSymbolId: "t", toSymbolId: "a" }],
    });
    await resolveTestedBy(P, ["r1"], undefined, d);
    expect(prisma.codeEdge.findMany.mock.calls.length).toBeGreaterThan(0);
    for (const [arg] of prisma.codeEdge.findMany.mock.calls) {
      expect(arg.where.toSymbolId).not.toBeNull();
      expect(arg.where.kind).not.toBe("imports");
    }
  });

  it("scopes every resolver read to the project", async () => {
    const { prisma, deps: d } = deps({
      requirements: [req("r1", "Mark entries as read")],
      codeMappings: [fileMap("r1", STORE, "s-set")],
      symbols: [
        ...storeSymbols,
        { ...sym("b-t", API_TEST, "TestOtherProject"), projectId: "proj-b" },
      ],
      edges: [
        importsStorage,
        { ...methodCall, projectId: "proj-b", fromSymbolId: "b-t" },
        { ...importsStorage, projectId: "proj-b" },
      ],
    });
    expect((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")).toEqual([]);
    for (const model of [prisma.codeSymbol, prisma.codeEdge]) {
      for (const [arg] of model.findMany.mock.calls) expect(arg.where.projectId).toBe(P);
    }
  });
});

describe("resolveTestedBy — config hubs do not fan out (#860)", () => {
  // The `module` symbol every parser emits for a file (parsers.ts,
  // parsers-tree-sitter.ts): name = basename, qualifiedName = path, 1 to EOF.
  const mod = (id: string, filePath: string, endLine: number): Sym =>
    sym(id, filePath, filePath.slice(filePath.lastIndexOf("/") + 1), {
      kind: "module",
      qualifiedName: filePath,
      startLine: 1,
      endLine,
    });
  const calls = (from: string, to: string) => ({
    projectId: P,
    kind: "calls",
    fromSymbolId: from,
    toSymbolId: to,
  });

  // ── Miniflux 2.3.3, as the code graph holds it (#706 run 3) ──────────────
  // `internal/config/options.go:64` is `func NewConfigOptions()`, ending at 621;
  // `IsOAuth2UserCreationAllowed` is at 829. `grep -rl NewConfigOptions
  // --include=*_test.go` finds 3 files in 3 directories, and these are the 14
  // test functions whose `calls` edges reach it: 1 in its own package, 2
  // foreign directories.
  const OPTIONS = "internal/config/options.go";
  const SANITIZER_TEST = "internal/reader/sanitizer/sanitizer_test.go";
  const REWRITE_TEST = "internal/reader/rewrite/content_rewrite_test.go";
  const optionSymbols = [
    mod("o-mod", OPTIONS, 1044),
    sym("o-new", OPTIONS, "NewConfigOptions", { startLine: 64, endLine: 621 }),
    sym("o-oauth", OPTIONS, "IsOAuth2UserCreationAllowed", { startLine: 829, endLine: 831 }),
  ];
  const sanitizerTests = [
    "TestInvalidIFrame",
    "TestBlockedIFrameWithChildElements",
    "TestSameDomainIFrame",
    "TestInvidiousIFrame",
    "TestIFrameAllowList",
    "TestIFrameWithChildElements",
    "TestIFrameWithReferrerPolicy",
  ].map((name, i) => sym(`t-san-${i}`, SANITIZER_TEST, name, { startLine: 389 + 12 * i }));
  const rewriteTests = [
    "TestRewriteYoutubeVideoLink",
    "TestRewriteYoutubeShortLink",
    "TestRewriteIncorrectYoutubeLink",
    "TestRewriteYoutubeVideoLinkUsingInvidious",
    "TestRewriteYoutubeShortLinkUsingInvidious",
    "TestAddYoutubeVideoFromId",
  ].map((name, i) => sym(`t-rw-${i}`, REWRITE_TEST, name, { startLine: 69 + 20 * i }));
  const configMapTest = sym(
    "t-cfgmap",
    "internal/config/options_parsing_test.go",
    "TestConfigMap",
    { startLine: 1764, endLine: 1775 },
  );
  const foreignCallers = [...sanitizerTests, ...rewriteTests];
  const OAUTH_TITLE = "OAuth2 user auto-creation gated by OAUTH2_USER_CREATION";

  type Mapping = ReturnType<typeof fileMap> & { startLine?: number; endLine?: number };
  /** The seeder's (#768) row for the `options.go:64-621` citation: bound to the constructor. */
  const constructorRow: Mapping = {
    ...fileMap("r1", OPTIONS, "o-new"),
    startLine: 64,
    endLine: 621,
  };
  const minifluxFixture = (mapping: Mapping, title: string): Fixture => ({
    requirements: [req("r1", title)],
    codeMappings: [mapping],
    symbols: [...optionSymbols, ...foreignCallers, configMapTest],
    edges: [...foreignCallers, configMapTest].map((t) => calls(t.id, "o-new")),
  });
  const resolve = async (d: TestedByDeps) =>
    (await resolveTestedBy(P, ["r1"], { limit: 50 }, d)).get("r1") ?? [];
  const names = async (d: TestedByDeps) => (await resolve(d)).map((t) => t.name).sort();

  it("drops every iframe and YouTube setup caller of NewConfigOptions from OAUTH2_USER_CREATION", async () => {
    const { deps: d } = deps(minifluxFixture(constructorRow, OAUTH_TITLE));
    // The two foreign packages call the constructor to build their fixtures; the
    // config package's own TestConfigMap shares no title word either (#905).
    expect(await names(d)).toEqual([]);
  });

  it("does the same for the stored run-3 shape: a file-level row ranged over the constructor", async () => {
    const fileRow = { ...fileMap("r1", OPTIONS), startLine: 64, endLine: 621 };
    const { deps: d } = deps(minifluxFixture(fileRow, OAUTH_TITLE));
    expect(await names(d)).toEqual([]);
  });

  it("#905 — none of the six run-3 config requirements is tested by the own-package TestConfigMap", async () => {
    // #860's symptom 3: each is mapped to the NewConfigOptions constructor, and the
    // only own-package caller is `TestConfigMap`, which tests the option map, not
    // OIDC, metrics or user creation.
    const titles = [
      "OpenID Connect sign-in",
      "Prometheus metrics endpoint",
      "METRICS_ALLOWED_NETWORKS restricts the metrics endpoint",
      "Metrics endpoint basic authentication",
      "Metrics refresh interval",
      OAUTH_TITLE,
    ];
    const ids = titles.map((_, i) => `r${i}`);
    const base = minifluxFixture(constructorRow, OAUTH_TITLE);
    const { deps: d } = deps({
      ...base,
      requirements: titles.map((t, i) => req(ids[i], t)),
      codeMappings: ids.map((id) => ({ ...constructorRow, requirementId: id })),
    });
    const gaps = await listUntestedRequirements(P, undefined, d);
    expect(gaps).toMatchObject({ total: 6, tested: 0, noCode: 0 });
    expect(gaps.untested.map((g) => g.requirementId)).toEqual(ids);
  });

  it("#905 — inside a hub, an own-package test that shares the title's words is kept", async () => {
    const f = minifluxFixture(constructorRow, OAUTH_TITLE);
    f.symbols!.push(
      sym("t-oa", "internal/config/options_parsing_test.go", "TestOAuth2UserCreationOptionParsing"),
    );
    f.edges!.push(calls("t-oa", "o-new"));
    const { deps: d } = deps(f);
    const out = await resolve(d);
    expect(out.map((t) => [t.name, t.relation])).toEqual([
      ["TestOAuth2UserCreationOptionParsing", "exercises"],
    ]);
  });

  it("is a hub at exactly DEFAULT_TESTED_BY_HUB_MIN_FOREIGN_TEST_DIRS (2) foreign directories", async () => {
    expect(DEFAULT_TESTED_BY_HUB_MIN_FOREIGN_TEST_DIRS).toBe(2);
    const { deps: atDefault } = deps(minifluxFixture(constructorRow, OAUTH_TITLE), {
      hubMinForeignTestDirs: DEFAULT_TESTED_BY_HUB_MIN_FOREIGN_TEST_DIRS,
    });
    expect(await names(atDefault)).toEqual([]);
    // One more required directory than Miniflux has: not a hub, all 14 callers
    // count. (The #1108 entry-point rule, off here, would demote all 14 as well.)
    const { deps: above } = deps(minifluxFixture(constructorRow, OAUTH_TITLE), {
      hubMinForeignTestDirs: 3,
      entryPointMinTestCallers: 1000,
    });
    const out = await resolve(above);
    expect(out).toHaveLength(14);
    expect(out.every((t) => t.relation === "exercises")).toBe(true);
  });

  it("counts only FOREIGN directories: the target's own package never makes it a hub", async () => {
    // Drop the rewrite package: 1 foreign directory (sanitizer) + the own one = 2
    // directories in all, which the cycle-2 all-directory count would have read as 2.
    const f = minifluxFixture(constructorRow, OAUTH_TITLE);
    f.symbols = f.symbols!.filter((s) => s.filePath !== REWRITE_TEST);
    f.edges = f.edges!.filter((e) => !e.fromSymbolId.startsWith("t-rw-"));
    const { deps: d } = deps(f);
    expect(await names(d)).toEqual(["TestConfigMap", ...sanitizerTests.map((t) => t.name)].sort());
  });

  it("keeps a foreign caller whose TEST name shares two title words", async () => {
    const { deps: d } = deps(minifluxFixture(constructorRow, "Invidious video link rewriting"));
    // Two of `invidious`, `video`, `link`; `TestInvidiousIFrame` and
    // `TestAddYoutubeVideoFromId` share one each.
    expect(await names(d)).toEqual([
      "TestRewriteYoutubeShortLinkUsingInvidious",
      "TestRewriteYoutubeVideoLink",
      "TestRewriteYoutubeVideoLinkUsingInvidious",
    ]);
  });

  it("keeps a foreign caller whose CALLEE is named for the requirement", async () => {
    // A rangeless file-level row expands to every symbol of options.go, so a call
    // into `IsOAuth2UserCreationAllowed` is judged by that callee's name.
    const f = minifluxFixture(fileMap("r1", OPTIONS), OAUTH_TITLE);
    f.symbols!.push(sym("t-cb", "internal/ui/oauth2_callback_test.go", "TestCallback"));
    f.edges!.push(calls("t-cb", "o-oauth"));
    const { deps: d } = deps(f);
    expect(await names(d)).toEqual(["TestCallback"]);
  });

  it("matches hub links against the requirement TITLE, not the common words of its body", async () => {
    const f = minifluxFixture(constructorRow, "Allow OAuth2 user creation");
    f.requirements = [
      req(
        "r1",
        "Allow OAuth2 user creation",
        "A new user account is created automatically the first time someone signs in " +
          "through an OAuth2 provider. The account gets the default iframe settings.",
      ),
    ];
    // Shares `default`, `account` and `provider` with the body, nothing with the title.
    f.symbols!.push(sym("t-acct", "internal/model/account_test.go", "TestDefaultAccountProvider"));
    f.edges!.push(calls("t-acct", "o-new"));
    const { deps: d } = deps(f);
    expect(await names(d)).toEqual([]);
  });

  it("NewConfigParser — 10 foreign directories — keeps only the config package's OIDC tests", async () => {
    // `internal/config/parser.go:25-29`. `grep -rl NewConfigParser --include=*_test.go`:
    // 13 files in 11 directories, 10 of them foreign; one real caller from each.
    const PARSER = "internal/config/parser.go";
    const OPTS_TEST = "internal/config/options_parsing_test.go";
    const foreign = [
      ["internal/http/client/client_test.go", "configureIntegrationAllowPrivateNetworksOption"],
      [
        "internal/integration/linktaco/linktaco_test.go",
        "configureIntegrationAllowPrivateNetworksOption",
      ],
      [
        "internal/integration/linkwarden/linkwarden_test.go",
        "configureIntegrationAllowPrivateNetworksOption",
      ],
      [
        "internal/integration/readeck/readeck_test.go",
        "configureIntegrationAllowPrivateNetworksOption",
      ],
      [
        "internal/integration/wallabag/wallabag_test.go",
        "configureIntegrationAllowPrivateNetworksOption",
      ],
      [
        "internal/mediaproxy/media_proxy_test.go",
        "TestRewriteDocumentWithRelativeProxyURL_None_Image",
      ],
      ["internal/model/feed_test.go", "TestFeedScheduleNextCheckRoundRobinDefault"],
      [
        "internal/reader/fetcher/request_builder_test.go",
        "configureFetcherAllowPrivateNetworksOption",
      ],
      [REWRITE_TEST, "TestRewriteYoutubeLinkAndCustomEmbedURL"],
      [SANITIZER_TEST, "TestCustomYoutubeEmbedURL"],
    ].map(([file, name], i) => sym(`t-p-${i}`, file, name));
    const own = [
      "TestValidateOIDCProviderRequiresDiscoveryEndpoint",
      "TestValidateOIDCProviderWithDiscoveryEndpoint",
      "TestMetricsUsernameOptionParsing",
    ].map((name, i) => sym(`t-own-${i}`, OPTS_TEST, name, { startLine: 1801 + 20 * i }));
    const { deps: d } = deps({
      requirements: [req("r1", "OIDC provider discovery endpoint")],
      codeMappings: [{ ...fileMap("r1", PARSER, "p-new"), startLine: 25, endLine: 29 }],
      symbols: [
        mod("p-mod", PARSER, 360),
        sym("p-new", PARSER, "NewConfigParser", { startLine: 25, endLine: 29 }),
        ...foreign,
        ...own,
      ],
      edges: [...foreign, ...own].map((t) => calls(t.id, "p-new")),
    });
    // Every foreign caller is setup. Inside a hub the own package's tests are
    // judged by title words too (#905): the two OIDC tests stay, the metrics one,
    // which merely builds a parser, does not.
    expect(await names(d)).toEqual([own[0].name, own[1].name].sort());
  });

  it("SanitizeHTML, tested only from its own package, is not a hub", async () => {
    // `internal/reader/sanitizer/sanitizer.go:165-201`, reached from its own test
    // file only (via the `sanitizeHTMLWithDefaultOptions` helper and two tests).
    const SANITIZER = "internal/reader/sanitizer/sanitizer.go";
    const callers = [
      sym("t-h", SANITIZER_TEST, "sanitizeHTMLWithDefaultOptions", { startLine: 17, endLine: 21 }),
      sym("t-l1", SANITIZER_TEST, "TestLinkWithTarget", { startLine: 510, endLine: 518 }),
      sym("t-l2", SANITIZER_TEST, "TestLinkWithNoTarget", { startLine: 520, endLine: 528 }),
    ];
    const { deps: d } = deps({
      requirements: [req("r1", "Strip unsafe iframe markup")],
      codeMappings: [{ ...fileMap("r1", SANITIZER, "s-fn"), startLine: 165, endLine: 201 }],
      symbols: [
        mod("s-mod", SANITIZER, 700),
        sym("s-fn", SANITIZER, "SanitizeHTML", { startLine: 165, endLine: 201 }),
        ...callers,
      ],
      edges: callers.map((t) => calls(t.id, "s-fn")),
    });
    // No title word is shared, and none is needed.
    const out = await resolve(d);
    expect(out.map((t) => t.name).sort()).toEqual(callers.map((t) => t.name).sort());
    expect(out.every((t) => t.relation === "exercises")).toBe(true);
  });

  it("a conventional sibling test directory (`__tests__/`) is the target's own", async () => {
    const LIB = "src/lib/password.ts";
    const { deps: d } = deps({
      requirements: [req("r1", "Session expiry")],
      codeMappings: [{ ...fileMap("r1", LIB, "pw"), startLine: 1, endLine: 20 }],
      symbols: [
        sym("pw", LIB, "hashPassword", { startLine: 1, endLine: 20 }),
        sym("t-own", "src/lib/__tests__/password.test.ts", "hashCase"),
        sym("t-a", "src/routes/login.test.ts", "loginCase"),
      ],
      edges: [calls("t-own", "pw"), calls("t-a", "pw")],
    });
    // Counted as foreign, `__tests__/` would make two foreign directories and a hub
    // that keeps neither test. As the target's own it leaves one: no hub, both kept.
    expect(await names(d)).toEqual(["hashCase", "loginCase"]);
  });

  it("a two-word title needs only one shared word through a hub (Password length)", async () => {
    const USER_GO = "internal/validator/user.go";
    const { deps: d } = deps({
      requirements: [req("r1", "Password length")],
      codeMappings: [fileMap("r1", USER_GO)],
      symbols: [
        mod("u-mod", USER_GO, 120),
        sym("u-pw", USER_GO, "ValidatePassword", { startLine: 10, endLine: 30 }),
        sym("u-name", USER_GO, "ValidateUsername", { startLine: 40, endLine: 60 }),
        sym("t-ui", "internal/ui/settings_test.go", "TestUpdatePasswordForm"),
        sym("t-api", "internal/api/user_test.go", "TestCreateUser"),
        sym("t-cli", "internal/cli/user_test.go", "TestResetUser"),
      ],
      edges: [calls("t-ui", "u-name"), calls("t-api", "u-name"), calls("t-cli", "u-name")],
    });
    // Three foreign directories make `user.go` a hub; `password` is shared, `length`
    // is not, and the callee `ValidateUsername` shares neither.
    const out = await resolve(d);
    expect(out.map((t) => [t.name, t.relation])).toEqual([["TestUpdatePasswordForm", "exercises"]]);
  });

  it("a flat single `tests/` directory is one foreign directory and never a hub", async () => {
    const LIB = "app/billing.py";
    const callers = ["test_invoice", "test_refund", "test_export"].map((n, i) =>
      sym(`t-py-${i}`, `tests/test_${n.slice(5)}.py`, n),
    );
    const { deps: d } = deps({
      requirements: [req("r1", "Unrelated title words")],
      codeMappings: [fileMap("r1", LIB, "b-fn")],
      symbols: [sym("b-fn", LIB, "charge"), ...callers],
      edges: callers.map((t) => calls(t.id, "b-fn")),
    });
    expect(await names(d)).toEqual(callers.map((t) => t.name).sort());
  });

  it("filters a ranged file-only target by range BEFORE the per-file cap", async () => {
    // Symbols are ordered by startLine, so a cap of 1 applied first would keep only
    // `NewConfigOptions` (line 64); the cited range 829-831 holds the accessor.
    const f = minifluxFixture({ ...fileMap("r1", OPTIONS), startLine: 829, endLine: 831 }, "x");
    f.symbols!.push(
      sym("t-oa", "internal/config/options_parsing_test.go", "TestOAuth2UserCreationOptionParsing"),
    );
    f.edges!.push(calls("t-oa", "o-oauth"));
    const { deps: d } = deps(f, { maxSymbolsPerFile: 1 });
    const out = await resolve(d);
    expect(out.map((t) => [t.name, t.subject?.symbol])).toEqual([
      ["TestOAuth2UserCreationOptionParsing", `${OPTIONS}::IsOAuth2UserCreationAllowed`],
    ]);
  });

  it("a ranged test-file citation past the per-file cap is still a direct link", async () => {
    const T = "internal/reader/icon/finder_test.go";
    const symbols = [
      mod("t-mod", T, 70),
      sym("t-a", T, "TestA", { startLine: 10, endLine: 20 }),
      sym("t-b", T, "TestB", { startLine: 30, endLine: 40 }),
      sym("t-c", T, "TestFindIcon", { startLine: 50, endLine: 60 }),
    ];
    const { deps: d } = deps(
      {
        requirements: [req("r1", "Find the feed icon")],
        codeMappings: [{ ...fileMap("r1", T), startLine: 52, endLine: 58 }],
        symbols,
      },
      { maxSymbolsPerFile: 1 },
    );
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out.map((t) => [t.filePath, t.relation])).toEqual([[T, "direct"]]);
  });
  describe("a test file cited only for its licence header is not a direct link", () => {
    const FINDER_TEST = "internal/reader/icon/finder_test.go";
    // As the parsers produce it: the module symbol, then the test function.
    const symbols = [
      mod("t-fmod", FINDER_TEST, 60),
      sym("t-find", FINDER_TEST, "TestFindIcon", { startLine: 12, endLine: 30 }),
    ];
    const resolve = async (mapping: Mapping, title = "Find the feed icon") => {
      const { deps: d } = deps({
        requirements: [req("r1", title)],
        codeMappings: [mapping],
        symbols,
      });
      return (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    };

    it("drops the seeder's module-bound header row (lines 1-3 bind to the module, 1-EOF)", async () => {
      const header = { ...fileMap("r1", FINDER_TEST, "t-fmod"), startLine: 1, endLine: 60 };
      expect(await resolve(header, "Licensed under the Apache License 2.0")).toEqual([]);
    });

    it("drops a module-bound row with no range", async () => {
      expect(await resolve(fileMap("r1", FINDER_TEST, "t-fmod"))).toEqual([]);
    });

    it("drops a file-level ranged header row although the module symbol overlaps it", async () => {
      const header = { ...fileMap("r1", FINDER_TEST), startLine: 1, endLine: 3 };
      expect(await resolve(header, "Licensed under the Apache License 2.0")).toEqual([]);
    });

    it("keeps the seeder's row for a citation inside the test (bound to TestFindIcon)", async () => {
      const body = { ...fileMap("r1", FINDER_TEST, "t-find"), startLine: 12, endLine: 30 };
      const out = await resolve(body);
      expect(out.map((t) => [t.name, t.relation])).toEqual([["TestFindIcon", "direct"]]);
    });

    it("keeps a file-level or module-bound row whose range covers a real test", async () => {
      const fileLevel = { ...fileMap("r1", FINDER_TEST), startLine: 14, endLine: 20 };
      expect((await resolve(fileLevel)).map((t) => t.relation)).toEqual(["direct"]);
      const narrowed = { ...fileMap("r1", FINDER_TEST, "t-fmod"), startLine: 10, endLine: 40 };
      expect((await resolve(narrowed)).map((t) => [t.filePath, t.relation])).toEqual([
        [FINDER_TEST, "direct"],
      ]);
    });

    it("keeps a module-bound row when the module is the file's only symbol (TS describe/it)", async () => {
      // A TS/JS test file's `it()` callbacks are anonymous, so the parser emits only
      // the module symbol, and the seeder binds every citation of it to the module
      // with the module's span. Nothing tells a header from a test: keep the link.
      const SPEC = "src/lib/__tests__/icon.test.ts";
      const { deps: d } = deps({
        requirements: [req("r1", "Find the feed icon")],
        codeMappings: [{ ...fileMap("r1", SPEC, "ts-mod"), startLine: 1, endLine: 80 }],
        symbols: [mod("ts-mod", SPEC, 80)],
      });
      const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
      expect(out.map((t) => [t.filePath, t.relation])).toEqual([[SPEC, "direct"]]);
    });

    it("keeps a whole-file test mapping with neither a symbol nor a range", async () => {
      expect((await resolve(fileMap("r1", FINDER_TEST))).map((t) => t.relation)).toEqual([
        "direct",
      ]);
      const manual = { ...fileMap("r1", FINDER_TEST), source: "manual" };
      expect((await resolve(manual)).map((t) => t.relation)).toEqual(["direct"]);
    });
  });

  describe("#905 — a document citation of a test file with no range is not a direct link", () => {
    const FINDER_TEST = "internal/reader/icon/finder_test.go";
    const symbols = [
      mod("t-fmod", FINDER_TEST, 60),
      sym("t-find", FINDER_TEST, "TestFindIcon", { startLine: 12, endLine: 30 }),
    ];
    const grounding = (extra: Partial<Mapping> = {}) => ({
      ...fileMap("r1", FINDER_TEST),
      source: "analysis-grounding",
      ...extra,
    });
    const run = async (mapping: Mapping & { source?: string }, syms: Sym[] = symbols) => {
      const { deps: d } = deps({
        requirements: [req("r1", "Find the feed icon")],
        codeMappings: [mapping],
        symbols: syms,
      });
      return (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    };

    it("drops the stored run-3 row: analysis-grounding, no symbol, no range", async () => {
      expect(await run(grounding())).toEqual([]);
    });

    it("drops it even when the file's only symbol is its module (TS describe/it)", async () => {
      const SPEC = "src/lib/__tests__/icon.test.ts";
      const row = { ...grounding(), filePath: SPEC };
      expect(await run(row, [mod("ts-mod", SPEC, 80)])).toEqual([]);
    });

    it("keeps an analysis-grounding row whose range covers a real test", async () => {
      const out = await run(grounding({ startLine: 14, endLine: 20 }));
      expect(out.map((t) => [t.filePath, t.relation])).toEqual([[FINDER_TEST, "direct"]]);
    });

    it("keeps an analysis-grounding row bound to a test symbol", async () => {
      const out = await run(grounding({ codeSymbolId: "t-find", startLine: 12, endLine: 30 }));
      expect(out.map((t) => [t.name, t.relation])).toEqual([["TestFindIcon", "direct"]]);
    });

    it("leaves the requirement in the untested list", async () => {
      const { deps: d } = deps({
        requirements: [req("r1", "Find the feed icon")],
        codeMappings: [grounding()],
        symbols,
      });
      const gaps = await listUntestedRequirements(P, undefined, d);
      expect(gaps).toMatchObject({ total: 1, tested: 0 });
      expect(gaps.untested.map((g) => g.requirementId)).toEqual(["r1"]);
    });
  });

  it("a ranged test-file mapping whose file has no symbols in the graph still links", async () => {
    const { deps: d } = deps({
      requirements: [req("r1", "x")],
      codeMappings: [{ ...fileMap("r1", "pkg/a.test.ts"), startLine: 1, endLine: 2 }],
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out.map((t) => t.relation)).toEqual(["direct"]);
  });
});

describe("resolveTestedBy — a rangeless whole-file mapping (#955, #1004)", () => {
  // Miniflux 2.3.3, #706 run 4: five age-based mark-as-read requirements carry the
  // seeder's `internal/storage/entry.go:` row (analysis-grounding, no symbol, no
  // range), and the only test reaching that file is an unrelated helper's.
  const ENTRY = "internal/storage/entry.go";
  const ENTRY_TEST = "internal/storage/entry_test.go";
  const entrySymbols = [
    sym("e-mod", ENTRY, "entry.go", { kind: "module", qualifiedName: ENTRY, endLine: 900 }),
    sym("e-trunc", ENTRY, "truncateStringForTSVectorField", { startLine: 40, endLine: 70 }),
    sym("e-mark", ENTRY, "MarkAllAsReadBeforeDate", { startLine: 500, endLine: 540 }),
    sym("t-trunc", ENTRY_TEST, "TestTruncateStringForTSVectorField", { startLine: 10 }),
  ];
  const truncCall = {
    projectId: P,
    kind: "calls",
    fromSymbolId: "t-trunc",
    toSymbolId: "e-trunc",
  };
  const wholeFile = { ...fileMap("r1", ENTRY), source: "analysis-grounding" };
  const AGE_TITLE = "Mark entries older than N days as read";
  const resolve = async (f: Fixture) =>
    (await resolveTestedBy(P, ["r1"], { limit: 50 }, deps(f).deps)).get("r1") ?? [];

  it("does not link an own-package helper test through the whole file", async () => {
    const f: Fixture = {
      requirements: [req("r1", AGE_TITLE)],
      codeMappings: [wholeFile],
      symbols: entrySymbols,
      edges: [truncCall],
    };
    expect(await resolve(f)).toEqual([]);
    const gaps = await listUntestedRequirements(P, undefined, deps(f).deps);
    expect(gaps).toMatchObject({
      tested: 0,
      untested: [{ requirementId: "r1", reason: "no-test" }],
    });
  });

  it("does not name-match the helper's own test to the whole file either", async () => {
    // No call edge: `TestTruncateStringForTSVectorField` is named for a symbol of
    // the file, which is not the same as being named for the requirement.
    const out = await resolve({
      requirements: [req("r1", AGE_TITLE)],
      codeMappings: [wholeFile],
      symbols: entrySymbols,
    });
    expect(out).toEqual([]);
  });

  it("keeps a test whose name, or its callee's, is about the requirement", async () => {
    // The #955 true positive, Miniflux's icon finder.
    const FINDER = "internal/reader/icon/finder.go";
    const FINDER_TEST = "internal/reader/icon/finder_test.go";
    const out = await resolve({
      requirements: [req("r1", "Parse base64 image data URLs in icon finder")],
      codeMappings: [fileMap("r1", FINDER)],
      symbols: [
        sym("f-parse", FINDER, "parseImageDataURL", { startLine: 300 }),
        sym("f-other", FINDER, "resizeIcon", { startLine: 100 }),
        sym("t-parse", FINDER_TEST, "TestParseImageDataURL"),
        sym("t-other", FINDER_TEST, "TestResizeIcon", { startLine: 40 }),
      ],
      edges: [
        { projectId: P, kind: "calls", fromSymbolId: "t-parse", toSymbolId: "f-parse" },
        { projectId: P, kind: "calls", fromSymbolId: "t-other", toSymbolId: "f-other" },
      ],
    });
    // TestResizeIcon still shares the token "icon": the weak whole-file `naming`
    // rule (#814) is unchanged, and it is never a strict link.
    expect(out.map((t) => [t.name, t.relation])).toEqual([
      ["TestParseImageDataURL", "exercises"],
      ["TestResizeIcon", "naming"],
    ]);
  });

  it("keeps a callee named for the requirement although its test is not", async () => {
    const out = await resolve({
      requirements: [req("r1", "Mark all as read before a date")],
      codeMappings: [wholeFile],
      symbols: [...entrySymbols, sym("t-x", ENTRY_TEST, "TestStorageScenario", { startLine: 90 })],
      edges: [{ projectId: P, kind: "calls", fromSymbolId: "t-x", toSymbolId: "e-mark" }],
    });
    expect(out.map((t) => [t.name, t.relation])).toEqual([["TestStorageScenario", "exercises"]]);
  });

  it("leaves a ranged or a symbol mapping of the same file alone", async () => {
    const base: Fixture = {
      requirements: [req("r1", AGE_TITLE)],
      symbols: entrySymbols,
      edges: [truncCall],
    };
    for (const mapping of [rangeMap("r1", ENTRY, 40, 70), fileMap("r1", ENTRY, "e-trunc")]) {
      const out = await resolve({ ...base, codeMappings: [mapping] });
      expect(out.map((t) => [t.name, t.relation])).toEqual([
        ["TestTruncateStringForTSVectorField", "exercises"],
      ]);
    }
  });
});

describe("resolveTestedBy — a shared entry point is not evidence (#1108)", () => {
  // Miniflux 2.3.3 `internal/api/api_test.go`: ten tests, five of which build the
  // router with `handler := NewHandler(nil, nil)` — three named for another
  // handler, two for NewHandler itself. The run-7 mapper bound "Feed counters
  // endpoint" and "Mark all as read endpoint response" to `api.go::NewHandler`.
  const API = "internal/api/api.go";
  const API_TEST = "internal/api/api_test.go";
  const routerCallers = [
    "TestGetEntryIDsHandlerRequiresAuthentication",
    "TestGetEntryIDsHandlerRejectsInvalidStarredParam",
    "TestGetEntryIDsHandlerRejectsInvalidStatusParam",
    "TestNewHandlerHandlesOptionsRequests",
    "TestNewHandlerSupportsBasePathStripping",
  ].map((name, i) => sym(`t-api-${i}`, API_TEST, name, { startLine: 16 + 20 * i }));
  const apiSymbols = [
    sym("a-new", API, "NewHandler", { startLine: 20, endLine: 120 }),
    ...routerCallers,
    sym("t-version", API_TEST, "TestVersionHandler", { startLine: 45 }),
  ];
  const callsNewHandler = (fromSymbolId: string) => ({
    projectId: P,
    kind: "calls",
    fromSymbolId,
    toSymbolId: "a-new",
  });
  const routerEdges = routerCallers.map((t) => callsNewHandler(t.id));
  const newHandlerRow = (id: string) => ({
    ...fileMap(id, API, "a-new"),
    startLine: 20,
    endLine: 120,
  });
  const routerFixture = (titles: string[]): Fixture => ({
    requirements: titles.map((t, i) => req(`r${i}`, t)),
    codeMappings: titles.map((_, i) => newHandlerRow(`r${i}`)),
    symbols: [...apiSymbols],
    edges: [...routerEdges],
  });
  const ROUTER_TITLES = ["Feed counters endpoint", "Mark all as read endpoint response"];

  // The config getters the other run-7 requirements map to: one test each.
  const OPTIONS = "internal/config/options.go";
  const OPTIONS_TEST = "internal/config/options_parsing_test.go";
  const getter = (id: string, name: string, startLine: number) =>
    sym(id, OPTIONS, name, { qualifiedName: `${OPTIONS}::configOptions::${name}`, startLine });
  const getterFixture: Fixture = {
    requirements: [
      req("g0", "Metrics endpoint disabled by default"),
      req("g1", "OAuth2 automatic user creation"),
      req("g2", "OIDC provider display name"),
    ],
    codeMappings: [
      fileMap("g0", OPTIONS, "c-metrics"),
      fileMap("g1", OPTIONS, "c-oauth"),
      fileMap("g2", OPTIONS, "c-oidc"),
    ],
    symbols: [
      getter("c-metrics", "HasMetricsCollector", 700),
      getter("c-oauth", "IsOAuth2UserCreationAllowed", 829),
      getter("c-oidc", "OAuth2OIDCProviderName", 850),
      sym("tc-metrics", OPTIONS_TEST, "TestMetricsCollectorOptionParsing", { startLine: 10 }),
      sym("tc-oauth", OPTIONS_TEST, "TestOAuth2UserCreationOptionParsing", { startLine: 30 }),
      sym("tc-oidc", OPTIONS_TEST, "TestOAuth2OIDCProviderNameOptionParsing", { startLine: 50 }),
    ],
    edges: [
      { projectId: P, kind: "calls", fromSymbolId: "tc-metrics", toSymbolId: "c-metrics" },
      { projectId: P, kind: "calls", fromSymbolId: "tc-oauth", toSymbolId: "c-oauth" },
      { projectId: P, kind: "calls", fromSymbolId: "tc-oidc", toSymbolId: "c-oidc" },
    ],
  };
  const all = async (f: Fixture, extra: Partial<TestedByDeps> = {}) =>
    resolveTestedBy(
      P,
      (f.requirements ?? []).map((r) => r.id),
      { limit: 50 },
      deps(f, extra).deps,
    );

  it("reports every NewHandler test of the two run-7 router requirements as entry-point", async () => {
    const out = await all(routerFixture(ROUTER_TITLES));
    for (const id of ["r0", "r1"]) {
      const tests = out.get(id)!;
      expect(tests).toHaveLength(5);
      expect(new Set(tests.map((t) => t.relation))).toEqual(new Set(["entry-point"]));
      expect(tests[0].subject).toEqual({ filePath: API, symbol: `${API}::NewHandler` });
      expect(tests[0].score).toBeLessThanOrEqual(0.4);
    }
  });

  it("lists them as entry-point-only: not tested, and not silently untested", async () => {
    const { deps: d } = deps(routerFixture(ROUTER_TITLES));
    const gaps = await listUntestedRequirements(P, undefined, d);
    expect(gaps.tested).toBe(0);
    expect(gaps.untested.map((g) => [g.requirementId, g.reason])).toEqual([
      ["r0", "entry-point-only"],
      ["r1", "entry-point-only"],
    ]);
  });

  it("keeps the three config-option requirements strictly tested", async () => {
    const out = await all(getterFixture);
    expect(["g0", "g1", "g2"].map((id) => out.get(id)!.map((t) => [t.name, t.relation]))).toEqual([
      [["TestMetricsCollectorOptionParsing", "exercises"]],
      [["TestOAuth2UserCreationOptionParsing", "exercises"]],
      [["TestOAuth2OIDCProviderNameOptionParsing", "exercises"]],
    ]);
    const gaps = await listUntestedRequirements(P, undefined, deps(getterFixture).deps);
    expect(gaps).toMatchObject({ tested: 3, untested: [] });
  });

  it("keeps a test of the entry point whose name is about the requirement", async () => {
    const out = (await all(routerFixture(["Base path stripping"]))).get("r0")!;
    expect(out[0]).toMatchObject({
      name: "TestNewHandlerSupportsBasePathStripping",
      relation: "exercises",
    });
    expect(out.slice(1).every((t) => t.relation === "entry-point")).toBe(true);
  });

  it("demotes a naming match to the entry point the same way", async () => {
    // The two TestNewHandler… tests make no call here: they reach the
    // requirement only by being named for NewHandler, in its sibling test file.
    const f = routerFixture(ROUTER_TITLES);
    f.symbols!.push(
      sym("t-more-0", API_TEST, "TestAlphaRoute", { startLine: 300 }),
      sym("t-more-1", API_TEST, "TestBetaRoute", { startLine: 320 }),
    );
    f.edges = [
      ...routerEdges.slice(0, 3),
      callsNewHandler("t-more-0"),
      callsNewHandler("t-more-1"),
    ];
    const out = (await all(f)).get("r0")!;
    const named = out.filter((t) => t.name.startsWith("TestNewHandler"));
    expect(named.map((t) => t.relation)).toEqual(["entry-point", "entry-point"]);
    expect(out.every((t) => t.relation === "entry-point")).toBe(true);
  });

  it("is an entry point at exactly DEFAULT_TESTED_BY_ENTRY_POINT_MIN_TEST_CALLERS (5) callers", async () => {
    expect(DEFAULT_TESTED_BY_ENTRY_POINT_MIN_TEST_CALLERS).toBe(5);
    const at = (await all(routerFixture(ROUTER_TITLES))).get("r0")!;
    expect(at.every((t) => t.relation === "entry-point")).toBe(true);
    // One more caller required than NewHandler has: every call counts again.
    const above = (await all(routerFixture(ROUTER_TITLES), { entryPointMinTestCallers: 6 })).get(
      "r0",
    )!;
    expect(above.map((t) => t.relation)).toEqual(Array(5).fill("exercises"));
  });

  it("is not one when most of its callers name it, however many there are", async () => {
    // Rename one router test: now three of the five name NewHandler.
    const f = routerFixture(ROUTER_TITLES);
    f.symbols = f.symbols!.map((s) =>
      s.id === "t-api-2" ? { ...s, name: "TestNewHandlerRejectsUnknownRoutes" } : s,
    );
    const out = (await all(f)).get("r0")!;
    expect(out.map((t) => t.relation)).toEqual(Array(5).fill("exercises"));
  });

  it("reads a legacy method name: ScheduleNextCheck stored without its Feed receiver", async () => {
    // A graph ingested before #1071 holds `feed.go::ScheduleNextCheck`; its 11
    // callers are all `TestFeedScheduleNextCheck…`, the method's own tests.
    const FEED = "internal/model/feed.go";
    const FEED_TEST = "internal/model/feed_test.go";
    const callers = Array.from({ length: 11 }, (_, i) =>
      sym(`t-sched-${i}`, FEED_TEST, `TestFeedScheduleNextCheckCase${"ABCDEFGHIJK"[i]}`, {
        startLine: 10 + 20 * i,
      }),
    );
    const out = (
      await all({
        requirements: [req("r0", "Selectable polling scheduler")],
        codeMappings: [fileMap("r0", FEED, "f-sched")],
        symbols: [sym("f-sched", FEED, "ScheduleNextCheck", { startLine: 120 }), ...callers],
        edges: callers.map((c) => ({
          projectId: P,
          kind: "calls",
          fromSymbolId: c.id,
          toSymbolId: "f-sched",
        })),
      })
    ).get("r0")!;
    expect(out).toHaveLength(11);
    expect(out.every((t) => t.relation === "exercises")).toBe(true);
  });
});

describe("listUntestedRequirements", () => {
  const fixture: Fixture = {
    analyses: [
      { id: "an-1", projectId: P },
      { id: "an-x", projectId: "proj-b" },
    ],
    requirements: [
      req("r-pw", "Password must be at least 6 characters"),
      req("r-oidc", "OIDC role mapping"),
      req("r-none", "Unmapped requirement"),
      { ...req("r-del", "Deleted"), deletedAt: new Date() },
      { ...req("r-other-an", "Other analysis"), analysisId: "an-2" },
    ],
    codeMappings: [
      fileMap("r-pw", USER),
      fileMap("r-oidc", "internal/oauth2/oidc.go"),
      fileMap("r-oidc", "internal/oauth2/oidc.go", "o1"),
      fileMap("r-del", "internal/oauth2/oidc.go"),
      fileMap("r-other-an", "internal/oauth2/oidc.go"),
    ],
    symbols: [...validatorSymbols, sym("o1", "internal/oauth2/oidc.go", "mapRoles")],
  };

  it("lists mapped-but-untested requirements, counts unmapped ones, skips deleted", async () => {
    const { deps: d } = deps(fixture);
    const gaps = await listUntestedRequirements(P, { analysisId: "an-1" }, d);
    expect(gaps).toEqual({
      total: 3,
      tested: 1,
      noCode: 1,
      untested: [
        {
          requirementId: "r-oidc",
          title: "OIDC role mapping",
          analysisId: "an-1",
          reason: "no-test",
          mappedFiles: 1,
        },
      ],
      nextCursor: null,
    });
  });

  it("covers every analysis without an analysisId", async () => {
    const { deps: d } = deps(fixture);
    const gaps = await listUntestedRequirements(P, undefined, d);
    expect(gaps.total).toBe(4);
    expect(gaps.untested.map((g) => g.requirementId)).toEqual(["r-oidc", "r-other-an"]);
  });

  it("pages by requirement id", async () => {
    const { deps: d } = deps(fixture);
    const first = await listUntestedRequirements(P, { limit: 1 }, d);
    expect(first.untested.map((g) => g.requirementId)).toEqual(["r-oidc"]);
    expect(first.nextCursor).toBe("r-oidc");
    const second = await listUntestedRequirements(P, { limit: 1, cursor: first.nextCursor! }, d);
    expect(second.untested.map((g) => g.requirementId)).toEqual(["r-other-an"]);
    expect(second.nextCursor).toBeNull();
  });

  it("404s an analysis from another project", async () => {
    const { prisma, deps: d } = deps(fixture);
    await expect(listUntestedRequirements(P, { analysisId: "an-x" }, d)).rejects.toMatchObject({
      statusCode: 404,
      code: "ANALYSIS_NOT_FOUND",
    });
    expect(prisma.requirement.findMany).not.toHaveBeenCalled();
  });
});
