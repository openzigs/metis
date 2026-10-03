/**
 * Unit tests for the workspace traceability rollup — Epic #610 (#626).
 *
 * Focus areas mirror the acceptance criteria: (1) linked-chain STITCHING across
 * `RequirementLink` edges, (2) ACCESS FILTERING — an inaccessible counterpart is
 * surfaced as `restricted` (null chain) and never expanded through, (3) the
 * DEPTH CAP, and (4) the workspace summary's per-project coverage + bounded
 * cross-project link map scoped to accessible projects. The spine's
 * `getRequirementChain` and both access seams are mocked; the service's own
 * composition logic runs against a hand-rolled Prisma mock (no real DB).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const getRequirementChain = vi.fn();
const actorCanAccessProject = vi.fn();
const listAccessibleProjectsInWorkspace = vi.fn();

vi.mock("./traceability-spine.js", () => ({
  getRequirementChain: (...args: unknown[]) => getRequirementChain(...args),
}));
vi.mock("../scheduler/project-access.js", () => ({
  actorCanAccessProject: (...args: unknown[]) => actorCanAccessProject(...args),
  isAdminActor: () => false,
}));
vi.mock("../cross-project/cross-project-access.js", () => ({
  listAccessibleProjectsInWorkspace: (...args: unknown[]) =>
    listAccessibleProjectsInWorkspace(...args),
}));
vi.mock("../prisma.js", () => ({ prisma: {} }));

const { clampLinkDepth, getRequirementChainWithLinks, getWorkspaceTraceabilitySummary } =
  await import("./workspace-rollup.js");
const { MAX_TRACEABILITY_LINK_DEPTH } = await import("@metis/shared");

const actor = { id: "user-1", role: "developer" as const };

function endpoint(id: string, projectId: string) {
  return { id, title: `req ${id}`, projectId, project: { name: `Project ${projectId}` } };
}

function edge(
  id: string,
  type: string,
  srcId: string,
  srcProj: string,
  tgtId: string,
  tgtProj: string,
) {
  return {
    id,
    type,
    sourceRequirementId: srcId,
    targetRequirementId: tgtId,
    source: endpoint(srcId, srcProj),
    target: endpoint(tgtId, tgtProj),
  };
}

/** A findMany that returns edges whose source or target is in the queried frontier. */
function edgeFindMany(all: ReturnType<typeof edge>[]) {
  return vi.fn(async (args: { where: { OR: Array<Record<string, { in: string[] }>> } }) => {
    const ids = new Set<string>();
    for (const clause of args.where.OR) {
      for (const v of Object.values(clause)) for (const id of v.in) ids.add(id);
    }
    return all.filter((e) => ids.has(e.sourceRequirementId) || ids.has(e.targetRequirementId));
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  actorCanAccessProject.mockResolvedValue(true);
  getRequirementChain.mockImplementation(async (projectId: string, requirementId: string) => ({
    requirementId,
    requirementTitle: `req ${requirementId}`,
    projectId,
    specs: [],
    directCode: [],
  }));
});

describe("clampLinkDepth", () => {
  it("defaults to 1 for undefined / non-finite", () => {
    expect(clampLinkDepth(undefined)).toBe(1);
    expect(clampLinkDepth(Number.NaN)).toBe(1);
  });
  it("floors below 1 up to 1 and caps at MAX", () => {
    expect(clampLinkDepth(0)).toBe(1);
    expect(clampLinkDepth(-5)).toBe(1);
    expect(clampLinkDepth(2)).toBe(2);
    expect(clampLinkDepth(999)).toBe(MAX_TRACEABILITY_LINK_DEPTH);
  });
});

describe("getRequirementChainWithLinks", () => {
  it("returns the base chain plus 1-hop linked chains by default", async () => {
    const prisma = {
      requirementLink: {
        findMany: edgeFindMany([
          edge("L1", "relates_to", "R1", "projA", "R2", "projB"),
          edge("L2", "depends_on", "R3", "projC", "R1", "projA"),
        ]),
      },
    };
    const result = await getRequirementChainWithLinks(
      actor,
      "projA",
      "R1",
      {},
      { prisma: prisma as never },
    );

    expect(result.requirementId).toBe("R1");
    expect(result.projectId).toBe("projA");
    expect(result.depth).toBe(1);
    expect(result.linkedChains).toHaveLength(2);
    // Outgoing edge → counterpart R2, incoming edge → counterpart R3.
    const byReq = Object.fromEntries(result.linkedChains.map((l) => [l.link.requirement.id, l]));
    expect(byReq.R2.restricted).toBe(false);
    expect(byReq.R2.chain?.projectId).toBe("projB");
    expect(byReq.R2.link.type).toBe("relates_to");
    expect(byReq.R3.chain?.projectId).toBe("projC");
    // Only one hop was requested → R1 expanded once.
    expect(prisma.requirementLink.findMany).toHaveBeenCalledTimes(1);
  });

  it("#814 — keeps the root chain's testedBy and leaks none through a restricted link", async () => {
    const testNode = { filePath: "a_test.go", symbol: "a_test.go::TestA", relation: "naming" };
    getRequirementChain.mockImplementation(async (projectId: string, requirementId: string) => ({
      requirementId,
      requirementTitle: `req ${requirementId}`,
      projectId,
      specs: [],
      directCode: [],
      testedBy: [{ ...testNode, symbol: `${requirementId}::TestA` }],
    }));
    actorCanAccessProject.mockImplementation(
      async (_a: unknown, projectId: string) => projectId !== "projB",
    );
    const prisma = {
      requirementLink: {
        findMany: edgeFindMany([edge("L1", "relates_to", "R1", "projA", "R2", "projB")]),
      },
    };
    const result = await getRequirementChainWithLinks(
      actor,
      "projA",
      "R1",
      {},
      { prisma: prisma as never },
    );
    expect(result.testedBy).toEqual([{ ...testNode, symbol: "R1::TestA" }]);
    expect(result.linkedChains[0]).toMatchObject({ restricted: true, chain: null });
    expect(getRequirementChain).toHaveBeenCalledTimes(1);
  });

  it("flags an inaccessible counterpart as restricted with a null chain and does not expand it", async () => {
    actorCanAccessProject.mockImplementation(
      async (_a: unknown, projectId: string) => projectId !== "projB",
    );
    const prisma = {
      requirementLink: {
        findMany: edgeFindMany([
          edge("L1", "relates_to", "R1", "projA", "R2", "projB"),
          // R2 would link onward to R9, but R2 is inaccessible so it is never reached.
          edge("L2", "relates_to", "R2", "projB", "R9", "projB"),
        ]),
      },
    };
    const result = await getRequirementChainWithLinks(
      actor,
      "projA",
      "R1",
      { depth: 3 },
      { prisma: prisma as never },
    );
    expect(result.linkedChains).toHaveLength(1);
    const linked = result.linkedChains[0];
    expect(linked.link.requirement.id).toBe("R2");
    expect(linked.restricted).toBe(true);
    expect(linked.chain).toBeNull();
    // getRequirementChain called once for the base R1 only — never for R2/R9.
    expect(getRequirementChain).toHaveBeenCalledTimes(1);
  });

  it("honours the depth cap: a chain of edges is followed exactly `depth` hops", async () => {
    const prisma = {
      requirementLink: {
        findMany: edgeFindMany([
          edge("L1", "relates_to", "R1", "projA", "R2", "projB"),
          edge("L2", "relates_to", "R2", "projB", "R3", "projC"),
          edge("L3", "relates_to", "R3", "projC", "R4", "projD"),
        ]),
      },
    };
    const result = await getRequirementChainWithLinks(
      actor,
      "projA",
      "R1",
      { depth: 2 },
      { prisma: prisma as never },
    );
    const reached = result.linkedChains.map((l) => l.link.requirement.id).sort();
    // depth 2: R1→R2 (hop1), R2→R3 (hop2). R4 is one hop too far.
    expect(reached).toEqual(["R2", "R3"]);
    expect(result.depth).toBe(2);
  });

  it("does not revisit a requirement reached by more than one edge", async () => {
    const prisma = {
      requirementLink: {
        findMany: edgeFindMany([
          edge("L1", "relates_to", "R1", "projA", "R2", "projB"),
          edge("L2", "depends_on", "R1", "projA", "R2", "projB"),
        ]),
      },
    };
    const result = await getRequirementChainWithLinks(
      actor,
      "projA",
      "R1",
      {},
      { prisma: prisma as never },
    );
    expect(result.linkedChains).toHaveLength(1);
    expect(result.linkedChains[0].link.requirement.id).toBe("R2");
  });
});

describe("getWorkspaceTraceabilitySummary", () => {
  type CodeRow = { requirementId: string; filePath: string; codeSymbolId: string | null };
  type Sym = {
    id: string;
    projectId: string;
    name: string;
    qualifiedName: string;
    filePath: string;
    kind: string;
    language: string;
    startLine: number;
  };
  type Where = Record<string, unknown>;
  const inList = (cond: unknown, v: unknown): boolean =>
    cond === undefined ||
    (cond && typeof cond === "object" && "in" in cond
      ? (cond as { in: unknown[] }).in.includes(v)
      : cond === v);

  /**
   * A Prisma double that honours the `projectId` / `in` filters the rollup and
   * the #814 resolver send, so a missing scope shows up as a wrong number.
   * `code` entries that are plain ids map to a file-only, test-less target.
   */
  function summaryPrisma(opts: {
    links: ReturnType<typeof edge>[];
    projects: Array<{ id: string; name: string }>;
    reqs: Record<string, string[]>;
    spec: Record<string, Array<string | { requirementId: string; specDocumentId: string }>>;
    code: Record<string, Array<string | CodeRow>>;
    specCode?: Record<string, Array<CodeRow & { specDocumentId: string }>>;
    symbols?: Sym[];
    edges?: Array<{ projectId: string; kind: string; fromSymbolId: string; toSymbolId: string }>;
  }) {
    const codeRows = (pid: string): CodeRow[] =>
      (opts.code[pid] ?? []).map((c) =>
        typeof c === "string"
          ? { requirementId: c, filePath: `src/${c}.txt`, codeSymbolId: null }
          : c,
      );
    const specRows = (pid: string) =>
      (opts.spec[pid] ?? []).map((c) =>
        typeof c === "string" ? { requirementId: c, specDocumentId: `spec-${c}` } : c,
      );
    const distinctOrRows = <T extends { requirementId: string }>(
      rows: T[],
      a: { distinct?: unknown },
    ) =>
      a.distinct
        ? [...new Set(rows.map((r) => r.requirementId))].map((requirementId) => ({ requirementId }))
        : rows;
    const symbols = opts.symbols ?? [];
    const symWhere = (sym: Sym, w: Where): boolean => {
      if (sym.projectId !== w.projectId) return false;
      if (w.OR)
        return (w.OR as Where[]).some((o) => symWhere(sym, { ...o, projectId: w.projectId }));
      return inList(w.id, sym.id) && inList(w.filePath, sym.filePath);
    };
    return {
      requirementLink: {
        findMany: vi.fn(async () =>
          opts.links.map((e) => ({
            id: e.id,
            type: e.type,
            source: { id: e.sourceRequirementId, projectId: e.source.projectId },
            target: { id: e.targetRequirementId, projectId: e.target.projectId },
          })),
        ),
      },
      project: { findMany: vi.fn(async () => opts.projects) },
      requirement: {
        findMany: vi.fn(async (a: { where: { projectId: string; deletedAt: null } }) =>
          (opts.reqs[a.where.projectId] ?? []).map((id) => ({ id, title: `req ${id}`, body: "" })),
        ),
      },
      requirementSpecMapping: {
        findMany: vi.fn(async (a: { where: Where; distinct?: unknown }) =>
          distinctOrRows(
            specRows(a.where.projectId as string).filter((r) =>
              inList(a.where.requirementId, r.requirementId),
            ),
            a,
          ),
        ),
      },
      specCodeMapping: {
        findMany: vi.fn(async (a: { where: Where }) =>
          (opts.specCode?.[a.where.projectId as string] ?? [])
            .filter((r) => inList(a.where.specDocumentId, r.specDocumentId))
            .map((r) => ({ startLine: null, ...r })),
        ),
      },
      requirementCodeMapping: {
        findMany: vi.fn(async (a: { where: Where; distinct?: unknown }) =>
          distinctOrRows(
            codeRows(a.where.projectId as string)
              .filter((r) => inList(a.where.requirementId, r.requirementId))
              .map((r) => ({ startLine: null, ...r })),
            a,
          ),
        ),
      },
      codeSymbol: {
        findMany: vi.fn(async (a: { where: Where }) => symbols.filter((x) => symWhere(x, a.where))),
      },
      codeEdge: {
        findMany: vi.fn(async (a: { where: Where }) =>
          (opts.edges ?? [])
            .filter(
              (e) =>
                e.projectId === a.where.projectId &&
                inList(a.where.kind, e.kind) &&
                inList(a.where.toSymbolId, e.toSymbolId),
            )
            .map((e) => ({
              toSymbolId: e.toSymbolId,
              fromSymbol: symbols.find(
                (x) => x.id === e.fromSymbolId && x.projectId === e.projectId,
              ),
            })),
        ),
      },
    };
  }

  function totalCalls(p: ReturnType<typeof summaryPrisma>): number {
    return Object.values(p).reduce(
      (n, model) =>
        n +
        Object.values(model).reduce(
          (m, fn) => m + (fn as ReturnType<typeof vi.fn>).mock.calls.length,
          0,
        ),
      0,
    );
  }

  it("returns empty when the caller has no accessible projects", async () => {
    listAccessibleProjectsInWorkspace.mockResolvedValue([]);
    const result = await getWorkspaceTraceabilitySummary(actor, "ws1", {
      prisma: {} as never,
    });
    expect(result).toEqual({ projects: [], crossProjectLinks: [] });
  });

  it("aggregates per-project coverage and the cross-project link map", async () => {
    listAccessibleProjectsInWorkspace.mockResolvedValue(["projA", "projB"]);
    const prisma = summaryPrisma({
      links: [
        edge("L1", "relates_to", "R1", "projA", "R2", "projB"), // cross-project
        edge("L2", "depends_on", "R3", "projA", "R4", "projA"), // same-project → excluded
      ],
      projects: [
        { id: "projA", name: "Alpha" },
        { id: "projB", name: "Beta" },
      ],
      reqs: { projA: ["R1", "R2", "R3", "R4"], projB: ["R2", "R5"] },
      spec: { projA: ["R1", "R3"], projB: ["R2"] },
      code: { projA: ["R1"], projB: [] },
    });
    const result = await getWorkspaceTraceabilitySummary(actor, "ws1", { prisma: prisma as never });

    expect(result.crossProjectLinks).toHaveLength(1);
    expect(result.crossProjectLinks[0]).toMatchObject({
      linkId: "L1",
      type: "relates_to",
      source: { requirementId: "R1", projectId: "projA" },
      target: { requirementId: "R2", projectId: "projB" },
    });

    const alpha = result.projects.find((p) => p.projectId === "projA");
    const beta = result.projects.find((p) => p.projectId === "projB");
    expect(alpha).toMatchObject({
      name: "Alpha",
      requirements: 4,
      linkedCrossProject: 1, // R1
      specCoverage: 0.5, // 2/4
      codeCoverage: 0.25, // 1/4
    });
    expect(beta).toMatchObject({
      name: "Beta",
      requirements: 2,
      linkedCrossProject: 1, // R2
      specCoverage: 0.5, // 1/2
      codeCoverage: 0, // 0/2
    });
    // #815 — R1's file has no test; projB has no mapped code, so no division by zero.
    expect(alpha).toMatchObject({
      codeMappedRequirements: 1,
      testCoverage: 0,
      strictTestCoverage: 0,
    });
    expect(beta).toMatchObject({
      codeMappedRequirements: 0,
      testCoverage: 0,
      strictTestCoverage: 0,
    });
  });

  it("clamps coverage to 1 and scopes the link query to accessible projects", async () => {
    listAccessibleProjectsInWorkspace.mockResolvedValue(["projA"]);
    const prisma = summaryPrisma({
      links: [],
      projects: [{ id: "projA", name: "Alpha" }],
      reqs: { projA: ["R1"] },
      // More distinct mapped requirements than live requirements (soft-deleted
      // rows still carry mappings) → fraction must clamp at 1, never exceed it.
      spec: { projA: ["R1", "R2", "R3"] },
      code: { projA: [] },
    });
    const result = await getWorkspaceTraceabilitySummary(actor, "ws1", { prisma: prisma as never });
    expect(result.projects[0].specCoverage).toBe(1);
    // The cross-project link query is bounded to the accessible project set.
    expect(prisma.requirementLink.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          source: { projectId: { in: ["projA"] } },
          target: { projectId: { in: ["projA"] } },
        },
      }),
    );
  });

  describe("#815 — tested coverage", () => {
    const sym = (id: string, filePath: string, name: string, projectId = "projA"): Sym => ({
      id,
      projectId,
      name,
      qualifiedName: `${filePath}::${name}`,
      filePath,
      kind: "function",
      language: filePath.endsWith(".go") ? "go" : "ts",
      startLine: 1,
    });
    const row = (requirementId: string, filePath: string, codeSymbolId: string | null = null) => ({
      requirementId,
      filePath,
      codeSymbolId,
    });
    /**
     * R1 exercised (calls edge), R2 named only (Go sibling test), R3 exercised via
     * a spec, R4 mapped with no test, R5 no code, R6 mapped straight to a test
     * file (direct). R9 is soft-deleted but still has a mapping row.
     */
    const fixture = (
      projectIds: string[] = ["projA"],
      reqs = ["R1", "R2", "R3", "R4", "R5", "R6"],
    ) => ({
      links: [],
      projects: projectIds.map((id) => ({ id, name: id })),
      reqs: Object.fromEntries(projectIds.map((p) => [p, reqs])),
      spec: { projA: [{ requirementId: "R3", specDocumentId: "S1" }] },
      specCode: { projA: [{ specDocumentId: "S1", ...row("", "src/d.ts", "s-d") }] },
      code: {
        projA: [
          row("R1", "src/a.ts", "s-a"),
          row("R2", "pkg/user.go"),
          row("R4", "src/e.ts"),
          row("R6", "src/f.test.ts"),
          row("R9", "src/a.ts", "s-a"),
          // Extra requirements (`X…`) map to the exercised symbol, to grow N.
          ...reqs.filter((r) => r.startsWith("X")).map((r) => row(r, "src/a.ts", "s-a")),
        ],
      },
      symbols: [
        sym("s-a", "src/a.ts", "login"),
        sym("t-a", "src/a.test.ts", "login works"),
        sym("v-pw", "pkg/user.go", "validatePassword"),
        sym("t-pw", "pkg/user_test.go", "TestValidatePassword"),
        sym("s-d", "src/d.ts", "exportCsv"),
        sym("t-d", "src/d.test.ts", "exports csv"),
        // Another project's test with an edge into projA's symbol id — must not count.
        sym("t-x", "src/e.test.ts", "leaks", "projB"),
      ],
      edges: [
        { projectId: "projA", kind: "calls", fromSymbolId: "t-a", toSymbolId: "s-a" },
        { projectId: "projA", kind: "references", fromSymbolId: "t-d", toSymbolId: "s-d" },
        { projectId: "projB", kind: "calls", fromSymbolId: "t-x", toSymbolId: "s-a" },
      ],
    });

    it("reports test coverage over code-mapped requirements, strict excluding naming", async () => {
      listAccessibleProjectsInWorkspace.mockResolvedValue(["projA"]);
      const prisma = summaryPrisma(fixture());
      const result = await getWorkspaceTraceabilitySummary(actor, "ws1", {
        prisma: prisma as never,
      });
      expect(result.projects[0]).toMatchObject({
        requirements: 6,
        codeMappedRequirements: 5, // R1 R2 R3 R4 R6 — not R5 (no code), not R9 (deleted)
        testCoverage: 0.8, // R1 R2 R3 R6
        strictTestCoverage: 0.6, // R1 R3 R6 — R2 is naming only
      });
      // Every resolver query is confined to the project.
      for (const model of [
        "requirement",
        "requirementCodeMapping",
        "codeSymbol",
        "codeEdge",
      ] as const) {
        for (const [arg] of prisma[model].findMany.mock.calls) {
          expect((arg as { where: { projectId: string } }).where.projectId).toBe("projA");
        }
      }
      expect(prisma.requirement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { projectId: "projA", deletedAt: null } }),
      );
    });

    it("reports 1, not more, when every code-mapped requirement is tested", async () => {
      listAccessibleProjectsInWorkspace.mockResolvedValue(["projA"]);
      const result = await getWorkspaceTraceabilitySummary(actor, "ws1", {
        prisma: summaryPrisma({ ...fixture(), reqs: { projA: ["R6"] } }) as never,
      });
      expect(result.projects[0]).toMatchObject({
        codeMappedRequirements: 1,
        testCoverage: 1,
        strictTestCoverage: 1,
      });
    });

    it("issues a constant number of queries per project, whatever the requirement count", async () => {
      const calls = async (projectIds: string[], reqs: string[]) => {
        listAccessibleProjectsInWorkspace.mockResolvedValue(projectIds);
        const prisma = summaryPrisma(fixture(projectIds, reqs));
        await getWorkspaceTraceabilitySummary(actor, "ws1", { prisma: prisma as never });
        return totalCalls(prisma);
      };
      const six = ["R1", "R2", "R3", "R4", "R5", "R6"];
      const many = [...six, ...Array.from({ length: 200 }, (_, i) => `X${i}`)];
      const one = await calls(["projA"], six);
      expect(await calls(["projA"], many)).toBe(one);
      const two = await calls(["projA", "projB"], many);
      const three = await calls(["projA", "projB", "projC"], many);
      // Linear in projects: link + project lookups once, then the same per-project constant.
      expect(three - two).toBeLessThanOrEqual(9);
      expect(two - one).toBeLessThanOrEqual(9);
      expect(one).toBeLessThanOrEqual(2 + 9);
    });
  });

  it("propagates a 404 from the workspace membership assertion (non-member)", async () => {
    listAccessibleProjectsInWorkspace.mockRejectedValue(
      Object.assign(new Error("Workspace not found"), { statusCode: 404 }),
    );
    await expect(
      getWorkspaceTraceabilitySummary(actor, "ws-nope", { prisma: {} as never }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
