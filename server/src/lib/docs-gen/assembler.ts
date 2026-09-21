/**
 * Epic #486 / Issue #490 — Document Assembler + Markdown Generator.
 *
 * Takes discovery agent output and assembles a complete markdown document with:
 * - Table of contents from headings
 * - Mermaid diagrams showing call flows
 * - Grouped sections by module/package
 * - Formula sections with LaTeX math notation
 * - Cross-references between related symbols
 */
import type { DocSection } from "./discovery-agent.js";
import type { ExtractedFormula } from "../code-graph/formula-extractor.js";

export interface AssembleOptions {
  projectId: string;
  title?: string;
  includeCallGraph?: boolean;
  includeFormulas?: boolean;
}

/**
 * Assemble doc sections into a complete markdown document.
 */
export function assembleDocument(sections: DocSection[], options: AssembleOptions): string {
  const title = options.title ?? "Generated Documentation";
  const includeCallGraph = options.includeCallGraph ?? true;
  const includeFormulas = options.includeFormulas ?? true;

  if (sections.length === 0) {
    return `# ${title}\n\n*No documentable symbols found in the codebase.*\n`;
  }

  // Module-level synthesis path: when every section is a module-level
  // business-requirements summary, produce a flat business document
  // (no per-symbol grouping, no call-graph noise).
  const allModules = sections.every((s) => s.symbolKind === "module");
  if (allModules) {
    return assembleBusinessDocument(sections, title, includeFormulas);
  }

  // Group sections by module path
  const modules = groupByModule(sections);
  const moduleNames = Array.from(modules.keys()).sort();

  const parts: string[] = [];

  // Title
  parts.push(`# ${title}\n`);
  parts.push(
    `> Auto-generated documentation. Last updated: ${new Date().toISOString().split("T")[0]}\n`,
  );

  // Table of Contents
  parts.push("## Table of Contents\n");
  for (const moduleName of moduleNames) {
    const anchor = slugify(moduleName);
    parts.push(`- [${moduleName}](#${anchor})`);
    const moduleSections = modules.get(moduleName)!;
    for (const section of moduleSections) {
      const symAnchor = slugify(section.symbolName);
      parts.push(`  - [${section.symbolName.split(".").pop()}](#${symAnchor})`);
    }
  }
  parts.push("");

  // Call Graph Diagram (if enabled and there are cross-module calls)
  if (includeCallGraph) {
    const diagram = generateCallGraphDiagram(sections);
    if (diagram) {
      parts.push("## Architecture Overview\n");
      parts.push("```mermaid");
      parts.push(diagram);
      parts.push("```\n");
    }
  }

  // Module sections
  for (const moduleName of moduleNames) {
    const moduleSections = modules.get(moduleName)!;
    parts.push(`## ${moduleName}\n`);

    for (const section of moduleSections) {
      parts.push(renderSection(section, includeFormulas));
    }
  }

  // Formulas appendix
  if (includeFormulas) {
    const allFormulas = sections.flatMap((s) => s.formulas);
    if (allFormulas.length > 0) {
      parts.push("## Formulas & Business Rules\n");
      parts.push(renderFormulasAppendix(allFormulas));
    }
  }

  return parts.join("\n");
}

/**
 * Render a business-requirements document from module-level synthesis.
 * Each section's `summary` is already pre-formatted business documentation
 * (Purpose / Business Rules / Formulas / Workflows) from the LLM.
 */
function assembleBusinessDocument(
  sections: DocSection[],
  title: string,
  includeFormulas: boolean,
): string {
  const parts: string[] = [];

  parts.push(`# ${title}\n`);
  parts.push(
    `> Business requirements extracted from source code. Generated ${new Date().toISOString().split("T")[0]}.\n`,
  );

  // Brief overview
  parts.push("## Overview\n");
  parts.push(
    `This document describes the business requirements, rules, and formulas implemented across **${sections.length}** modules of the system. Each module section below was synthesized by analyzing the actual source code, comments, and extracted formulas.\n`,
  );

  // TOC — one entry per module (clean, navigable)
  parts.push("## Table of Contents\n");
  for (const section of sections) {
    const anchor = slugify(section.symbolName);
    parts.push(`- [${section.symbolName}](#${anchor})`);
  }
  parts.push("");

  // Module sections — each is a complete business writeup
  parts.push("## Modules\n");
  for (const section of sections) {
    parts.push(renderSection(section, includeFormulas));
  }

  // Aggregated formulas appendix
  if (includeFormulas) {
    const allFormulas = sections.flatMap((s) => s.formulas);
    if (allFormulas.length > 0) {
      parts.push("## Appendix: All Extracted Formulas & Constants\n");
      parts.push(renderFormulasAppendix(allFormulas));
    }
  }

  return parts.join("\n");
}

/**
 * Group sections by their module/directory path.
 */
function groupByModule(sections: DocSection[]): Map<string, DocSection[]> {
  const modules = new Map<string, DocSection[]>();
  for (const section of sections) {
    // Use directory as module name
    const parts = section.modulePath.split("/");
    const moduleName = parts.length > 1 ? parts.slice(0, -1).join("/") : parts[0];
    if (!modules.has(moduleName)) modules.set(moduleName, []);
    modules.get(moduleName)!.push(section);
  }
  return modules;
}

/**
 * Render a single doc section as markdown.
 */
