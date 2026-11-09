/**
 * #2115 — cross-project impact through product edges of kind `api`, on a
 * fixture shaped like the #2105 walkthrough's Miniflux pair: miniflux/v2
 * (backend-api) and miniflux/python-client (frontend) with a declared edge
 * python-client → v2 (`api`, `contract`, `consumes`).
 */
import { describe, expect, it, vi } from "vitest";
import type { ImpactAffectedSymbolView, ImpactItemView } from "@metis/shared";

vi.mock("../prisma.js", () => ({ prisma: {} }));

const { apiEdgeImpact, computeApiEdgeImpact, isApiSurfaceFile } =
  await import("./api-edge-impact.js");
type ApiEdgeRow = import("./api-edge-impact.js").ApiEdgeRow;
type ApiEdgeImpactPrisma = import("./api-edge-impact.js").ApiEdgeImpactPrisma;

const V2 = "p-v2";
const CLIENT = "p-client";
const R_V2 = "r-v2";
const R_CLIENT = "r-client";

function sym(
  qualifiedName: string,
  filePath: string,
  confidence: number,
  extra: Partial<ImpactAffectedSymbolView> = {},
): ImpactAffectedSymbolView {
  return {
    id: `s-${qualifiedName}`,
    codeSymbolId: null,
    filePath,
    qualifiedName,
    startLine: null,
    endLine: null,
    relation: "direct",
    depth: 0,
    confidence,
    ...extra,
  };
}

function item(
  id: string,
  projectId: string,
  symbols: ImpactAffectedSymbolView[],
  requirementTitle = "Update Entry API takes more fields",
  requirementId: string | null = null,
): ImpactItemView {
  return {
    id,
    projectId,
    requirementId,
    requirementTitle,
    affectedSymbols: symbols,
  } as unknown as ImpactItemView;
}

function edge(over: Partial<ApiEdgeRow> = {}): ApiEdgeRow {
  return {
    id: "e-declared",
    sourceRepoId: R_CLIENT,
    targetRepoId: R_V2,
    direction: "consumes",
    origin: "declared",
    strength: "contract",
    sourceFile: null,
    targetFile: null,
    evidence: "[]",
    ...over,
  };
}

const repoProject = new Map([
  [R_V2, V2],
  [R_CLIENT, CLIENT],
]);
const projectNames = new Map([
  [V2, "miniflux/v2"],
  [CLIENT, "miniflux/python-client"],
]);

function run(items: ImpactItemView[], edges: ApiEdgeRow[] = [edge()], readable = [V2, CLIENT]) {
  return computeApiEdgeImpact({
    impactAnalysisId: "ia-1",
    items,
    edges,
    repoProject,
    readableProjectIds: new Set(readable),
    projectNames,
  });
}

// miniflux/v2#2846 — the Update Entry API takes more fields.
const apiChangeV2 = item("i-v2-2846", V2, [
  sym("api.(*handler).updateEntry", "internal/api/entry.go", 0.95),
  sym("storage.(*Storage).UpdateEntry", "internal/storage/entry.go", 0.9),
  sym("ui.(*handler).showEntry", "internal/ui/entry.go", 0.4, { depth: 1, relation: "caller" }),
]);
const apiChangeClient = item("i-client-2846", CLIENT, [
  sym("Client::get_entry", "miniflux.py", 0.61, { startLine: 600, endLine: 610 }),
  sym("Client::update_entry", "miniflux.py", 0.97, { startLine: 658, endLine: 685 }),
  sym("Client::update_feed", "miniflux.py", 0.7),
  sym("Client::get_entries", "miniflux.py", 0.5),
]);

// miniflux/v2#4386 — a web-UI paging bug.
const uiTitle = "Pagination breaks on the unread page";
const uiChangeV2 = item(
  "i-v2-4386",
  V2,
  [
    sym("ui.(*handler).showUnreadPage", "internal/ui/unread_entries.go", 0.9),
    sym("ui.getPagination", "internal/ui/pagination.go", 0.88),
    // A caller in the API package is NOT a direct match: the change is the UI's.
    sym("api.(*handler).getEntries", "internal/api/entry.go", 0.3, {
      depth: 1,
      relation: "caller",
    }),
  ],
  uiTitle,
);
const uiChangeClient = item(
  "i-client-4386",
  CLIENT,
  [
    "mark_feed_entries_as_read",
    "mark_category_entries_as_read",
    "mark_user_entries_as_read",
    "flush_history",
    "refresh_feed",
    "delete_feed",
  ].map((m, i) => sym(`Client::${m}`, "miniflux.py", 1 - i * 0.01)),
  uiTitle,
);

