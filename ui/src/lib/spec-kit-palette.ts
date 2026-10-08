/**
 * #789 — the Spec Kit page's command palette.
 *
 * It offers and dispatches the canonical `speckit.*` commands only. The page
 * used to suggest the six v1.2 short names (`/specify` …), which the server
 * answers with `Deprecation: true`; a typed short name is still accepted, and
 * mapped to its `speckit.*` successor before anything is sent.
 */
import { SPECKIT_COMMANDS, normalizeSpecKitCommand } from "@metis/shared";
import type { SpecKitNamespacedCommand } from "@metis/shared";

export interface PaletteSuggestion {
  command: SpecKitNamespacedCommand;
  hint: string;
}

const HINTS: Record<SpecKitNamespacedCommand, string> = {
  "speckit.constitution": "Write constitution.md from the Markdown you give",
  "speckit.specify": "New feature from a brief (or re-specify the selected one)",
  "speckit.clarify": "Ask one open question (or answer the last one)",
  "speckit.plan": "Plan, research, data model, contract, quickstart",
  "speckit.checklist": "Quality checklists from the spec and plan",
  "speckit.tasks": "A tasks.md backlog from spec + plan",
  "speckit.analyze": "Cross-artifact consistency check",
  "speckit.implement": "Hand the artifacts to an analysis",
  "speckit.taskstoissues": "Export tasks.md to issues (dry run first)",
};

/** The commands the server refuses (400 SPECKIT_FEATURE_REQUIRED) without a feature. */
export const FEATURE_REQUIRED_COMMANDS: ReadonlySet<SpecKitNamespacedCommand> = new Set([
  "speckit.plan",
  "speckit.checklist",
  "speckit.taskstoissues",
]);

const PREFIX = "speckit.";

/**
 * Suggestions for a buffer that starts with `/` and has no input yet. Matches
 * the namespaced name (`/speckit.pl`) or its short form (`/pl`).
 */
export function suggestPaletteCommands(buffer: string): PaletteSuggestion[] {
  if (!buffer.startsWith("/")) return [];
  const word = buffer.slice(1).trim().toLowerCase();
  return SPECKIT_COMMANDS.filter(
    (c) => c.startsWith(word) || c.slice(PREFIX.length).startsWith(word),
  ).map((command) => ({ command, hint: HINTS[command] }));
}

/** `/speckit.<cmd> <input>` (or a legacy `/<cmd> <input>`) → the canonical command. */
export function parsePaletteCommand(
  buffer: string,
): { command: SpecKitNamespacedCommand; input: string } | null {
  const m = /^\s*\/(\S+)(?:\s+([\s\S]*))?$/.exec(buffer);
  if (!m) return null;
  const normalized = normalizeSpecKitCommand(m[1]!);
  if (!normalized) return null;
  return { command: normalized.canonical, input: (m[2] ?? "").trim() };
}
