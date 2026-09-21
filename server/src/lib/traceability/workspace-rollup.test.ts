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

const actor = { id: "user-1", role: "member" as const };

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
  function summaryPrisma(opts: {
    links: ReturnType<typeof edge>[];
    projects: Array<{ id: string; name: string }>;
    counts: Record<string, number>;
    spec: Record<string, string[]>;
    code: Record<string, string[]>;
  }) {
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
        count: vi.fn(
          async (a: { where: { projectId: string } }) => opts.counts[a.where.projectId] ?? 0,
        ),
      },
      requirementSpecMapping: {
        findMany: vi.fn(async (a: { where: { projectId: string } }) =>
          (opts.spec[a.where.projectId] ?? []).map((id) => ({ requirementId: id })),
        ),
      },
      requirementCodeMapping: {
        findMany: vi.fn(async (a: { where: { projectId: string } }) =>
          (opts.code[a.where.projectId] ?? []).map((id) => ({ requirementId: id })),
        ),
      },
    };
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
      counts: { projA: 4, projB: 2 },
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
  });

  it("clamps coverage to 1 and scopes the link query to accessible projects", async () => {
    listAccessibleProjectsInWorkspace.mockResolvedValue(["projA"]);
    const prisma = summaryPrisma({
      links: [],
      projects: [{ id: "projA", name: "Alpha" }],
      counts: { projA: 1 },
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

  it("propagates a 404 from the workspace membership assertion (non-member)", async () => {
    listAccessibleProjectsInWorkspace.mockRejectedValue(
      Object.assign(new Error("Workspace not found"), { statusCode: 404 }),
    );
    await expect(
      getWorkspaceTraceabilitySummary(actor, "ws-nope", { prisma: {} as never }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});
