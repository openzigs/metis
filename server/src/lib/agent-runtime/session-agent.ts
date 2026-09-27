/**
 * #236 — a chat session's OWN agent, of either kind.
 *
 * A session binds a library agent through `ai_sessions.agentId` (a foreign key
 * to `agents`) or a project custom agent through `ai_sessions.agentRef`
 * (`custom:<id>`, not a foreign key). Both are read here, through the one
 * definition (`definition.ts`), so a custom agent's persona, tool allowlist,
 * approval override, skills and model apply exactly as a library agent's do.
 *
 * A custom agent is re-checked on EVERY turn: it must still exist and still be
 * owned by, or enabled for, the session's project. When it is not, the session
 * fails CLOSED — no persona and an empty allowlist (no tools) — the rule a
 * deleted library agent already follows.
 */
import type { AgentDefinitionDto, ApprovalPolicyOverride } from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { readStoredOverride } from "./policy.js";
import {
  customDefinition,
  isCustomAgentUsableInProject,
  libraryDefinition,
  loadAgentDefinition,
  parseAgentRef,
} from "./definition.js";

const log = createChildLogger("session-agent");

export interface SessionAgentBinding {
  agentId: string | null;
  agentRef?: string | null;
  projectId?: string | null;
}

export interface SessionAgent {
  /** `library:<id>` / `custom:<id>`, or `null` when the session has no agent. */
  ref: string | null;
  /**
   * A bound CUSTOM agent's definition (`null` for a library agent — its persona
   * is rendered by `SessionRuntime` — or when the agent can no longer be used).
   */
  definition: AgentDefinitionDto | null;
  /**
   * The tool allowlist the session gate enforces: `null` = none declared (a
   * library agent with no `tools`, or no agent); `[]` = nothing allowed (a
   * custom agent with no tools, or an agent that can no longer be read).
   */
  allowlist: string[] | null;
  approvalOverride: ApprovalPolicyOverride | null;
}

const NONE: SessionAgent = { ref: null, definition: null, allowlist: null, approvalOverride: null };

/** The session's agent ref: its custom `agentRef`, else its library `agentId`. */
export function sessionAgentRef(s: SessionAgentBinding): string | null {
  if (s.agentRef) return s.agentRef;
  return s.agentId ? `library:${s.agentId}` : null;
}

function jsonToolRefs(raw: string | null | undefined): string[] {
  const parsed: unknown = JSON.parse(raw ?? "[]");
  return Array.isArray(parsed)
    ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
    : [];
}

function closed(ref: string): SessionAgent {
  return { ref, definition: null, allowlist: [], approvalOverride: null };
}

/**
 * Read a CUSTOM agent bound to a session and check the session's project may
 * still use it. `null` = gone or no longer usable.
 */
export async function loadBoundCustomAgent(
  agentRef: string,
  projectId: string | null | undefined,
  db: PrismaClient = defaultPrisma,
): Promise<AgentDefinitionDto | null> {
  const parsed = parseAgentRef(agentRef);
  if (!parsed || parsed.kind !== "custom" || !projectId) return null;
  const def = await loadAgentDefinition(agentRef, db);
  if (!def || !(await isCustomAgentUsableInProject(def, projectId, db))) return null;
  return def;
}

/**
 * The session agent's definition, allowlist and approval override — read once
 * per turn. The library branch keeps the #142 semantics exactly: a library
 * agent's empty `tools` declares no allowlist; an unreadable one fails closed.
 */
export async function loadSessionAgent(
  s: SessionAgentBinding,
  db: PrismaClient = defaultPrisma,
): Promise<SessionAgent> {
  const ref = sessionAgentRef(s);
  if (!ref) return NONE;
  try {
    if (s.agentRef) {
      const def = await loadBoundCustomAgent(s.agentRef, s.projectId, db);
      if (!def) {
        log.warn("Session custom agent unavailable; offering no tools", { agentRef: s.agentRef });
        return closed(ref);
      }
      return {
        ref,
        definition: def,
        allowlist: [...(def.toolAllowlist ?? [])],
        approvalOverride: def.approvalPolicy,
      };
    }
    const row = (await db.agent.findFirst({
      where: { id: s.agentId! },
      select: { tools: true, approvalPolicy: true },
    })) as { tools?: string | null; approvalPolicy?: string | null } | null;
    if (!row) return closed(ref);
    const refs = jsonToolRefs(row.tools);
    return {
      ref,
      // The library persona is rendered by `SessionRuntime.resolveAgentForSession`.
      definition: null,
      allowlist: refs.length > 0 ? refs : null,
      approvalOverride: readStoredOverride(row.approvalPolicy ?? null),
    };
  } catch (err) {
    log.warn("Session agent unreadable; offering no tools", {
      ref,
      error: (err as Error).message,
    });
    return closed(ref);
  }
}

/** One agent a chat session may bind (the picker's list — #236). */
export interface BindableAgent {
  ref: string;
  kind: "library" | "custom";
  key: string;
  name: string;
  description: string;
}

/**
 * The agents a chat session may bind: every enabled library agent (the library
 * binding rule is unchanged), then — for a project session — the custom agents
 * the project owns or has enabled. ONE list for the one picker.
 */
export async function listBindableAgents(
  projectId: string | null,
  db: PrismaClient = defaultPrisma,
): Promise<BindableAgent[]> {
  const library = await db.agent.findMany({
    where: { deletedAt: null, archivedAt: null, enabled: true },
    orderBy: { key: "asc" },
  });
  const out: BindableAgent[] = library.map((r) => {
    const d = libraryDefinition(r);
    return { ref: d.ref, kind: "library", key: d.key, name: d.name, description: d.description };
  });
  if (!projectId) return out;
  const enabled = await db.customAgentEnablement.findMany({
    where: { projectId, enabled: true },
    select: { customAgentId: true },
  });
  const custom = await db.customAgent.findMany({
    where: { OR: [{ projectId }, { id: { in: enabled.map((e) => e.customAgentId) } }] },
    orderBy: { name: "asc" },
  });
  for (const r of custom) {
    const d = customDefinition(r);
    out.push({ ref: d.ref, kind: "custom", key: d.key, name: d.name, description: d.description });
  }
  return out;
}
