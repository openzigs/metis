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
import { createChildLogger } from "../logger.js";
import { lookupCatalogEntry, MODEL_CATALOG_OVERRIDES_ENV } from "../ai/model-catalog.js";
import { readStoredOverride } from "./policy.js";

const log = createChildLogger("agent-definition");

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
 * Library agents first, then custom agents by name. The list is NOT capped
 * here: how many are offered as tools is decided per calling agent, AFTER its
 * allowlist has narrowed the list (`subAgentTools`), so an agent an allowlist
 * names is never lost to a cap applied to the whole project.
 */
export async function listCallableAgents(
  projectId: string,
  opts: { db?: PrismaClient } = {},
): Promise<AgentDefinitionDto[]> {
  const db = opts.db ?? defaultPrisma;
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
  return [...library.map(libraryDefinition), ...custom.map(customDefinition)];
}

/**
 * Providers whose model names are the OPERATOR's vocabulary, not a fixed list:
 * a local runtime serves whatever it has pulled, and an Azure "model" is a
 * deployment name. The catalog
 * cannot enumerate these without a network probe it may never have made (the
 * discovery cache is filled only by `GET /api/ai/models`), so a well-formed
 * name is sent as saved — the runtime answers a truly missing one with its own
 * clear error, which is visible, where silently swapping it would not be.
 */
const OPEN_VOCABULARY_PROVIDERS: ReadonlySet<string> = new Set(["local-gemma", "azure"]);

/** A syntactically sane model id (Ollama tags, HF paths and ARNs included). */
const PLAUSIBLE_MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export interface AgentModelResolution {
  /** The model to send; `undefined` = the provider's default. */
  model: string | undefined;
  /** The agent's saved model is the one being sent. */
  usedPreferred: boolean;
  /**
   * Set when the agent HAS a saved model that is NOT being sent. A saved model
   * is never swapped silently: every caller surfaces this on its result and
   * it is logged here.
   */
  warning?: string;
}

/**
 * The model an agent runs on (#135 / #145). Its saved model is sent when:
 *   • the catalog knows it for this provider (builtin, operator override, or a
 *     discovered local model), or
 *   • the provider's model names are open-vocabulary
 *     ({@link OPEN_VOCABULARY_PROVIDERS}) and the name is well-formed.
 * Otherwise the caller's model runs — and the result carries a `warning` naming
 * the rejected model, so the swap is never silent. The decision never depends
 * on whether a discovery cache happens to be warm.
 */
export function resolveAgentModel(
  providerKey: string,
  preferred: string | null | undefined,
  fallback: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
): AgentModelResolution {
  if (!preferred) return { model: fallback, usedPreferred: false };
  if (preferred === fallback) return { model: preferred, usedPreferred: true };
  const plausible = PLAUSIBLE_MODEL.test(preferred);
  if (
    plausible &&
    (OPEN_VOCABULARY_PROVIDERS.has(providerKey) || lookupCatalogEntry(providerKey, preferred, env))
  ) {
    return { model: preferred, usedPreferred: true };
  }
  const ranOn = fallback ? `"${fallback}"` : "the provider's default model";
  const why = plausible
    ? `is not in the model catalog for the "${providerKey}" provider ` +
      `(add it to ${MODEL_CATALOG_OVERRIDES_ENV} to allow it)`
    : "is not a valid model name";
  const warning = `The agent's saved model "${preferred.slice(0, 200)}" ${why}; it ran on ${ranOn} instead.`;
  log.warn("Agent's saved model not used", { providerKey, preferred, fallback: fallback ?? null });
  return { model: fallback, usedPreferred: false, warning };
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