describe("isApiSurfaceFile", () => {
  const none = new Set<string>();
  it.each([
    ["internal/api/entry.go", true],
    ["src/API/users.ts", true],
    ["app/graphql/resolvers.ts", true],
    ["docs/openapi.yaml", true],
    ["proto/feeds.proto", true],
    ["schema.graphql", true],
    ["internal/ui/pagination.go", false],
    ["internal/storage/entry.go", false],
    ["rapid/capital.go", false],
    ["api.go", false],
    ["internal\\api\\entry.go", true],
  ])("%s → %s", (path, expected) => {
    expect(isApiSurfaceFile(path, none)).toBe(expected);
  });

  it("counts a file the edge records on the provider's side", () => {
    expect(
      isApiSurfaceFile("internal/http/handlers.go", new Set(["internal/http/handlers.go"])),
    ).toBe(true);
  });
});

describe("computeApiEdgeImpact — the Miniflux pair", () => {
  it("names the client downstream of an API change, with update_entry as its citing method", () => {
    const result = run([apiChangeV2, apiChangeClient]);
    expect(result.untouched).toEqual([]);
    expect(result.consumers).toHaveLength(1);
    const [c] = result.consumers;
    expect(c).toMatchObject({
      edgeId: "e-declared",
      edgeOrigin: "declared",
      edgeStrength: "contract",
      providerProjectId: V2,
      providerProjectName: "miniflux/v2",
      providerItemId: "i-v2-2846",
      changeTitle: "Update Entry API takes more fields",
      consumerProjectId: CLIENT,
      consumerProjectName: "miniflux/python-client",
      apiSurfaceFiles: ["internal/api/entry.go"],
    });
    expect(c.citingMethods.map((m) => m.qualifiedName)).toEqual([
      "Client::update_entry",
      "Client::update_feed",
      "Client::get_entry",
    ]);
    expect(c.citingMethods[0]).toEqual({
      qualifiedName: "Client::update_entry",
      filePath: "miniflux.py",
      startLine: 658,
      endLine: 685,
      confidence: 0.97,
      source: "run",
    });
  });

  it("gives a UI-only change no consumer, and flags the client's matches as untouched", () => {
    const result = run([uiChangeV2, uiChangeClient]);
    expect(result.consumers).toEqual([]);
    expect(result.untouched).toEqual([
      {
        consumerItemId: "i-client-4386",
        consumerProjectId: CLIENT,
        providerProjectId: V2,
        providerProjectName: "miniflux/v2",
        edgeId: "e-declared",
      },
    ]);
  });

  it("pairs each stored requirement with the consumer's item for the same requirement only", () => {
    const req = (i: ImpactItemView, requirementId: string) => ({ ...i, requirementId });
    const result = run([
      req(apiChangeV2, "req-2846"),
      req(apiChangeClient, "req-2846"),
      req(uiChangeV2, "req-4386"),
      req(uiChangeClient, "req-4386"),
    ]);
    expect(result.consumers.map((c) => c.providerItemId)).toEqual(["i-v2-2846"]);
    expect(result.consumers[0].citingMethods[0].qualifiedName).toBe("Client::update_entry");
    expect(result.untouched.map((u) => u.consumerItemId)).toEqual(["i-client-4386"]);
  });

  it("reads a run's text aspects as one request: an aspect off the API flags nothing", () => {
    // The #2105 run split the issue into its title and its "Currently, …" line;
    // only the first matched the API handler.
    const aspect = item(
      "i-v2-2846-b",
      V2,
      [
        sym("model.Entry", "internal/model/entry.go", 0.9),
        sym("storage.(*Storage).UpdateEntry", "internal/storage/entry.go", 0.85),
      ],
      "Currently, the Update Entry endpoint only allows editing the title and content fields.",
    );
    const clientAspect = {
      ...apiChangeClient,
      id: "i-client-2846-b",
      requirementTitle: aspect.requirementTitle,
    };
    const result = run([apiChangeV2, aspect, apiChangeClient, clientAspect]);
    expect(result.untouched).toEqual([]);
    expect(result.consumers.map((c) => c.providerItemId)).toEqual(["i-v2-2846"]);
    // Both aspects' client matches cite the API, best first and each once.
    expect(result.consumers[0].citingMethods.map((m) => m.qualifiedName)).toEqual([
      "Client::update_entry",
      "Client::update_feed",
      "Client::get_entry",
    ]);
  });

  it("pairs changes by requirement id when the run has one", () => {
    const v2 = item("i-v2", V2, apiChangeV2.affectedSymbols, "Title A", "req-1");
    const client = item("i-c", CLIENT, apiChangeClient.affectedSymbols, "Title B", "req-1");
    const other = item("i-c2", CLIENT, apiChangeClient.affectedSymbols, "Title A", "req-2");
    const [c] = run([v2, client, other]).consumers;
    expect(c.citingMethods).toHaveLength(3);
    expect(run([v2, other]).consumers[0].citingMethods).toEqual([]);
  });

  it("leaves a consumer item alone when the provider had no match for its requirement", () => {
    const result = run([
      { ...uiChangeV2, requirementId: "req-4386" },
      { ...uiChangeClient, requirementId: "req-client-only" },
    ]);
    expect(result.untouched).toEqual([]);
    expect(result.consumers).toEqual([]);
  });

  it("does nothing when the provider has no item in the run", () => {
    expect(run([uiChangeClient])).toEqual({
      impactAnalysisId: "ia-1",
      consumers: [],
      untouched: [],
    });
  });
});

