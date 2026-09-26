/**
 * Epic #128 — everything one chat turn needs to offer and gate tools:
 *
 *   • the MODE: `native` (the catalog marks the model tool-capable, #141),
 *     `text` (not tool-capable — only the curated code tools, through the
 *     textual protocol, exactly as #713 shipped them), or `off`;
 *   • the session's TOOLSET (#140) — never offered to an unscoped session
 *     (#1368: with no project, the only tree a tool could reach is METIS's own);
 *   • the session's GATE (#142) — its stored policy, its agent's allowlist, the
 *     `prompt-once` memory, and a prompter that asks the session's owner.
 *
 * Epic #129 adds the AGENT tools, offered natively only:
 *   • `load_skill` (#146) — the prompt carries each available skill's name and
 *     description; the model reads a body on demand. Also offered to an
 *     UNSCOPED session: it reads only METIS's own skill library, never a tree.
 *   • one tool per agent the project may call (#147), project sessions only.
 * When they cannot be offered (a model that is not tool-capable, or the flags
 * are off) the session falls back to the pre-#146 inline skill bodies.
 */
import type { AgentDefinitionDto, ApprovalPolicyOverride } from "@metis/shared";
import { LOAD_SKILL_TOOL_NAME } from "@metis/shared";
import { prisma } from "../../prisma.js";
import { createChildLogger } from "../../logger.js";
import { getConfigService } from "../../config/config-service.js";
import { getMCPRegistry } from "../../mcp/mcp-service.js";
import { formatToolSchemas } from "../../analysis/agent-loop.js";
import { getChatCodeTools, type ChatCodeToolDeps } from "../../analysis/tools/index.js";
import { listCallableAgents } from "../../agent-runtime/definition.js";
import { effectivePolicy, readStoredOverride } from "../../agent-runtime/policy.js";
import {
  loadSkillTool,
  resolveSkillCatalog,
  type SkillAllowlistSource,
  type SkillCatalogEntry,
} from "../../agent-runtime/skills.js";
import {
  SubAgentBudget,
  loadSubAgentLimits,
  subAgentTools,
  type AgentToolsContext,
  type SubAgentLimits,
} from "../../agent-runtime/subagents.js";
import { resolveCapabilities } from "../capabilities.js";
import type { AIProvider } from "../types.js";
import { getToolRegistry, type ToolRegistry } from "../tool-registry.js";
import {
  ApprovalGateService,
  matchesToolRef,
  parsePolicyJson,
  sessionApprovalMemory,
} from "../approval-policy.js";
import { getToolApprovalBroker, type ToolApprovalBroker } from "./approval-broker.js";
import { brokerPrompter } from "./prompter.js";
import {
  buildSessionToolset,
  codeRuntimeTool,
  makeToolset,
  type McpToolsetSource,
  type RuntimeToolset,
} from "./toolset.js";
import type { RuntimeTool, ToolEvent } from "./types.js";

const log = createChildLogger("session-tools");

export type ChatToolMode = "off" | "native" | "text";

export interface SessionToolRuntime {
  mode: ChatToolMode;
  toolset: RuntimeToolset;
  /** Text mode only: the code-tool schemas for the byte-stable prompt lead. */
  schemaBlock: string;
  /**
   * The allowlist the session gate enforces (`null` = none declared): the
   * session agent's refs, plus `load_skill` when the agent's own skills are
   * offered through it (#146 — loading an agent's skill is part of the agent).
   */
  agentAllowlist: readonly string[] | null;
  /**
   * #146 — `progressive`: the prompt carries the skill catalog and `load_skill`
   * is in the toolset. `inline`: the pre-#146 whole skill bodies.
   */
  skillMode: "progressive" | "inline";
  /** #146 — the skills this session may use (allow-list filtered). */
  skillCatalog: SkillCatalogEntry[];
  /** #145 — the session agent's approval-policy override (tighten-only). */
  approvalOverride: ApprovalPolicyOverride | null;
  /**
   * #147 — shared context of the sub-agent tools in `toolset` (`null` when none
   * are offered). The route binds `signal`, `onToolEvent`,
   * `providerChatOptions`, `toolResultMaxChars` and `onUsage` on it BEFORE the
   * tool loop runs; the tools read them when they execute.
   */
  subAgents: AgentToolsContext | null;
}