function renderSection(section: DocSection, includeFormulas: boolean): string {
  const parts: string[] = [];

  // Module sections (from synthesizeBusinessRequirements) carry pre-formatted
  // business documentation in the summary — render it as-is with just a
  // module header, skipping the per-symbol metadata.
  if (section.symbolKind === "module") {
    parts.push(`### ${section.symbolName}\n`);
    parts.push(`*Source: \`${section.modulePath}\`*\n`);
    parts.push(section.summary + "\n");

    if (includeFormulas && section.formulas.length > 0) {
      parts.push("\n#### Extracted Formulas\n");
      for (const f of section.formulas) {
        parts.push(`- **${f.kind}**: \`${f.expression.slice(0, 200)}\``);
      }
      parts.push("");
    }

    parts.push("---\n");
    return parts.join("\n");
  }

  const shortName = section.symbolName.split(".").pop() ?? section.symbolName;

  parts.push(`### ${shortName}\n`);
  parts.push(
    `**Kind:** ${section.symbolKind} | **Complexity:** ${section.complexity} | **File:** \`${section.modulePath}\`\n`,
  );
  parts.push(section.summary + "\n");

  // Parameters
  if (section.parameters.length > 0) {
    parts.push("**Parameters:**\n");
    parts.push("| Name | Type | Description |");
    parts.push("|------|------|-------------|");
    for (const p of section.parameters) {
      parts.push(`| \`${p.name}\` | \`${p.type}\` | ${p.description || "-"} |`);
    }
    parts.push("");
  }

  // Return type
  if (section.returns) {
    parts.push(`**Returns:** \`${section.returns}\`\n`);
  }

  // Rationale
  if (section.rationale.length > 0) {
    parts.push("**Design Rationale:**\n");
    for (const r of section.rationale) {
      parts.push(`> ${r}\n`);
    }
  }

  // Call graph (inline)
  if (section.callsTo.length > 0 || section.calledBy.length > 0) {
    parts.push("**Dependencies:**\n");
    if (section.callsTo.length > 0) {
      parts.push(`- Calls: ${section.callsTo.map((n) => `\`${n.split(".").pop()}\``).join(", ")}`);
    }
    if (section.calledBy.length > 0) {
      parts.push(
        `- Called by: ${section.calledBy.map((n) => `\`${n.split(".").pop()}\``).join(", ")}`,
      );
    }
    parts.push("");
  }

  // Formulas within this symbol
  if (includeFormulas && section.formulas.length > 0) {
    parts.push("**Formulas:**\n");
    for (const f of section.formulas) {
      parts.push(`- ${f.description}: $${escapeLatex(f.expression)}$`);
    }
    parts.push("");
  }

  parts.push("---\n");
  return parts.join("\n");
}

/**
 * Generate a Mermaid graph showing inter-module call relationships.
 */
function generateCallGraphDiagram(sections: DocSection[]): string | null {
  const edges = new Set<string>();
  const nodes = new Set<string>();

  for (const section of sections) {
    const fromNode = sanitizeMermaidId(section.symbolName);
    nodes.add(fromNode);

    for (const target of section.callsTo) {
      const toNode = sanitizeMermaidId(target);
      nodes.add(toNode);
      edges.add(`  ${fromNode} --> ${toNode}`);
    }
  }

  if (edges.size === 0) return null;
  if (edges.size > 50) {
    // Too many edges — show only inter-module relationships
    return generateModuleLevelDiagram(sections);
  }

  const lines: string[] = ["graph LR"];
  for (const edge of edges) {
    lines.push(edge);
  }
  return lines.join("\n");
}

/**
 * Generate a simplified module-level Mermaid diagram.
 */
function generateModuleLevelDiagram(sections: DocSection[]): string | null {
  const moduleEdges = new Set<string>();
  for (const section of sections) {
    const fromModule = section.modulePath.split("/").slice(0, -1).join("/") || section.modulePath;
    for (const target of section.callsTo) {
      // Find the target section
      const targetSection = sections.find((s) => s.symbolName === target);
      if (targetSection) {
        const toModule =
          targetSection.modulePath.split("/").slice(0, -1).join("/") || targetSection.modulePath;
        if (fromModule !== toModule) {
          moduleEdges.add(`  ${sanitizeMermaidId(fromModule)} --> ${sanitizeMermaidId(toModule)}`);
        }
      }
    }
  }
  if (moduleEdges.size === 0) return null;
  return ["graph LR", ...moduleEdges].join("\n");
}

/**
 * Render the formulas appendix section.
 */
function renderFormulasAppendix(formulas: ExtractedFormula[]): string {
  const parts: string[] = [];

  // Group by kind
  const byKind = new Map<string, ExtractedFormula[]>();
  for (const f of formulas) {
    if (!byKind.has(f.kind)) byKind.set(f.kind, []);
    byKind.get(f.kind)!.push(f);
  }

  const kindLabels: Record<string, string> = {
    arithmetic: "Calculations",
    constant: "Constants",
    "business-rule": "Business Rules",
    validation: "Validations",
  };

  for (const [kind, items] of byKind) {
    parts.push(`### ${kindLabels[kind] ?? kind}\n`);
    parts.push("| Name | Expression | Location |");
    parts.push("|------|-----------|----------|");
    for (const item of items.slice(0, 50)) {
      const name = item.name ?? "-";
      const expr =
        item.expression.length > 60 ? item.expression.slice(0, 57) + "..." : item.expression;
      parts.push(`| \`${name}\` | \`${expr}\` | ${item.filePath}:${item.startLine} |`);
    }
    parts.push("");
  }

  return parts.join("\n");
}

// ============================================================================
// Helpers
// ============================================================================

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function sanitizeMermaidId(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
}

function escapeLatex(expr: string): string {
  return expr.replace(/\\/g, "\\\\").replace(/_/g, "\\_").replace(/\$/g, "\\$");
}
