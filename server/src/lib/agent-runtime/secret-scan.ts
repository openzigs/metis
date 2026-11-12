/**
 * Epic #129 — agent personas and skill bodies are user-authored text that is
 * sent to a model provider on every call and shown to every project member, so
 * a credential pasted into one leaks to all of them. Definitions are refused on
 * save when they carry a HIGH-CONFIDENCE credential shape. The error names the
 * kind of credential, never the value.
 *
 * Deliberately narrow: only the shared set's high-confidence shapes (vendor
 * prefixes and key blocks, not "long random strings") — a false positive blocks
 * a legitimate save. Documentation placeholders that end in `EXAMPLE` (the form
 * AWS's own docs use) are allowed, as is a match its pattern's `refuse` exempts
 * (Stripe's published `sk_test_` key): still redacted on every read path.
 *
 * #2333 — the shapes live in `safety/secret-patterns.ts`, the one set the
 * connector redactor and every repository read path use too; this file keeps
 * no copy of them.
 */
import { SECRET_PATTERNS, secretMatches } from "../safety/secret-patterns.js";

const REFUSED = SECRET_PATTERNS.filter((p) => p.highConfidence);

/** The kinds of credential found in `text` (deduplicated), `[]` when clean. */
export function findSecretKinds(text: string): string[] {
  if (!text) return [];
  const kinds = new Set<string>();
  for (const p of REFUSED) {
    for (const m of secretMatches(p, text)) {
      if (/EXAMPLE$/i.test(m) || (p.refuse && !p.refuse(m))) continue;
      kinds.add(p.kind);
    }
  }
  return [...kinds];
}

export class DefinitionSecretError extends Error {
  readonly code = "DEFINITION_CONTAINS_SECRET";
  constructor(
    readonly field: string,
    readonly kinds: string[],
  ) {
    super(
      `${field} appears to contain a credential (${kinds.join(", ")}). ` +
        "Remove it — agent and skill text is sent to the model and shown to every project member.",
    );
    this.name = "DefinitionSecretError";
  }
}

/** Throw {@link DefinitionSecretError} when any field carries a credential. */
export function assertNoSecrets(fields: Record<string, string | null | undefined>): void {
  for (const [field, value] of Object.entries(fields)) {
    const kinds = findSecretKinds(value ?? "");
    if (kinds.length > 0) throw new DefinitionSecretError(field, kinds);
  }
}
