/**
 * API contract doc generator (Epic #544 / Issue #553).
 *
 * Auto-generates human-readable API reference documentation from detected
 * OpenAPI/GraphQL/protobuf specifications.
 */
import type { GeneratedDoc } from "./unified-doc-generator.js";
import type { CrawlSpec } from "./repo-crawler.js";

export interface ApiContractDocInput {
  productName: string;
  repoName: string;
  repoConnectionId: string;
  ownerOrOrg: string;
  specs: CrawlSpec[];
}

export interface ParsedEndpoint {
  method: string;
  path: string;
  summary?: string;
  description?: string;
  parameters?: Array<{ name: string; in: string; required?: boolean; type?: string }>;
  requestBody?: string;
  responses?: Array<{ status: string; description: string }>;
  tags?: string[];
}

export interface ParsedGraphQLType {
  name: string;
  kind: "type" | "input" | "enum" | "interface" | "union" | "scalar";
  fields?: Array<{ name: string; type: string; description?: string }>;
  description?: string;
}

export interface ParsedProtoService {
  name: string;
  methods: Array<{
    name: string;
    inputType: string;
    outputType: string;
    description?: string;
  }>;
}

export interface ParsedProtoMessage {
  name: string;
  fields: Array<{ name: string; type: string; number: number }>;
}

/**
 * Generate API contract documentation from a list of specs.
 */
export function generateApiContractDoc(input: ApiContractDocInput): GeneratedDoc {
  const { productName, repoName, ownerOrOrg, specs } = input;
  const sections: string[] = [];

  sections.push(`# ${repoName} — API Contract Documentation\n`);
  sections.push(`Part of the **${productName}** product.\n`);
  sections.push(`Repository: \`${ownerOrOrg}/${repoName}\`\n`);

  // Process each spec
  for (const spec of specs) {
    switch (spec.format) {
      case "openapi":
      case "swagger":
        sections.push(generateOpenApiSection(spec));
        break;
      case "graphql":
        sections.push(generateGraphQLSection(spec));
        break;
      case "protobuf":
        sections.push(generateProtobufSection(spec));
        break;
    }
    sections.push("");
  }

  if (specs.length === 0) {
    sections.push("_No API specifications found in this repository._\n");
  }

  const content = sections.join("\n");
  return {
    title: `${repoName} — API Contracts`,
    content,
    metadata: {
      generatedAt: new Date().toISOString(),
      repoCount: 1,
      edgeCount: 0,
      provenance: specs.map((s) => ({
        repo: `${ownerOrOrg}/${repoName}`,
        file: s.filePath,
      })),
    },
  };
}

/**
 * Parse and render OpenAPI/Swagger spec to Markdown.
 */
