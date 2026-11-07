/**
 * Epic #1866 (#1870) — the deterministic check every extracted rule's citation
 * passes before it is stored: the model's `clauseExcerpt` must appear in the
 * revision's `extractedText` verbatim, whitespace aside.
 *
 * Whitespace runs (spaces, tabs, line breaks) compare as one space, and the
 * excerpt's own leading and trailing whitespace is ignored, so a clause the
 * model copied across a line break still matches. Nothing else is forgiven:
 * case, punctuation and every word must be the source's. The offsets returned
 * are into the ORIGINAL text, and the excerpt returned is the source's own
 * `text.slice(start, end)`, never the model's copy, so a stored rule always
 * satisfies `clauseExcerpt === extractedText.slice(clauseStart, clauseEnd)`.
 */

/** An excerpt shorter than this does not pin a clause, so it never verifies (#1867's scorer floor). */
export const MIN_CLAUSE_EXCERPT_WORDS = 4;

export interface VerifiedClause {
  clauseStart: number;
  clauseEnd: number;
  /** `text.slice(clauseStart, clauseEnd)`. */
  clauseExcerpt: string;
}

/** `text` with every whitespace run as one space, and each kept character's index in `text`. */
function collapse(text: string): { flat: string; origin: number[] } {
  let flat = "";
  const origin: number[] = [];
  let inSpace = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      if (!inSpace) {
        flat += " ";
        origin.push(i);
      }
      inSpace = true;
      continue;
    }
    inSpace = false;
    flat += ch;
    origin.push(i);
  }
  return { flat, origin };
}

/**
 * Where `excerpt` sits in `text`, or `null` when it is not there verbatim
 * (whitespace aside) or is under {@link MIN_CLAUSE_EXCERPT_WORDS} words. When
 * it occurs more than once, the first occurrence starting inside `prefer` (the
 * section the model was shown) wins, else the first in the text.
 */
export function locateClause(
  text: string,
  excerpt: string,
  prefer?: { start: number; end: number },
): VerifiedClause | null {
  return clauseLocator(text)(excerpt, prefer);
}

/** {@link locateClause} over one text, collapsing it once for many excerpts. */
export function clauseLocator(
  text: string,
): (excerpt: string, prefer?: { start: number; end: number }) => VerifiedClause | null {
  const { flat, origin } = collapse(text);
  return (excerpt, prefer) => find(text, flat, origin, excerpt, prefer);
}

function find(
  text: string,
  flat: string,
  origin: number[],
  excerpt: string,
  prefer?: { start: number; end: number },
): VerifiedClause | null {
  const needle = collapse(excerpt.trim()).flat;
  if (needle.split(" ").filter(Boolean).length < MIN_CLAUSE_EXCERPT_WORDS) return null;

  let chosen = -1;
  for (let at = flat.indexOf(needle); at !== -1; at = flat.indexOf(needle, at + 1)) {
    if (chosen === -1) chosen = at;
    if (!prefer) break;
    const start = origin[at];
    if (start >= prefer.start && start < prefer.end) {
      chosen = at;
      break;
    }
  }
  if (chosen === -1) return null;

  const clauseStart = origin[chosen];
  // The needle is trimmed, so its last character is not whitespace and maps to
  // exactly one character of the source.
  const clauseEnd = origin[chosen + needle.length - 1] + 1;
  return { clauseStart, clauseEnd, clauseExcerpt: text.slice(clauseStart, clauseEnd) };
}
