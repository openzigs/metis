/**
 * Detect the agents available to a project (#154).
 *
 * Combines:
 *   1. Built-in METIS specialist agents (BA / Architect / PO / QA)
 *   2. Per-project KnownAgentDefinition rows (parsed from AGENTS.md or
 *      created manually)
 *   3. MCP-server tools surfaced as agents-as-tools (each MCP server
 *      contributes a single "tools" entry with its tool list)
 *
 * Returns a normalised, typed structure that can be rendered to AGENTS.md
 * markdown by `generator.ts`.
 */
export interface DetectedAgent {
  name: string;
  description: string;
  systemPrompt: string;
  tools: string[];
  model?: string;
  source: "builtin" | "agents-md" | "manual" | "skill";
}

export interface DetectedAgentSet {
  agents: DetectedAgent[];
  /** Tools detected from MCP servers, grouped by server label. */
  mcpServers: Array<{ label: string; tools: string[] }>;
}

export interface DetectorInput {
  projectName: string;
  projectDescription?: string;
  defaultModel?: string;
  knownAgents?: Array<{
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    model?: string | null;
    source: string;
  }>;
  mcpServers?: Array<{ label: string; tools: string[] }>;
  /** Optional skill-derived agent names (Phase 10 custom agents). */
  skills?: Array<{ name: string; description?: string }>;
}

export const BUILTIN_AGENTS: ReadonlyArray<DetectedAgent> = [
  {
    name: "business-analyst",
    description:
      "Reads project documents to extract business goals, stakeholders, rules, and user stories.",
    systemPrompt:
      "You are a senior business analyst. Identify and structure goals, stakeholders, success metrics, and user stories from the provided context.",
    tools: [],
    source: "builtin",
  },
  {
    name: "architect",
    description:
      "Reviews modules, services, and architecture; surfaces integration points and risks.",
    systemPrompt:
      "You are a senior software architect. Identify modules, services, APIs, integrations, and architectural risks from the provided context.",
    tools: [],
    source: "builtin",
  },
  {
    name: "product-owner",
    description:
      "Synthesises requirements and prioritises issues based on business value and risk.",
    systemPrompt:
      "You are a product owner. Convert findings into prioritised requirements with clear acceptance criteria.",
    tools: [],
    source: "builtin",
  },
  {
    name: "quality-engineer",
    description:
      "Cross-checks outputs against industry standards, regulations, and comparable products.",
    systemPrompt:
      "You are a senior QA / standards engineer. Validate findings against industry best practices and regulatory expectations.",
    tools: [],
    source: "builtin",
  },
];

export function detectAgents(input: DetectorInput): DetectedAgentSet {
  const agents: DetectedAgent[] = BUILTIN_AGENTS.map((a) => ({
    ...a,
    model: input.defaultModel,
  }));

  // Merge known agents (overrides built-ins by name).
  if (input.knownAgents && input.knownAgents.length > 0) {
    for (const k of input.knownAgents) {
      const existing = agents.findIndex((a) => a.name === k.name);
      const def: DetectedAgent = {
        name: k.name,
        description: k.description,
        systemPrompt: k.systemPrompt,
        tools: [...k.tools],
        model: k.model ?? input.defaultModel,
        source: (k.source as DetectedAgent["source"]) ?? "agents-md",
      };
      if (existing >= 0) {
        agents[existing] = def;
      } else {
        agents.push(def);
      }
    }
  }

  // Skill-derived agents.
  if (input.skills && input.skills.length > 0) {
    for (const s of input.skills) {
      if (!agents.some((a) => a.name === s.name)) {
        agents.push({
          name: s.name,
          description: s.description ?? `Skill ${s.name}`,
          systemPrompt: `Use the ${s.name} skill to complete tasks.`,
          tools: [],
          model: input.defaultModel,
          source: "skill",
        });
      }
    }
  }

  // Surface MCP server tools as a per-agent tool list — every built-in
  // agent gains the union of MCP tools so the AGENTS.md export reflects
  // the agentic surface area.
  const mcp = input.mcpServers ?? [];
  if (mcp.length > 0) {
    const mcpToolNames = mcp.flatMap((s) => s.tools.map((t) => `${s.label}:${t}`));
    for (const a of agents) {
      a.tools = Array.from(new Set([...a.tools, ...mcpToolNames]));
    }
  }

  return {
    agents,
    mcpServers: mcp,
  };
}
