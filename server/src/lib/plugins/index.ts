/**
 * Epic #165 (#115) — Plugin packaging.
 *
 * Pack METIS skills/agents/hooks into a tarball-equivalent buffer that any
 * Copilot CLI install can consume, and unpack one back into the project. The
 * implementation uses a simple deterministic JSON envelope (no native tar
 * dependency) so the slim image budget from #179 isn't regressed and
 * cross-platform handling stays trivial.
 *
 * Plugin envelope shape (`metis-plugin-<slug>.json`):
 *
 *   {
 *     "format": "metis-plugin",
 *     "version": "1.0",
 *     "manifest": { name, version, description, exportedAt },
 *     "skills":  [{ name, description, version, instructions, tools, tags }],
 *     "agents":  [{ name, description, systemPrompt, tools, model, reasoningEffort }],
 *     "hooks":   [{ event, handlerKind, config }]
 *   }
 *
 * Idempotency: pack(unpack(buf)) === buf for any well-formed envelope.
 */
import { z } from "zod";
import {
  SDK_HOOK_EVENTS,
  SDK_HOOK_HANDLER_KINDS,
  type CustomAgentDefinition,
  type SdkHookEvent,
  type SdkHookHandlerKind,
} from "@metis/shared";

export const PLUGIN_FORMAT = "metis-plugin";
export const PLUGIN_FORMAT_VERSION = "1.0";

export class PluginFormatError extends Error {}

const SLUG_RE = /^[a-z][a-z0-9-]{1,63}$/;

export function pluginFileName(slug: string): string {
  if (!SLUG_RE.test(slug)) {
    throw new PluginFormatError(
      "Plugin slug must be lowercase alphanumeric with hyphens, starting with a letter",
    );
  }
  return `metis-plugin-${slug}.json`;
}

export interface PluginSkill {
  name: string;
  description: string;
  version: string;
  instructions: string;
  tools: string[];
  tags: string[];
}

export interface PluginHook {
  event: SdkHookEvent;
  handlerKind: SdkHookHandlerKind;
  config: Record<string, unknown>;
}

export interface PluginManifest {
  name: string;
  version: string;
  description: string;
  exportedAt: string;
}

export interface PluginEnvelope {
  format: typeof PLUGIN_FORMAT;
  version: typeof PLUGIN_FORMAT_VERSION;
  manifest: PluginManifest;
  skills: PluginSkill[];
  agents: CustomAgentDefinition[];
  hooks: PluginHook[];
}

const skillSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  version: z.string().min(1),
  instructions: z.string().default(""),
  tools: z.array(z.string()).default([]),
  tags: z.array(z.string()).default([]),
});

const agentSchema = z.object({
  name: z.string().min(1),
  description: z.string().default(""),
  systemPrompt: z.string().min(1),
  tools: z.array(z.string()).default([]),
  model: z.string().nullish(),
  reasoningEffort: z.enum(["low", "medium", "high"]).nullish(),
});

const hookSchema = z.object({
  event: z.enum(SDK_HOOK_EVENTS as unknown as [string, ...string[]]),
  handlerKind: z.enum(SDK_HOOK_HANDLER_KINDS as unknown as [string, ...string[]]),
  config: z.record(z.unknown()).default({}),
});

const envelopeSchema = z.object({
  format: z.literal(PLUGIN_FORMAT),
  version: z.literal(PLUGIN_FORMAT_VERSION),
  manifest: z.object({
    name: z.string().min(1),
    version: z.string().min(1),
    description: z.string().default(""),
    exportedAt: z.string(),
  }),
  skills: z.array(skillSchema).default([]),
  agents: z.array(agentSchema).default([]),
  hooks: z.array(hookSchema).default([]),
});

export interface PackInput {
  manifest: Omit<PluginManifest, "exportedAt">;
  skills?: PluginSkill[];
  agents?: CustomAgentDefinition[];
  hooks?: PluginHook[];
  /** Override the timestamp — used in tests so output is deterministic. */
  exportedAt?: string;
}

/** Build a deterministic plugin buffer from in-memory definitions. */
export function pack(input: PackInput): Buffer {
  if (!SLUG_RE.test(input.manifest.name)) {
    throw new PluginFormatError(
      "Plugin manifest.name must be a lowercase slug (use the metis-plugin-<slug> form)",
    );
  }
  const envelope: PluginEnvelope = {
    format: PLUGIN_FORMAT,
    version: PLUGIN_FORMAT_VERSION,
    manifest: {
      ...input.manifest,
      exportedAt: input.exportedAt ?? new Date().toISOString(),
    },
    skills: (input.skills ?? []).map((s) => ({ ...s })),
    agents: (input.agents ?? []).map((a) => ({ ...a })),
    hooks: (input.hooks ?? []).map((h) => ({ ...h, config: { ...h.config } })),
  };
  return Buffer.from(JSON.stringify(envelope, null, 2), "utf-8");
}

/** Parse + validate a plugin buffer. Throws {@link PluginFormatError}. */
export function unpack(buf: Buffer | string): PluginEnvelope {
  let parsed: unknown;
  try {
    parsed = JSON.parse(typeof buf === "string" ? buf : buf.toString("utf-8"));
  } catch {
    throw new PluginFormatError("Plugin payload is not valid JSON");
  }
  const result = envelopeSchema.safeParse(parsed);
  if (!result.success) {
    throw new PluginFormatError(`Plugin envelope failed validation: ${result.error.message}`);
  }
  return result.data as PluginEnvelope;
}

/** Convenience — round-trip a buffer (used by the import/export idempotency tests). */
export function repack(buf: Buffer | string): Buffer {
  const env = unpack(buf);
  return pack({
    manifest: env.manifest,
    skills: env.skills,
    agents: env.agents,
    hooks: env.hooks,
    exportedAt: env.manifest.exportedAt,
  });
}
