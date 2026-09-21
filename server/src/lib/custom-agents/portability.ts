/**
 * Epic #260 (#82) — custom-agent import/export JSON.
 *
 * SECURITY MODEL
 * --------------
 * Import payloads are UNTRUSTED. We validate strictly with Zod:
 *   - `.strict()` rejects unknown fields (defends against prototype pollution
 *     and smuggled server-owned fields like `isBuiltIn`/`projectId`).
 *   - field types are enforced; names match the same regex the service uses.
 *   - SSRF guard: NO string field (model / tool name) may look like a URL, so
 *     an import can never coerce the server into fetching a remote resource.
 * Import NEVER carries identity (`id`, `projectId`, `isBuiltIn`, timestamps) —
 * those are assigned server-side on create.
 */
import { z } from "zod";
import type { CustomAgentDefinition, CustomAgentDto } from "@metis/shared";

export class AgentImportError extends Error {}

/** Current export-document schema version. */
export const AGENT_EXPORT_SCHEMA_VERSION = 1 as const;

const NAME_RE = /^[A-Za-z][A-Za-z0-9 _-]{1,63}$/;
// Reject anything with a URL scheme or a leading `//` (protocol-relative).
const URL_LIKE_RE = /^[a-z][a-z0-9+.-]*:\/\/|^\/\//i;

function noUrl(label: string) {
  return (val: string, ctx: z.RefinementCtx) => {
    if (URL_LIKE_RE.test(val.trim())) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${label} must not be a URL`,
      });
    }
  };
}

const definitionSchema = z
  .object({
    name: z.string().regex(NAME_RE, "Invalid agent name"),
    description: z.string().max(500).default(""),
    systemPrompt: z.string().min(1).max(20_000),
    tools: z
      .array(z.string().min(1).max(120).superRefine(noUrl("tool name")))
      .max(64)
      .default([]),
    model: z.string().max(200).superRefine(noUrl("model")).nullish(),
    reasoningEffort: z.enum(["low", "medium", "high"]).nullish(),
  })
  .strict();

const documentSchema = z
  .object({
    schemaVersion: z.literal(AGENT_EXPORT_SCHEMA_VERSION),
    agent: definitionSchema,
  })
  .strict();

export interface AgentExportDocument {
  schemaVersion: typeof AGENT_EXPORT_SCHEMA_VERSION;
  agent: {
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    model: string | null;
    reasoningEffort: CustomAgentDefinition["reasoningEffort"];
  };
}

/** Build a portable, side-effect-free export document from a stored agent. */
export function exportAgent(agent: CustomAgentDto): AgentExportDocument {
  return {
    schemaVersion: AGENT_EXPORT_SCHEMA_VERSION,
    agent: {
      name: agent.name,
      description: agent.description,
      systemPrompt: agent.systemPrompt,
      tools: [...agent.tools],
      model: agent.model ?? null,
      reasoningEffort: agent.reasoningEffort ?? null,
    },
  };
}

/**
 * Parse + validate an untrusted import payload into a clean
 * {@link CustomAgentDefinition}. Accepts either the wrapped export document
 * (`{ schemaVersion, agent }`) or a bare definition.
 *
 * @throws AgentImportError on any validation failure.
 */
export function parseAgentImport(payload: unknown): CustomAgentDefinition {
  if (payload === null || typeof payload !== "object") {
    throw new AgentImportError("Import payload must be a JSON object");
  }

  // A wrapped document declares schemaVersion; a bare definition does not.
  const isWrapped = "schemaVersion" in (payload as Record<string, unknown>);
  const result = isWrapped
    ? documentSchema.safeParse(payload)
    : definitionSchema.safeParse(payload);

  if (!result.success) {
    throw new AgentImportError(result.error.issues.map((i) => i.message).join("; "));
  }

  const def = isWrapped
    ? (result.data as z.infer<typeof documentSchema>).agent
    : (result.data as z.infer<typeof definitionSchema>);

  return {
    name: def.name,
    description: def.description,
    systemPrompt: def.systemPrompt,
    tools: def.tools,
    model: def.model ?? null,
    reasoningEffort: def.reasoningEffort ?? null,
  };
}
