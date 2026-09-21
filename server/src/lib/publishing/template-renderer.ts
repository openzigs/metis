/**
 * Template Renderer — Epic #595 / Issue #613.
 *
 * Renders validated template data into formatted output for GitHub
 * (Markdown) or Jira (custom field mappings).
 */
import type { TemplateSchema, TemplateSection } from "./template-schema.js";

/**
 * Render validated template data to GitHub-flavored Markdown.
 */
export function renderToMarkdown(data: Record<string, unknown>, schema: TemplateSchema): string {
  const lines: string[] = [];

  for (const section of schema.sections) {
    const value = data[section.key];
    if (value === undefined || value === null) continue;

    // Title is rendered as the issue title, not in the body
    if (section.key === "title") continue;

    lines.push(`## ${section.label}`);
    lines.push("");
    lines.push(renderSectionValue(value, section));
    lines.push("");
  }

  return lines.join("\n").trim();
}

/**
 * Render validated template data to a Jira-compatible field map.
 * Returns an object with standard and custom field mappings.
 */
export function renderToJiraFields(
  data: Record<string, unknown>,
  schema: TemplateSchema,
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  const bodyParts: string[] = [];

  for (const section of schema.sections) {
    const value = data[section.key];
    if (value === undefined || value === null) continue;

    // Check for Jira field mapping
    const mapping = schema.platformFields?.[section.key];
    if (mapping?.jiraField) {
      fields[mapping.jiraField] = formatJiraFieldValue(value, section);
    } else if (section.key === "title") {
      fields.summary = value;
    } else {
      // No Jira mapping — append to description body
      bodyParts.push(`h3. ${section.label}`);
      bodyParts.push(renderSectionValueJira(value, section));
      bodyParts.push("");
    }
  }

  if (bodyParts.length > 0) {
    fields.description = bodyParts.join("\n").trim();
  }

  return fields;
}

function renderSectionValue(value: unknown, section: TemplateSection): string {
  switch (section.type) {
    case "text":
    case "markdown":
      return String(value);
    case "checklist":
      if (Array.isArray(value)) {
        return value.map((item: unknown) => `- [ ] ${String(item)}`).join("\n");
      }
      return String(value);
    case "number":
      return `**${section.label}**: ${value}`;
    case "select":
      return `**${section.label}**: ${value}`;
    case "tags":
      if (Array.isArray(value)) {
        return value.map((tag: unknown) => `\`${String(tag)}\``).join(", ");
      }
      return String(value);
    default:
      return String(value);
  }
}

function renderSectionValueJira(value: unknown, section: TemplateSection): string {
  switch (section.type) {
    case "text":
    case "markdown":
      return String(value);
    case "checklist":
      if (Array.isArray(value)) {
        return value.map((item: unknown) => `* ${String(item)}`).join("\n");
      }
      return String(value);
    case "number":
      return `*${section.label}*: ${value}`;
    case "select":
      return `*${section.label}*: ${value}`;
    case "tags":
      if (Array.isArray(value)) {
        return value.map((tag: unknown) => `{${String(tag)}}`).join(", ");
      }
      return String(value);
    default:
      return String(value);
  }
}

function formatJiraFieldValue(value: unknown, section: TemplateSection): unknown {
  switch (section.type) {
    case "select":
      // Jira expects { name: "value" } for priority and similar fields
      return { name: String(value) };
    case "tags":
      // Jira labels are string arrays
      return Array.isArray(value) ? value : [String(value)];
    case "number":
      return Number(value);
    default:
      return value;
  }
}

/**
 * Build the LLM prompt section describing the template schema.
 * Injected into the system prompt so the LLM produces structured output.
 */
export function buildTemplatePrompt(schema: TemplateSchema): string {
  const lines = ["You MUST structure your output as a JSON object with the following fields:", ""];

  for (const section of schema.sections) {
    const req = section.required ? "(REQUIRED)" : "(optional)";
    let typeDesc: string = section.type;
    if (section.type === "checklist") typeDesc = "array of strings";
    if (section.type === "tags") typeDesc = "array of strings";
    if (section.type === "select" && section.validation?.options) {
      typeDesc = `one of: ${section.validation.options.join(", ")}`;
    }
    lines.push(`- "${section.key}" ${req} [${typeDesc}]: ${section.label}`);
    if (section.placeholder) {
      lines.push(`  Example: ${section.placeholder}`);
    }
  }

  lines.push("");
  lines.push("Return ONLY valid JSON matching this schema. No markdown wrapping.");

  return lines.join("\n");
}