describe("computeApiEdgeImpact — the edge", () => {
  it("reads a `provides` edge from the provider's side", () => {
    const provides = edge({ sourceRepoId: R_V2, targetRepoId: R_CLIENT, direction: "provides" });
    expect(run([apiChangeV2, apiChangeClient], [provides]).consumers[0].consumerProjectId).toBe(
      CLIENT,
    );
    // The client is the provider of nothing: its change reaches no one.
    expect(run([apiChangeClient], [provides]).consumers).toEqual([]);
  });

  it("reads a `depends-on` edge as the source calling the target", () => {
    const dep = edge({ direction: "depends-on" });
    expect(run([apiChangeV2], [dep]).consumers[0].consumerProjectId).toBe(CLIENT);
  });

  it("reads an unclassified edge both ways", () => {
    const either = edge({ direction: null, sourceRepoId: R_V2, targetRepoId: R_CLIENT });
    expect(run([apiChangeV2], [either]).consumers[0].consumerProjectId).toBe(CLIENT);
    const clientApi = item("i-c-api", CLIENT, [sym("Client", "client/api/base.py", 0.9)]);
    expect(run([clientApi], [either]).consumers[0].consumerProjectId).toBe(V2);
  });

  it("skips an edge through a resource, an edge within one project, and an unknown repo", () => {
    expect(run([apiChangeV2], [edge({ targetRepoId: null })]).consumers).toEqual([]);
    expect(run([apiChangeV2], [edge({ sourceRepoId: R_V2 })]).consumers).toEqual([]);
    expect(run([apiChangeV2], [edge({ sourceRepoId: "r-gone" })]).consumers).toEqual([]);
    const sameProject = new Map(repoProject).set("r-v2-docs", V2);
    const within = computeApiEdgeImpact({
      impactAnalysisId: "ia-1",
      items: [apiChangeV2],
      edges: [edge({ sourceRepoId: "r-v2-docs" })],
      repoProject: sameProject,
      readableProjectIds: new Set([V2, CLIENT]),
      projectNames,
    });
    expect(within.consumers).toEqual([]);
  });

  it("never names a consumer the caller cannot open", () => {
    expect(run([apiChangeV2], [edge()], [V2]).consumers).toEqual([]);
  });

  it("counts a file the edge records on the provider's side as API surface", () => {
    const handlerChange = item("i-v2-h", V2, [sym("routes", "internal/http/router.go", 0.9)]);
    expect(run([handlerChange]).consumers).toEqual([]);
    const recorded = edge({ targetFile: "internal/http/router.go" });
    expect(run([handlerChange], [recorded]).consumers[0].apiSurfaceFiles).toEqual([
      "internal/http/router.go",
    ]);
  });

  it("ignores a provider symbol of another repo of the same project", () => {
    const otherRepo = item("i-v2-x", V2, [
      sym("api.handler", "internal/api/entry.go", 0.9, { repo: { id: "r-v2-fork", name: "fork" } }),
    ]);
    expect(run([otherRepo]).consumers).toEqual([]);
    const ownRepo = item("i-v2-y", V2, [
      sym("api.handler", "internal/api/entry.go", 0.9, { repo: { id: R_V2, name: "v2" } }),
    ]);
    expect(run([ownRepo]).consumers).toHaveLength(1);
  });

  it("cites the edge's consumer-side evidence when the consumer is not in the run", () => {
    const detected = edge({
      origin: "detected",
      sourceFile: "miniflux.py",
      evidence: JSON.stringify([
        { filePath: "miniflux.py", lineNumber: 660, pattern: "p", matchType: "url_pattern" },
        { filePath: "internal/api/api.go", pattern: "p", matchType: "m", repoConnectionId: R_V2 },
        { filePath: "tests/test_client.py", lineNumber: 12, repoConnectionId: R_CLIENT },
        { filePath: "miniflux.py", lineNumber: 660 },
        { nope: true },
        "junk",
      ]),
    });
    const [c] = run([apiChangeV2], [detected]).consumers;
    expect(c.citingMethods).toEqual([
      {
        qualifiedName: null,
        filePath: "miniflux.py",
        startLine: 660,
        endLine: 660,
        confidence: null,
        source: "edge-evidence",
      },
      {
        qualifiedName: null,
        filePath: "tests/test_client.py",
        startLine: 12,
        endLine: 12,
        confidence: null,
        source: "edge-evidence",
      },
    ]);
  });

  it("caps evidence citations and survives malformed evidence", () => {
    const many = edge({
      evidence: JSON.stringify([1, 2, 3, 4].map((n) => ({ filePath: `c${n}.py`, lineNumber: n }))),
    });
    expect(run([apiChangeV2], [many]).consumers[0].citingMethods).toHaveLength(3);
    expect(run([apiChangeV2], [edge({ evidence: "{" })]).consumers[0].citingMethods).toEqual([]);
    expect(run([apiChangeV2], [edge({ evidence: "{}" })]).consumers[0].citingMethods).toEqual([]);
    const sourceOnly = edge({ sourceFile: "miniflux.py" });
    expect(run([apiChangeV2], [sourceOnly]).consumers[0].citingMethods[0].filePath).toBe(
      "miniflux.py",
    );
  });

  it("lists a consumer once per change, from the declared edge over a detected twin", () => {
    const detected = edge({ id: "a-detected", origin: "detected", strength: null });
    const result = run([apiChangeV2, apiChangeClient], [detected, edge()]);
    expect(result.consumers).toHaveLength(1);
    expect(result.consumers[0].edgeId).toBe("e-declared");
  });

  it("does not flag a consumer item another provider's change reached through its API", () => {
    const R_AUTH = "r-auth";
    const AUTH = "p-auth";
    const authEdge = edge({ id: "e-auth", targetRepoId: R_AUTH });
    const authApi = item("i-auth", AUTH, [sym("api.login", "api/login.go", 0.9)], uiTitle);
    const result = computeApiEdgeImpact({
      impactAnalysisId: "ia-1",
      items: [uiChangeV2, uiChangeClient, authApi],
      edges: [edge(), authEdge],
      repoProject: new Map(repoProject).set(R_AUTH, AUTH),
      readableProjectIds: new Set([V2, CLIENT, AUTH]),
      projectNames,
    });
    expect(result.untouched).toEqual([]);
    expect(result.consumers.map((c) => c.providerProjectName)).toEqual(["p-auth"]);
  });

  it("flags an untouched consumer item once across several providers", () => {
    const R_AUTH = "r-auth";
    const AUTH = "p-auth";
    const authUi = item("i-auth", AUTH, [sym("ui.page", "ui/page.go", 0.9)], uiTitle);
    const result = computeApiEdgeImpact({
      impactAnalysisId: "ia-1",
      items: [uiChangeV2, uiChangeClient, authUi],
      edges: [edge(), edge({ id: "e-auth", targetRepoId: R_AUTH })],
      repoProject: new Map(repoProject).set(R_AUTH, AUTH),
      readableProjectIds: new Set([V2, CLIENT, AUTH]),
      projectNames,
    });
    expect(result.untouched).toHaveLength(1);
    // Edges are walked declared first, then by id: `e-auth` is met first.
    expect(result.untouched[0]).toMatchObject({ edgeId: "e-auth", providerProjectId: AUTH });
  });

  it("sorts consumers by provider, change and consumer", () => {
    const R_WEB = "r-web";
    const WEB = "p-web";
    const result = computeApiEdgeImpact({
      impactAnalysisId: "ia-1",
      items: [apiChangeV2],
      edges: [edge({ id: "e-web", sourceRepoId: R_WEB }), edge()],
      repoProject: new Map(repoProject).set(R_WEB, WEB),
      readableProjectIds: new Set([V2, CLIENT, WEB]),
      projectNames: new Map(projectNames).set(WEB, "a-web"),
    });
    expect(result.consumers.map((c) => c.consumerProjectName)).toEqual([
      "a-web",
      "miniflux/python-client",
    ]);
  });
});

