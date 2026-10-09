/**
 * "Tested by" resolver tests — Issue #814.
 *
 * An in-memory fake Prisma that honours exactly the `where` filters the
 * resolver sends (project scope included), so a missing scope or a wrong
 * filter shows up as a wrong answer rather than passing over a stub.
 */
import { describe, expect, it, vi } from "vitest";
import {
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
  edges?: Array<{ projectId: string; kind: string; fromSymbolId: string; toSymbolId: string }>;
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
    return inList(w.id, s.id) && inList(w.filePath, s.filePath);
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
    const { deps: d } = deps({
      requirements: [req("r1", "Password must be at least 6 characters")],
      codeMappings: [fileMap("r1", USER)],
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
      codeMappings: [fileMap("r1", USER)],
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
      codeMappings: [fileMap("r1", "pkg/a.ts")],
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
      codeMappings: [fileMap("r1", USER)],
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
    // requirement, code mappings, spec mappings, spec code, target symbols, edges, siblings.
    expect(totalCalls(one.prisma)).toBe(7);
    expect(totalCalls(many.prisma)).toBe(7);
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
    // One more required directory than Miniflux has: not a hub, all 14 callers count.
    const { deps: above } = deps(minifluxFixture(constructorRow, OAUTH_TITLE), {
      hubMinForeignTestDirs: 3,
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
