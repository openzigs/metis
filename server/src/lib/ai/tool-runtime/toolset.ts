/**
 * Epic #128 / #140 — the tools ONE session may be offered, as one list.
 *
 *   • METIS tools from the {@link ToolRegistry} (knowledge search, schema
 *     inspection, SELECT-only queries, diff apply, …);
 *   • MCP tools the registry bridges — only from servers the session's project
 *     may use (its own project-scoped servers plus globals on its allow-list),
 *     and only tools each server's governance allowlist admits;
 *   • the curated code-search tools, when the caller passes them.
 *
 * A tool outside the session's agent allowlist is never offered (and the gate
 * refuses it if a model names it anyway). Offering is a courtesy; enforcement
 * is the gate plus the tool's own scope checks at execution time.
 */
import crypto from "node:crypto";
import type { ChatToolSpec } from "../types.js";
import type { ToolRegistry, ToolRuntimeView } from "../tool-registry.js";
import type { AgentTool } from "../../analysis/tools/types.js";
import { matchesToolRef } from "../approval-policy.js";
import type { RiskLevel } from "../types.js";
import type { RuntimeTool, RuntimeToolContext } from "./types.js";

/**
 * Tools that reach BEYOND the session's project. A project-scoped chat must not
 * be offered them (#140: "only tools allowed for the session's project").
 */
export const CHAT_EXCLUDED_TOOLS: ReadonlySet<string> = new Set(["search-knowledge-global"]);

const WIRE_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/**
 * A provider-safe, collision-free name for `canonical`. A name that is already
 * valid is kept as-is (so `search_code_graph` stays `search_code_graph`);
 * otherwise invalid characters become `_`, and a short hash keeps two canonical
 * names that sanitise alike apart.
 */
export function toWireName(canonical: string, taken: ReadonlySet<string>): string {
  if (WIRE_NAME.test(canonical) && !taken.has(canonical)) return canonical;
  const hash = crypto.createHash("sha256").update(canonical).digest("hex").slice(0, 8);
  const base = canonical.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64 - 9);
  return `${base}_${hash}`;
}

export interface McpToolsetSource {
  /** Server ids the project may use. */
  allowedServerIds(projectId: string): Promise<ReadonlySet<string>>;
  /** Per-server governance, or `null` when the server is gone. */
  governance(
    serverId: string,
  ): Promise<{ allowlist: string[] | null; requireApproval: boolean } | null>;
}

export interface BuildToolsetInput {
  ctx: RuntimeToolContext;
  registry: ToolRegistry;
  /** Curated code-search tools (already scoped to the project by `ctx`). */
  codeTools?: readonly AgentTool[];
  mcp?: McpToolsetSource | null;
  /** `null` — the agent declares no allowlist; otherwise refs (`mcp:x:*` allowed). */
  agentAllowlist?: readonly string[] | null;
  exclude?: ReadonlySet<string>;
}

/** #147 — a tool the session has but the agent's allowlist withheld. */
export interface WithheldTool {
  name: string;
  risk: RiskLevel;
}

export interface RuntimeToolset {
  tools: RuntimeTool[];
  /** Resolve the name a model used — its wire name, or the canonical name. */
  resolve(name: string): RuntimeTool | undefined;
  /** Native tool definitions, ordered by wire name (byte-stable for a tool set). */
  specs(): ChatToolSpec[];
  /**
   * #147 — a tool the agent's allowlist WITHHELD from this toolset (by wire or
   * canonical name). The executor refuses a call to one as `TOOL_NOT_ALLOWED`
   * through the gate — recorded as an agent-allowlist denial, never mistaken
   * for a tool that does not exist.
   */
  withheld(name: string): WithheldTool | undefined;
  /** #147 — every withheld tool (a sub-agent's toolset inherits the list). */
  withheldTools: readonly WithheldTool[];
}

export function makeToolset(
  tools: RuntimeTool[],
  withheld: readonly WithheldTool[] = [],
): RuntimeToolset {
  const byWire = new Map(tools.map((t) => [t.wireName, t]));
  const byName = new Map(tools.map((t) => [t.name, t]));
  const withheldByName = new Map<string, WithheldTool>();
  for (const w of withheld) {
    if (byName.has(w.name)) continue;
    withheldByName.set(w.name, w);
    withheldByName.set(toWireName(w.name, new Set()), w);
  }
  return {
    tools,
    withheldTools: withheld,
    withheld: (name) =>
      byWire.has(name) || byName.has(name) ? undefined : withheldByName.get(name),
    resolve: (name) => byWire.get(name) ?? byName.get(name),
    specs: () =>
      [...tools]
        .sort((a, b) => a.wireName.localeCompare(b.wireName, "en"))
        .map((t) => ({ name: t.wireName, description: t.description, parameters: t.parameters })),
  };
}

function allowedByAgent(name: string, allowlist: readonly string[] | null | undefined): boolean {
  if (!allowlist) return true;
  return allowlist.some((ref) => matchesToolRef(ref, name));
}

