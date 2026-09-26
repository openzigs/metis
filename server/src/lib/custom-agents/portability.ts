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
 *
 * Epic #129 (#145) — schema version 2 adds the rest of the one agent
 * definition: `skillKeys` and the `approvalPolicy` override (tighten-only; it
 * can never loosen a session's policy). Version 1 documents still import —
 * with no skills and no override, exactly as before.
 */
import { z } from "zod";
import type { CustomAgentDefinition, CustomAgentDto } from "@metis/shared";

export class AgentImportError extends Error {}

/**
 * Current export-document schema version. An agent with no skills and no
 * approval override is still exported as version 1 — byte-for-byte what older
 * METIS versions export and import — so plain agents stay portable backwards.
 */
export const AGENT_EXPORT_SCHEMA_VERSION = 2 as const;
/** Versions {@link parseAgentImport} accepts. */
export const AGENT_IMPORT_SCHEMA_VERSIONS = [1, 2] as const;

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

const action = z.enum(["auto", "prompt-once", "always-prompt", "deny"]);
const approvalPolicySchema = z
  .object({ low: action.optional(), medium: action.optional(), high: action.optional() })
  .strict();

const definitionV1Schema = z
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

const definitionSchema = definitionV1Schema
  .extend({
    skillKeys: z
      .array(z.string().regex(/^[a-z0-9][a-z0-9._-]{0,79}$/, "Invalid skill key"))
      .max(32)
      .default([]),
    approvalPolicy: approvalPolicySchema.nullish(),
  })
  .strict();

const documentSchema = z.discriminatedUnion("schemaVersion", [
  z.object({ schemaVersion: z.literal(1), agent: definitionV1Schema }).strict(),
  z.object({ schemaVersion: z.literal(2), agent: definitionSchema }).strict(),
]);

export interface AgentExportDocument {
  schemaVersion: (typeof AGENT_IMPORT_SCHEMA_VERSIONS)[number];
  agent: {
    name: string;
    description: string;
    systemPrompt: string;
    tools: string[];
    model: string | null;
    reasoningEffort: CustomAgentDefinition["reasoningEffort"];
    /** Version 2 only. */
    skillKeys?: string[];
    /** Version 2 only. */
    approvalPolicy?: CustomAgentDefinition["approvalPolicy"];
  };
}

/** Build a portable, side-effect-free export document from a stored agent. */
export function exportAgent(agent: CustomAgentDto): AgentExportDocument {
  const base = {
    name: agent.name,
    description: agent.description,
    systemPrompt: agent.systemPrompt,
    tools: [...agent.tools],
    model: agent.model ?? null,
    reasoningEffort: agent.reasoningEffort ?? null,
  };
  const skillKeys = agent.skillKeys ?? [];
  const approvalPolicy = agent.approvalPolicy ?? null;
  if (skillKeys.length === 0 && !approvalPolicy) return { schemaVersion: 1, agent: base };
  return {
    schemaVersion: AGENT_EXPORT_SCHEMA_VERSION,
    agent: { ...base, skillKeys: [...skillKeys], approvalPolicy },
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

  const def: z.infer<typeof definitionV1Schema> & {
    skillKeys?: string[];
    approvalPolicy?: z.infer<typeof approvalPolicySchema> | null;
  } = isWrapped
    ? (result.data as z.infer<typeof documentSchema>).agent
    : (result.data as z.infer<typeof definitionSchema>);

  return {
    name: def.name,
    description: def.description,
    systemPrompt: def.systemPrompt,
    tools: def.tools,
    model: def.model ?? null,
    reasoningEffort: def.reasoningEffort ?? null,
    skillKeys: def.skillKeys ?? [],
    approvalPolicy: def.approvalPolicy ?? null,
  };
}