function generateOpenApiSection(spec: CrawlSpec): string {
  const lines: string[] = [];
  lines.push(`## OpenAPI Specification\n`);
  lines.push(`Source: \`${spec.filePath}\`\n`);

  const endpoints = parseOpenApiEndpoints(spec.content);
  if (endpoints.length === 0) {
    lines.push("_Could not parse endpoints from spec._\n");
    return lines.join("\n");
  }

  // Group by tag
  const byTag = new Map<string, ParsedEndpoint[]>();
  for (const ep of endpoints) {
    const tag = ep.tags?.[0] ?? "default";
    const existing = byTag.get(tag) ?? [];
    existing.push(ep);
    byTag.set(tag, existing);
  }

  for (const [tag, eps] of byTag) {
    lines.push(`### ${tag}\n`);
    lines.push("| Method | Path | Summary |");
    lines.push("|--------|------|---------|");
    for (const ep of eps) {
      lines.push(`| \`${ep.method}\` | \`${ep.path}\` | ${ep.summary ?? ""} |`);
    }
    lines.push("");

    // Detail for each endpoint
    for (const ep of eps) {
      lines.push(`#### \`${ep.method} ${ep.path}\`\n`);
      if (ep.description) lines.push(`${ep.description}\n`);
      if (ep.parameters && ep.parameters.length > 0) {
        lines.push("**Parameters:**\n");
        lines.push("| Name | In | Required | Type |");
        lines.push("|------|-----|----------|------|");
        for (const p of ep.parameters) {
          lines.push(
            `| ${p.name} | ${p.in} | ${p.required ? "Yes" : "No"} | ${p.type ?? "string"} |`,
          );
        }
        lines.push("");
      }
      if (ep.responses && ep.responses.length > 0) {
        lines.push("**Responses:**\n");
        lines.push("| Status | Description |");
        lines.push("|--------|-------------|");
        for (const r of ep.responses) {
          lines.push(`| ${r.status} | ${r.description} |`);
        }
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Parse OpenAPI endpoints from YAML/JSON content.
 * This is a lightweight parser — not full spec resolution.
 */
export function parseOpenApiEndpoints(content: string): ParsedEndpoint[] {
  const endpoints: ParsedEndpoint[] = [];

  // Try JSON first
  try {
    const spec = JSON.parse(content);
    if (spec.paths) {
      for (const [path, methods] of Object.entries(spec.paths)) {
        if (typeof methods !== "object" || methods === null) continue;
        for (const [method, details] of Object.entries(methods as Record<string, unknown>)) {
          if (["get", "post", "put", "patch", "delete", "options", "head"].includes(method)) {
            const d = details as Record<string, unknown>;
            endpoints.push({
              method: method.toUpperCase(),
              path,
              summary: (d.summary as string) ?? undefined,
              description: (d.description as string) ?? undefined,
              tags: (d.tags as string[]) ?? undefined,
              parameters: Array.isArray(d.parameters)
                ? (d.parameters as Array<Record<string, unknown>>).map((p) => ({
                    name: (p.name as string) ?? "",
                    in: (p.in as string) ?? "query",
                    required: (p.required as boolean) ?? false,
                    type: ((p.schema as Record<string, unknown>)?.type as string) ?? "string",
                  }))
                : undefined,
              responses: d.responses
                ? Object.entries(d.responses as Record<string, unknown>).map(([status, resp]) => ({
                    status,
                    description: ((resp as Record<string, unknown>)?.description as string) ?? "",
                  }))
                : undefined,
            });
          }
        }
      }
    }
    return endpoints;
  } catch {
    // Not JSON, try YAML-like parsing (simple regex extraction)
  }

  // Simple YAML path extraction
  let currentPath = "";
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const pathMatch = /^['"]?(\/.+?)['"]?\s*:/.exec(line);
    if (pathMatch && !line.startsWith(" ")) {
      currentPath = pathMatch[1];
      continue;
    }
    // Indented path under 'paths:' key
    const indentedPathMatch = /^\s{2}['"]?(\/.+?)['"]?\s*:/.exec(line);
    if (indentedPathMatch) {
      currentPath = indentedPathMatch[1];
      continue;
    }
    const methodMatch = /^\s{4}(get|post|put|patch|delete|options|head)\s*:/.exec(line);
    if (methodMatch && currentPath) {
      const method = methodMatch[1].toUpperCase();
      // Look ahead for summary
      let summary: string | undefined;
      for (let j = i + 1; j < Math.min(i + 10, lines.length); j++) {
        const sumMatch = /^\s+summary:\s*['"]?(.+?)['"]?\s*$/.exec(lines[j]);
        if (sumMatch) {
          summary = sumMatch[1];
          break;
        }
        // Stop if we hit another method or path
        if (/^\s{2,4}(get|post|put|patch|delete)\s*:/.test(lines[j])) break;
        if (/^\s{0,2}['"]?\//.test(lines[j])) break;
      }
      endpoints.push({ method, path: currentPath, summary });
    }
  }

  return endpoints;
}

/**
 * Render GraphQL schema to Markdown documentation.
 */
function generateGraphQLSection(spec: CrawlSpec): string {
  const lines: string[] = [];
  lines.push(`## GraphQL Schema\n`);
  lines.push(`Source: \`${spec.filePath}\`\n`);

  const types = parseGraphQLTypes(spec.content);
  if (types.length === 0) {
    lines.push("_Could not parse types from GraphQL schema._\n");
    return lines.join("\n");
  }

  // Separate queries/mutations from types
  const queryTypes = types.filter(
    (t) => t.name === "Query" || t.name === "Mutation" || t.name === "Subscription",
  );
  const objectTypes = types.filter(
    (t) =>
      t.name !== "Query" && t.name !== "Mutation" && t.name !== "Subscription" && t.kind === "type",
  );
  const inputTypes = types.filter((t) => t.kind === "input");
  const enumTypes = types.filter((t) => t.kind === "enum");

  // Queries/Mutations
  for (const qt of queryTypes) {
    lines.push(`### ${qt.name}\n`);
    if (qt.fields && qt.fields.length > 0) {
      lines.push("| Field | Type | Description |");
      lines.push("|-------|------|-------------|");
      for (const f of qt.fields) {
        lines.push(`| ${f.name} | \`${f.type}\` | ${f.description ?? ""} |`);
      }
      lines.push("");
    }
  }

  // Object types
  if (objectTypes.length > 0) {
    lines.push("### Types\n");
    for (const t of objectTypes) {
      lines.push(`#### ${t.name}\n`);
      if (t.description) lines.push(`${t.description}\n`);
      if (t.fields && t.fields.length > 0) {
        lines.push("| Field | Type |");
        lines.push("|-------|------|");
        for (const f of t.fields) {
          lines.push(`| ${f.name} | \`${f.type}\` |`);
        }
        lines.push("");
      }
    }
  }

  // Input types
  if (inputTypes.length > 0) {
    lines.push("### Input Types\n");
    for (const t of inputTypes) {
      lines.push(`#### ${t.name}\n`);
      if (t.fields && t.fields.length > 0) {
        lines.push("| Field | Type |");
        lines.push("|-------|------|");
        for (const f of t.fields) {
          lines.push(`| ${f.name} | \`${f.type}\` |`);
        }
        lines.push("");
      }
    }
  }

  // Enums
  if (enumTypes.length > 0) {
    lines.push("### Enums\n");
    for (const t of enumTypes) {
      lines.push(`#### ${t.name}\n`);
      if (t.fields && t.fields.length > 0) {
        lines.push("Values: " + t.fields.map((f) => `\`${f.name}\``).join(", "));
        lines.push("");
      }
    }
  }

  return lines.join("\n");
}

/**
 * Parse GraphQL SDL for types.
 */
export function parseGraphQLTypes(content: string): ParsedGraphQLType[] {
  const types: ParsedGraphQLType[] = [];
  const typePattern =
    /(?:"""([^]*?)"""\s*)?(?:type|input|enum|interface|union|scalar)\s+(\w+)(?:\s+implements\s+\w+(?:\s*&\s*\w+)*)?\s*\{([^}]*)\}/g;

  let match: RegExpExecArray | null;
  while ((match = typePattern.exec(content)) !== null) {
    const description = match[1]?.trim();
    const name = match[2];
    const body = match[3];
    const kindMatch = content
      .slice(match.index, match.index + 20)
      .match(/^(type|input|enum|interface)/);
    const kind = (kindMatch?.[1] ?? "type") as ParsedGraphQLType["kind"];

    const fields: ParsedGraphQLType["fields"] = [];
    if (kind === "enum") {
      // Enum values
      const valuePattern = /(\w+)/g;
      let vm: RegExpExecArray | null;
      while ((vm = valuePattern.exec(body)) !== null) {
        fields.push({ name: vm[1], type: "enum_value" });
      }
    } else {
      // Object fields
      const fieldPattern = /(\w+)\s*(?:\([^)]*\))?\s*:\s*([^\n,!]+[!]?)/g;
      let fm: RegExpExecArray | null;
      while ((fm = fieldPattern.exec(body)) !== null) {
        fields.push({ name: fm[1], type: fm[2].trim() });
      }
    }

    types.push({ name, kind, fields, description });
  }

  return types;
}

/**
 * Render protobuf definitions to Markdown documentation.
 */
function generateProtobufSection(spec: CrawlSpec): string {
  const lines: string[] = [];
  lines.push(`## Protobuf Definitions\n`);
  lines.push(`Source: \`${spec.filePath}\`\n`);

  const { services, messages } = parseProtobuf(spec.content);

  // Services
  if (services.length > 0) {
    lines.push("### Services\n");
    for (const svc of services) {
      lines.push(`#### ${svc.name}\n`);
      if (svc.methods.length > 0) {
        lines.push("| Method | Input | Output |");
        lines.push("|--------|-------|--------|");
        for (const m of svc.methods) {
          lines.push(`| ${m.name} | \`${m.inputType}\` | \`${m.outputType}\` |`);
        }
        lines.push("");
      }
    }
  }

  // Messages
  if (messages.length > 0) {
    lines.push("### Messages\n");
    for (const msg of messages) {
      lines.push(`#### ${msg.name}\n`);
      if (msg.fields.length > 0) {
        lines.push("| Field | Type | Number |");
        lines.push("|-------|------|--------|");
        for (const f of msg.fields) {
          lines.push(`| ${f.name} | \`${f.type}\` | ${f.number} |`);
        }
        lines.push("");
      }
    }
  }

  if (services.length === 0 && messages.length === 0) {
    lines.push("_Could not parse definitions from protobuf file._\n");
  }

  return lines.join("\n");
}

/**
 * Parse protobuf content for services and messages.
 */
export function parseProtobuf(content: string): {
  services: ParsedProtoService[];
  messages: ParsedProtoMessage[];
} {
  const services: ParsedProtoService[] = [];
  const messages: ParsedProtoMessage[] = [];

  // Parse services
  const servicePattern = /service\s+(\w+)\s*\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = servicePattern.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];
    const methods: ParsedProtoService["methods"] = [];
    const rpcPattern = /rpc\s+(\w+)\s*\(\s*(\w+)\s*\)\s*returns\s*\(\s*(\w+)\s*\)/g;
    let rm: RegExpExecArray | null;
    while ((rm = rpcPattern.exec(body)) !== null) {
      methods.push({
        name: rm[1],
        inputType: rm[2],
        outputType: rm[3],
      });
    }
    services.push({ name, methods });
  }

  // Parse messages
  const messagePattern = /message\s+(\w+)\s*\{([^}]*)\}/g;
  while ((match = messagePattern.exec(content)) !== null) {
    const name = match[1];
    const body = match[2];
    const fields: ParsedProtoMessage["fields"] = [];
    const fieldPattern = /(\w+)\s+(\w+)\s*=\s*(\d+)/g;
    let fm: RegExpExecArray | null;
    while ((fm = fieldPattern.exec(body)) !== null) {
      fields.push({
        type: fm[1],
        name: fm[2],
        number: parseInt(fm[3], 10),
      });
    }
    messages.push({ name, fields });
  }

  return { services, messages };
}