/** Wrap one curated code tool. They are read-only and project-scoped: `low` risk. */
export function codeRuntimeTool(tool: AgentTool, wireName: string): RuntimeTool {
  return {
    name: tool.name,
    wireName,
    description: tool.description,
    parameters: tool.parameters as unknown as Record<string, unknown>,
    risk: "low",
    source: "code",
    validate: (args) =>
      args !== null && typeof args === "object" && !Array.isArray(args)
        ? { ok: true, args }
        : { ok: false },
    async execute(args, ctx) {
      if (!ctx.projectId) {
        return { text: "Code search needs a project-scoped session.", isError: true };
      }
      const r = await tool.execute(args, { projectId: ctx.projectId });
      return {
        text: r.content,
        ...(typeof r.isError === "boolean" ? { isError: r.isError } : {}),
        ...(typeof r.resultCount === "number" ? { resultCount: r.resultCount } : {}),
        ...(r.truncated ? { truncated: true } : {}),
      };
    },
  };
}

function registryRuntimeTool(
  registry: ToolRegistry,
  view: ToolRuntimeView,
  wireName: string,
  forcePrompt: boolean,
  forcePromptNow?: () => Promise<boolean>,
): RuntimeTool {
  return {
    name: view.name,
    wireName,
    description: view.description,
    parameters: view.parameters,
    risk: view.risk,
    source: view.origin?.kind === "mcp" ? "mcp" : "metis",
    ...(forcePrompt ? { forcePrompt: true } : {}),
    ...(forcePromptNow ? { forcePromptNow } : {}),
    validate: (args) => (registry.validate(view.name, args) ? { ok: true, args } : { ok: false }),
    async execute(args, ctx) {
      // The runtime's gate has ALREADY decided this call; the registry still
      // demands a gate, so hand it one that admits exactly this tool, once.
      let used = false;
      const decided = {
        async decide(input: { toolName: string }): Promise<boolean> {
          if (used || input.toolName !== view.name) return false;
          used = true;
          return true;
        },
      };
      const r = await registry.invoke(
        view.name,
        args,
        {
          sessionId: ctx.sessionId,
          userId: ctx.userId,
          ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
          gateDecided: true,
        },
        decided,
      );
      // #143 — the registry turns a tool's thrown exception into
      // `[Tool Error] <exception message>`; that raw text must not reach the
      // transcript (which the client reads) — the executor logs failures.
      if (r.isError && r.text.startsWith("[Tool Error]")) {
        throw new Error(r.text.slice("[Tool Error]".length).trim());
      }
      return { text: r.text, ...(r.isError ? { isError: true } : {}) };
    },
  };
}

/**
 * Build the session's toolset. Never throws for one bad MCP server: a server
 * whose governance cannot be read is simply not offered.
 */
export async function buildSessionToolset(input: BuildToolsetInput): Promise<RuntimeToolset> {
  const exclude = input.exclude ?? CHAT_EXCLUDED_TOOLS;
  const taken = new Set<string>();
  const tools: RuntimeTool[] = [];
  const withheld: WithheldTool[] = [];
  const add = (make: (wire: string) => RuntimeTool, canonical: string): void => {
    const wire = toWireName(canonical, taken);
    taken.add(wire);
    tools.push(make(wire));
  };

  for (const tool of input.codeTools ?? []) {
    if (!allowedByAgent(tool.name, input.agentAllowlist)) {
      withheld.push({ name: tool.name, risk: "low" });
      continue;
    }
    add((wire) => codeRuntimeTool(tool, wire), tool.name);
  }

  const projectId = input.ctx.projectId;
  let allowedServers: ReadonlySet<string> = new Set();
  if (input.mcp && projectId) {
    try {
      allowedServers = await input.mcp.allowedServerIds(projectId);
    } catch {
      allowedServers = new Set();
    }
  }
  const governanceCache = new Map<
    string,
    { allowlist: string[] | null; requireApproval: boolean } | null
  >();

  for (const view of input.registry.describeAll()) {
    if (exclude.has(view.name)) continue;
    if (tools.some((t) => t.name === view.name)) continue;
    if (!allowedByAgent(view.name, input.agentAllowlist)) {
      // An MCP tool is reported only as unknown: whether its server is even
      // allowed for this project is not the agent allowlist's to reveal.
      if (view.origin?.kind !== "mcp") withheld.push({ name: view.name, risk: view.risk });
      continue;
    }
    let forcePrompt = false;
    let forcePromptNow: (() => Promise<boolean>) | undefined;
    if (view.origin?.kind === "mcp") {
      const serverId = view.origin.serverId;
      if (!input.mcp || !allowedServers.has(serverId)) continue;
      if (!governanceCache.has(serverId)) {
        try {
          governanceCache.set(serverId, await input.mcp.governance(serverId));
        } catch {
          governanceCache.set(serverId, null);
        }
      }
      const gov = governanceCache.get(serverId);
      if (!gov) continue;
      const bare = view.name.split(":").slice(2).join(":");
      if (gov.allowlist && !gov.allowlist.includes(bare)) continue;
      forcePrompt = gov.requireApproval;
      // The snapshot above decides what is OFFERED; whether a person must
      // approve is read again at call time, so an admin switching
      // `requireApproval` on mid-turn applies to the very next call. A server
      // whose governance is gone or unreadable by then forces the prompt.
      const mcp = input.mcp;
      forcePromptNow = async () => (await mcp.governance(serverId))?.requireApproval ?? true;
    }
    add(
      (wire) => registryRuntimeTool(input.registry, view, wire, forcePrompt, forcePromptNow),
      view.name,
    );
  }
  return makeToolset(tools, withheld);
}
