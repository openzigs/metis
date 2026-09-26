/**
 * Runtime helpers that wire Phase 10 Skills + Agents into the Phase 4 chat
 * pipeline.
 *
 * Two responsibilities:
 *
 *   1. {@link loadSkillIntoSession} \u2014 the implementation behind the
 *      `load-skill` tool. Idempotent per session (loading the same skill
 *      twice is a no-op), records to AuditLog, returns the system-block
 *      content the chat route should append.
 *
 *      ENFORCEMENT: when the target session is bound to a project, the
 *      project's `ProjectSkillAllowlist` is consulted. Skills not in the
 *      allow-list are rejected with `PROJECT_SKILL_NOT_ALLOWED` (HTTP 403).
 *      Sessions without a project bypass the check (the global library
 *      acts as the allow-list).
 *
 *   2. {@link resolveAgentForSession} \u2014 reads an Agent + its default
 *      skills, returns the system message and the loaded skill ids the
 *      session should be initialised with. The chat route persists the
 *      result onto the AISession row.
 */
import type { PrismaClient } from "@prisma/client";
import path from "node:path";
import fs from "node:fs/promises";
import { prisma as defaultPrisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { AgentService, getAgentService, type AgentActorRef as ActorRef } from "./agent-service.js";
import { SkillService, getSkillService } from "./skill-service.js";
import { ProjectLibraryAllowlistService, getProjectLibraryAllowlist } from "./project-allowlist.js";
import { normalizeSkillFilePath } from "../agent-runtime/skills.js";

export class SessionRuntimeError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(`[${code}] ${message}`);
    this.name = "SessionRuntimeError";
  }
}

export interface LoadSkillInput {
  sessionId: string;
  /** Lookup may be by id or key \u2014 keys are friendlier from the UI. */
  skillId?: string;
  skillKey?: string;
}

export interface LoadSkillResult {
  alreadyLoaded: boolean;
  skillId: string;
  skillKey: string;
  systemBlock: string;
  loadedSkillIds: string[];
}

interface SessionRuntimeDeps {
  db?: PrismaClient;
  skillService?: SkillService;
  agentService?: AgentService;
  allowlist?: ProjectLibraryAllowlistService;
}

