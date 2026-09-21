/**
 * Slash-command parser façade. Delegates the actual regex parsing to the
 * shared package so the UI and the server agree byte-for-byte on what
 * counts as a Spec Kit command. Exposes a tiny enrichment helper used by
 * the command dispatcher to resolve the corresponding artifact filename
 * for write-emitting commands.
 */
import {
  parseSpecKitCommand as parseFromShared,
  type ParsedSpecKitCommand,
  type SpecKitArtifactName,
  type SpecKitCommand,
} from "@metis/shared";

export { parseFromShared as parseSpecKitCommand };
export type { ParsedSpecKitCommand };

/**
 * Maps each command to the artifact it produces (or null when the command
 * does not write a single artifact). `/clarify` and `/analyze` APPEND to
 * `clarify.md` / `analysis.md`; `/implement` does not write any artifact.
 */
export const COMMAND_OUTPUT: Record<SpecKitCommand, SpecKitArtifactName | null> = {
  specify: "spec.md",
  plan: "plan.md",
  tasks: "tasks.md",
  clarify: "clarify.md",
  analyze: "analysis.md",
  implement: null,
};

/** True when the command appends rather than overwrites its output artifact. */
export const COMMAND_APPENDS: Record<SpecKitCommand, boolean> = {
  specify: false,
  plan: false,
  tasks: false,
  clarify: true,
  analyze: true,
  implement: false,
};
