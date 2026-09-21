/**
 * Epic #193 — Spec Kit Mode shared types (v1.2.0).
 *
 * Defines the canonical `.specify/` artifact set and the slash-command
 * vocabulary surfaced by both the chat input and the CLI/ACP transports.
 * Implementations live in `server/src/lib/spec-kit/` and the UI components
 * under `ui/src/components/spec-kit/`.
 */
import { z } from "zod";

/** Canonical artifact filenames inside the project's `.specify/` directory. */
export const SPEC_KIT_ARTIFACT_NAMES = [
  "spec.md",
  "plan.md",
  "tasks.md",
  "constitution.md",
  "clarify.md",
  "analysis.md",
] as const;
export type SpecKitArtifactName = (typeof SPEC_KIT_ARTIFACT_NAMES)[number];

/** All slash commands recognised by the Spec Kit pipeline. */
export const SPEC_KIT_COMMANDS = [
  "specify",
  "plan",
  "tasks",
  "clarify",
  "analyze",
  "implement",
] as const;
export type SpecKitCommand = (typeof SPEC_KIT_COMMANDS)[number];

/**
 * Epic #396 (MVP-1) — canonical Spec Kit-namespaced command set. Hosts
 * (Copilot, Claude, Cursor, Pi) discover slash commands by scanning prompt
 * directories; their files use the `speckit.*` form. Each entry maps to a
 * legacy short name (or null when there is no v1.2 equivalent yet — those
 * dispatch slots are filled by MVP-2..7).
 */
export const SPECKIT_COMMANDS = [
  "speckit.constitution",
  "speckit.specify",
  "speckit.clarify",
  "speckit.plan",
  "speckit.checklist",
  "speckit.tasks",
  "speckit.analyze",
  "speckit.implement",
  "speckit.taskstoissues",
] as const;
export type SpecKitNamespacedCommand = (typeof SPECKIT_COMMANDS)[number];

/**
 * Mapping from each `speckit.*` command to its legacy short alias (when one
 * existed in v1.2). The runner accepts either form; the route layer sets a
 * `Deprecation: true` response header when the legacy alias is used.
 */
export const SPECKIT_LEGACY_ALIAS: Record<SpecKitNamespacedCommand, SpecKitCommand | null> = {
  "speckit.constitution": null, // MVP-2 — no legacy /constitution slash command
  "speckit.specify": "specify",
  "speckit.clarify": "clarify",
  "speckit.plan": "plan",
  "speckit.checklist": null, // MVP-3
  "speckit.tasks": "tasks",
  "speckit.analyze": "analyze",
  "speckit.implement": "implement",
  "speckit.taskstoissues": null, // MVP-4
};

/** True when `cmd` is one of the namespaced `speckit.*` commands (case-insensitive). */
export function isSpecKitNamespacedCommand(cmd: string): cmd is SpecKitNamespacedCommand {
  return (SPECKIT_COMMANDS as readonly string[]).includes(cmd.toLowerCase());
}

/**
 * Normalize an inbound command string to its canonical lowercase form.
 * Accepts both `SpecKit.Specify` and `speckit.specify` and strips a leading
 * `/` if present. Returns null when the string matches neither the legacy
 * nor the namespaced vocabulary.
 */
export function normalizeSpecKitCommand(
  raw: string,
): { canonical: SpecKitNamespacedCommand; legacy: boolean } | null {
  if (typeof raw !== "string") return null;
  const lower = raw.toLowerCase().trim().replace(/^\//, "");
  if ((SPECKIT_COMMANDS as readonly string[]).includes(lower)) {
    return { canonical: lower as SpecKitNamespacedCommand, legacy: false };
  }
  // Legacy short name -> canonical namespaced form.
  for (const ns of SPECKIT_COMMANDS) {
    const alias = SPECKIT_LEGACY_ALIAS[ns];
    if (alias && alias === lower) return { canonical: ns, legacy: true };
  }
  return null;
}

/** True when `name` is one of the six canonical artifact filenames. */
export function isSpecKitArtifactName(name: string): name is SpecKitArtifactName {
  return (SPEC_KIT_ARTIFACT_NAMES as readonly string[]).includes(name);
}

/** True when `cmd` is one of the six canonical slash commands. */
export function isSpecKitCommand(cmd: string): cmd is SpecKitCommand {
  return (SPEC_KIT_COMMANDS as readonly string[]).includes(cmd);
}

export const specKitArtifactSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  name: z.enum(SPEC_KIT_ARTIFACT_NAMES),
  content: z.string(),
  version: z.number().int().nonnegative(),
  updatedById: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SpecKitArtifactDto = z.infer<typeof specKitArtifactSchema>;

export const specKitListResponseSchema = z.object({
  enabled: z.boolean(),
  artifacts: z.array(specKitArtifactSchema),
});
export type SpecKitListResponse = z.infer<typeof specKitListResponseSchema>;

export const specKitWriteRequestSchema = z.object({
  content: z.string().max(200_000),
});
export type SpecKitWriteRequest = z.infer<typeof specKitWriteRequestSchema>;

export const specKitCommandRequestSchema = z.object({
  /** Free-form input from the user, e.g. the prompt after `/specify `. */
  input: z.string().max(8_000).default(""),
});
export type SpecKitCommandRequest = z.infer<typeof specKitCommandRequestSchema>;

export const specKitCommandResponseSchema = z.object({
  command: z.enum(SPEC_KIT_COMMANDS),
  artifactName: z.enum(SPEC_KIT_ARTIFACT_NAMES).nullable(),
  artifact: specKitArtifactSchema.nullable(),
  /** Human-readable summary surfaced in the chat transcript. */
  message: z.string(),
  tokensUsed: z.number().int().nonnegative().default(0),
});
export type SpecKitCommandResponse = z.infer<typeof specKitCommandResponseSchema>;

/**
 * Parsed slash command. `input` is the substring AFTER the command word
 * (trimmed). Returns `null` when the buffer is not a recognised Spec Kit
 * command — callers should defer to other slash command parsers
 * (`/model`, `/compact`, …) before falling through to chat.
 */
export interface ParsedSpecKitCommand {
  command: SpecKitCommand;
  input: string;
}

const COMMAND_RE = new RegExp(`^\\s*\\/(${SPEC_KIT_COMMANDS.join("|")})(?:\\s+([\\s\\S]*))?$`, "i");
const NAMESPACED_RE = new RegExp(
  `^\\s*\\/(${SPECKIT_COMMANDS.map((c) => c.replace(".", "\\.")).join("|")})(?:\\s+([\\s\\S]*))?$`,
  "i",
);

export function parseSpecKitCommand(buffer: string): ParsedSpecKitCommand | null {
  if (typeof buffer !== "string") return null;
  // Namespaced form takes precedence — `/speckit.specify foo` must NOT match
  // the legacy `/specify` regex (which would otherwise eat `peckit.specify`).
  const ns = NAMESPACED_RE.exec(buffer);
  if (ns) {
    const canonical = ns[1]!.toLowerCase() as SpecKitNamespacedCommand;
    const legacy = SPECKIT_LEGACY_ALIAS[canonical];
    if (!legacy) return null; // MVP-2/3/4 commands have no v1.2 dispatcher yet
    return { command: legacy, input: (ns[2] ?? "").trim() };
  }
  const m = COMMAND_RE.exec(buffer);
  if (!m) return null;
  const command = m[1]!.toLowerCase() as SpecKitCommand;
  const input = (m[2] ?? "").trim();
  return { command, input };
}
