/**
 * AGENTS.md renderer + parser (#154).
 *
 * Format follows the AGENTS.md spec (https://agents.md): each agent is a
 * `## <name>` heading with a YAML-ish front-matter list of metadata
 * (description, model, tools) and a free-form prose system prompt.
 *
 * Round-trip safe: `parseAgentsMd(generateAgentsMd(set)).agents` is
 * structurally identical to `set.agents` (modulo metadata-only changes).
 */
import type { DetectedAgent, DetectedAgentSet } from "./detector.js";

export interface ParsedAgentsMd {
  title?: string;
  preface?: string;
  agents: Array<{
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    model?: string;
  }>;
}

export interface GenerateOptions {
  projectName: string;
  projectDescription?: string;
}

export function generateAgentsMd(set: DetectedAgentSet, opts: GenerateOptions): string {
  const lines: string[] = [];
  lines.push(`# ${opts.projectName}`);
  lines.push("");
  if (opts.projectDescription) {
    lines.push(opts.projectDescription.trim());
    lines.push("");
  }
  lines.push("This file defines the agents available to AI tools when working on this project.");
  lines.push("");

  for (const a of set.agents) {
    lines.push(`## ${a.name}`);
    lines.push("");
    lines.push(`- description: ${a.description.replace(/\n/g, " ")}`);
    if (a.model) lines.push(`- model: ${a.model}`);
    lines.push(
      `- tools: ${a.tools.length === 0 ? "[]" : a.tools.map((t) => `\`${t}\``).join(", ")}`,
    );
    lines.push("");
    lines.push("### system_prompt");
    lines.push("");
    lines.push(a.systemPrompt.trim());
    lines.push("");
  }

  if (set.mcpServers.length > 0) {
    lines.push("## MCP servers");
    lines.push("");
    for (const s of set.mcpServers) {
      lines.push(`- **${s.label}**: ${s.tools.join(", ") || "(no tools)"}`);
    }
    lines.push("");
  }

  lines.push("<!-- generated-by: metis -->");
  return lines.join("\n").replace(/\n+$/, "") + "\n";
}

const HEADING_PATTERN = /^##\s+(.+?)\s*$/;
const META_PATTERN = /^-\s+([a-z_]+):\s*(.*)$/i;

export function parseAgentsMd(markdown: string): ParsedAgentsMd {
  const rawLines = markdown.split(/\r?\n/);
  const out: ParsedAgentsMd = { agents: [] };

  let i = 0;
  // Optional title (first H1 if present before any H2).
  while (i < rawLines.length) {
    if (HEADING_PATTERN.test(rawLines[i])) break;
    const m = /^#\s+(.+?)\s*$/.exec(rawLines[i]);
    if (m) {
      out.title = m[1];
      i += 1;
      break;
    }
    i += 1;
  }

  // Preface up to the first H2.
  const preface: string[] = [];
  while (i < rawLines.length && !HEADING_PATTERN.test(rawLines[i])) {
    preface.push(rawLines[i]);
    i += 1;
  }
  const prefaceJoined = preface.join("\n").trim();
  if (prefaceJoined) out.preface = prefaceJoined;

  // Sections.
  while (i < rawLines.length) {
    const headMatch = HEADING_PATTERN.exec(rawLines[i]);
    if (!headMatch) {
      i += 1;
      continue;
    }
    const sectionName = headMatch[1].trim();
    i += 1;

    // Skip non-agent sections (e.g. "MCP servers").
    if (sectionName.toLowerCase() === "mcp servers") {
      while (i < rawLines.length && !HEADING_PATTERN.test(rawLines[i])) i += 1;
      continue;
    }

    let description = "";
    let model: string | undefined;
    const tools: string[] = [];
    let systemPrompt = "";

    // Metadata block.
    while (i < rawLines.length) {
      const line = rawLines[i];
      if (HEADING_PATTERN.test(line)) break;
      if (/^###\s+system_prompt/i.test(line)) {
        i += 1;
        const promptLines: string[] = [];
        while (i < rawLines.length) {
          const next = rawLines[i];
          if (HEADING_PATTERN.test(next)) break;
          if (next.trim().startsWith("<!--")) break;
          promptLines.push(next);
          i += 1;
        }
        systemPrompt = promptLines.join("\n").trim();
        break;
      }
      const meta = META_PATTERN.exec(line);
      if (meta) {
        const key = meta[1].toLowerCase();
        const value = meta[2].trim();
        if (key === "description") description = value;
        else if (key === "model") model = value;
        else if (key === "tools") {
          if (value === "[]" || value === "") {
            // empty
          } else {
            for (const piece of value.split(",")) {
              const t = piece.trim().replace(/^`|`$/g, "");
              if (t) tools.push(t);
            }
          }
        }
      }
      i += 1;
    }

    out.agents.push({
      name: sectionName,
      description,
      systemPrompt,
      tools,
      ...(model ? { model } : {}),
    });
  }

  return out;
}

/** Convert the parsed shape back into DetectedAgent[] for storage. */
export function parsedToDetected(parsed: ParsedAgentsMd): DetectedAgent[] {
  return parsed.agents.map((a) => ({
    name: a.name,
    description: a.description,
    systemPrompt: a.systemPrompt,
    tools: a.tools,
    model: a.model,
    source: "agents-md" as const,
  }));
}