describe("apiEdgeImpact — the loader", () => {
  function fakePrisma(opts: {
    runRepos?: { id: string; projectId: string }[];
    otherRepos?: { id: string; projectId: string }[];
    edges?: ApiEdgeRow[];
  }) {
    const repoFind = vi.fn(async (args: { where: { projectId?: unknown; id?: unknown } }) =>
      args.where.projectId ? (opts.runRepos ?? []) : (opts.otherRepos ?? []),
    );
    const edgeFind = vi.fn(async () => opts.edges ?? []);
    const projectFind = vi.fn(async (args: { where: { id: { in: string[] } } }) =>
      args.where.id.in.map((id) => ({ id, name: projectNames.get(id) ?? id })),
    );
    const prisma = {
      repoConnection: { findMany: repoFind },
      productEdge: { findMany: edgeFind },
      project: { findMany: projectFind },
    } as unknown as ApiEdgeImpactPrisma;
    return { prisma, repoFind, edgeFind, projectFind };
  }

  it("reads the run's repos, the API edges on readable products, and the consumer's name", async () => {
    const { prisma, edgeFind } = fakePrisma({
      runRepos: [{ id: R_V2, projectId: V2 }],
      otherRepos: [{ id: R_CLIENT, projectId: CLIENT }],
      edges: [edge()],
    });
    const readableProjectIds = vi.fn(async (ids: string[]) => ids);
    const productWhere = { workspaceId: "ws-1" };
    const result = await apiEdgeImpact(
      { id: "ia-9", projectIds: [V2], items: [apiChangeV2] },
      { readableProjectIds, productWhere },
      prisma,
    );
    expect(readableProjectIds).toHaveBeenCalledWith([CLIENT]);
    expect(edgeFind).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          integrationKind: "api",
          targetRepoId: { not: null },
          OR: [{ sourceRepoId: { in: [R_V2] } }, { targetRepoId: { in: [R_V2] } }],
          product: productWhere,
        },
      }),
    );
    expect(result.impactAnalysisId).toBe("ia-9");
    expect(result.consumers[0]).toMatchObject({
      consumerProjectId: CLIENT,
      consumerProjectName: "miniflux/python-client",
      citingMethods: [],
    });
  });

  it("omits a consumer outside the run the caller cannot open", async () => {
    const { prisma, projectFind } = fakePrisma({
      runRepos: [{ id: R_V2, projectId: V2 }],
      otherRepos: [{ id: R_CLIENT, projectId: CLIENT }],
      edges: [edge()],
    });
    const result = await apiEdgeImpact(
      { id: "ia-9", projectIds: [V2], items: [apiChangeV2] },
      { readableProjectIds: async () => [] },
      prisma,
    );
    expect(result.consumers).toEqual([]);
    expect(projectFind).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: { in: [V2] } } }),
    );
  });

  it("does not filter by product for an admin, and skips the readability read inside the run", async () => {
    const { prisma, edgeFind, repoFind } = fakePrisma({
      runRepos: [
        { id: R_V2, projectId: V2 },
        { id: R_CLIENT, projectId: CLIENT },
      ],
      edges: [edge()],
    });
    const readableProjectIds = vi.fn(async (ids: string[]) => ids);
    const result = await apiEdgeImpact(
      { id: "ia-9", projectIds: [V2, CLIENT], items: [apiChangeV2, apiChangeClient] },
      { readableProjectIds },
      prisma,
    );
    expect(readableProjectIds).not.toHaveBeenCalled();
    expect(repoFind).toHaveBeenCalledTimes(1);
    const where = (edgeFind.mock.calls[0] as unknown as [{ where: object }])[0].where;
    expect(where).not.toHaveProperty("product");
    expect(result.consumers[0].citingMethods[0].qualifiedName).toBe("Client::update_entry");
  });

  it("returns empty without querying when the run has no item, repo or edge", async () => {
    const access = { readableProjectIds: async (ids: string[]) => ids };
    const none = fakePrisma({});
    expect(
      await apiEdgeImpact({ id: "a", projectIds: [V2], items: [] }, access, none.prisma),
    ).toEqual({ impactAnalysisId: "a", consumers: [], untouched: [] });
    expect(none.repoFind).not.toHaveBeenCalled();

    expect(
      (
        await apiEdgeImpact(
          { id: "a", projectIds: [V2], items: [apiChangeV2] },
          access,
          none.prisma,
        )
      ).consumers,
    ).toEqual([]);
    expect(none.edgeFind).not.toHaveBeenCalled();

    const noEdge = fakePrisma({ runRepos: [{ id: R_V2, projectId: V2 }] });
    await apiEdgeImpact({ id: "a", projectIds: [V2], items: [apiChangeV2] }, access, noEdge.prisma);
    expect(noEdge.projectFind).not.toHaveBeenCalled();
  });
});
