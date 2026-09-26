/**
 * Epic #129 — agent personas and skill bodies are user-authored text that is
 * sent to a model provider on every call and shown to every project member, so
 * a credential pasted into one leaks to all of them. Definitions are refused on
 * save when they carry a HIGH-CONFIDENCE credential shape. The error names the
 * kind of credential, never the value.
 *
 * Deliberately narrow (vendor prefixes and key blocks, not "long random
 * strings"): a false positive blocks a legitimate save, so only shapes with a
 * vendor-specific prefix are matched. Documentation placeholders that end in
 * `EXAMPLE` (the form AWS's own docs use) are allowed.
 */

interface SecretPattern {
  kind: string;
  re: RegExp;
}

const PATTERNS: readonly SecretPattern[] = [
  { kind: "AWS access key id", re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { kind: "GitHub token", re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}\b/g },
  { kind: "GitHub token", re: /\bgithub_pat_[A-Za-z0-9_]{40,}\b/g },
  { kind: "Anthropic API key", re: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "OpenAI API key", re: /\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{32,}/g },
  { kind: "Slack token", re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "private key", re: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/g },
  { kind: "Google API key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
];

/** The kinds of credential found in `text` (deduplicated), `[]` when clean. */
export function findSecretKinds(text: string): string[] {
  if (!text) return [];
  const kinds = new Set<string>();
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    for (const m of text.matchAll(p.re)) {
      if (/EXAMPLE$/i.test(m[0])) continue;
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
