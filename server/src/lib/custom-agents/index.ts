/**
 * Epic #165 (#112) — `customAgents` SessionConfig.
 *
 * Persists user-defined and built-in custom agent definitions. The four
 * built-ins (BA, Architect, PO, QA) are seeded in {@link ensureBuiltInAgents}
 * with `isBuiltIn=true, projectId=null` and may not be deleted.
 *
 * The shape mirrors the Copilot SDK's `CustomAgentDefinition`. Because
 * `@github/copilot` was dropped in #179, the shape is implemented natively
 * here and works for every provider. The future Copilot sidecar (#180) will
 * adopt this shape verbatim.
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import type { CustomAgentDefinition, CustomAgentDto, SdkReasoningEffort } from "@metis/shared";

export class CustomAgentError extends Error {}

const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]{1,63}$/;
const REASONING_EFFORTS = new Set(["low", "medium", "high"]);

interface AgentRow {
  id: string;
  projectId: string | null;
  name: string;
  description: string;
  systemPrompt: string;
  tools: string;
  model: string | null;
  reasoningEffort: string | null;
  isBuiltIn: boolean;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(r: AgentRow): CustomAgentDto {
  let tools: string[] = [];
  try {
    const parsed = JSON.parse(r.tools);
    if (Array.isArray(parsed)) tools = parsed.filter((t): t is string => typeof t === "string");
  } catch {
    tools = [];
  }
  return {
    id: r.id,
    projectId: r.projectId,
    name: r.name,
    description: r.description,
    systemPrompt: r.systemPrompt,
    tools,
    model: r.model,
    reasoningEffort: (r.reasoningEffort as SdkReasoningEffort | null) ?? null,
    isBuiltIn: r.isBuiltIn,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

function validate(def: Partial<CustomAgentDefinition>, opts: { allowEmpty?: boolean } = {}): void {
  if (!opts.allowEmpty) {
    if (!def.name || !NAME_RE.test(def.name)) {
      throw new CustomAgentError("Invalid agent name");
    }
    if (typeof def.systemPrompt !== "string" || def.systemPrompt.trim().length === 0) {
      throw new CustomAgentError("systemPrompt is required");
    }
  }
  if (def.tools != null) {
    if (!Array.isArray(def.tools) || def.tools.some((t) => typeof t !== "string")) {
      throw new CustomAgentError("tools must be an array of strings");
    }
  }
  if (def.reasoningEffort != null && !REASONING_EFFORTS.has(def.reasoningEffort)) {
    throw new CustomAgentError("reasoningEffort must be low|medium|high");
  }
}

const BUILT_INS: ReadonlyArray<CustomAgentDefinition & { description: string }> = [
  {
    name: "BA",
    description: "Business Analyst — extracts goals, stakeholders, and rules from scope docs.",
    systemPrompt:
      "You are a Business Analyst. Read the supplied scope documents and emit clear, structured business goals, stakeholder lists, and explicit business rules. Be concise and avoid implementation detail.",
    tools: ["search_documents", "record_project_memory"],
    model: null,
    reasoningEffort: "medium",
  },
  {
    name: "Architect",
    description: "Solution Architect — identifies components, APIs, and architectural impact.",
    systemPrompt:
      "You are a Solution Architect. Inspect the codebase and document the architecture: components, APIs, data flow, and risks. Cite file paths.",
    tools: ["search_documents", "search_code", "record_project_memory"],
    model: null,
    reasoningEffort: "high",
  },
  {
    name: "PO",
    description:
      "Product Owner — turns goals into prioritised user stories with acceptance criteria.",
    systemPrompt:
      "You are a Product Owner. Convert the analysis into concrete user stories using Given/When/Then acceptance criteria, prioritised by business value.",
    tools: ["record_project_memory"],
    model: null,
    reasoningEffort: "medium",
  },
  {
    name: "QA",
    description: "QA Lead — derives a test plan and edge cases from user stories.",
    systemPrompt:
      "You are a QA Lead. Derive a test plan from the user stories: scenario coverage, edge cases, and explicit non-functional requirements.",
    tools: ["search_documents"],
    model: null,
    reasoningEffort: "medium",
  },
];

export const BUILT_IN_AGENT_NAMES = BUILT_INS.map((b) => b.name);

export async function ensureBuiltInAgents(): Promise<void> {
  // NOTE: We can't use `prisma.customAgent.upsert` with the compound unique
  // `(projectId, name)` because `projectId` is nullable for built-ins and
  // Prisma rejects `null` inside a compound unique `where` clause (and SQL
  // NULL != NULL means even if it accepted it, the lookup would never hit).
  // Use findFirst + update/create instead.
  for (const def of BUILT_INS) {
    const existing = await prisma.customAgent.findFirst({
      where: { projectId: null, name: def.name, isBuiltIn: true },
    });
    if (existing) {
      // Keep description / prompt in sync with code so deployments don't
      // ship with stale built-ins, but never flip isBuiltIn or projectId.
      await prisma.customAgent.update({
        where: { id: existing.id },
        data: {
          description: def.description,
          systemPrompt: def.systemPrompt,
          tools: JSON.stringify(def.tools),
          isBuiltIn: true,
        },
      });
    } else {
      await prisma.customAgent.create({
        data: {
          projectId: null,
          name: def.name,
          description: def.description,
          systemPrompt: def.systemPrompt,
          tools: JSON.stringify(def.tools),
          model: def.model ?? null,
          reasoningEffort: def.reasoningEffort ?? null,
          isBuiltIn: true,
        },
      });
    }
  }
}

export interface ListAgentsOptions {
  /** Project scope — built-ins plus this project's custom agents. */
  projectId?: string | null;
  /** When false, omit built-ins. Defaults to true. */
  includeBuiltIns?: boolean;
}

