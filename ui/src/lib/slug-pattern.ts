/**
 * HTML `pattern` attribute values for slug inputs (#729).
 *
 * Browsers compile `pattern` with the `v` (unicode sets) flag, where an
 * unescaped `-` at the edge of a character class is a SyntaxError. An invalid
 * pattern is logged to the console and then IGNORED, silently disabling the
 * field's client-side validation. So every `-` inside a class is escaped here.
 * `pattern` is implicitly anchored (`^(?:…)$`), so no anchors are written.
 */

/** Workspace slug — mirrors `server/src/routes/workspaces.ts` (`/^[a-z0-9][a-z0-9-]*[a-z0-9]$/`). */
export const WORKSPACE_SLUG_PATTERN = "[a-z0-9][a-z0-9\\-]*[a-z0-9]";