function parseLoadedIds(raw: string): string[] {
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

export class SessionRuntime {
  private readonly db: PrismaClient;
  private readonly skills: SkillService;
  private readonly agents: AgentService;
  private readonly allowlist: ProjectLibraryAllowlistService;

  constructor(deps: SessionRuntimeDeps = {}) {
    this.db = deps.db ?? defaultPrisma;
    this.skills = deps.skillService ?? getSkillService();
    this.agents = deps.agentService ?? getAgentService();
    this.allowlist = deps.allowlist ?? getProjectLibraryAllowlist();
  }

  /**
   * Inject a skill's instructions into a session. No-op when the same skill
   * is requested twice. Returns the system block the chat route should append
   * to the prompt and the updated `loadedSkillIds` array (already persisted).
   */
  async loadSkillIntoSession(input: LoadSkillInput, actor: ActorRef): Promise<LoadSkillResult> {
    if (!input.skillId && !input.skillKey) {
      throw new SessionRuntimeError(
        400,
        "SKILL_REF_REQUIRED",
        "Either skillId or skillKey is required",
      );
    }
    const skill = input.skillId
      ? await this.skills.get(input.skillId)
      : await this.skills.getByKey(input.skillKey!);
    if (!skill) {
      throw new SessionRuntimeError(404, "SKILL_NOT_FOUND", "Skill not found");
    }
    if (!skill.enabled || skill.archived) {
      throw new SessionRuntimeError(
        409,
        "SKILL_NOT_AVAILABLE",
        `Skill '${skill.key}' is not enabled`,
      );
    }
    const session = await this.db.aISession.findFirst({
      where: { id: input.sessionId, userId: actor.id, deletedAt: null },
    });
    if (!session) {
      throw new SessionRuntimeError(404, "SESSION_NOT_FOUND", "Session not found");
    }
    // Phase 10 review fix — enforce per-project skill allow-list. Sessions
    // bound to a project may only load skills the project owner has enabled.
    // Sessions without a project (ad-hoc chat) bypass the check; the global
    // library is the authoritative allow-list there.
    if (session.projectId) {
      const allowed = await this.allowlist.resolveAllowedSkillIds(session.projectId);
      if (!allowed.has(skill.id)) {
        throw new SessionRuntimeError(
          403,
          "PROJECT_SKILL_NOT_ALLOWED",
          `Skill '${skill.key}' is not enabled for this project`,
        );
      }
    }
    const loaded = parseLoadedIds(session.loadedSkillIds);
    const systemBlock = renderSkillSystemBlock(skill);
    if (loaded.includes(skill.id)) {
      audit({
        actor: { id: actor.id },
        action: "skill.load.noop",
        target: { type: "ai_session", id: session.id },
        metadata: { skillId: skill.id, skillKey: skill.key },
      });
      return {
        alreadyLoaded: true,
        skillId: skill.id,
        skillKey: skill.key,
        systemBlock,
        loadedSkillIds: loaded,
      };
    }
    const next = [...loaded, skill.id];
    await this.db.aISession.update({
      where: { id: session.id },
      data: { loadedSkillIds: JSON.stringify(next) },
    });
    audit({
      actor: { id: actor.id },
      action: "skill.load",
      target: { type: "ai_session", id: session.id },
      metadata: {
        skillId: skill.id,
        skillKey: skill.key,
        version: skill.version,
        contentSha256: skill.contentSha256,
      },
    });
    return {
      alreadyLoaded: false,
      skillId: skill.id,
      skillKey: skill.key,
      systemBlock,
      loadedSkillIds: next,
    };
  }

  async listLoadedSkills(
    sessionId: string,
    actor: ActorRef,
  ): Promise<Array<{ id: string; key: string; name: string; version: string }>> {
    const session = await this.db.aISession.findFirst({
      where: { id: sessionId, userId: actor.id, deletedAt: null },
    });
    if (!session) {
      throw new SessionRuntimeError(404, "SESSION_NOT_FOUND", "Session not found");
    }
    const ids = parseLoadedIds(session.loadedSkillIds);
    if (ids.length === 0) return [];
    const rows = await this.db.skill.findMany({
      where: { id: { in: ids }, deletedAt: null },
      select: { id: true, key: true, name: true, version: true },
    });
    // Preserve the load order recorded on the session.
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is { id: string; key: string; name: string; version: string } => Boolean(r));
  }

  /**
   * Resolve an agent reference into the system message + auto-loaded skill
   * ids needed to start a new session under that persona. The caller (chat
   * route) is expected to persist these onto the AISession row.
   */
  async resolveAgentForSession(input: { agentId?: string; agentKey?: string }): Promise<{
    agent: { id: string; key: string; name: string; version: string; model: string };
    systemMessage: string;
    autoLoadedSkillIds: string[];
    autoLoadedSkillBlocks: string[];
  }> {
    if (!input.agentId && !input.agentKey) {
      throw new SessionRuntimeError(
        400,
        "AGENT_REF_REQUIRED",
        "Either agentId or agentKey is required",
      );
    }
    const agent = input.agentId
      ? await this.agents.get(input.agentId)
      : await this.agents.getByKey(input.agentKey!);
    if (!agent) {
      throw new SessionRuntimeError(404, "AGENT_NOT_FOUND", "Agent not found");
    }
    if (!agent.enabled || agent.archived) {
      throw new SessionRuntimeError(
        409,
        "AGENT_NOT_AVAILABLE",
        `Agent '${agent.key}' is not enabled`,
      );
    }
    const systemMessage = renderAgentSystemMessage(agent);
    const skillIds: string[] = [];
    const skillBlocks: string[] = [];
    for (const skillKey of agent.defaultSkillKeys) {
      const skill = await this.skills.getByKey(skillKey);
      if (!skill || !skill.enabled || skill.archived) continue;
      skillIds.push(skill.id);
      skillBlocks.push(renderSkillSystemBlock(skill));
    }
    return {
      agent: {
        id: agent.id,
        key: agent.key,
        name: agent.name,
        version: agent.version,
        model: agent.model,
      },
      systemMessage,
      autoLoadedSkillIds: skillIds,
      autoLoadedSkillBlocks: skillBlocks,
    };
  }

  /**
   * Issue #113 — materialize the session's loaded skills into the provider's
   * `$COPILOT_HOME/skills/<key>/SKILL.md` layout so the GitHub Copilot SDK
   * picks them up natively via `SessionConfig.skillDirectories`.
   *
   * Behaviour:
   *   • Returns the absolute path to the `skills/` directory so the caller
   *     can pass it as `skillDirectories: [<path>]` to the SDK.
   *   • Always rewrites the directory tree to match the current loaded set
   *     (stale skill folders from prior loads are removed first).
   *   • Honours `disabledSkillKeys` — those folders are NOT written even if
   *     they appear in `loadedSkillIds` (the SDK then refuses to inject them).
   *   • Reconstructs the original frontmatter+body verbatim from the
   *     persisted `source` so the SDK sees the exact content the admin
   *     authored. Falls back to a synthesised SKILL.md when `source` is
   *     missing (e.g. older rows pre-Phase-10.1).
   *
   * Returns `{ skillsDir, written, disabledSkills }`.
   */
  async materializeSkillsForSession(input: {
    sessionId: string;
    copilotHome: string;
    loadedSkillIds: readonly string[];
    disabledSkillKeys?: readonly string[];
  }): Promise<{ skillsDir: string; written: string[]; disabledSkills: string[] }> {
    const skillsDir = path.join(input.copilotHome, "skills");
    // Always start from a clean slate so removing a skill from the session
    // really removes it from the SDK's view.
    await fs.rm(skillsDir, { recursive: true, force: true });
    if (input.loadedSkillIds.length === 0) {
      await fs.mkdir(skillsDir, { recursive: true });
      return { skillsDir, written: [], disabledSkills: [...(input.disabledSkillKeys ?? [])] };
    }
    const disabled = new Set(input.disabledSkillKeys ?? []);
    const rows = await this.db.skill.findMany({
      where: { id: { in: [...input.loadedSkillIds] }, deletedAt: null, enabled: true },
    });
    const byId = new Map(rows.map((r) => [r.id, r]));
    await fs.mkdir(skillsDir, { recursive: true });
    const written: string[] = [];
    const skipped: string[] = [];
    for (const id of input.loadedSkillIds) {
      const row = byId.get(id);
      if (!row) continue;
      if (disabled.has(row.key)) {
        skipped.push(row.key);
        continue;
      }
      const dir = path.join(skillsDir, row.key);
      await fs.mkdir(dir, { recursive: true });
      // Reconstruct SKILL.md from the persisted manifest + body. The Skill
      // row's `source` column tracks the origin (e.g. "inline", repo URL),
      // not the original file contents, so we re-emit a canonical YAML
      // frontmatter doc the SDK can parse with its own loader.
      const file = path.join(dir, "SKILL.md");
      const content = synthesizeSkillFile(row);
      await fs.writeFile(file, content, "utf-8");
      // Epic #129 (#146) — an Agent Skills directory keeps its supporting files
      // (`references/…`). Each path was validated on import and is re-checked
      // here, so nothing can be written outside the skill's own directory.
      const files =
        (await this.db.skillFile?.findMany({
          where: { skillId: row.id },
          select: { path: true, content: true },
        })) ?? [];
      for (const f of files) {
        const rel = normalizeSkillFilePath(f.path);
        if (!rel) continue;
        const target = path.join(dir, ...rel.split("/"));
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, f.content, "utf-8");
      }
      written.push(row.key);
    }
    return { skillsDir, written, disabledSkills: [...disabled, ...skipped] };
  }
}

