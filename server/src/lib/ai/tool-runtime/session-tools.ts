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
 */
import { prisma } from "../../prisma.js";
import { createChildLogger } from "../../logger.js";
import { getConfigService } from "../../config/config-service.js";
import { getMCPRegistry } from "../../mcp/mcp-service.js";
import { formatToolSchemas } from "../../analysis/agent-loop.js";
import { getChatCodeTools, type ChatCodeToolDeps } from "../../analysis/tools/index.js";
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
import type { ToolEvent } from "./types.js";

const log = createChildLogger("session-tools");

export type ChatToolMode = "off" | "native" | "text";

export interface SessionToolRuntime {
  mode: ChatToolMode;
  toolset: RuntimeToolset;
  /** Text mode only: the code-tool schemas for the byte-stable prompt lead. */
  schemaBlock: string;
  /** The session agent's allowlist (`null` = none declared). */
  agentAllowlist: readonly string[] | null;
}

export interface SessionToolsFlags {
  /** `CHAT_TOOLS` — offer METIS + MCP tools natively (default on). */
  chatTools: boolean;
  /** `CHAT_CODE_SEARCH_TOOLS` — offer the curated code-search tools (default off). */
  codeSearchTools: boolean;
}

export function loadSessionToolsFlags(): SessionToolsFlags {
  const cfg = getConfigService();
  return {
    chatTools: cfg.getBool("CHAT_TOOLS", true),
    codeSearchTools: cfg.getBool("CHAT_CODE_SEARCH_TOOLS", false),
  };
}

/**
 * The agent's declared tool allowlist. `null` when the session has no agent or
 * the agent declares no `tools`; `[]` (nothing allowed) when the session names
 * an agent that can no longer be read — fail closed.
 */
export async function loadAgentAllowlist(agentId: string | null): Promise<string[] | null> {
  if (!agentId) return null;
  try {
    const row = await prisma.agent.findFirst({ where: { id: agentId }, select: { tools: true } });
    if (!row) return [];
    const parsed: unknown = JSON.parse(row.tools ?? "[]");
    const refs = Array.isArray(parsed)
      ? parsed.filter((x): x is string => typeof x === "string" && x.length > 0)
      : [];
    return refs.length > 0 ? refs : null;
  } catch (err) {
    log.warn("Agent tool allowlist unreadable; offering no tools", {
      agentId,
      error: (err as Error).message,
    });
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
  session: { id: string; userId: string; projectId: string | null; agentId: string | null };
  provider: AIProvider;
  model: string;
  flags?: SessionToolsFlags;
  registry?: ToolRegistry;
  codeToolDeps?: ChatCodeToolDeps;
  mcp?: McpToolsetSource | null;
}

const OFF: SessionToolRuntime = {
  mode: "off",
  toolset: makeToolset([]),
  schemaBlock: "",
  agentAllowlist: null,
};

export async function resolveSessionTools(
  input: ResolveSessionToolsInput,
): Promise<SessionToolRuntime> {
  const projectId = input.session.projectId;
  if (!projectId) return OFF;
  const flags = input.flags ?? loadSessionToolsFlags();
  const agentAllowlist = await loadAgentAllowlist(input.session.agentId);
  const codeTools = flags.codeSearchTools ? getChatCodeTools(input.codeToolDeps) : [];
  const native = resolveCapabilities(input.provider, input.model).nativeToolCalls;

  if (native) {
    if (!flags.chatTools && codeTools.length === 0) return OFF;
    const toolset = await buildSessionToolset({
      ctx: { sessionId: input.session.id, userId: input.session.userId, projectId },
      registry: flags.chatTools ? (input.registry ?? getToolRegistry()) : emptyRegistry(),
      codeTools,
      mcp: flags.chatTools ? (input.mcp === undefined ? mcpToolsetSource() : input.mcp) : null,
      agentAllowlist,
    });
    if (toolset.tools.length === 0) return OFF;
    return { mode: "native", toolset, schemaBlock: "", agentAllowlist };
  }

  // Not tool-capable: only the curated code tools, on the text protocol (#713).
  const allowed = codeTools.filter(
    (t) => !agentAllowlist || agentAllowlist.some((ref) => matchesToolRef(ref, t.name)),
  );
  if (allowed.length === 0) return OFF;
  return {
    mode: "text",
    toolset: makeToolset(allowed.map((t) => codeRuntimeTool(t, t.name))),
    schemaBlock: formatToolSchemas(allowed),
    agentAllowlist,
  };
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
    policy: parsePolicyJson(input.session.policy),
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
