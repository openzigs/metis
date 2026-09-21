/**
 * Epic #515 / Issue #516 — expand_skill internal agent tool.
 *
 * Returns the full instructions for a named skill, enabling lazy skill
 * loading. Only registered when SKILL_LOADING=lazy (default).
 */
import type { AgentTool, ToolResult } from "./tools/types.js";
import type { SkillRegistry } from "./skill-loader.js";

export interface ExpandSkillToolOptions {
  /** The skill registry to look up full instructions from. */
  registry: SkillRegistry;
}

/**
 * Create the `expand_skill` internal agent tool.
 * When the LLM needs the full instructions for a skill (lazy mode),
 * it calls this tool with the skill key.
 */
export function createExpandSkillTool(opts: ExpandSkillToolOptions): AgentTool {
  return {
    name: "expand_skill",
    description:
      "Returns the full instructions for a named skill. Use when you need detailed guidance for a specific task.",
    parameters: {
      type: "object",
      properties: {
        skill: {
          type: "string",
          description: "The skill key to expand (from the skill manifest).",
        },
      },
      required: ["skill"],
    },
    async execute(args: unknown): Promise<ToolResult> {
      const { skill } = args as { skill: string };

      if (!skill || typeof skill !== "string") {
        return { content: JSON.stringify({ error: "skill key is required" }) };
      }

      const instructions = opts.registry.expandSkill(skill);

      if (instructions === null) {
        const available = opts.registry.getManifests().map((m) => m.key);
        return {
          content: JSON.stringify({
            error: `Unknown skill: ${skill}`,
            available,
          }),
        };
      }

      return { content: instructions };
    },
  };
}