export async function listAgents(opts: ListAgentsOptions = {}): Promise<CustomAgentDto[]> {
  const includeBuiltIns = opts.includeBuiltIns ?? true;
  const projectId = opts.projectId ?? null;
  const where = projectId
    ? { OR: [{ projectId }, ...(includeBuiltIns ? [{ projectId: null, isBuiltIn: true }] : [])] }
    : { projectId: null, isBuiltIn: true };
  const rows = await prisma.customAgent.findMany({
    where,
    orderBy: [{ isBuiltIn: "desc" }, { name: "asc" }],
  });
  return rows.map(toDto);
}

export async function getAgent(id: string): Promise<CustomAgentDto | null> {
  const row = await prisma.customAgent.findUnique({ where: { id } });
  return row ? toDto(row) : null;
}

export interface CreateAgentInput extends CustomAgentDefinition {
  projectId: string;
}

export async function createAgent(
  input: CreateAgentInput,
  actorId?: string,
): Promise<CustomAgentDto> {
  validate(input);
  const existing = await prisma.customAgent.findFirst({
    where: { projectId: input.projectId, name: input.name },
  });
  if (existing) throw new CustomAgentError("An agent with that name already exists");
  const row = await prisma.customAgent.create({
    data: {
      projectId: input.projectId,
      name: input.name,
      description: input.description,
      systemPrompt: input.systemPrompt,
      tools: JSON.stringify(input.tools),
      model: input.model ?? null,
      reasoningEffort: input.reasoningEffort ?? null,
      isBuiltIn: false,
    },
  });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "custom_agent.created",
    target: { type: "custom_agent", id: row.id },
    metadata: { projectId: input.projectId, name: input.name },
  });
  return toDto(row);
}

