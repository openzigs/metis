/**
 * AgentService \u2014 CRUD + immutable versioning for the Phase 10 Agents library.
 *
 * Mirrors {@link SkillService} but persists agent personas. Each agent may
 * declare a list of `defaultSkills` (referenced by skill key) that the chat
 * runtime auto-loads when the user picks the agent for a session.
 *
 * The route handler enforces RBAC. This service enforces structural
 * invariants: defaultSkills must reference real, enabled skills; tools
 * referenced in the manifest are stored verbatim (the actual gating happens
 * in the Phase 4 ApprovalGate, never here \u2014 this is a hint).
 */
import type { Prisma, PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { bumpVersion, parseAgentSource, slugifyKey, type AgentFrontmatter } from "./frontmatter.js";
import { getToolRegistry, type ToolRegistry } from "../ai/tool-registry.js";
import { CHAT_CODE_TOOL_NAMES } from "../analysis/tools/chat-code-tool-names.js";
import { LOAD_SKILL_TOOL_NAME, SUBAGENT_TOOL_PREFIX } from "@metis/shared";
import { parseAgentRef } from "../agent-runtime/definition.js";
import { assertNoSecrets, DefinitionSecretError } from "../agent-runtime/secret-scan.js";

export class AgentServiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "AgentServiceError";
  }
}

export interface AgentActorRef {
  id: string;
  role?: string;
}
type ActorRef = AgentActorRef;

export interface AgentUpsertInput {
  key?: string;
  source: string;
  /** Skill keys to wire as `defaultSkills` for this agent. */
  defaultSkillKeys?: string[];
  origin?: string;
}

export interface AgentSummary {
  id: string;
  key: string;
  name: string;
  displayName: string;
  description: string;
  version: string;
  model: string;
  tools: string[];
  tags: string[];
  handoffs: string[];
  enabled: boolean;
  archived: boolean;
  source: string;
  contentSha256: string | null;
  defaultSkillKeys: string[];
  createdById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface AgentDetail extends AgentSummary {
  systemPrompt: string;
  manifest: AgentFrontmatter;
}

export interface AgentVersionSummary {
  id: string;
  version: string;
  contentSha256: string;
  createdById: string | null;
  createdAt: Date;
}

export interface AgentVersionDetail extends AgentVersionSummary {
  manifest: AgentFrontmatter;
  systemPrompt: string;
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

function fromManifest(raw: string): AgentFrontmatter {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as AgentFrontmatter;
    }
  } catch {
    // fall through
  }
  return { name: "unknown", description: "", version: "0.1.0" } as AgentFrontmatter;
}

export class AgentService {
  constructor(
    private readonly db: PrismaClient = defaultPrisma,
    private readonly toolRegistry: () => ToolRegistry = getToolRegistry,
  ) {}

