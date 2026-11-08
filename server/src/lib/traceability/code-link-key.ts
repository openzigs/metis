/**
 * #1825 — the identity of one requirement-to-code link: its file and code
 * symbol. The code agent's citation writer (`seed-code-links-from-findings.ts`)
 * dedupes against its own `analysis-grounding` rows only, so a file the semantic
 * mapper linked first holds two rows, one per source. Every reader that lists a
 * requirement's links shows each (filePath, codeSymbolId) once.
 */

import { codeLinkKey } from "@metis/shared";

/**
 * The key a requirement's code links are deduped on (a file-level link has no
 * symbol). #1969 — `@metis/shared`'s, which the borrow's duplicate rule reads too.
 */
export { codeLinkKey };

/**
 * Each (filePath, codeSymbolId) once, keeping the first row: the caller's
 * order decides which row speaks for the link (readers sort the surer first).
 */
export function uniqueCodeLinks<T extends { filePath: string; codeSymbolId: string | null }>(
  rows: readonly T[],
): T[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = codeLinkKey(row.filePath, row.codeSymbolId);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
