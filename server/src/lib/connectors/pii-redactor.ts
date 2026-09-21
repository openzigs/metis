/**
 * PII redactor for connector-fetched data — Phase 8 SEC.
 *
 * Sample rows pulled by the inspect/query tools (or surfaced into the RAG
 * pipeline) MUST be scrubbed before persistence. Patterns covered:
 *
 *   - email addresses
 *   - US-format phone numbers (with international prefix variants)
 *   - SSNs
 *   - credit card numbers (Luhn-checked to suppress false positives)
 *   - common cryptographic key/token shapes (Bearer prefix, JWT,
 *     `ghp_…`/`github_pat_…` PATs, AWS access keys, hex-encoded secrets ≥32 chars)
 *
 * The redactor is configuration-driven via `PII_REDACT_DISABLE_PATTERNS` —
 * a comma-separated list of pattern ids that should be skipped (only useful
 * when the underlying data set is provably safe).
 */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;
const PHONE = /(?:\+?\d{1,3}[\s.-]?)?(?:\(\d{3}\)|\d{3})[\s.-]?\d{3}[\s.-]?\d{4}\b/g;
const SSN = /\b\d{3}-\d{2}-\d{4}\b/g;
const CREDIT_CARD = /\b(?:\d[ -]?){13,19}\b/g;
const BEARER = /\bBearer\s+[A-Za-z0-9._\-/+=]{16,}/g;
const JWT_LIKE = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const GH_PAT = /\b(?:ghp|gho|ghu|ghs|ghr|github_pat)_[A-Za-z0-9_]{20,}/g;
const AWS_KEY = /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g;
// L3 — tightened to skip common LEGITIMATE hex shapes:
//   - 32-char hex   → MD5 sums, UUIDs (also handled by uuid pattern)
//   - 40-char hex   → SHA-1 / git commit SHAs
//   - 64-char hex   → SHA-256
//   - 128-char hex  → SHA-512
// Only 33-39, 41-63, 65-127, or ≥129 char hex strings are flagged as
// secrets. Additionally, surrounding "git", "commit", "sha", or "sha-1"
// context strings suppress matching even when the length would qualify.
const HEX_SECRET = /\b[a-f0-9]{32,}\b/gi;
const HEX_HASH_LENGTHS = new Set([32, 40, 64, 128]);
const HEX_CONTEXT_PREFIX_RE = /(commit|sha-?\d*|git|hash|digest|md5|fingerprint)[\s:=]+$/i;

interface PatternEntry {
  id: string;
  re: RegExp;
  label: string;
  needsLuhn?: boolean;
  /** Optional context-aware filter; return false to suppress the match. */
  shouldRedact?: (match: string, fullInput: string, offset: number) => boolean;
}

const PATTERNS: PatternEntry[] = [
  { id: "email", re: EMAIL, label: "[REDACTED:email]" },
  { id: "phone", re: PHONE, label: "[REDACTED:phone]" },
  { id: "ssn", re: SSN, label: "[REDACTED:ssn]" },
  { id: "credit_card", re: CREDIT_CARD, label: "[REDACTED:cc]", needsLuhn: true },
  { id: "bearer", re: BEARER, label: "[REDACTED:token]" },
  { id: "jwt", re: JWT_LIKE, label: "[REDACTED:jwt]" },
  { id: "github_pat", re: GH_PAT, label: "[REDACTED:github_pat]" },
  { id: "aws_key", re: AWS_KEY, label: "[REDACTED:aws_key]" },
  {
    id: "long_hex",
    re: HEX_SECRET,
    label: "[REDACTED:secret]",
    shouldRedact: shouldRedactHex,
  },
];

/**
 * Suppress redaction of hex strings that are almost certainly LEGITIMATE
 * digests rather than secret material:
 *   - exact lengths matching MD5 (32) / SHA-1 (40) / SHA-256 (64) / SHA-512 (128)
 *   - any hex preceded by an obvious "this is a hash" context string
 */
function shouldRedactHex(match: string, fullInput: string, offset: number): boolean {
  if (HEX_HASH_LENGTHS.has(match.length)) return false;
  // Look back ≤24 chars for a context word; if found, skip redaction.
  const start = Math.max(0, offset - 24);
  const before = fullInput.slice(start, offset);
  if (HEX_CONTEXT_PREFIX_RE.test(before)) return false;
  return true;
}

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

/** Redact PII from a single string. */
export function redactString(input: string): string {
  if (!input) return input;
  const skip = disabledIds();
  let out = input;
  for (const p of PATTERNS) {
    if (skip.has(p.id)) continue;
    p.re.lastIndex = 0;
    out = out.replace(p.re, (match: string, ...args: unknown[]) => {
      if (p.needsLuhn && !luhn(match)) return match;
      // The 2nd-to-last replace arg is the offset, last is the input string.
      const offset =
        typeof args[args.length - 2] === "number" ? (args[args.length - 2] as number) : 0;
      const fullInput =
        typeof args[args.length - 1] === "string" ? (args[args.length - 1] as string) : input;
      if (p.shouldRedact && !p.shouldRedact(match, fullInput, offset)) return match;
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