export interface SessionToolsFlags {
  /** `CHAT_TOOLS` — offer METIS + MCP tools natively (default on). */
  chatTools: boolean;
  /** `CHAT_CODE_SEARCH_TOOLS` — offer the curated code-search tools (default off). */
  codeSearchTools: boolean;
  /** #146 `CHAT_PROGRESSIVE_SKILLS` — catalog + `load_skill` (default on). */
  progressiveSkills?: boolean;
  /** #147 `CHAT_SUBAGENTS` — offer the project's agents as tools (default on). */
  subAgents?: boolean;
}

export function loadSessionToolsFlags(): SessionToolsFlags {
  const cfg = getConfigService();
  return {
    chatTools: cfg.getBool("CHAT_TOOLS", true),
    codeSearchTools: cfg.getBool("CHAT_CODE_SEARCH_TOOLS", false),
    progressiveSkills: cfg.getBool("CHAT_PROGRESSIVE_SKILLS", true),
    subAgents: cfg.getBool("CHAT_SUBAGENTS", true),
  };
}

/**
 * The agent's declared tool allowlist. `null` when the session has no agent or
 * the agent declares no `tools`; `[]` (nothing allowed) when the session names
 * an agent that can no longer be read — fail closed.
 */
export async function loadAgentAllowlist(agentId: string | null): Promise<string[] | null> {
  return (await loadSessionAgent(agentId)).allowlist;
}

/**
 * #145 — the session agent's tool allowlist AND approval override, read in one
 * query. The allowlist keeps the #142 semantics exactly (fail closed to `[]`
 * when the agent cannot be read); an unreadable override fails closed to
 * "prompt on everything" (see `readStoredOverride`).
 */
export async function loadSessionAgent(
  agentId: string | null,
): Promise<{ allowlist: string[] | null; approvalOverride: ApprovalPolicyOverride | null }> {
  if (!agentId) return { allowlist: null, approvalOverride: null };
  try {
    const row = (await prisma.agent.findFirst({
      where: { id: agentId },
      select: { tools: true, approvalPolicy: true },
    })) as { tools?: string | null; approvalPolicy?: string | null } | null;
    if (!row) return { allowlist: [], approvalOverride: null };
    const parsed: unknown = JSON.parse(row.tools ?? "[]");
    const refs = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    return {
      allowlist: refs.length > 0 ? refs : null,
      approvalOverride: readStoredOverride(row.approvalPolicy ?? null),
    };
  } catch (err) {
    log.warn("Agent tool allowlist unreadable; offering no tools", {
      agentId,
      error: (err as Error).message,
    });
    return { allowlist: [], approvalOverride: null };
  }
}

function parseIds(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw) as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/** MCP servers a project may use, from the live MCP registry (absent in tests). */
export function mcpToolsetSource(): McpToolsetSource | null {
  let registry: ReturnType<typeof getMCPRegistry>;
  try {
    registry = getMCPRegistry();
  } catch {
    return null; // MCP not bootstrapped (tests, or a server without MCP)
  }
  return {
    async allowedServerIds(projectId) {
      const views = await registry.listForProject(projectId);
      return new Set(views.map((v) => v.id));
    },
    governance: (serverId) => registry.readGovernance(serverId),
  };
}

export interface ResolveSessionToolsInput {
  session: {
    id: string;
    userId: string;
    projectId: string | null;
    agentId: string | null;
    /** #146 — the session's skills (JSON array of ids). */
    loadedSkillIds?: string;
    /** #147 — the session's stored policy (the sub-agents' gates start from it). */
    policy?: string;
  };
  provider: AIProvider;
  model: string;
  flags?: SessionToolsFlags;
  registry?: ToolRegistry;
  codeToolDeps?: ChatCodeToolDeps;
  mcp?: McpToolsetSource | null;
  /** #146/#147 seams (tests inject the callable agents and limits). */
  agents?: {
    callable?: readonly AgentDefinitionDto[];
    limits?: SubAgentLimits;
    allowlist?: SkillAllowlistSource;
  };
}

