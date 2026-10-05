/**
 * "Tested by" resolver tests — Issue #814.
 *
 * An in-memory fake Prisma that honours exactly the `where` filters the
 * resolver sends (project scope included), so a missing scope or a wrong
 * filter shows up as a wrong answer rather than passing over a stub.
 */
import { describe, expect, it, vi } from "vitest";
import {
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
            .map((m) => pick({ startLine: null, endLine: null, ...m }, select)),
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
  const OPTIONS = "internal/config/options.go";
  const optionSymbols = [
    sym("o-new", OPTIONS, "NewConfigOptions", { startLine: 64, endLine: 621 }),
    sym("o-oauth", OPTIONS, "OAuth2UserCreationAllowed", { startLine: 640, endLine: 642 }),
    sym("o-yt", OPTIONS, "YouTubeEmbedUrlOverride", { startLine: 700, endLine: 702 }),
  ];
  // Five sanitizer tests in five files read a YouTube option; one OAuth test reads
  // the OAuth option and builds the config.
  const sanitizerTests = Array.from({ length: 5 }, (_, i) =>
    sym(`t-yt-${i}`, `internal/reader/sanitizer/s${i}_test.go`, `TestRewriteYouTubeIframe${i}`),
  );
  const oauthTest = sym("t-oauth", "internal/oauth2/user_test.go", "TestOAuth2UserCreation");
  const calls = (from: string, to: string) => ({
    projectId: P,
    kind: "calls",
    fromSymbolId: from,
    toSymbolId: to,
  });
  const hubFixture = (mapping: ReturnType<typeof fileMap>, title: string): Fixture => ({
    requirements: [req("r1", title)],
    codeMappings: [mapping],
    symbols: [...optionSymbols, ...sanitizerTests, oauthTest],
    edges: [
      ...sanitizerTests.map((t) => calls(t.id, "o-yt")),
      ...sanitizerTests.map((t) => calls(t.id, "o-new")),
      calls("t-oauth", "o-oauth"),
      calls("t-oauth", "o-new"),
    ],
  });

  it("a file-only mapping onto a config hub links only the tests about the requirement", async () => {
    const { deps: d } = deps(hubFixture(fileMap("r1", OPTIONS), "OAUTH2_USER_CREATION"));
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out.map((t) => t.name)).toEqual(["TestOAuth2UserCreation"]);
  });

  it("a symbol mapping onto a hub constructor drops the unrelated callers", async () => {
    const mapping = { ...fileMap("r1", OPTIONS, "o-new"), startLine: 64, endLine: 621 };
    const { deps: d } = deps(hubFixture(mapping, "OIDC discovery endpoint"));
    // No exercising test is about OIDC, so the requirement stays untested.
    expect((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")).toEqual([]);
  });

  it("keeps a hub link whose CALLEE is named for the requirement", async () => {
    const f = hubFixture(fileMap("r1", OPTIONS), "Allow OAuth2 user creation");
    f.symbols!.push(sym("t-misc", "internal/api/misc_test.go", "TestMisc"));
    f.edges!.push(calls("t-misc", "o-oauth"));
    const { deps: d } = deps(f);
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out.map((t) => t.name).sort()).toEqual(["TestMisc", "TestOAuth2UserCreation"]);
  });

  it("below the hub threshold every exercising test still counts", async () => {
    const { deps: d } = deps(hubFixture(fileMap("r1", OPTIONS), "OAUTH2_USER_CREATION"), {
      hubMinTestFiles: 7,
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    expect(out).toHaveLength(6);
    expect(out.every((t) => t.relation === "exercises")).toBe(true);
  });

  it("a file-only mapping with a line range expands only to the symbols in that range", async () => {
    const mapping = { ...fileMap("r1", OPTIONS), startLine: 630, endLine: 650 };
    const { deps: d } = deps(hubFixture(mapping, "Something unrelated"));
    const out = (await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")!;
    // Only `OAuth2UserCreationAllowed` is in range; one test file exercises it.
    expect(out.map((t) => [t.name, t.subject?.symbol])).toEqual([
      ["TestOAuth2UserCreation", `${OPTIONS}::OAuth2UserCreationAllowed`],
    ]);
  });

  it("a test file cited only for its licence header is not a direct link", async () => {
    const FINDER_TEST = "internal/reader/icon/finder_test.go";
    const symbols = [sym("t-find", FINDER_TEST, "TestFindIcon", { startLine: 12, endLine: 30 })];
    const header = { ...fileMap("r1", FINDER_TEST), startLine: 1, endLine: 3 };
    const { deps: d } = deps({
      requirements: [req("r1", "Licensed under the Apache License 2.0")],
      codeMappings: [header],
      symbols,
    });
    expect((await resolveTestedBy(P, ["r1"], undefined, d)).get("r1")).toEqual([]);

    const body = { ...header, startLine: 14, endLine: 20 };
    const cited = deps({
      requirements: [req("r1", "Find the feed icon")],
      codeMappings: [body],
      symbols,
    });
    const out = (await resolveTestedBy(P, ["r1"], undefined, cited.deps)).get("r1")!;
    expect(out.map((t) => [t.filePath, t.relation])).toEqual([[FINDER_TEST, "direct"]]);
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
