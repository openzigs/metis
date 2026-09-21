/**
 * Slash-command autocomplete + parser for chat-style surfaces (Epic #193).
 *
 * Re-uses the canonical `SPEC_KIT_COMMANDS` set from `@metis/shared` so
 * the UI hint list and the server router never drift.
 */
import { SPEC_KIT_COMMANDS, parseSpecKitCommand } from "@metis/shared";
import type { SpecKitCommand } from "@metis/shared";

export interface SlashSuggestion {
  command: SpecKitCommand;
  hint: string;
}

const HINTS: Record<SpecKitCommand, string> = {
  specify: "Generate spec.md from a brief",
  plan: "Run the architect against spec.md",
  tasks: "Produce a tasks.md backlog from spec + plan",
  clarify: "Ask one open question (or answer the last one)",
  analyze: "Cross-phase consistency check",
  implement: "Hand off to the orchestrator",
};

/** Returns suggestions for a buffer that starts with `/`. Empty when not a slash buffer. */
export function suggestSlashCommands(buffer: string): SlashSuggestion[] {
  if (!buffer.startsWith("/")) return [];
  const rest = buffer.slice(1).split(/\s+/, 1)[0] ?? "";
  const lower = rest.toLowerCase();
  return SPEC_KIT_COMMANDS.filter((c) => c.startsWith(lower)).map((command) => ({
    command,
    hint: HINTS[command],
  }));
}

export { parseSpecKitCommand };