export async function updateAgent(
  id: string,
  patch: Partial<CustomAgentDefinition>,
  actorId?: string,
): Promise<CustomAgentDto> {
  const existing = await prisma.customAgent.findUnique({ where: { id } });
  if (!existing) throw new CustomAgentError("Agent not found");
  if (existing.isBuiltIn) {
    throw new CustomAgentError("Built-in agents cannot be modified");
  }
  validate(patch, { allowEmpty: true });
  const row = await prisma.customAgent.update({
    where: { id },
    data: {
      name: patch.name,
      description: patch.description,
      systemPrompt: patch.systemPrompt,
      tools: patch.tools != null ? JSON.stringify(patch.tools) : undefined,
      model: patch.model,
      reasoningEffort: patch.reasoningEffort,
    },
  });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "custom_agent.updated",
    target: { type: "custom_agent", id: row.id },
  });
  return toDto(row);
}

// ── Epic #260 (#79) — per-project enablement ──────────────────────────────

export interface AgentEnablementDto {
  id: string;
  customAgentId: string;
  projectId: string;
  enabled: boolean;
  enabledById: string | null;
  createdAt: string;
  updatedAt: string;
}

interface EnablementRow {
  id: string;
  customAgentId: string;
  projectId: string;
  enabled: boolean;
  enabledById: string | null;
  createdAt: Date;
  updatedAt: Date;
}

function toEnablementDto(r: EnablementRow): AgentEnablementDto {
  return {
    id: r.id,
    customAgentId: r.customAgentId,
    projectId: r.projectId,
    enabled: r.enabled,
    enabledById: r.enabledById,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}

/**
 * Enable (or disable) a custom agent for a specific project. Idempotent —
 * upserts the `(customAgentId, projectId)` row. The agent must exist.
 */
export async function setAgentEnabledForProject(
  customAgentId: string,
  projectId: string,
  enabled: boolean,
  actorId?: string,
): Promise<AgentEnablementDto> {
  const agent = await prisma.customAgent.findUnique({ where: { id: customAgentId } });
  if (!agent) throw new CustomAgentError("Agent not found");
  const row = await prisma.customAgentEnablement.upsert({
    where: { customAgentId_projectId: { customAgentId, projectId } },
    create: { customAgentId, projectId, enabled, enabledById: actorId ?? null },
    update: { enabled, enabledById: actorId ?? null },
  });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: enabled ? "custom_agent.enabled" : "custom_agent.disabled",
    target: { type: "custom_agent", id: customAgentId },
    metadata: { projectId },
  });
  return toEnablementDto(row as EnablementRow);
}

/** True when the agent has an enablement row for the project with `enabled=true`. */
export async function isAgentEnabledForProject(
  customAgentId: string,
  projectId: string,
): Promise<boolean> {
  const row = await prisma.customAgentEnablement.findUnique({
    where: { customAgentId_projectId: { customAgentId, projectId } },
  });
  return Boolean(row?.enabled);
}

/**
 * Resolve the full {@link CustomAgentDto} list of agents currently enabled for
 * a project via the enablement join. Agents enabled but since-deleted are
 * skipped. Used by the analysis orchestrator (#81) and the API (#80).
 */
export async function listEnabledAgentsForProject(projectId: string): Promise<CustomAgentDto[]> {
  const rows = (await prisma.customAgentEnablement.findMany({
    where: { projectId, enabled: true },
  })) as EnablementRow[];
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.customAgentId);
  const found = (await prisma.customAgent.findMany({
    where: { id: { in: ids } },
  })) as AgentRow[];
  return found.map(toDto);
}

export async function deleteAgent(id: string, actorId?: string): Promise<void> {
  const existing = await prisma.customAgent.findUnique({ where: { id } });
  if (!existing) throw new CustomAgentError("Agent not found");
  if (existing.isBuiltIn) {
    throw new CustomAgentError("Built-in agents cannot be deleted");
  }
  await prisma.customAgent.delete({ where: { id } });
  audit({
    actor: actorId ? { id: actorId } : null,
    action: "custom_agent.deleted",
    target: { type: "custom_agent", id },
  });
}
