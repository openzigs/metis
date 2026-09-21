/**
 * SkillService \u2014 CRUD + immutable versioning for the Phase 10 Skills library.
 *
 * Every save creates a `SkillVersion` row \u2014 the latest pointer lives on the
 * `Skill` row itself for cheap reads. Archive is a soft state (sets
 * `archivedAt` + `enabled=false`); delete is a soft delete (sets `deletedAt`).
 *
 * RBAC: the routes layer enforces `skill.manage` for create/update/archive/
 * delete; project-scoped enable/disable lives in `project-allowlist.ts`.
 *
 * Audit: every state-changing call writes an AuditLog entry with the resulting
 * `contentSha256` so version history stays tamper-evident.
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { bumpVersion, parseSkillSource, slugifyKey, type SkillFrontmatter } from "./frontmatter.js";

export class SkillServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "SkillServiceError";
  }
}

export interface ActorRef {
  id: string;
  role?: string;
}

export interface SkillUpsertInput {
  /** Optional override for the slug. When omitted we slugify the name. */
  key?: string;
  /** Raw `---\n...\n---\nbody` source as authored by the user. */
  source: string;
  /** Where the source came from \u2014 stored on the Skill row for audit. */
  origin?: string;
}

export interface SkillSummary {
  id: string;
  key: string;
  name: string;
  description: string;
  version: string;
  tools: string[];
  resources: string[];
  tags: string[];
  enabled: boolean;
  archived: boolean;
  source: string;
  contentSha256: string | null;
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillDetail extends SkillSummary {
  instructions: string;
  manifest: SkillFrontmatter;
}

export interface SkillVersionSummary {
  id: string;
  version: string;
  contentSha256: string;
  createdById: string | null;
  createdAt: Date;
}

export interface SkillVersionDetail extends SkillVersionSummary {
  manifest: SkillFrontmatter;
  instructions: string;
}

function toJsonArray(values: readonly string[] | undefined): string {
  return JSON.stringify(values ?? []);
}

function fromJsonArray(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function fromManifest(raw: string): SkillFrontmatter {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as SkillFrontmatter;
    }
  } catch {
    // fall through
  }
  return { name: "unknown", description: "", version: "0.1.0" } as SkillFrontmatter;
}

