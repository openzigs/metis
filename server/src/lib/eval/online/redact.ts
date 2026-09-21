/**
 * Epic #1316 / issue #1321 — privacy pass for sampled live traffic.
 *
 * Live questions, answers and retrieved contexts are customer content. Before
 * ANY of it reaches a judge (which for #1317 will be a remote model) it goes
 * through the connector PII redactor — the same primitive that scrubs
 * connector-fetched sample rows — and is then truncated to a bounded size.
 *
 * Nothing produced here is persisted verbatim: `scorer.ts` records only the
 * SHA-256 digest of the redacted text. See `store.ts` for the write-side guard.
 */
import { createHash } from "node:crypto";
import { redactString } from "../../connectors/pii-redactor.js";

export interface LiveRunCandidate {
  /** Which product surface produced the run. */
  surface: "chat" | "analysis" | "docs-gen";
  /** The user's question / prompt. */
  question: string;
  /** The answer shown to the user. */
  answer: string;
  /** Retrieved context chunks the answer was supposed to be grounded in. */
  contexts: string[];
}

export interface RedactedCandidate {
  question: string;
  answer: string;
  contexts: string[];
  /** Number of PII substitutions made across all three fields. */
  redactionHits: number;
}

/** Hard ceiling on how much text is redacted per field, before truncation. */
const REDACT_INPUT_CEILING = 64_000;
/** Maximum number of context chunks carried into scoring. */
export const MAX_CONTEXTS = 16;

const REDACTION_MARKER = /\[REDACTED:/g;

function countMarkers(s: string): number {
  return s.match(REDACTION_MARKER)?.length ?? 0;
}

function scrub(input: string, maxChars: number): { text: string; hits: number } {
  const bounded = input.slice(0, REDACT_INPUT_CEILING);
  const before = countMarkers(bounded);
  // Redact the full bounded string FIRST, then truncate: truncating first can
  // split a PII token in half and leave the tail unrecognisable to the redactor.
  const redacted = redactString(bounded);
  const hits = Math.max(0, countMarkers(redacted) - before);
  return { text: redacted.slice(0, maxChars), hits };
}

export function redactCandidate(c: LiveRunCandidate, maxChars: number): RedactedCandidate {
  const q = scrub(c.question ?? "", maxChars);
  const a = scrub(c.answer ?? "", maxChars);
  const contexts: string[] = [];
  let contextHits = 0;
  for (const raw of (c.contexts ?? []).slice(0, MAX_CONTEXTS)) {
    const r = scrub(raw ?? "", maxChars);
    contexts.push(r.text);
    contextHits += r.hits;
  }
  return {
    question: q.text,
    answer: a.text,
    contexts,
    redactionHits: q.hits + a.hits + contextHits,
  };
}

/** SHA-256 hex digest — the only representation of content that reaches disk. */
export function digest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
