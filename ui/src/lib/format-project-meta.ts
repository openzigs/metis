/**
 * Issue #430 (epic #407) — project card meta-line assembly.
 *
 * Project cards render a small muted meta line beneath the project name made of
 * a `slug` token and a `status` token joined by a middot separator:
 *
 *   <slug> · <status>          e.g.  acme-migration · draft
 *
 * The previous render hard-coded `{slug} · {status}` as a JSX expression, so a
 * missing/empty `slug` (legacy projects, optimistic create, malformed data)
 * produced a stray *leading* separator — `· draft` — with nothing before the
 * middot. This helper joins only the tokens that are actually present, so the
 * separator never leads, trails, or doubles. It is pure and side-effect-free so
 * every render site can share it and it is trivially unit-testable.
 */

/** Separator placed between present meta tokens (middot, padded). */
export const META_SEPARATOR = " · ";

export interface ProjectMetaInput {
  /** URL slug. May be empty/undefined for legacy or in-flight projects. */
  slug?: string | null;
  /** Lifecycle status (e.g. "draft" | "active" | "archived"). */
  status?: string | null;
}

/**
 * Join the present meta tokens with {@link META_SEPARATOR}. Tokens that are
 * absent, empty, or whitespace-only are dropped so the separator only appears
 * *between* two real tokens — never as a stray leading/trailing prefix.
 *
 * Returns the tokens (caller may want to style the slug as `<code>`) plus a
 * pre-joined `text` for the common all-plain-text case.
 */
export function formatProjectMeta(input: ProjectMetaInput): {
  /** Tokens that are present, in order — empty array when nothing is present. */
  tokens: string[];
  /** The tokens joined by {@link META_SEPARATOR}; empty string when none. */
  text: string;
} {
  const tokens = [input.slug, input.status]
    .map((t) => (t ?? "").trim())
    .filter((t) => t.length > 0);

  return { tokens, text: tokens.join(META_SEPARATOR) };
}
