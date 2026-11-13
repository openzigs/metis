/**
 * PII redactor for connector-fetched data — Phase 8 SEC.
 *
 * Sample rows pulled by the inspect/query tools (or surfaced into the RAG
 * pipeline) MUST be scrubbed before persistence. Two sets run, secrets first:
 *
 *   - SECRETS — the shared set in `safety/secret-patterns.ts` (#2333): key
 *     blocks, vendor tokens, URL credentials, `Bearer …`, JWTs, long hex. This
 *     file keeps no copy of it.
 *   - PII — below, and only here: email addresses, US-format phone numbers
 *     (with international prefix variants), SSNs and credit card numbers
 *     (Luhn-checked to suppress false positives). Never applied to repository
 *     source code: there they rewrite version strings and test data (#1138).
 *
 * Secrets go first so a key is replaced whole before a PII shape (a run of
 * digits read as a phone number) could take part of it and leave the rest.
 *
 * The redactor is configuration-driven via `PII_REDACT_DISABLE_PATTERNS` —
 * a comma-separated list of pattern ids (PII or secret) that should be skipped
 * (only useful when the underlying data set is provably safe).
 */
import { redactSecrets } from "../safety/secret-patterns.js";

// #2333 — starts only at the beginning of a run of local-part characters, so a
// long run with no `@` is scanned once rather than once per character.
const EMAIL = /(?<![\w.+-])[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD = /\b(?:\d[ -]?){13,19}\b/g;

interface PatternEntry {
  id: string;
  re: RegExp;
  label: string;
  needsLuhn?: boolean;
}

const PII_PATTERNS: PatternEntry[] = [
  { id: "email", re: EMAIL, label: "[REDACTED:email]" },
  { id: "phone", re: PHONE, label: "[REDACTED:phone]" },
  { id: "ssn", re: SSN, label: "[REDACTED:ssn]" },
  { id: "credit_card", re: CREDIT_CARD, label: "[REDACTED:cc]", needsLuhn: true },
];

function disabledIds(): Set<string> {
  const raw = process.env.PII_REDACT_DISABLE_PATTERNS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

/** Luhn check for credit-card validation. */
function luhn(value: string): boolean {
  const digits = value.replace(/\D/g, "");
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let n = digits.charCodeAt(i) - 48;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

/** Redact secrets, then PII, from a single string. */
export function redactString(input: string): string {
  if (!input) return input;
  const skip = disabledIds();
  let out = redactSecrets(input, { skip }).text;
  for (const p of PII_PATTERNS) {
    if (skip.has(p.id)) continue;
    out = out.replace(p.re, (match: string) => {
      if (p.needsLuhn && !luhn(match)) return match;
      return p.label;
    });
  }
  return out;
}

/** Redact PII from a single value (string / object / array). Cycles guarded. */
export function redactValue(value: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 8 || value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (typeof value !== "object") return value;
  if (seen.has(value as object)) return value;
  seen.add(value as object);
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1, seen));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactValue(v, depth + 1, seen);
  }
  return out;
}

/** Redact every value in a row of query output. */
export function redactRows<T extends Record<string, unknown>>(rows: T[]): T[] {
  return rows.map((r) => redactValue(r) as T);
}
