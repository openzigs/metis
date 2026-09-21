/**
 * Stakeholder + project-context service — Epic #208 (E6.1 / #230).
 *
 * CRUD primitives for the {@link Stakeholder}, {@link ProjectContext}, and
 * requirement↔stakeholder association models. Accepts an injected Prisma
 * surface ({@link StakeholderPrismaClient}) so the whole service is unit-
 * testable with an in-memory mock — no database required.
 *
 * List-shaped ProjectContext fields (inScope / outOfScope / constraints /
 * glossary) are stored JSON-as-TEXT per the METIS schema-duality convention;
 * this service is the (de)serialisation boundary, so callers always work with
 * parsed arrays/objects.
 */
import {
  type CreateStakeholderInput,
  type GlossaryEntry,
  type LinkStakeholderInput,
  type ProjectContext,
  type ProjectContextInput,
  type Stakeholder,
  type StakeholderLevel,
  type StakeholderPriority,
  type UpdateStakeholderInput,
  glossaryEntrySchema,
} from "@metis/shared";

/** Predictable failure modes surfaced to the route layer. */
export type StakeholderErrorCode = "NOT_FOUND" | "CONFLICT" | "INVALID";

export class StakeholderError extends Error {
  readonly code: StakeholderErrorCode;
  readonly statusCode: number;
  constructor(code: StakeholderErrorCode, message: string) {
    super(message);
    this.name = "StakeholderError";
    this.code = code;
    this.statusCode = code === "NOT_FOUND" ? 404 : code === "CONFLICT" ? 409 : 400;
  }
}

/**
 * Minimal Prisma surface this service depends on. Accepting an interface keeps
 * the service trivially mockable and works for both the root client and an
 * interactive-transaction client.
 */
export interface StakeholderPrismaClient {
  stakeholder: {
    create(args: unknown): Promise<Record<string, unknown>>;
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
    findFirst(args: unknown): Promise<Record<string, unknown> | null>;
    update(args: unknown): Promise<Record<string, unknown>>;
    delete(args: unknown): Promise<Record<string, unknown>>;
  };
  projectContext: {
    findUnique(args: unknown): Promise<Record<string, unknown> | null>;
    upsert(args: unknown): Promise<Record<string, unknown>>;
  };
  requirement: {
    findFirst(args: unknown): Promise<Record<string, unknown> | null>;
  };
  requirementStakeholder: {
    upsert(args: unknown): Promise<Record<string, unknown>>;
    findMany(args: unknown): Promise<Array<Record<string, unknown>>>;
    deleteMany(args: unknown): Promise<{ count: number }>;
  };
}

const DEFAULT_LEVEL: StakeholderLevel = "medium";

function toStakeholder(row: Record<string, unknown>): Stakeholder {
  return {
    id: String(row.id),
    projectId: String(row.projectId),
    name: String(row.name),
    role: String(row.role ?? ""),
    description: String(row.description ?? ""),
    influence: (row.influence as StakeholderLevel) ?? DEFAULT_LEVEL,
    interest: (row.interest as StakeholderLevel) ?? DEFAULT_LEVEL,
    viewpoint: String(row.viewpoint ?? ""),
  };
}

/** Parse a JSON-as-TEXT string array, tolerating bad/legacy data. */
function parseStringList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (Array.isArray(parsed)) {
      return parsed.filter((s): s is string => typeof s === "string");
    }
  } catch {
    // fall through to empty
  }
  return [];
}

/** Parse a JSON-as-TEXT glossary array, dropping malformed entries. */
function parseGlossary(raw: unknown): GlossaryEntry[] {
  if (typeof raw !== "string") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: GlossaryEntry[] = [];
  for (const entry of parsed) {
    const result = glossaryEntrySchema.safeParse(entry);
    if (result.success) out.push(result.data);
  }
  return out;
}

function toProjectContext(row: Record<string, unknown> | null): ProjectContext {
  return {
    businessGoals: row ? String(row.businessGoals ?? "") : "",
    inScope: parseStringList(row?.inScope),
    outOfScope: parseStringList(row?.outOfScope),
    constraints: parseStringList(row?.constraints),
    glossary: parseGlossary(row?.glossary),
  };
}

export class StakeholderService {
  private readonly db: StakeholderPrismaClient;

  constructor(db: StakeholderPrismaClient) {
    this.db = db;
  }

  /** Create a stakeholder under a project. Enforces unique (project, name). */
  async create(projectId: string, input: CreateStakeholderInput): Promise<Stakeholder> {
    const existing = await this.db.stakeholder.findFirst({
      where: { projectId, name: input.name },
    });
    if (existing) {
      throw new StakeholderError("CONFLICT", `Stakeholder "${input.name}" already exists`);
    }
    const row = await this.db.stakeholder.create({
      data: {
        projectId,
        name: input.name,
        role: input.role ?? "",
        description: input.description ?? "",
        influence: input.influence ?? DEFAULT_LEVEL,
        interest: input.interest ?? DEFAULT_LEVEL,
        viewpoint: input.viewpoint ?? "",
      },
    });
    return toStakeholder(row);
  }

  /** List a project's stakeholders, ordered by name. */
  async list(projectId: string): Promise<Stakeholder[]> {
    const rows = await this.db.stakeholder.findMany({
      where: { projectId },
      orderBy: { name: "asc" },
    });
    return rows.map(toStakeholder);
  }