function off(
  catalog: SkillCatalogEntry[] = [],
  approvalOverride: ApprovalPolicyOverride | null = null,
  agentAllowlist: readonly string[] | null = null,
): SessionToolRuntime {
  return {
    mode: "off",
    toolset: makeToolset([]),
    schemaBlock: "",
    agentAllowlist,
    skillMode: "inline",
    skillCatalog: catalog,
    approvalOverride,
    subAgents: null,
  };
}

/** The gate's allowlist: the agent's refs, plus `load_skill` when it is offered. */
function gateAllowlist(
  agentAllowlist: readonly string[] | null,
  toolset: RuntimeToolset,
): readonly string[] | null {
  if (!agentAllowlist) return null;
  return toolset.resolve(LOAD_SKILL_TOOL_NAME)
    ? [...agentAllowlist, LOAD_SKILL_TOOL_NAME]
    : agentAllowlist;
}

export async function resolveSessionTools(
  input: ResolveSessionToolsInput,
): Promise<SessionToolRuntime> {
  const projectId = input.session.projectId;
  const flags = input.flags ?? loadSessionToolsFlags();
  const agent = await loadSessionAgent(input.session.agentId);
  const agentAllowlist = agent.allowlist;
  const skillAllowlist = input.agents?.allowlist;
  const catalog = await resolveSkillCatalog({
    skillIds: parseIds(input.session.loadedSkillIds),
    projectId,
    ...(skillAllowlist ? { allowlist: skillAllowlist } : {}),
  });
  const native = resolveCapabilities(input.provider, input.model).nativeToolCalls;
  const progressive =
    native && flags.chatTools && flags.progressiveSkills !== false && catalog.length > 0;
  const skillTools = (): RuntimeTool[] =>
    progressive
      ? [loadSkillTool({ catalog, ...(skillAllowlist ? { allowlist: skillAllowlist } : {}) })]
      : [];

  // #1368 — an unscoped session gets no tool that reaches a tree; #146 — it
  // may still read its own skills on demand.
  if (!projectId) {
    const tools = skillTools();
    if (tools.length === 0) return off(catalog, agent.approvalOverride);
    const toolset = makeToolset(tools);
    return {
      mode: "native",
      toolset,
      schemaBlock: "",
      agentAllowlist: gateAllowlist(agentAllowlist, toolset),
      skillMode: "progressive",
      skillCatalog: catalog,
      approvalOverride: agent.approvalOverride,
      subAgents: null,
    };
  }
  const codeTools = flags.codeSearchTools ? getChatCodeTools(input.codeToolDeps) : [];

  if (native) {
    const base =
      !flags.chatTools && codeTools.length === 0
        ? makeToolset([])
        : await buildSessionToolset({
            ctx: { sessionId: input.session.id, userId: input.session.userId, projectId },
            registry: flags.chatTools ? (input.registry ?? getToolRegistry()) : emptyRegistry(),
            codeTools,
            mcp: flags.chatTools
              ? input.mcp === undefined
                ? mcpToolsetSource()
                : input.mcp
              : null,
            agentAllowlist,
          });
    const taken = new Set(base.tools.map((t) => t.wireName));
    const agentTools = skillTools().filter((t) => !taken.has(t.wireName));
    for (const t of agentTools) taken.add(t.wireName);
    let subAgents: AgentToolsContext | null = null;
    if (flags.chatTools && flags.subAgents !== false) {
      const callable = input.agents?.callable ?? (await safeCallable(projectId));
      const limits = input.agents?.limits ?? loadSubAgentLimits();
      if (callable.length > 0 && limits.maxDepth >= 1) {
        const ctx: AgentToolsContext = {
          provider: input.provider,
          model: input.model,
          session: {
            id: input.session.id,
            userId: input.session.userId,
            projectId,
            policy: input.session.policy ?? "",
          },
          callable,
          limits,
          budget: new SubAgentBudget(limits.tokenBudget),
          approvalTimeoutMs: getConfigService().getNumber("AI_TOOL_APPROVAL_TIMEOUT_MS", 120_000),
          ...(skillAllowlist ? { allowlist: skillAllowlist } : {}),
          // Re-checked when a sub-agent is CALLED: it may have been disabled
          // for the project since the tool list was built.
          isCallable: async (ref) =>
            (input.agents?.callable ?? (await safeCallable(projectId))).some((d) => d.ref === ref),
        };
        const tools = subAgentTools(
          ctx,
          { depth: 0, runId: null, allowlist: agentAllowlist, baseToolset: base },
          taken,
        );
        if (tools.length > 0) {
          agentTools.push(...tools);
          subAgents = ctx;
        }
      }
    }
    const toolset = makeToolset([...base.tools, ...agentTools], base.withheldTools);
    if (toolset.tools.length === 0) return off(catalog, agent.approvalOverride, agentAllowlist);
    return {
      mode: "native",
      toolset,
      schemaBlock: "",
      agentAllowlist: gateAllowlist(agentAllowlist, toolset),
      skillMode: toolset.resolve(LOAD_SKILL_TOOL_NAME) ? "progressive" : "inline",
      skillCatalog: catalog,
      approvalOverride: agent.approvalOverride,
      subAgents,
    };
  }

  // Not tool-capable: only the curated code tools, on the text protocol (#713).
  const allowed = codeTools.filter(
    (t) => !agentAllowlist || agentAllowlist.some((ref) => matchesToolRef(ref, t.name)),
  );
  if (allowed.length === 0) return off(catalog, agent.approvalOverride, agentAllowlist);
  return {
    mode: "text",
    toolset: makeToolset(allowed.map((t) => codeRuntimeTool(t, t.name))),
    schemaBlock: formatToolSchemas(allowed),
    agentAllowlist,
    skillMode: "inline",
    skillCatalog: catalog,
    approvalOverride: agent.approvalOverride,
    subAgents: null,
  };
}

