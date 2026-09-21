/**
 * Tests for the StakeholderService (Epic #208 / Issue #230).
 *
 * Exercises stakeholder CRUD, project-context upsert/read (JSON-as-TEXT
 * (de)serialisation), and requirement↔stakeholder association against an
 * in-memory Prisma mock — no database required.
 */
import { describe, expect, it, vi } from "vitest";
import {
  StakeholderError,
  StakeholderService,
  type StakeholderPrismaClient,
} from "../src/lib/stakeholders/stakeholder-service.js";

function makeDb(overrides: Partial<Record<keyof StakeholderPrismaClient, unknown>> = {}) {
  const db = {
    stakeholder: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "sh1",
        ...data,
      })),
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => ({
        id: "sh1",
        projectId: "p1",
        name: "Updated",
        ...data,
      })),
      delete: vi.fn(async () => ({ id: "sh1" })),
    },
    projectContext: {
      findUnique: vi.fn(async () => null),
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({ ...create })),
    },
    requirement: {
      findFirst: vi.fn(async () => ({ id: "req1", projectId: "p1" })),
    },
    requirementStakeholder: {
      upsert: vi.fn(async () => ({ id: "link1" })),
      findMany: vi.fn(async () => []),
      deleteMany: vi.fn(async () => ({ count: 1 })),
    },
  } as unknown as StakeholderPrismaClient;
  Object.assign(db, overrides);
  return db;
}

describe("StakeholderService.create", () => {
  it("creates a stakeholder with defaults applied", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    const sh = await svc.create("p1", { name: "Product Owner" });
    expect(sh.name).toBe("Product Owner");
    expect(sh.influence).toBe("medium");
    expect(sh.interest).toBe("medium");
    expect(sh.role).toBe("");
    expect(sh.viewpoint).toBe("");
  });

  it("passes through explicit fields", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    const sh = await svc.create("p1", {
      name: "CISO",
      role: "Security",
      description: "Owns compliance",
      influence: "high",
      interest: "high",
      viewpoint: "security",
    });
    expect(sh.influence).toBe("high");
    expect(sh.viewpoint).toBe("security");
    expect(sh.description).toBe("Owns compliance");
  });

  it("rejects a duplicate name within the project", async () => {
    const db = makeDb();
    (db.stakeholder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "x" });
    const svc = new StakeholderService(db);
    await expect(svc.create("p1", { name: "Dup" })).rejects.toMatchObject({
      code: "CONFLICT",
      statusCode: 409,
    });
  });
});

describe("StakeholderService.list", () => {
  it("maps rows ordered by name", async () => {
    const db = makeDb();
    (db.stakeholder.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      { id: "a", projectId: "p1", name: "Alice", influence: "low", interest: "high" },
    ]);
    const svc = new StakeholderService(db);
    const list = await svc.list("p1");
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("Alice");
    expect(list[0]!.influence).toBe("low");
    const args = (db.stakeholder.findMany as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.orderBy).toEqual({ name: "asc" });
  });
});

describe("StakeholderService.update", () => {
  it("404s on an unknown id", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    await expect(svc.update("p1", "missing", { name: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
      statusCode: 404,
    });
  });

  it("applies only the provided fields", async () => {
    const db = makeDb();
    (db.stakeholder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "sh1" });
    const svc = new StakeholderService(db);
    await svc.update("p1", "sh1", { influence: "high", viewpoint: "ops" });
    const data = (db.stakeholder.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toEqual({ influence: "high", viewpoint: "ops" });
    expect(data.name).toBeUndefined();
  });

  it("applies all updatable fields when given", async () => {
    const db = makeDb();
    (db.stakeholder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "sh1" });
    const svc = new StakeholderService(db);
    await svc.update("p1", "sh1", {
      name: "n",
      role: "r",
      description: "d",
      influence: "low",
      interest: "low",
      viewpoint: "v",
    });
    const data = (db.stakeholder.update as ReturnType<typeof vi.fn>).mock.calls[0][0].data;
    expect(data).toEqual({
      name: "n",
      role: "r",
      description: "d",
      influence: "low",
      interest: "low",
      viewpoint: "v",
    });
  });
});

describe("StakeholderService.remove", () => {
  it("deletes an existing stakeholder", async () => {
    const db = makeDb();
    (db.stakeholder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "sh1" });
    const svc = new StakeholderService(db);
    await svc.remove("p1", "sh1");
    expect(db.stakeholder.delete).toHaveBeenCalledWith({ where: { id: "sh1" } });
  });

  it("404s when the stakeholder is missing", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    await expect(svc.remove("p1", "nope")).rejects.toBeInstanceOf(StakeholderError);
  });
});