  // ── Tool ref validation ─────────────────────────────────────────────
  /**
   * Issue #74 — agent tool refs must be validated at save time. Each
   * frontmatter `tools[]` entry must either:
   *   • match a registered tool exactly (e.g. `mcp:github:create_issue`,
   *     `read_file`), or
   *   • be a wildcard whitelist of an MCP namespace
   *     (`mcp:*` for every MCP-bridged tool, or `mcp:<server-label>:*` for
   *     all tools surfaced by one server).
   *
   * Plain `*` is rejected — every agent must enumerate either specific
   * tools or specific namespaces. Unknown refs raise
   * `AGENT_TOOL_REF_UNKNOWN` with the offending names so the UI can show
   * an actionable error.
   */
  private validateToolRefs(tools: readonly string[] | undefined): void {
    if (!tools || tools.length === 0) return;
    const registry = this.toolRegistry();
    // #142 — the chat code-search tools are offered by the tool runtime, not
    // the registry, but an agent's allowlist may still name them.
    const known = new Set([...registry.list().map((t) => t.name), ...CHAT_CODE_TOOL_NAMES]);
    const knownPrefixes = new Set<string>();
    for (const name of known) {
      if (name.startsWith("mcp:")) {
        const parts = name.split(":");
        if (parts.length >= 3) knownPrefixes.add(`mcp:${parts[1]}:*`);
      }
    }
    const unknown: string[] = [];
    for (const ref of tools) {
      if (ref === "mcp:*") continue; // entire MCP namespace blanket grant
      // Epic #129 — the agent tools: `load_skill` (#146) and sub-agents (#147):
      // `agent:*`, `agent:library:*`, `agent:custom:*`, or one agent's ref.
      if (ref === LOAD_SKILL_TOOL_NAME) continue;
      if (ref.startsWith(SUBAGENT_TOOL_PREFIX)) {
        const rest = ref.slice(SUBAGENT_TOOL_PREFIX.length);
        if (rest === "*" || rest === "library:*" || rest === "custom:*") continue;
        if (parseAgentRef(rest)) continue;
        unknown.push(ref);
        continue;
      }
      if (ref.endsWith(":*")) {
        // Namespace wildcard — accepted only if at least one tool with
        // that prefix is currently registered. This means agents can
        // reference `mcp:github:*` even if exact tool names rotate, but
        // typo'd prefixes still fail loudly.
        if (knownPrefixes.has(ref)) continue;
        unknown.push(ref);
        continue;
      }
      if (known.has(ref)) continue;
      unknown.push(ref);
    }
    if (unknown.length > 0) {
      throw new AgentServiceError(
        400,
        "AGENT_TOOL_REF_UNKNOWN",
        `tools[] references unknown tools: ${unknown.join(", ")}`,
      );
    }
  }

  /** Epic #129 — no credentials in text every chat and provider will see. */
  private assertNoSecrets(body: string, description: string | undefined): void {
    try {
      assertNoSecrets({ systemPrompt: body, description });
    } catch (err) {
      throw new AgentServiceError(
        400,
        "AGENT_CONTAINS_SECRET",
        (err as DefinitionSecretError).message,
      );
    }
  }

  // ── Read ────────────────────────────────────────────────────────────
  async list(
    opts: { tag?: string; query?: string; includeArchived?: boolean } = {},
  ): Promise<AgentSummary[]> {
    const where: Prisma.AgentWhereInput = {
      deletedAt: null,
      ...(opts.includeArchived ? {} : { archivedAt: null }),
      ...(opts.query
        ? {
            OR: [
              { name: { contains: opts.query } },
              { displayName: { contains: opts.query } },
              { description: { contains: opts.query } },
              { key: { contains: opts.query } },
            ],
          }
        : {}),
    };
    const rows = await this.db.agent.findMany({
      where,
      orderBy: { updatedAt: "desc" },
      include: { skills: { include: { skill: { select: { key: true } } } } },
    });
    const filtered = opts.tag
      ? rows.filter((r) => fromJsonArray(r.tags).includes(opts.tag!))
      : rows;
    return filtered.map((r) => this.toSummary(r));
  }

  async get(id: string): Promise<AgentDetail | null> {
    const row = await this.db.agent.findUnique({
      where: { id },
      include: { skills: { include: { skill: { select: { key: true } } } } },
    });
    if (!row || row.deletedAt) return null;
    return this.toDetail(row);
  }

  async getByKey(key: string): Promise<AgentDetail | null> {
    const row = await this.db.agent.findUnique({
      where: { key },
      include: { skills: { include: { skill: { select: { key: true } } } } },
    });
    if (!row || row.deletedAt) return null;
    return this.toDetail(row);
  }

