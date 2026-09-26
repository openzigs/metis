/**
 * Epic #129 (#145) — ONE agent definition for both kinds of agent.
 *
 * METIS keeps two agent stores: the admin-managed library (`agents`, authored
 * as `*.agent.md` frontmatter, versioned, with default skills) and project
 * custom agents (`custom_agents`, authored in the wizard or imported as JSON).
 * Every runtime — the chat session's persona, a sub-agent call, the analysis
 * custom-agent phase and the playground — reads an agent ONLY through
 * {@link AgentDefinitionDto}, resolved here. That is what "one definition"
 * means: one shape (persona, skills, tool allowlist, model, approval policy,
 * version) and one loader, whichever table the row lives in.
 *
 * Tool allowlist semantics per kind (both are the stores' existing meaning):
 *   • library — an empty `tools` list declares NO allowlist (`null`), as the
 *     #142 gate has always read it;
 *   • custom  — `tools` is the list the agent "is permitted to call", so an
 *     empty list means NO tools (`[]`).
 */
import type {
  AgentDefinitionDto,
  AgentKind,
  AgentRef,
  ApprovalPolicyOverride,
  SdkReasoningEffort,
} from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { lookupCatalogEntry } from "../ai/model-catalog.js";
import { readStoredOverride } from "./policy.js";

const REASONING = new Set(["low", "medium", "high"]);

export function agentRef(kind: AgentKind, id: string): AgentRef {
  return `${kind}:${id}`;
}

/** Parse `library:<id>` / `custom:<id>`; `null` for anything else. */
export function parseAgentRef(raw: unknown): { kind: AgentKind; id: string } | null {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const m = /^(library|custom):([A-Za-z0-9_-]{1,128})$/.exec(raw);
  return m ? { kind: m[1] as AgentKind, id: m[2]! } : null;
}

function jsonStrings(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
  } catch {
    return [];
  }
}

function effort(raw: string | null | undefined): SdkReasoningEffort | null {
  return raw && REASONING.has(raw) ? (raw as SdkReasoningEffort) : null;
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "agent"
  );
}

export interface LibraryAgentRow {
  id: string;
  key: string;
  name: string;
  displayName: string;
  description: string;
  systemPrompt: string;
  tools: string;
  model: string;
  version: string;
  reasoningEffort?: string | null;
  approvalPolicy?: string | null;
  skills?: Array<{ skill: { key: string } }>;
}

export interface CustomAgentRow {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string;
  model: string | null;
  reasoningEffort: string | null;
  skillKeys?: string | null;
  approvalPolicy?: string | null;
  version?: string | null;
}

export function libraryDefinition(row: LibraryAgentRow): AgentDefinitionDto {
  const tools = jsonStrings(row.tools);
  return {
    ref: agentRef("library", row.id),
    kind: "library",
    id: row.id,
    key: row.key,
    name: row.displayName || row.name,
    description: row.description,
    persona: row.systemPrompt,
    skillKeys: (row.skills ?? []).map((s) => s.skill.key),
    toolAllowlist: tools.length > 0 ? tools : null,
    model: row.model ? row.model : null,
    reasoningEffort: effort(row.reasoningEffort),
    approvalPolicy: readStoredOverride(row.approvalPolicy),
    version: row.version,
    projectId: null,
  };
}

export function customDefinition(row: CustomAgentRow): AgentDefinitionDto {
  return {
    ref: agentRef("custom", row.id),
    kind: "custom",
    id: row.id,
    key: slug(row.name),
    name: row.name,
    description: row.description,
    persona: row.systemPrompt,
    skillKeys: jsonStrings(row.skillKeys),
    toolAllowlist: jsonStrings(row.tools),
    model: row.model ? row.model : null,
    reasoningEffort: effort(row.reasoningEffort),
    approvalPolicy: readStoredOverride(row.approvalPolicy),
    version: row.version || "1.0.0",
    projectId: row.projectId,
  };
}