describe("StakeholderService project context", () => {
  it("returns empty defaults when never set", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    const ctx = await svc.getContext("p1");
    expect(ctx).toEqual({
      businessGoals: "",
      inScope: [],
      outOfScope: [],
      constraints: [],
      glossary: [],
    });
  });

  it("parses JSON-as-TEXT list fields and a glossary", async () => {
    const db = makeDb();
    (db.projectContext.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      businessGoals: "Ship v2",
      inScope: JSON.stringify(["login"]),
      outOfScope: JSON.stringify(["billing"]),
      constraints: JSON.stringify(["GDPR"]),
      glossary: JSON.stringify([{ term: "SLA", definition: "service level agreement" }]),
    });
    const svc = new StakeholderService(db);
    const ctx = await svc.getContext("p1");
    expect(ctx.businessGoals).toBe("Ship v2");
    expect(ctx.inScope).toEqual(["login"]);
    expect(ctx.glossary[0]!.term).toBe("SLA");
  });

  it("drops malformed list/glossary data without throwing", async () => {
    const db = makeDb();
    (db.projectContext.findUnique as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      businessGoals: "",
      inScope: "not-json",
      outOfScope: JSON.stringify("a string not array"),
      constraints: JSON.stringify([1, "ok", null]),
      glossary: JSON.stringify([{ term: "", definition: "x" }, { bad: true }]),
    });
    const svc = new StakeholderService(db);
    const ctx = await svc.getContext("p1");
    expect(ctx.inScope).toEqual([]);
    expect(ctx.outOfScope).toEqual([]);
    expect(ctx.constraints).toEqual(["ok"]);
    expect(ctx.glossary).toEqual([]);
  });

  it("serialises lists to JSON-as-TEXT on upsert", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    await svc.upsertContext("p1", {
      businessGoals: "g",
      inScope: ["a"],
      glossary: [{ term: "t", definition: "d" }],
    });
    const args = (db.projectContext.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.where).toEqual({ projectId: "p1" });
    expect(args.create.inScope).toBe(JSON.stringify(["a"]));
    expect(args.create.outOfScope).toBe(JSON.stringify([]));
    expect(JSON.parse(args.create.glossary)).toEqual([{ term: "t", definition: "d" }]);
  });

  it("round-trips parsed context from the upsert result", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    const ctx = await svc.upsertContext("p1", { inScope: ["x", "y"] });
    expect(ctx.inScope).toEqual(["x", "y"]);
  });
});

describe("StakeholderService requirement links", () => {
  it("links a requirement to a stakeholder with defaults", async () => {
    const db = makeDb();
    (db.stakeholder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "sh1" });
    const svc = new StakeholderService(db);
    await svc.linkRequirement("p1", "req1", { stakeholderId: "sh1" });
    const args = (db.requirementStakeholder.upsert as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(args.create.priority).toBe("should-have");
    expect(args.where.requirement_stakeholder_link).toEqual({
      requirementId: "req1",
      stakeholderId: "sh1",
    });
  });

  it("404s when the requirement is missing", async () => {
    const db = makeDb();
    (db.requirement.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    (db.stakeholder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "sh1" });
    const svc = new StakeholderService(db);
    await expect(
      svc.linkRequirement("p1", "missing", { stakeholderId: "sh1" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("404s when the stakeholder is missing", async () => {
    const db = makeDb();
    (db.requirement.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ id: "req1" });
    (db.stakeholder.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const svc = new StakeholderService(db);
    await expect(svc.linkRequirement("p1", "req1", { stakeholderId: "x" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("unlinks an existing association", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    await svc.unlinkRequirement("p1", "req1", "sh1");
    expect(db.requirementStakeholder.deleteMany).toHaveBeenCalledWith({
      where: { requirementId: "req1", stakeholderId: "sh1" },
    });
  });

  it("404s when unlinking a non-existent association", async () => {
    const db = makeDb();
    (db.requirementStakeholder.deleteMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      count: 0,
    });
    const svc = new StakeholderService(db);
    await expect(svc.unlinkRequirement("p1", "req1", "sh1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("lists stakeholders for a requirement with link metadata", async () => {
    const db = makeDb();
    (db.requirementStakeholder.findMany as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        priority: "must-have",
        viewpoint: "security",
        stakeholder: { id: "sh1", projectId: "p1", name: "CISO", influence: "high" },
      },
      { priority: "should-have", viewpoint: "", stakeholder: null },
    ]);
    const svc = new StakeholderService(db);
    const list = await svc.listForRequirement("p1", "req1");
    expect(list).toHaveLength(1);
    expect(list[0]!.name).toBe("CISO");
    expect(list[0]!.priority).toBe("must-have");
    expect(list[0]!.linkViewpoint).toBe("security");
  });
});

describe("StakeholderService requirement links — cross-project isolation (A01/IDOR)", () => {
  it("unlinkRequirement scopes the ownership check to the caller's project", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    await svc.unlinkRequirement("projectA", "req1", "sh1");
    const where = (db.requirement.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "req1", projectId: "projectA", deletedAt: null });
  });

  it("unlinkRequirement rejects when the requirement belongs to another project", async () => {
    // Requirement exists, but not under the caller's project → findFirst yields null.
    const db = makeDb();
    (db.requirement.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const svc = new StakeholderService(db);
    await expect(svc.unlinkRequirement("projectA", "reqOwnedByB", "sh1")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Must NOT have attempted to delete a link it could not prove ownership of.
    expect(db.requirementStakeholder.deleteMany).not.toHaveBeenCalled();
  });

  it("listForRequirement scopes the ownership check to the caller's project", async () => {
    const db = makeDb();
    const svc = new StakeholderService(db);
    await svc.listForRequirement("projectA", "req1");
    const where = (db.requirement.findFirst as ReturnType<typeof vi.fn>).mock.calls[0][0].where;
    expect(where).toMatchObject({ id: "req1", projectId: "projectA", deletedAt: null });
  });

  it("listForRequirement rejects when the requirement belongs to another project", async () => {
    const db = makeDb();
    (db.requirement.findFirst as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const svc = new StakeholderService(db);
    await expect(svc.listForRequirement("projectA", "reqOwnedByB")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    // Must NOT have read any links for a requirement it does not own.
    expect(db.requirementStakeholder.findMany).not.toHaveBeenCalled();
  });
});
