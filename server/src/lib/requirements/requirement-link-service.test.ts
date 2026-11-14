/**
 * Unit tests for the requirement-link service — Epic #610 (#624).
 *
 * The security-critical concern is DUAL-PROJECT authz: create/delete must deny
 * when EITHER endpoint's project is inaccessible, and workspace search must not
 * surface requirements outside the caller's accessible project set. These tests
 * mock the shared per-project / per-workspace access mechanisms (asserting they
 * are consulted for BOTH endpoints) and drive the service's own logic against a
 * hand-rolled Prisma mock — no real DB (the #289 lesson).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// #2491 — the source filter is pinned over a real database in
// tests/source-redaction-2491.sqlite.test.ts; here nothing is restricted unless
// a test says which ids are.
const hiddenIds = vi.hoisted(() => ({ ids: new Set<string>() }));
vi.mock("../analysis/source-redaction.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../analysis/source-redaction.js")>()),
  restrictedIds: async (_reader: unknown, rows: Array<{ id: string }>) =>
    new Set(rows.map((r) => r.id).filter((id) => hiddenIds.ids.has(id))),
  restrictedRequirementIds: async (_reader: unknown, ids: Iterable<string>) =>
    new Set([...ids].filter((id) => hiddenIds.ids.has(id))),
}));

const actorHasProjectAccess = vi.fn();
const listMemberProjectsInWorkspace = vi.fn();
const audit = vi.fn();

vi.mock("../scheduler/project-access.js", () => ({
  actorHasProjectAccess: (...args: unknown[]) => actorHasProjectAccess(...args),
  isAdminActor: () => false,
}));
vi.mock("../cross-project/cross-project-access.js", () => ({
  listMemberProjectsInWorkspace: (...args: unknown[]) => listMemberProjectsInWorkspace(...args),
}));
vi.mock("../audit/audit-service.js", () => ({ audit: (...args: unknown[]) => audit(...args) }));

// Default Prisma client the service falls back to when a caller omits `db`.
const resolveDatabaseProviderMock = vi.fn<() => "sqlite" | "postgresql">(() => "sqlite");
const defaultPrismaMock = {
  requirement: { count: vi.fn(), findMany: vi.fn() },
  $queryRaw: vi.fn(),
};
vi.mock("../prisma.js", () => ({
  prisma: defaultPrismaMock,
  // Runtime adapter-scheme selector (`prisma.ts`) — drives the Postgres-only
  // case-insensitive search branch. Defaults to sqlite so the existing builder
  // path is exercised unless a test opts into Postgres.
  resolveDatabaseProvider: (...a: unknown[]) => resolveDatabaseProviderMock(...(a as [])),
  // Minimal `Prisma` tagged-template + join stubs: capture the SQL fragments and
  // bound values so a test can assert the Postgres path builds an ILIKE query
  // with the search term as a bound parameter (never interpolated).
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({ strings, values }),
    join: (values: unknown[]) => ({ __join: values }),
  },
}));

const { AppError } = await import("../../middleware/error-handler.js");
const {
  createRequirementLink,
  deleteRequirementLink,
  listRequirementLinks,
  searchWorkspaceRequirements,
  SEARCH_SCAN_BATCH,
  SEARCH_SCAN_CAP,
} = await import("./requirement-link-service.js");

const actor = { id: "user-1", role: "developer" as const };

function reqRow(id: string, projectId: string, workspaceId: string | null, title = `req ${id}`) {
  return {
    id,
    title,
    projectId,
    project: { id: projectId, name: `Project ${projectId}`, workspaceId },
  };
}

function createMockDb() {
  return {
    requirement: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      count: vi.fn(),
    },
    requirementLink: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      delete: vi.fn(),
    },
    $queryRaw: vi.fn(),
  };
}

type MockDb = ReturnType<typeof createMockDb>;

beforeEach(() => {
  vi.clearAllMocks();
  actorHasProjectAccess.mockResolvedValue(true);
  resolveDatabaseProviderMock.mockReturnValue("sqlite");
});

describe("createRequirementLink", () => {
  let db: MockDb;
  beforeEach(() => {
    db = createMockDb();
    db.requirement.findMany.mockResolvedValue([
      reqRow("src", "projA", "ws1"),
      reqRow("tgt", "projB", "ws1"),
    ]);
    db.requirementLink.findUnique.mockResolvedValue(null);
    db.requirementLink.findMany.mockResolvedValue([]);
    db.requirementLink.create.mockResolvedValue({
      id: "link-1",
      type: "relates_to",
      createdAt: new Date("2026-01-01"),
      sourceRequirementId: "src",
      targetRequirementId: "tgt",
    });
  });

  it("rejects a self-link (400 SELF_LINK)", async () => {
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "same",
        targetRequirementId: "same",
        type: "relates_to",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "SELF_LINK" });
    expect(db.requirement.findMany).not.toHaveBeenCalled();
  });

  it("rejects an unknown link type (400 INVALID_LINK_TYPE)", async () => {
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "bogus",
      }),
    ).rejects.toMatchObject({ statusCode: 400, code: "INVALID_LINK_TYPE" });
  });

  it("404s when either requirement is missing", async () => {
    db.requirement.findMany.mockResolvedValue([reqRow("src", "projA", "ws1")]);
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).rejects.toMatchObject({ statusCode: 404, code: "REQUIREMENT_NOT_FOUND" });
  });

  it("answers 404 REQUIREMENT_NOT_FOUND (not 403) when the SOURCE project is inaccessible (#1236)", async () => {
    actorHasProjectAccess.mockImplementation(
      async (_a, projectId: string) => projectId !== "projA",
    );
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "REQUIREMENT_NOT_FOUND",
      message: "Source or target requirement not found",
    });
    expect(db.requirementLink.create).not.toHaveBeenCalled();
  });

  it("answers 404 REQUIREMENT_NOT_FOUND (not 403) when the TARGET project is inaccessible (#1236)", async () => {
    actorHasProjectAccess.mockImplementation(
      async (_a, projectId: string) => projectId !== "projB",
    );
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: "REQUIREMENT_NOT_FOUND",
      message: "Source or target requirement not found",
    });
    expect(db.requirementLink.create).not.toHaveBeenCalled();
  });

  it("checks BOTH endpoints' projects", async () => {
    await createRequirementLink(db as never, actor, {
      sourceRequirementId: "src",
      targetRequirementId: "tgt",
      type: "relates_to",
    });
    const checked = actorHasProjectAccess.mock.calls.map((c) => c[1]);
    expect(checked).toContain("projA");
    expect(checked).toContain("projB");
  });

  it("rejects a cross-workspace link (409 CROSS_WORKSPACE_LINK)", async () => {
    db.requirement.findMany.mockResolvedValue([
      reqRow("src", "projA", "ws1"),
      reqRow("tgt", "projB", "ws2"),
    ]);
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CROSS_WORKSPACE_LINK" });
  });

  it("rejects a null-workspace cross-project link", async () => {
    db.requirement.findMany.mockResolvedValue([
      reqRow("src", "projA", null),
      reqRow("tgt", "projB", null),
    ]);
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "CROSS_WORKSPACE_LINK" });
  });

  it("allows a same-project link even with a null workspace", async () => {
    db.requirement.findMany.mockResolvedValue([
      reqRow("src", "projA", null),
      reqRow("tgt", "projA", null),
    ]);
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).resolves.toMatchObject({ id: "link-1" });
  });

  it("rejects a depends_on link that would close a cycle (409 DEPENDENCY_CYCLE)", async () => {
    // target already depends_on src: tgt -> src. Adding src -> tgt closes it.
    db.requirementLink.findMany.mockImplementation(
      async (args: { where: { sourceRequirementId: { in: string[] } } }) => {
        if (args.where.sourceRequirementId.in.includes("tgt")) {
          return [{ targetRequirementId: "src" }];
        }
        return [];
      },
    );
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "depends_on",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DEPENDENCY_CYCLE" });
    expect(db.requirementLink.create).not.toHaveBeenCalled();
  });

  it("allows a depends_on link with no cycle (transitive walk terminates)", async () => {
    // tgt -> other -> (nothing). No path back to src.
    db.requirementLink.findMany.mockImplementation(
      async (args: { where: { sourceRequirementId: { in: string[] } } }) => {
        if (args.where.sourceRequirementId.in.includes("tgt"))
          return [{ targetRequirementId: "other" }];
        return [];
      },
    );
    db.requirementLink.create.mockResolvedValue({
      id: "link-2",
      type: "depends_on",
      createdAt: new Date(),
      sourceRequirementId: "src",
      targetRequirementId: "tgt",
    });
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "depends_on",
      }),
    ).resolves.toMatchObject({ id: "link-2", type: "depends_on" });
  });

  it("rejects a duplicate link (409 DUPLICATE_LINK)", async () => {
    db.requirementLink.findUnique.mockResolvedValue({ id: "existing" });
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DUPLICATE_LINK" });
  });

  it("maps a racing insert's Prisma P2002 to 409 DUPLICATE_LINK (not 500)", async () => {
    // findUnique sees no existing row (the check passes), but a concurrent
    // create wins the race and the DB unique constraint fires on our insert.
    db.requirementLink.findUnique.mockResolvedValue(null);
    db.requirementLink.create.mockRejectedValue(
      Object.assign(new Error("Unique constraint failed"), { code: "P2002" }),
    );
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).rejects.toMatchObject({ statusCode: 409, code: "DUPLICATE_LINK" });
  });

  it("rethrows a non-unique create error unchanged", async () => {
    db.requirementLink.findUnique.mockResolvedValue(null);
    db.requirementLink.create.mockRejectedValue(new Error("db connection lost"));
    await expect(
      createRequirementLink(db as never, actor, {
        sourceRequirementId: "src",
        targetRequirementId: "tgt",
        type: "relates_to",
      }),
    ).rejects.toThrow("db connection lost");
  });

  it("creates the link, writes an audit row, and returns target context", async () => {
    const result = await createRequirementLink(db as never, actor, {
      sourceRequirementId: "src",
      targetRequirementId: "tgt",
      type: "relates_to",
    });
    expect(db.requirementLink.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ createdById: "user-1", type: "relates_to" }),
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "requirement.link.create" }),
    );
    expect(result.requirement).toMatchObject({
      id: "tgt",
      projectId: "projB",
      projectName: "Project projB",
    });
  });
});

describe("deleteRequirementLink", () => {
  let db: MockDb;
  beforeEach(() => {
    db = createMockDb();
    db.requirementLink.findUnique.mockResolvedValue({
      id: "link-1",
      type: "relates_to",
      sourceRequirementId: "src",
      targetRequirementId: "tgt",
      source: { projectId: "projA" },
      target: { projectId: "projB" },
    });
  });

  it("404s when the link is missing", async () => {
    db.requirementLink.findUnique.mockResolvedValue(null);
    await expect(deleteRequirementLink(db as never, actor, "nope")).rejects.toMatchObject({
      statusCode: 404,
      code: "LINK_NOT_FOUND",
    });
  });

  // #649: an unauthorized caller must get the SAME 404 for an inaccessible link
  // as for a non-existent one — the old 403-vs-404 split was an existence oracle
  // over the (server-generated) id space.
  it("returns 404 LINK_NOT_FOUND (not 403) when the source project is inaccessible", async () => {
    actorHasProjectAccess.mockImplementation(
      async (_a, projectId: string) => projectId !== "projA",
    );
    await expect(deleteRequirementLink(db as never, actor, "link-1")).rejects.toMatchObject({
      statusCode: 404,
      code: "LINK_NOT_FOUND",
    });
    expect(db.requirementLink.delete).not.toHaveBeenCalled();
  });

  it("returns 404 LINK_NOT_FOUND (not 403) when the target project is inaccessible", async () => {
    actorHasProjectAccess.mockImplementation(
      async (_a, projectId: string) => projectId !== "projB",
    );
    await expect(deleteRequirementLink(db as never, actor, "link-1")).rejects.toMatchObject({
      statusCode: 404,
      code: "LINK_NOT_FOUND",
    });
    expect(db.requirementLink.delete).not.toHaveBeenCalled();
  });

  it("gives an INDISTINGUISHABLE response for a missing id vs an inaccessible id", async () => {
    db.requirementLink.findUnique.mockResolvedValueOnce(null);
    const missing = await deleteRequirementLink(db as never, actor, "nope").catch((e) => e);
    db.requirementLink.findUnique.mockResolvedValueOnce({
      id: "link-1",
      type: "relates_to",
      sourceRequirementId: "src",
      targetRequirementId: "tgt",
      source: { projectId: "projA" },
      target: { projectId: "projB" },
    });
    actorHasProjectAccess.mockResolvedValue(false);
    const denied = await deleteRequirementLink(db as never, actor, "link-1").catch((e) => e);
    expect(denied.statusCode).toBe(missing.statusCode);
    expect(denied.code).toBe(missing.code);
    expect(denied.message).toBe(missing.message);
  });

  it("propagates a non-authz error from the access check unchanged (not masked as 404)", async () => {
    actorHasProjectAccess.mockRejectedValue(new Error("db connection lost"));
    await expect(deleteRequirementLink(db as never, actor, "link-1")).rejects.toThrow(
      "db connection lost",
    );
    expect(db.requirementLink.delete).not.toHaveBeenCalled();
  });

  it("deletes and audits when both projects are accessible", async () => {
    await deleteRequirementLink(db as never, actor, "link-1");
    expect(db.requirementLink.delete).toHaveBeenCalledWith({ where: { id: "link-1" } });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ action: "requirement.link.delete" }),
    );
  });
});

describe("listRequirementLinks", () => {
  let db: MockDb;
  beforeEach(() => {
    db = createMockDb();
    db.requirement.findUnique.mockResolvedValue({ id: "req", projectId: "projA", deletedAt: null });
    db.requirementLink.findMany.mockResolvedValue([]);
  });

  it("404s for a missing or soft-deleted requirement", async () => {
    db.requirement.findUnique.mockResolvedValue({
      id: "req",
      projectId: "projA",
      deletedAt: new Date(),
    });
    await expect(listRequirementLinks(db as never, actor, "req")).rejects.toMatchObject({
      statusCode: 404,
      code: "REQUIREMENT_NOT_FOUND",
    });
  });

  // #649: same existence-oracle fix as delete — an inaccessible requirement and a
  // missing one must be indistinguishable on this direct-by-id read.
  it("returns 404 REQUIREMENT_NOT_FOUND (not 403) when the requirement's own project is inaccessible", async () => {
    actorHasProjectAccess.mockResolvedValue(false);
    await expect(listRequirementLinks(db as never, actor, "req")).rejects.toMatchObject({
      statusCode: 404,
      code: "REQUIREMENT_NOT_FOUND",
    });
  });

  it("gives an INDISTINGUISHABLE response for a missing requirement vs an inaccessible one", async () => {
    db.requirement.findUnique.mockResolvedValueOnce(null);
    const missing = await listRequirementLinks(db as never, actor, "gone").catch((e) => e);
    db.requirement.findUnique.mockResolvedValueOnce({
      id: "req",
      projectId: "projA",
      deletedAt: null,
    });
    actorHasProjectAccess.mockResolvedValue(false);
    const denied = await listRequirementLinks(db as never, actor, "req").catch((e) => e);
    expect(denied.statusCode).toBe(missing.statusCode);
    expect(denied.code).toBe(missing.code);
    expect(denied.message).toBe(missing.message);
  });

  it("propagates a non-authz error from the access check unchanged (not masked as 404)", async () => {
    actorHasProjectAccess.mockRejectedValue(new Error("db connection lost"));
    await expect(listRequirementLinks(db as never, actor, "req")).rejects.toThrow(
      "db connection lost",
    );
  });

  it("returns outgoing + incoming links with counterpart context", async () => {
    db.requirementLink.findMany.mockImplementation(
      async (args: { where: Record<string, string> }) => {
        if ("sourceRequirementId" in args.where) {
          return [
            {
              id: "out-1",
              type: "relates_to",
              createdAt: new Date(),
              sourceRequirementId: "req",
              targetRequirementId: "tgt",
              target: reqRow("tgt", "projB", "ws1"),
            },
          ];
        }
        return [
          {
            id: "in-1",
            type: "depends_on",
            createdAt: new Date(),
            sourceRequirementId: "prev",
            targetRequirementId: "req",
            source: reqRow("prev", "projC", "ws1"),
          },
        ];
      },
    );
    const result = await listRequirementLinks(db as never, actor, "req");
    expect(result.outgoing).toHaveLength(1);
    expect(result.outgoing[0].requirement).toMatchObject({ id: "tgt", projectId: "projB" });
    expect(result.incoming).toHaveLength(1);
    expect(result.incoming[0].requirement).toMatchObject({ id: "prev", projectId: "projC" });
  });

  it("omits links whose counterpart project the caller cannot access (no leak)", async () => {
    // Own project projA accessible; counterpart projB is NOT.
    actorHasProjectAccess.mockImplementation(
      async (_a, projectId: string) => projectId === "projA",
    );
    db.requirementLink.findMany.mockImplementation(
      async (args: { where: Record<string, string> }) => {
        if ("sourceRequirementId" in args.where) {
          return [
            {
              id: "out-1",
              type: "relates_to",
              createdAt: new Date(),
              sourceRequirementId: "req",
              targetRequirementId: "tgt",
              target: reqRow("tgt", "projB", "ws1"),
            },
          ];
        }
        return [];
      },
    );
    const result = await listRequirementLinks(db as never, actor, "req");
    expect(result.outgoing).toHaveLength(0);
  });
});

describe("searchWorkspaceRequirements", () => {
  let db: MockDb;
  beforeEach(() => {
    db = createMockDb();
    listMemberProjectsInWorkspace.mockResolvedValue(["projA", "projB"]);
    db.requirement.findMany.mockResolvedValue([
      {
        id: "r1",
        title: "Login",
        projectId: "projA",
        project: { name: "Project A" },
        analysisId: "a",
        sourceIds: null,
      },
    ]);
  });

  it("propagates the 404 when the workspace is not accessible", async () => {
    listMemberProjectsInWorkspace.mockRejectedValue(
      new AppError(404, "NOT_FOUND", "Workspace not found"),
    );
    await expect(
      searchWorkspaceRequirements(
        actor,
        { workspaceId: "ws-x", page: 1, pageSize: 20 },
        db as never,
      ),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(db.requirement.findMany).not.toHaveBeenCalled();
  });

  it("returns an empty page when no accessible projects remain", async () => {
    listMemberProjectsInWorkspace.mockResolvedValue(["projA"]);
    const result = await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", excludeProjectId: "projA", page: 1, pageSize: 20 },
      db as never,
    );
    expect(result).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
    expect(db.requirement.findMany).not.toHaveBeenCalled();
  });

  it("scopes the query to accessible projects, excludes soft-deleted, and paginates", async () => {
    const result = await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", query: "log", page: 1, pageSize: 10 },
      db as never,
    );
    const callArgs = db.requirement.findMany.mock.calls[0][0];
    expect(callArgs.where.projectId).toEqual({ in: ["projA", "projB"] });
    expect(callArgs.where.deletedAt).toBeNull();
    expect(callArgs.where.title).toEqual({ contains: "log" });
    expect(callArgs.skip).toBe(0);
    expect(callArgs.orderBy).toEqual([{ title: "asc" }, { id: "asc" }]);
    expect(result.items).toEqual([
      { id: "r1", title: "Login", projectId: "projA", projectName: "Project A" },
    ]);
    expect(result.total).toBe(1);
  });

  it("cuts page 2 from the visible matches", async () => {
    const rows = Array.from({ length: 15 }, (_, i) => ({
      id: `r${String(i).padStart(2, "0")}`,
      title: `t${String(i).padStart(2, "0")}`,
      projectId: "projA",
      project: { name: "Project A" },
      analysisId: "a",
      sourceIds: null,
    }));
    db.requirement.findMany.mockImplementation(async (args: { skip: number; take: number }) =>
      rows.slice(args.skip, args.skip + args.take),
    );
    const result = await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", query: "t", page: 2, pageSize: 10 },
      db as never,
    );
    expect(result.items.map((i) => i.id)).toEqual(rows.slice(10).map((r) => r.id));
    expect(result).toMatchObject({ page: 2, pageSize: 10, total: 15 });
  });

  it("uses a case-insensitive ILIKE query on the Postgres adapter path (mixed-case term)", async () => {
    resolveDatabaseProviderMock.mockReturnValue("postgresql");
    const queryRaw = db.$queryRaw as ReturnType<typeof vi.fn>;
    queryRaw.mockResolvedValueOnce([
      {
        id: "r1",
        title: "Login",
        projectId: "projA",
        projectName: "Project A",
        analysisId: "a",
        sourceIds: null,
      },
    ]);
    const result = await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", query: "LOGIN", page: 1, pageSize: 10 },
      db as never,
    );
    // Postgres takes the raw ILIKE branch — the Prisma builder is NOT used.
    expect(db.requirement.findMany).not.toHaveBeenCalled();
    expect(db.requirement.count).not.toHaveBeenCalled();
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const pageSql = (queryRaw.mock.calls[0][0] as { strings: string[] }).strings.join(" ");
    expect(pageSql).toContain("ILIKE");
    // The mixed-case term is a bound parameter (never interpolated into SQL).
    const pageValues = (queryRaw.mock.calls[0][0] as { values: unknown[] }).values;
    expect(pageValues).toContain("%LOGIN%");
    expect(result).toMatchObject({ total: 1, page: 1, pageSize: 10 });
    expect(result.items).toEqual([
      { id: "r1", title: "Login", projectId: "projA", projectName: "Project A" },
    ]);
  });

  it("escapes LIKE metacharacters in the term on the Postgres path", async () => {
    resolveDatabaseProviderMock.mockReturnValue("postgresql");
    const queryRaw = db.$queryRaw as ReturnType<typeof vi.fn>;
    queryRaw.mockResolvedValueOnce([]);
    await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", query: "50%_off", page: 1, pageSize: 20 },
      db as never,
    );
    const values = (queryRaw.mock.calls[0][0] as { values: unknown[] }).values;
    // % and _ are escaped so they match literally, not as wildcards.
    expect(values).toContain("%50\\%\\_off%");
  });

  it("keeps the SQLite path (plain contains, no raw SQL) when the provider is sqlite", async () => {
    await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", query: "LOG", page: 1, pageSize: 20 },
      db as never,
    );
    expect(db.$queryRaw).not.toHaveBeenCalled();
    const whereArg = db.requirement.findMany.mock.calls[0][0].where;
    expect(whereArg.title).toEqual({ contains: "LOG" });
  });

  it("excludes the excludeProject from the scoped set", async () => {
    await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", excludeProjectId: "projB", page: 1, pageSize: 20 },
      db as never,
    );
    const whereArg = db.requirement.findMany.mock.calls[0][0].where;
    expect(whereArg.projectId).toEqual({ in: ["projA"] });
  });

  it("falls back to the default Prisma client when no db is supplied", async () => {
    defaultPrismaMock.requirement.findMany.mockResolvedValue([
      {
        id: "r9",
        title: "Fallback",
        projectId: "projA",
        project: { name: "Project A" },
        analysisId: "a",
        sourceIds: null,
      },
    ]);
    const result = await searchWorkspaceRequirements(actor, {
      workspaceId: "ws1",
      page: 1,
      pageSize: 20,
    });
    expect(defaultPrismaMock.requirement.findMany).toHaveBeenCalledTimes(1);
    expect(result.items[0]).toMatchObject({ id: "r9", projectName: "Project A" });
  });
});

describe("#2491 — a requirement resting on a source the caller cannot see", () => {
  let db: MockDb;
  /** `n` matches in title order; the first `hidden` of them restricted. */
  const matches = (n: number, hidden: number) => {
    const rows = Array.from({ length: n }, (_, i) => {
      const id = `r${String(i).padStart(5, "0")}`;
      return {
        id,
        title: id,
        projectId: "projA",
        project: { name: "Project A" },
        projectName: "Project A",
        analysisId: "a",
        sourceIds: null,
      };
    });
    hiddenIds.ids = new Set(rows.slice(0, hidden).map((r) => r.id));
    return rows;
  };
  beforeEach(() => {
    db = createMockDb();
    listMemberProjectsInWorkspace.mockResolvedValue(["projA"]);
  });
  afterEach(() => {
    hiddenIds.ids = new Set();
    resolveDatabaseProviderMock.mockReturnValue("sqlite");
  });

  it("is left out of the SQLite search before the page is cut, and not counted", async () => {
    const rows = matches(30, 12);
    db.requirement.findMany.mockImplementation(async (args: { skip: number; take: number }) =>
      rows.slice(args.skip, args.skip + args.take),
    );
    const result = await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", query: "r", page: 1, pageSize: 10 },
      db as never,
    );
    expect(result.items.map((i) => i.id)).toEqual(rows.slice(12, 22).map((r) => r.id));
    expect(result.total).toBe(18);
    // No id list is bound into the query at all: each batch is decided after it is read.
    for (const [args] of db.requirement.findMany.mock.calls) {
      expect(JSON.stringify(args.where)).not.toContain("notIn");
    }
  });

  it("reads a bounded window of matches in bounded batches, however many rows match (#1346)", async () => {
    const rows = matches(50_000, 49_000);
    db.requirement.findMany.mockImplementation(async (args: { skip: number; take: number }) =>
      rows.slice(args.skip, args.skip + args.take),
    );
    const result = await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", page: 1, pageSize: 20 },
      db as never,
    );
    const takes = db.requirement.findMany.mock.calls.map(([args]) => args.take as number);
    expect(Math.max(...takes)).toBeLessThanOrEqual(SEARCH_SCAN_BATCH);
    expect(takes.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(SEARCH_SCAN_CAP);
    // Every match in the window is hidden: nothing leaks, nothing is counted.
    expect(result).toEqual({ items: [], page: 1, pageSize: 20, total: 0 });
  });

  it("is left out of the Postgres search's count and page, with no id list bound", async () => {
    resolveDatabaseProviderMock.mockReturnValue("postgresql");
    const rows = matches(50_000, 49_000);
    const queryRaw = db.$queryRaw as ReturnType<typeof vi.fn>;
    queryRaw.mockImplementation(async (sql: { values: unknown[] }) => {
      const [take, skip] = sql.values.slice(-2) as [number, number];
      return rows.slice(skip, skip + take);
    });
    const result = await searchWorkspaceRequirements(
      actor,
      { workspaceId: "ws1", query: "r", page: 1, pageSize: 10 },
      db as never,
    );
    expect(result.total).toBe(0);
    let read = 0;
    for (const [sql] of queryRaw.mock.calls) {
      const text = (sql as { strings: string[] }).strings.join(" ");
      expect(text).not.toContain("NOT IN");
      const [take] = (sql as { values: unknown[] }).values.slice(-2) as [number, number];
      expect(take).toBeLessThanOrEqual(SEARCH_SCAN_BATCH);
      read += take;
    }
    expect(read).toBeLessThanOrEqual(SEARCH_SCAN_CAP);
  });
});