/** A custom agent already read through the custom-agents service. */
export function customDtoDefinition(dto: {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string | null;
  reasoningEffort?: string | null;
  skillKeys?: string[];
  approvalPolicy?: ApprovalPolicyOverride | null;
  version?: string;
}): AgentDefinitionDto {
  return customDefinition({
    id: dto.id,
    projectId: dto.projectId,
    name: dto.name,
    description: dto.description,
    systemPrompt: dto.systemPrompt,
    tools: JSON.stringify(dto.tools ?? []),
    model: dto.model ?? null,
    reasoningEffort: dto.reasoningEffort ?? null,
    skillKeys: JSON.stringify(dto.skillKeys ?? []),
    approvalPolicy: dto.approvalPolicy ? JSON.stringify(dto.approvalPolicy) : null,
    version: dto.version ?? null,
  });
}

const LIBRARY_INCLUDE = { skills: { include: { skill: { select: { key: true } } } } } as const;

/**
 * Load one agent by ref. Returns `null` when it does not exist or cannot run
 * (library: deleted, archived or disabled). Scope checks — may THIS project
 * use it — are the caller's job ({@link isAgentUsableInProject}).
 */
export async function loadAgentDefinition(
  ref: string,
  db: PrismaClient = defaultPrisma,
): Promise<AgentDefinitionDto | null> {
  const parsed = parseAgentRef(ref);
  if (!parsed) return null;
  if (parsed.kind === "library") {
    const row = await db.agent.findUnique({ where: { id: parsed.id }, include: LIBRARY_INCLUDE });
    if (!row || row.deletedAt || row.archivedAt || !row.enabled) return null;
    return libraryDefinition(row);
  }
  const row = await db.customAgent.findUnique({ where: { id: parsed.id } });
  return row ? customDefinition(row) : null;
}

/**
 * The agents a project's chat may call as sub-agents (#147):
 *   • custom agents OWNED by the project or ENABLED for it (the invoke/ACP rule);
 *   • library agents with an explicit, enabled `ProjectAgentAllowlist` row.
 *     The library's "no rows ⇒ everything" picker default is deliberately NOT
 *     used here: exposing every library agent as a tool is an opt-in, not a
 *     side effect of installing an agent.
 */
export async function listCallableAgents(
  projectId: string,
  opts: { db?: PrismaClient; limit?: number } = {},
): Promise<AgentDefinitionDto[]> {
  const db = opts.db ?? defaultPrisma;
  const limit = opts.limit ?? 16;
  const enabledCustom = await db.customAgentEnablement.findMany({
    where: { projectId, enabled: true },
    select: { customAgentId: true },
  });
  const custom = await db.customAgent.findMany({
    where: {
      OR: [{ projectId }, { id: { in: enabledCustom.map((e) => e.customAgentId) } }],
    },
    orderBy: { name: "asc" },
  });
  const allowRows = await db.projectAgentAllowlist.findMany({
    where: { projectId, enabled: true },
    select: { agentId: true },
  });
  const library =
    allowRows.length === 0
      ? []
      : await db.agent.findMany({
          where: {
            id: { in: allowRows.map((r) => r.agentId) },
            deletedAt: null,
            archivedAt: null,
            enabled: true,
          },
          include: LIBRARY_INCLUDE,
          orderBy: { key: "asc" },
        });
  return [...library.map(libraryDefinition), ...custom.map(customDefinition)].slice(0, limit);
}

/**
 * The model an agent runs on: its preferred model when the model catalog knows
 * it for this provider (#135 — a name the catalog cannot vouch for is never
 * sent), otherwise the caller's model.
 */
export function resolveAgentModel(
  providerKey: string,
  preferred: string | null | undefined,
  fallback: string,
): { model: string; usedPreferred: boolean } {
  if (preferred && preferred !== fallback && lookupCatalogEntry(providerKey, preferred)) {
    return { model: preferred, usedPreferred: true };
  }
  return { model: fallback, usedPreferred: preferred === fallback && Boolean(preferred) };
}

/** The persona system block (the #700 byte-stable lead's first element). */
export function renderPersona(
  def: Pick<AgentDefinitionDto, "key" | "name" | "version" | "description" | "persona">,
): string {
  const header = `[agent:${def.key}@${def.version}] ${def.name}`;
  const desc = def.description ? `\n${def.description}` : "";
  const body = def.persona.trim();
  return body.length === 0 ? `${header}${desc}` : `${header}${desc}\n\n${body}`;
}

export type { AgentDefinitionDto, ApprovalPolicyOverride };