export class SkillService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  // ── Read ────────────────────────────────────────────────────────────
  async list(
    opts: { tag?: string; query?: string; includeArchived?: boolean } = {},
  ): Promise<SkillSummary[]> {
    const where: Prisma.SkillWhereInput = {
      deletedAt: null,
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.query
        ? {
            OR: [
              { name: { contains: opts.query } },
              { description: { contains: opts.query } },
              { key: { contains: opts.query } },
            ],
          }
        : {}),
    };
    const rows = await this.db.skill.findMany({
      where,
      orderBy: { updatedAt: "desc" },
    });
    const filtered = opts.tag
      ? rows.filter((r) => fromJsonArray(r.tags).includes(opts.tag!))
      : rows;
    return filtered.map(this.toSummary);
  }

  async get(id: string): Promise<SkillDetail | null> {
    const row = await this.db.skill.findUnique({ where: { id } });
    if (!row || row.deletedAt) return null;
    return this.toDetail(row);
  }

  async getByKey(key: string): Promise<SkillDetail | null> {
    const row = await this.db.skill.findUnique({ where: { key } });
    if (!row || row.deletedAt) return null;
    return this.toDetail(row);
  }

  async listVersions(id: string): Promise<SkillVersionSummary[]> {
    const rows = await this.db.skillVersion.findMany({
      where: { skillId: id },
      orderBy: { createdAt: "desc" },
    });
    return rows.map((r) => ({
      id: r.id,
      version: r.version,
      contentSha256: r.contentSha256,
      createdById: r.createdById,
      createdAt: r.createdAt,
    }));
  }

  async getVersion(id: string, versionId: string): Promise<SkillVersionDetail | null> {
    const row = await this.db.skillVersion.findFirst({
      where: { id: versionId, skillId: id },
    });
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      contentSha256: row.contentSha256,
      createdById: row.createdById,
      createdAt: row.createdAt,
      manifest: fromManifest(row.manifest),
      instructions: row.instructions,
    };
  }

  // ── Write ───────────────────────────────────────────────────────────
  async create(input: SkillUpsertInput, actor: ActorRef): Promise<SkillDetail> {
    const parsed = parseSkillSource(input.source);
    const key = input.key ?? slugifyKey(parsed.frontmatter.name);
    const existing = await this.db.skill.findUnique({ where: { key } });
    if (existing && !existing.deletedAt) {
      throw new SkillServiceError(409, "SKILL_KEY_EXISTS", `Skill key '${key}' is already in use`);
    }
    const manifestJson = JSON.stringify(parsed.frontmatter);
    const data: Prisma.SkillCreateInput = {
      key,
      name: parsed.frontmatter.name,
      description: parsed.frontmatter.description ?? "",
      version: parsed.frontmatter.version ?? "0.1.0",
      instructions: parsed.body,
      tools: toJsonArray(parsed.frontmatter.tools),
      resources: toJsonArray(parsed.frontmatter.resources),
      tags: toJsonArray(parsed.frontmatter.tags),
      manifest: manifestJson,
      contentSha256: parsed.contentSha256,
      source: input.origin ?? "inline",
      ...(actor.id ? { createdBy: { connect: { id: actor.id } } } : {}),
      versions: {
        create: {
          version: parsed.frontmatter.version ?? "0.1.0",
          manifest: manifestJson,
          instructions: parsed.body,
          contentSha256: parsed.contentSha256,
          ...(actor.id ? { createdBy: { connect: { id: actor.id } } } : {}),
        },
      },
    };
    const row = existing
      ? await this.db.skill.update({
          where: { id: existing.id },
          data: {
            ...data,
            createdBy: undefined,
            deletedAt: null,
            archivedAt: null,
            enabled: true,
          },
        })
      : await this.db.skill.create({ data });
    audit({
      actor: { id: actor.id },
      action: "skill.create",
      target: { type: "skill", id: row.id },
      metadata: {
        key: row.key,
        version: row.version,
        contentSha256: row.contentSha256,
        source: row.source,
      },
    });
    return this.toDetail(row);
  }

  async update(id: string, input: SkillUpsertInput, actor: ActorRef): Promise<SkillDetail> {
    const existing = await this.db.skill.findUnique({ where: { id }, include: { versions: true } });
    if (!existing || existing.deletedAt) {
      throw new SkillServiceError(404, "SKILL_NOT_FOUND", "Skill not found");
    }
    const parsed = parseSkillSource(input.source);
    if (parsed.contentSha256 === existing.contentSha256) {
      throw new SkillServiceError(
        409,
        "SKILL_NO_CHANGE",
        "Source is identical to the current version \u2014 nothing to save",
      );
    }
    const versions = new Set(existing.versions.map((v) => v.version));
    const proposed = parsed.frontmatter.version ?? existing.version;
    const nextVersion = versions.has(proposed) ? bumpVersion(proposed, versions) : proposed;
    const manifestJson = JSON.stringify({ ...parsed.frontmatter, version: nextVersion });
    const updated = await this.db.skill.update({
      where: { id },
      data: {
        name: parsed.frontmatter.name,
        description: parsed.frontmatter.description ?? "",
        instructions: parsed.body,
        tools: toJsonArray(parsed.frontmatter.tools),
        resources: toJsonArray(parsed.frontmatter.resources),
        tags: toJsonArray(parsed.frontmatter.tags),
        manifest: manifestJson,
        version: nextVersion,
        contentSha256: parsed.contentSha256,
        source: input.origin ?? existing.source,
        versions: {
          create: {
            version: nextVersion,
            manifest: manifestJson,
            instructions: parsed.body,
            contentSha256: parsed.contentSha256,
            ...(actor.id ? { createdBy: { connect: { id: actor.id } } } : {}),
          },
        },
      },
    });
    audit({
      actor: { id: actor.id },
      action: "skill.update",
      target: { type: "skill", id: updated.id },
      metadata: {
        key: updated.key,
        previousVersion: existing.version,
        version: updated.version,
        contentSha256: updated.contentSha256,
      },
    });
    return this.toDetail(updated);
  }

  async setEnabled(id: string, enabled: boolean, actor: ActorRef): Promise<SkillDetail> {
    const existing = await this.db.skill.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new SkillServiceError(404, "SKILL_NOT_FOUND", "Skill not found");
    }
    const updated = await this.db.skill.update({ where: { id }, data: { enabled } });
    audit({
      actor: { id: actor.id },
      action: enabled ? "skill.enable" : "skill.disable",
      target: { type: "skill", id },
      metadata: { key: existing.key },
    });
    return this.toDetail(updated);
  }

  async archive(id: string, actor: ActorRef): Promise<SkillDetail> {
    const existing = await this.db.skill.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new SkillServiceError(404, "SKILL_NOT_FOUND", "Skill not found");
    }
    const updated = await this.db.skill.update({
      where: { id },
      data: { archivedAt: new Date(), enabled: false },
    });
    audit({
      actor: { id: actor.id },
      action: "skill.archive",
      target: { type: "skill", id },
      metadata: { key: existing.key },
    });
    return this.toDetail(updated);
  }

  async remove(id: string, actor: ActorRef): Promise<void> {
    const existing = await this.db.skill.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new SkillServiceError(404, "SKILL_NOT_FOUND", "Skill not found");
    }
    await this.db.skill.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
    audit({
      actor: { id: actor.id },
      action: "skill.delete",
      target: { type: "skill", id },
      metadata: { key: existing.key },
    });
  }

  /**
   * Diff two versions \u2014 returned as parallel slices so the UI can render a
   * line-by-line comparison without pulling the full Markdown twice. Pure
   * helper, exposed on the service for completeness.
   */
  async diff(
    id: string,
    leftVersionId: string,
    rightVersionId: string,
  ): Promise<{ left: SkillVersionDetail | null; right: SkillVersionDetail | null }> {
    const [left, right] = await Promise.all([
      this.getVersion(id, leftVersionId),
      this.getVersion(id, rightVersionId),
    ]);
    return { left, right };
  }

  // ── Mappers ─────────────────────────────────────────────────────────
  private toSummary = (row: {
    id: string;
    key: string;
    name: string;
    description: string;
    version: string;
    tools: string;
    resources: string;
    tags: string;
    enabled: boolean;
    archivedAt: Date | null;
    source: string;
    contentSha256: string | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): SkillSummary => ({
    id: row.id,
    key: row.key,
    name: row.name,
    description: row.description,
    version: row.version,
    tools: fromJsonArray(row.tools),
    resources: fromJsonArray(row.resources),
    tags: fromJsonArray(row.tags),
    enabled: row.enabled,
    archived: row.archivedAt !== null,
    source: row.source,
    contentSha256: row.contentSha256,
    createdById: row.createdById,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });

  private toDetail = (row: {
    id: string;
    key: string;
    name: string;
    description: string;
    version: string;
    instructions: string;
    tools: string;
    resources: string;
    tags: string;
    manifest: string;
    enabled: boolean;
    archivedAt: Date | null;
    source: string;
    contentSha256: string | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): SkillDetail => ({
    ...this.toSummary(row),
    instructions: row.instructions,
    manifest: fromManifest(row.manifest),
  });
}

let singleton: SkillService | null = null;
export function getSkillService(): SkillService {
  if (!singleton) singleton = new SkillService();
  return singleton;
}
export function __setSkillService(svc: SkillService | null): void {
  singleton = svc;
}
