/**
 * Per-project allow-lists for Phase 10 Skills + Agents.
 *
 * Project owners (those holding `project.update`) can enable or disable
 * specific skills + agents for their project, even though the global library
 * is admin-managed. The chat / analysis runtime consults these lists to
 * decide which definitions show up in the picker.
 *
 * Note: the route layer is responsible for verifying that the actor actually
 * holds `project.update` for the supplied projectId. This service trusts
 * that gate.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";

export class AllowlistError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "AllowlistError";
  }
}

export interface AllowlistActorRef {
  id: string;
}
type ActorRef = AllowlistActorRef;

export class ProjectLibraryAllowlistService {
  constructor(private readonly db: PrismaClient = defaultPrisma) {}

  async listSkills(
    projectId: string,
  ): Promise<
    Array<{ skillId: string; skillKey: string; enabled: boolean; addedById: string | null }>
  > {
    const rows = await this.db.projectSkillAllowlist.findMany({
      where: { projectId },
      include: { skill: { select: { key: true } } },
    });
    return rows.map((r) => ({
      skillId: r.skillId,
      skillKey: r.skill.key,
      enabled: r.enabled,
      addedById: r.addedById,
    }));
  }

  async listAgents(
    projectId: string,
  ): Promise<
    Array<{ agentId: string; agentKey: string; enabled: boolean; addedById: string | null }>
  > {
    const rows = await this.db.projectAgentAllowlist.findMany({
      where: { projectId },
      include: { agent: { select: { key: true } } },
    });
    return rows.map((r) => ({
      agentId: r.agentId,
      agentKey: r.agent.key,
      enabled: r.enabled,
      addedById: r.addedById,
    }));
  }

  async setSkillEnabled(
    projectId: string,
    skillId: string,
    enabled: boolean,
    actor: ActorRef,
  ): Promise<void> {
    const skill = await this.db.skill.findUnique({ where: { id: skillId } });
    if (!skill || skill.deletedAt) {
      throw new AllowlistError(404, "SKILL_NOT_FOUND", "Skill not found");
    }
    await this.db.projectSkillAllowlist.upsert({
      where: { projectId_skillId: { projectId, skillId } },
      create: { projectId, skillId, enabled, addedById: actor.id },
      update: { enabled },
    });
    audit({
      actor: { id: actor.id },
      action: "skill.allowlist.update",
      target: { type: "project_skill_allowlist", id: `${projectId}:${skillId}` },
      metadata: { projectId, skillId, enabled },
    });
  }

  async setAgentEnabled(
    projectId: string,
    agentId: string,
    enabled: boolean,
    actor: ActorRef,
  ): Promise<void> {
    const agent = await this.db.agent.findUnique({ where: { id: agentId } });
    if (!agent || agent.deletedAt) {
      throw new AllowlistError(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    await this.db.projectAgentAllowlist.upsert({
      where: { projectId_agentId: { projectId, agentId } },
      create: { projectId, agentId, enabled, addedById: actor.id },
      update: { enabled },
    });
    audit({
      actor: { id: actor.id },
      action: "agent.allowlist.update",
      target: { type: "project_agent_allowlist", id: `${projectId}:${agentId}` },
      metadata: { projectId, agentId, enabled },
    });
  }

  async removeSkill(projectId: string, skillId: string, actor: ActorRef): Promise<void> {
    await this.db.projectSkillAllowlist.deleteMany({ where: { projectId, skillId } });
    audit({
      actor: { id: actor.id },
      action: "skill.allowlist.remove",
      target: { type: "project_skill_allowlist", id: `${projectId}:${skillId}` },
      metadata: { projectId, skillId },
    });
  }

  async removeAgent(projectId: string, agentId: string, actor: ActorRef): Promise<void> {
    await this.db.projectAgentAllowlist.deleteMany({ where: { projectId, agentId } });
    audit({
      actor: { id: actor.id },
      action: "agent.allowlist.remove",
      target: { type: "project_agent_allowlist", id: `${projectId}:${agentId}` },
      metadata: { projectId, agentId },
    });
  }

  /**
   * Resolve the effective set of skill ids enabled for a project. When the
   * project has no allowlist rows we default-allow every globally enabled
   * skill (mirrors the MCP allowlist convention). When at least one row
   * exists we treat the list as exhaustive.
   */
  async resolveAllowedSkillIds(projectId: string): Promise<Set<string>> {
    const rows = await this.db.projectSkillAllowlist.findMany({ where: { projectId } });
    if (rows.length === 0) {
      const all = await this.db.skill.findMany({
        where: { deletedAt: null, archivedAt: null, enabled: true },
        select: { id: true },
      });
      return new Set(all.map((r) => r.id));
    }
    return new Set(rows.filter((r) => r.enabled).map((r) => r.skillId));
  }

  /**
   * Resolve the effective set of skills available to a project's chat sessions,
   * as display rows (id, key, name, description). This mirrors
   * `resolveAllowedSkillIds` (the runtime's actual gate) — when the project has
   * no explicit allowlist rows, every globally enabled skill is available — and
   * then projects to display fields, never offering a disabled/archived/deleted
   * skill. This is what the chat "Available skills" picker should consume; the
   * raw `listSkills` (explicit rows only) is for allowlist management, not the
   * picker. Without this the picker showed "No skills allowed" even though the
   * runtime would have allowed the skill (#468).
   */
  async resolveAvailableSkills(
    projectId: string,
  ): Promise<Array<{ skillId: string; skillKey: string; name: string; description: string }>> {
    const allowedIds = await this.resolveAllowedSkillIds(projectId);
    if (allowedIds.size === 0) return [];
    const skills = await this.db.skill.findMany({
      where: {
        id: { in: [...allowedIds] },
        deletedAt: null,
        archivedAt: null,
        enabled: true,
      },
      select: { id: true, key: true, name: true, description: true },
      orderBy: { key: "asc" },
    });
    return skills.map((s) => ({
      skillId: s.id,
      skillKey: s.key,
      name: s.name,
      description: s.description,
    }));
  }

  async resolveAllowedAgentIds(projectId: string): Promise<Set<string>> {
    const rows = await this.db.projectAgentAllowlist.findMany({ where: { projectId } });
    if (rows.length === 0) {
      const all = await this.db.agent.findMany({
        where: { deletedAt: null, archivedAt: null, enabled: true },
        select: { id: true },
      });
      return new Set(all.map((r) => r.id));
    }
    return new Set(rows.filter((r) => r.enabled).map((r) => r.agentId));
  }
}

let singleton: ProjectLibraryAllowlistService | null = null;
export function getProjectLibraryAllowlist(): ProjectLibraryAllowlistService {
  if (!singleton) singleton = new ProjectLibraryAllowlistService();
  return singleton;
}
export function __setProjectLibraryAllowlist(svc: ProjectLibraryAllowlistService | null): void {
  singleton = svc;
}