  async listVersions(id: string): Promise<AgentVersionSummary[]> {
    const rows = await this.db.agentVersion.findMany({
      where: { agentId: id },
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

  async getVersion(id: string, versionId: string): Promise<AgentVersionDetail | null> {
    const row = await this.db.agentVersion.findFirst({ where: { id: versionId, agentId: id } });
    if (!row) return null;
    return {
      id: row.id,
      version: row.version,
      contentSha256: row.contentSha256,
      createdById: row.createdById,
      createdAt: row.createdAt,
      manifest: fromManifest(row.manifest),
      systemPrompt: row.systemPrompt,
    };
  }

  // ── Write ───────────────────────────────────────────────────────────
  private async resolveDefaultSkillIds(keys: readonly string[] | undefined): Promise<string[]> {
    if (!keys || keys.length === 0) return [];
    const dedup = Array.from(new Set(keys));
    const rows = await this.db.skill.findMany({
      where: { key: { in: dedup }, deletedAt: null },
      select: { id: true, key: true, enabled: true },
    });
    if (rows.length !== dedup.length) {
      const found = new Set(rows.map((r) => r.key));
      const missing = dedup.filter((k) => !found.has(k));
      throw new AgentServiceError(
        400,
        "SKILL_REF_NOT_FOUND",
        `defaultSkills reference unknown skill keys: ${missing.join(", ")}`,
      );
    }
    const disabled = rows.filter((r) => !r.enabled).map((r) => r.key);
    if (disabled.length > 0) {
      throw new AgentServiceError(
        400,
        "SKILL_REF_DISABLED",
        `defaultSkills reference disabled skills: ${disabled.join(", ")}`,
      );
    }
    return rows.map((r) => r.id);
  }

  async create(input: AgentUpsertInput, actor: ActorRef): Promise<AgentDetail> {
    const parsed = parseAgentSource(input.source);
    this.validateToolRefs(parsed.frontmatter.tools);
    this.assertNoSecrets(parsed.body, parsed.frontmatter.description);
    const key = input.key ?? slugifyKey(parsed.frontmatter.name);
    const existing = await this.db.agent.findUnique({ where: { key } });
    if (existing && !existing.deletedAt) {
      throw new AgentServiceError(409, "AGENT_KEY_EXISTS", `Agent key '${key}' is already in use`);
    }
    const skillIds = await this.resolveDefaultSkillIds(input.defaultSkillKeys);
    const manifestJson = JSON.stringify(parsed.frontmatter);
    const data: Prisma.AgentCreateInput = {
      key,
      name: parsed.frontmatter.name,
      displayName: parsed.frontmatter.displayName ?? "",
      description: parsed.frontmatter.description ?? "",
      model: parsed.frontmatter.model ?? "",
      systemPrompt: parsed.body,
      tools: toJsonArray(parsed.frontmatter.tools),
      tags: toJsonArray(parsed.frontmatter.tags),
      handoffs: toJsonArray(parsed.frontmatter.handoffs),
      manifest: manifestJson,
      version: parsed.frontmatter.version ?? "0.1.0",
      // Epic #129 (#145) — the definition fields the frontmatter now carries.
      reasoningEffort: parsed.frontmatter.reasoningEffort ?? null,
      approvalPolicy: parsed.frontmatter.approvalPolicy
        ? JSON.stringify(parsed.frontmatter.approvalPolicy)
        : null,
      contentSha256: parsed.contentSha256,
      source: input.origin ?? "inline",
      ...(actor.id ? { createdBy: { connect: { id: actor.id } } } : {}),
      versions: {
        create: {
          version: parsed.frontmatter.version ?? "0.1.0",
          manifest: manifestJson,
          systemPrompt: parsed.body,
          contentSha256: parsed.contentSha256,
          ...(actor.id ? { createdBy: { connect: { id: actor.id } } } : {}),
        },
      },
      ...(skillIds.length > 0
        ? { skills: { create: skillIds.map((sid) => ({ skill: { connect: { id: sid } } })) } }
        : {}),
    };
    const row = existing
      ? await this.db.$transaction(async (tx) => {
          await tx.agentSkill.deleteMany({ where: { agentId: existing.id } });
          return tx.agent.update({
            where: { id: existing.id },
            data: {
              ...data,
              createdBy: undefined,
              deletedAt: null,
              archivedAt: null,
              enabled: true,
            },
            include: { skills: { include: { skill: { select: { key: true } } } } },
          });
        })
      : await this.db.agent.create({
          data,
          include: { skills: { include: { skill: { select: { key: true } } } } },
        });
    audit({
      actor: { id: actor.id },
      action: "agent.create",
      target: { type: "agent", id: row.id },
      metadata: {
        key: row.key,
        version: row.version,
        contentSha256: row.contentSha256,
        defaultSkills: input.defaultSkillKeys ?? [],
      },
    });
    return this.toDetail(row);
  }

  async update(id: string, input: AgentUpsertInput, actor: ActorRef): Promise<AgentDetail> {
    const existing = await this.db.agent.findUnique({
      where: { id },
      include: { versions: true, skills: { include: { skill: { select: { key: true } } } } },
    });
    if (!existing || existing.deletedAt) {
      throw new AgentServiceError(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    const parsed = parseAgentSource(input.source);
    if (parsed.contentSha256 === existing.contentSha256 && input.defaultSkillKeys === undefined) {
      throw new AgentServiceError(
        409,
        "AGENT_NO_CHANGE",
        "Source is identical to the current version \u2014 nothing to save",
      );
    }
    this.validateToolRefs(parsed.frontmatter.tools);
    this.assertNoSecrets(parsed.body, parsed.frontmatter.description);
    const versions = new Set(existing.versions.map((v) => v.version));
    const proposed = parsed.frontmatter.version ?? existing.version;
    const nextVersion =
      parsed.contentSha256 === existing.contentSha256
        ? existing.version
        : versions.has(proposed)
          ? bumpVersion(proposed, versions)
          : proposed;
    const manifestJson = JSON.stringify({ ...parsed.frontmatter, version: nextVersion });
    const skillIds =
      input.defaultSkillKeys !== undefined
        ? await this.resolveDefaultSkillIds(input.defaultSkillKeys)
        : null;
    const updated = await this.db.$transaction(async (tx) => {
      if (skillIds !== null) {
        await tx.agentSkill.deleteMany({ where: { agentId: id } });
      }
      return tx.agent.update({
        where: { id },
        data: {
          name: parsed.frontmatter.name,
          displayName: parsed.frontmatter.displayName ?? existing.displayName,
          description: parsed.frontmatter.description ?? "",
          model: parsed.frontmatter.model ?? existing.model,
          systemPrompt: parsed.body,
          tools: toJsonArray(parsed.frontmatter.tools),
          tags: toJsonArray(parsed.frontmatter.tags),
          handoffs: toJsonArray(parsed.frontmatter.handoffs),
          manifest: manifestJson,
          version: nextVersion,
          reasoningEffort: parsed.frontmatter.reasoningEffort ?? null,
          approvalPolicy: parsed.frontmatter.approvalPolicy
            ? JSON.stringify(parsed.frontmatter.approvalPolicy)
            : null,
          contentSha256: parsed.contentSha256,
          source: input.origin ?? existing.source,
          ...(parsed.contentSha256 !== existing.contentSha256
            ? {
                versions: {
                  create: {
                    version: nextVersion,
                    manifest: manifestJson,
                    systemPrompt: parsed.body,
                    contentSha256: parsed.contentSha256,
                    ...(actor.id ? { createdBy: { connect: { id: actor.id } } } : {}),
                  },
                },
              }
            : {}),
          ...(skillIds !== null && skillIds.length > 0
            ? {
                skills: {
                  create: skillIds.map((sid) => ({ skill: { connect: { id: sid } } })),
                },
              }
            : {}),
        },
        include: { skills: { include: { skill: { select: { key: true } } } } },
      });
    });
    audit({
      actor: { id: actor.id },
      action: "agent.update",
      target: { type: "agent", id: updated.id },
      metadata: {
        key: updated.key,
        previousVersion: existing.version,
        version: updated.version,
        contentSha256: updated.contentSha256,
      },
    });
    return this.toDetail(updated);
  }

  async setEnabled(id: string, enabled: boolean, actor: ActorRef): Promise<AgentDetail> {
    const existing = await this.db.agent.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new AgentServiceError(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    const updated = await this.db.agent.update({
      where: { id },
      data: { enabled },
      include: { skills: { include: { skill: { select: { key: true } } } } },
    });
    audit({
      actor: { id: actor.id },
      action: enabled ? "agent.enable" : "agent.disable",
      target: { type: "agent", id },
      metadata: { key: existing.key },
    });
    return this.toDetail(updated);
  }

  async archive(id: string, actor: ActorRef): Promise<AgentDetail> {
    const existing = await this.db.agent.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new AgentServiceError(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    const updated = await this.db.agent.update({
      where: { id },
      data: { archivedAt: new Date(), enabled: false },
      include: { skills: { include: { skill: { select: { key: true } } } } },
    });
    audit({
      actor: { id: actor.id },
      action: "agent.archive",
      target: { type: "agent", id },
      metadata: { key: existing.key },
    });
    return this.toDetail(updated);
  }

  async remove(id: string, actor: ActorRef): Promise<void> {
    const existing = await this.db.agent.findUnique({ where: { id } });
    if (!existing || existing.deletedAt) {
      throw new AgentServiceError(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    await this.db.agent.update({
      where: { id },
      data: { deletedAt: new Date(), enabled: false },
    });
    audit({
      actor: { id: actor.id },
      action: "agent.delete",
      target: { type: "agent", id },
      metadata: { key: existing.key },
    });
  }

  async diff(
    id: string,
    leftVersionId: string,
    rightVersionId: string,
  ): Promise<{ left: AgentVersionDetail | null; right: AgentVersionDetail | null }> {
    const [left, right] = await Promise.all([
      this.getVersion(id, leftVersionId),
      this.getVersion(id, rightVersionId),
    ]);
    return { left, right };
  }

  // ── Mappers ─────────────────────────────────────────────────────────
  private toSummary(row: {
    id: string;
    key: string;
    name: string;
    displayName: string;
    description: string;
    version: string;
    model: string;
    tools: string;
    tags: string;
    handoffs: string;
    enabled: boolean;
    archivedAt: Date | null;
    source: string;
    contentSha256: string | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
    skills?: Array<{ skill: { key: string } }>;
  }): AgentSummary {
    return {
      id: row.id,
      key: row.key,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      version: row.version,
      model: row.model,
      tools: fromJsonArray(row.tools),
      tags: fromJsonArray(row.tags),
      handoffs: fromJsonArray(row.handoffs),
      enabled: row.enabled,
      archived: row.archivedAt !== null,
      source: row.source,
      contentSha256: row.contentSha256,
      defaultSkillKeys: (row.skills ?? []).map((s) => s.skill.key),
      createdById: row.createdById,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  private toDetail(row: {
    id: string;
    key: string;
    name: string;
    displayName: string;
    description: string;
    version: string;
    model: string;
    systemPrompt: string;
    tools: string;
    tags: string;
    handoffs: string;
    manifest: string;
    enabled: boolean;
    archivedAt: Date | null;
    source: string;
    contentSha256: string | null;
    createdById: string | null;
    createdAt: Date;
    updatedAt: Date;
    skills?: Array<{ skill: { key: string } }>;
  }): AgentDetail {
    return {
      ...this.toSummary(row),
      systemPrompt: row.systemPrompt,
      manifest: fromManifest(row.manifest),
    };
  }
}

let singleton: AgentService | null = null;
export function getAgentService(): AgentService {
  if (!singleton) singleton = new AgentService();
  return singleton;
}
export function __setAgentService(svc: AgentService | null): void {
  singleton = svc;
}