function synthesizeSkillFile(row: {
  name: string;
  description: string;
  version: string;
  instructions: string;
  manifest?: string;
}): string {
  // Best effort: replay the original frontmatter when available so tools/tags
  // declared by the admin survive the round trip; fall back to the minimum
  // viable shape otherwise.
  let extra = "";
  if (row.manifest) {
    try {
      const m = JSON.parse(row.manifest) as Record<string, unknown>;
      if (Array.isArray(m.tools) && m.tools.length > 0) {
        extra += `tools: ${JSON.stringify(m.tools)}\n`;
      }
      if (Array.isArray(m.tags) && m.tags.length > 0) {
        extra += `tags: ${JSON.stringify(m.tags)}\n`;
      }
      if (Array.isArray(m.resources) && m.resources.length > 0) {
        extra += `resources: ${JSON.stringify(m.resources)}\n`;
      }
    } catch {
      // ignore — the synthetic minimum below is still valid YAML.
    }
  }
  const fm = [
    "---",
    `name: ${JSON.stringify(row.name)}`,
    `description: ${JSON.stringify(row.description)}`,
    `version: ${JSON.stringify(row.version)}`,
    extra.trim(),
    "---",
    "",
  ]
    .filter((line) => line.length > 0 || true)
    .join("\n");
  return fm + row.instructions + (row.instructions.endsWith("\n") ? "" : "\n");
}

export function renderSkillSystemBlock(skill: {
  key: string;
  name: string;
  version: string;
  description: string;
  instructions: string;
}): string {
  const header = `[skill:${skill.key}@${skill.version}] ${skill.name}`;
  const desc = skill.description ? `\n${skill.description}` : "";
  const body = skill.instructions.trim();
  return body.length === 0 ? `${header}${desc}` : `${header}${desc}\n\n${body}`;
}

export function renderAgentSystemMessage(agent: {
  key: string;
  name: string;
  displayName: string;
  version: string;
  description: string;
  systemPrompt: string;
}): string {
  const label = agent.displayName || agent.name;
  const header = `[agent:${agent.key}@${agent.version}] ${label}`;
  const desc = agent.description ? `\n${agent.description}` : "";
  const body = agent.systemPrompt.trim();
  return body.length === 0 ? `${header}${desc}` : `${header}${desc}\n\n${body}`;
}

let singleton: SessionRuntime | null = null;
export function getSessionRuntime(): SessionRuntime {
  if (!singleton) singleton = new SessionRuntime();
  return singleton;
}
export function __setSessionRuntime(runtime: SessionRuntime | null): void {
  singleton = runtime;
}