async function safeCallable(projectId: string): Promise<AgentDefinitionDto[]> {
  try {
    return await listCallableAgents(projectId);
  } catch (err) {
    log.warn("Callable agents unreadable; offering no sub-agents", {
      projectId,
      error: (err as Error).message,
    });
    return [];
  }
}

function emptyRegistry(): ToolRegistry {
  return { describeAll: () => [] } as unknown as ToolRegistry;
}

export interface SessionGateInput {
  session: { id: string; userId: string; projectId: string | null; policy: string };
  runtime: SessionToolRuntime;
  signal?: AbortSignal;
  onEvent?: (event: ToolEvent) => void;
  broker?: ToolApprovalBroker;
}

/** The session's approval gate for one turn. */
export function sessionGate(input: SessionGateInput): ApprovalGateService {
  const timeoutMs = getConfigService().getNumber("AI_TOOL_APPROVAL_TIMEOUT_MS", 120_000);
  return new ApprovalGateService({
    sessionId: input.session.id,
    userId: input.session.userId,
    // #145 — the session agent's override can only tighten the stored policy.
    policy: effectivePolicy(parsePolicyJson(input.session.policy), input.runtime.approvalOverride),
    agentAllowlist: input.runtime.agentAllowlist,
    rememberedApproval: sessionApprovalMemory(input.session.id),
    prompter: brokerPrompter({
      broker: input.broker ?? getToolApprovalBroker(),
      toolset: input.runtime.toolset,
      projectId: input.session.projectId,
      ...(timeoutMs > 0 ? { timeoutMs } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
      ...(input.onEvent ? { onEvent: input.onEvent } : {}),
    }),
  });
}