  /** Update a stakeholder. Scoped by project so cross-project ids 404. */
  async update(
    projectId: string,
    stakeholderId: string,
    patch: UpdateStakeholderInput,
  ): Promise<Stakeholder> {
    const existing = await this.db.stakeholder.findFirst({
      where: { id: stakeholderId, projectId },
    });
    if (!existing) {
      throw new StakeholderError("NOT_FOUND", "Stakeholder not found");
    }
    const data: Record<string, unknown> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.role !== undefined) data.role = patch.role;
    if (patch.description !== undefined) data.description = patch.description;
    if (patch.influence !== undefined) data.influence = patch.influence;
    if (patch.interest !== undefined) data.interest = patch.interest;
    if (patch.viewpoint !== undefined) data.viewpoint = patch.viewpoint;
    const row = await this.db.stakeholder.update({
      where: { id: stakeholderId },
      data,
    });
    return toStakeholder(row);
  }

  /** Delete a stakeholder (cascades to its requirement links). */
  async remove(projectId: string, stakeholderId: string): Promise<void> {
    const existing = await this.db.stakeholder.findFirst({
      where: { id: stakeholderId, projectId },
    });
    if (!existing) {
      throw new StakeholderError("NOT_FOUND", "Stakeholder not found");
    }
    await this.db.stakeholder.delete({ where: { id: stakeholderId } });
  }

  /** Read the project's context model (empty defaults when never set). */
  async getContext(projectId: string): Promise<ProjectContext> {
    const row = await this.db.projectContext.findUnique({ where: { projectId } });
    return toProjectContext(row);
  }

  /** Create-or-update the project's context model (one row per project). */
  async upsertContext(projectId: string, input: ProjectContextInput): Promise<ProjectContext> {
    const businessGoals = input.businessGoals ?? "";
    const inScope = JSON.stringify(input.inScope ?? []);
    const outOfScope = JSON.stringify(input.outOfScope ?? []);
    const constraints = JSON.stringify(input.constraints ?? []);
    const glossary = JSON.stringify(input.glossary ?? []);
    const row = await this.db.projectContext.upsert({
      where: { projectId },
      create: { projectId, businessGoals, inScope, outOfScope, constraints, glossary },
      update: { businessGoals, inScope, outOfScope, constraints, glossary },
    });
    return toProjectContext(row);
  }

  /**
   * Attribute a requirement to a stakeholder (idempotent upsert keyed on the
   * (requirement, stakeholder) pair). Both must belong to `projectId`.
   */
  async linkRequirement(
    projectId: string,
    requirementId: string,
    input: LinkStakeholderInput,
  ): Promise<void> {
    const [requirement, stakeholder] = await Promise.all([
      this.db.requirement.findFirst({ where: { id: requirementId, projectId, deletedAt: null } }),
      this.db.stakeholder.findFirst({ where: { id: input.stakeholderId, projectId } }),
    ]);
    if (!requirement) throw new StakeholderError("NOT_FOUND", "Requirement not found");
    if (!stakeholder) throw new StakeholderError("NOT_FOUND", "Stakeholder not found");

    const priority: StakeholderPriority = input.priority ?? "should-have";
    await this.db.requirementStakeholder.upsert({
      where: {
        requirement_stakeholder_link: { requirementId, stakeholderId: input.stakeholderId },
      },
      create: {
        requirementId,
        stakeholderId: input.stakeholderId,
        priority,
        viewpoint: input.viewpoint ?? "",
      },
      update: { priority, viewpoint: input.viewpoint ?? "" },
    });
  }

  /**
   * Remove a requirement↔stakeholder attribution. Project-scoped: the
   * requirement must belong to `projectId` (mirrors {@link linkRequirement})
   * so a caller in project A cannot detach a link owned by project B.
   */
  async unlinkRequirement(
    projectId: string,
    requirementId: string,
    stakeholderId: string,
  ): Promise<void> {
    const requirement = await this.db.requirement.findFirst({
      where: { id: requirementId, projectId, deletedAt: null },
    });
    if (!requirement) {
      throw new StakeholderError("NOT_FOUND", "Requirement↔stakeholder link not found");
    }
    const result = await this.db.requirementStakeholder.deleteMany({
      where: { requirementId, stakeholderId },
    });
    if (result.count === 0) {
      throw new StakeholderError("NOT_FOUND", "Requirement↔stakeholder link not found");
    }
  }

  /**
   * List the stakeholders attributed to a requirement. Project-scoped: the
   * requirement must belong to `projectId` (mirrors {@link linkRequirement})
   * so a caller in project A cannot read links owned by project B.
   */
  async listForRequirement(
    projectId: string,
    requirementId: string,
  ): Promise<Array<Stakeholder & { priority: StakeholderPriority; linkViewpoint: string }>> {
    const requirement = await this.db.requirement.findFirst({
      where: { id: requirementId, projectId, deletedAt: null },
    });
    if (!requirement) {
      throw new StakeholderError("NOT_FOUND", "Requirement not found");
    }
    const rows = await this.db.requirementStakeholder.findMany({
      where: { requirementId },
      include: { stakeholder: true },
    });
    return rows
      .filter((r) => r.stakeholder && typeof r.stakeholder === "object")
      .map((r) => {
        const sh = toStakeholder(r.stakeholder as Record<string, unknown>);
        return {
          ...sh,
          priority: (r.priority as StakeholderPriority) ?? "should-have",
          linkViewpoint: String(r.viewpoint ?? ""),
        };
      });
  }
}
