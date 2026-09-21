/**
 * Tests for the AGENTS.md detector + generator (#154).
 *
 * Round-trip safety: parse(generate(x)).agents === x.agents (modulo metadata).
 */
import { describe, expect, it } from "vitest";
import { detectAgents, BUILTIN_AGENTS } from "../src/lib/agents-md/detector.js";
import {
  generateAgentsMd,
  parseAgentsMd,
  parsedToDetected,
} from "../src/lib/agents-md/generator.js";

describe("agents-md/detector", () => {
  it("returns the built-in specialist agents by default", () => {
    const set = detectAgents({ projectName: "p" });
    expect(set.agents.map((a) => a.name)).toEqual([
      "business-analyst",
      "architect",
      "product-owner",
      "quality-engineer",
    ]);
    expect(set.mcpServers).toEqual([]);
  });

  it("BUILTIN_AGENTS exposes all four built-in specialists", () => {
    expect(BUILTIN_AGENTS).toHaveLength(4);
    for (const a of BUILTIN_AGENTS) {
      expect(a.source).toBe("builtin");
    }
  });

  it("applies the default model to all agents", () => {
    const set = detectAgents({ projectName: "p", defaultModel: "gpt-4o" });
    for (const a of set.agents) {
      expect(a.model).toBe("gpt-4o");
    }
  });

  it("known agents override built-ins by name", () => {
    const set = detectAgents({
      projectName: "p",
      knownAgents: [
        {
          name: "business-analyst",
          description: "custom BA",
          systemPrompt: "be a BA",
          tools: ["custom_tool"],
          model: "claude-3",
          source: "agents-md",
        },
      ],
    });
    const ba = set.agents.find((a) => a.name === "business-analyst")!;
    expect(ba.description).toBe("custom BA");
    expect(ba.model).toBe("claude-3");
    expect(ba.source).toBe("agents-md");
  });

  it("known agents add new entries when not matching a built-in", () => {
    const set = detectAgents({
      projectName: "p",
      knownAgents: [
        {
          name: "security-reviewer",
          description: "sec",
          systemPrompt: "review security",
          tools: [],
          model: null,
          source: "agents-md",
        },
      ],
    });
    expect(set.agents.find((a) => a.name === "security-reviewer")).toBeDefined();
  });

  it("skill-derived agents are appended once", () => {
    const set = detectAgents({
      projectName: "p",
      skills: [
        { name: "test-planner", description: "plan tests" },
        { name: "test-planner", description: "duplicate" },
      ],
    });
    const matches = set.agents.filter((a) => a.name === "test-planner");
    expect(matches).toHaveLength(1);
    expect(matches[0].source).toBe("skill");
  });

  it("MCP server tools are added to every agent's tool list", () => {
    const set = detectAgents({
      projectName: "p",
      mcpServers: [
        { label: "github", tools: ["search_issues", "create_pull_request"] },
        { label: "filesystem", tools: ["read_file"] },
      ],
    });
    for (const a of set.agents) {
      expect(a.tools).toContain("github:search_issues");
      expect(a.tools).toContain("github:create_pull_request");
      expect(a.tools).toContain("filesystem:read_file");
    }
    expect(set.mcpServers).toHaveLength(2);
  });

  it("known-agent source defaults to agents-md when unrecognised", () => {
    const set = detectAgents({
      projectName: "p",
      knownAgents: [
        {
          name: "x",
          description: "y",
          systemPrompt: "z",
          tools: [],
          model: null,
          source: "unknown",
        },
      ],
    });
    expect(set.agents.find((a) => a.name === "x")?.source).toBe("unknown");
  });
});

describe("agents-md/generator", () => {
  it("generateAgentsMd emits markdown with sections per agent", () => {
    const set = detectAgents({ projectName: "Demo" });
    const md = generateAgentsMd(set, { projectName: "Demo", projectDescription: "desc" });
    expect(md).toContain("# Demo");
    expect(md).toContain("desc");
    expect(md).toContain("## business-analyst");
    expect(md).toContain("### system_prompt");
    expect(md).toContain("- description:");
    expect(md).toContain("- tools: []");
    expect(md).toContain("<!-- generated-by: metis -->");
  });

  it("includes MCP servers section when present", () => {
    const set = detectAgents({
      projectName: "p",
      mcpServers: [{ label: "github", tools: ["a", "b"] }],
    });
    const md = generateAgentsMd(set, { projectName: "p" });
    expect(md).toContain("## MCP servers");
    expect(md).toContain("**github**: a, b");
  });

  it("emits MCP server line even when a server has no tools", () => {
    const set = detectAgents({
      projectName: "p",
      mcpServers: [{ label: "empty", tools: [] }],
    });
    const md = generateAgentsMd(set, { projectName: "p" });
    expect(md).toContain("**empty**: (no tools)");
  });

  it("parseAgentsMd extracts name + description + system_prompt", () => {
    const md = `# My Project\n\nIntro text\n\n## reviewer\n\n- description: Reviews code\n- model: gpt-4o\n- tools: \`a\`, \`b\`\n\n### system_prompt\n\nYou are a reviewer.\n`;
    const parsed = parseAgentsMd(md);
    expect(parsed.title).toBe("My Project");
    expect(parsed.preface).toBe("Intro text");
    expect(parsed.agents).toHaveLength(1);
    expect(parsed.agents[0]).toEqual({
      name: "reviewer",
      description: "Reviews code",
      systemPrompt: "You are a reviewer.",
      tools: ["a", "b"],
      model: "gpt-4o",
    });
  });

  it("parseAgentsMd handles empty tools list and no model", () => {
    const md = `## solo\n\n- description: solo agent\n- tools: []\n\n### system_prompt\n\ndo work\n`;
    const parsed = parseAgentsMd(md);
    expect(parsed.agents[0].tools).toEqual([]);
    expect(parsed.agents[0].model).toBeUndefined();
  });

  it("parseAgentsMd skips MCP servers section without a system_prompt", () => {
    const md = `# x\n\n## MCP servers\n\n- foo: a, b\n\n## real\n\n- description: real\n\n### system_prompt\n\np`;
    const parsed = parseAgentsMd(md);
    expect(parsed.agents.map((a) => a.name)).toEqual(["real"]);
  });

  it("round-trips: parse(generate(set)) matches the input agents", () => {
    const set = detectAgents({ projectName: "demo" });
    const md = generateAgentsMd(set, { projectName: "demo" });
    const parsed = parseAgentsMd(md);
    expect(parsed.agents).toHaveLength(set.agents.length);
    for (const original of set.agents) {
      const reparsed = parsed.agents.find((p) => p.name === original.name);
      expect(reparsed).toBeDefined();
      expect(reparsed!.description).toBe(original.description);
      expect(reparsed!.systemPrompt).toBe(original.systemPrompt);
    }
  });

  it("parsedToDetected restores the source as agents-md", () => {
    const md = `# x\n\n## a\n\n- description: d\n\n### system_prompt\n\np`;
    const parsed = parseAgentsMd(md);
    const detected = parsedToDetected(parsed);
    expect(detected[0].source).toBe("agents-md");
  });
});
