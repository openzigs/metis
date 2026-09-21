/**
 * WCAG SC 3.3.3 Error Suggestion (AA) helpers — Issue #663 (epic #658).
 *
 * Pure, deterministic functions that turn a *detectable-cause* input error into
 * a message that SUGGESTS a concrete correction (not just "invalid"). They are
 * framework-agnostic and unit-tested away from the form components that consume
 * them.
 *
 * Design rules (from the issue):
 *  - Only suggest a fix when one can be **reasonably derived** from the entered
 *    value. When nothing is derivable we fall back to a message that states the
 *    expected format (still actionable) rather than fabricating a guess.
 *  - Security-sensitive fields (passwords, credentials) are handled by their own
 *    forms and NEVER call these helpers — we do not suggest corrections for
 *    secret values.
 *  - No heavy fuzzy-match dependency: a tiny local Levenshtein powers the email
 *    domain-typo suggestion against a small allow-list of common providers.
 */

// Curly quotes so the suggested value stands out and never collides with the
// straight quotes a user might have typed into the field.
const LQUO = "“";
const RQUO = "”";

function quoted(value: string): string {
  return `${LQUO}${value}${RQUO}`;
}

// ── Slug ─────────────────────────────────────────────────────────────────────

/**
 * Normalize an arbitrary string into a canonical slug candidate: lowercase,
 * every run of non-alphanumerics collapsed to a single hyphen, and leading /
 * trailing hyphens trimmed. The result (when non-empty) is valid under both the
 * project (`[a-z0-9][a-z0-9-]*`) and workspace (`^[a-z0-9][a-z0-9-]*[a-z0-9]$`)
 * slug patterns.
 */
export function normalizeSlug(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Message for a malformed slug. When the entered value normalizes to a non-empty
 * candidate we suggest it verbatim; otherwise we state the allowed character set.
 * Suitable for the project slug rule (`[a-z0-9][a-z0-9-]*`), which permits a
 * single-character slug. For the stricter workspace rule use
 * {@link workspaceSlugSuggestionMessage}.
 */
export function slugSuggestionMessage(raw: string): string {
  const suggestion = normalizeSlug(raw);
  if (suggestion === "") {
    return "Use lowercase letters, numbers, and hyphens (e.g. “my-project”).";
  }
  return `Use lowercase letters, numbers, and hyphens — try ${quoted(suggestion)}.`;
}

// The workspace slug pattern requires at least two characters (leading AND
// trailing alphanumeric), unlike the project pattern which allows one.
const WORKSPACE_SLUG_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

/**
 * Message for a malformed workspace slug. Only suggests a normalized candidate
 * when it actually satisfies the workspace rule (≥2 chars); a normalization that
 * collapses to a single character (e.g. "a!" → "a") would still be rejected, so
 * we fall back to stating the requirement rather than suggesting an invalid fix.
 */
export function workspaceSlugSuggestionMessage(raw: string): string {
  const suggestion = normalizeSlug(raw);
  if (suggestion !== "" && WORKSPACE_SLUG_RE.test(suggestion)) {
    return `Use lowercase letters, numbers, and hyphens — try ${quoted(suggestion)}.`;
  }
  return "Use at least two characters — lowercase letters, numbers, and hyphens (e.g. “my-workspace”).";
}

// ── URL ──────────────────────────────────────────────────────────────────────

const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;

/**
 * Derive a corrected http(s) URL from a malformed entry, or `null` when nothing
 * safe is derivable:
 *  - a value with a non-http(s) scheme (e.g. `ftp://…`) → same URL over https,
 *  - a scheme-less value that becomes a valid host once prefixed with
 *    `https://` (must contain a dot so we don't "correct" `not-a-url`).
 * Returns `null` for values that are already valid http(s) URLs.
 */
export function httpUrlSuggestion(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;

  if (HAS_SCHEME.test(trimmed)) {
    let parsed: URL;
    try {
      parsed = new URL(trimmed);
    } catch {
      return null;
    }
    if (parsed.protocol === "http:" || parsed.protocol === "https:") return null;
    try {
      const swapped = new URL(trimmed);
      swapped.protocol = "https:";
      return swapped.toString();
    } catch {
      return null;
    }
  }

  // Scheme-less: only suggest when prefixing yields a host that looks real.
  try {
    const candidate = new URL(`https://${trimmed}`);
    if (candidate.hostname.includes(".")) return candidate.toString();
  } catch {
    /* fall through */
  }
  return null;
}

/** True when the value is already a valid absolute http(s) URL. */
export function isHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw.trim());
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/** Message for an unparseable URL entry (content-ingest style). */
export function urlSuggestionMessage(raw: string): string {
  const suggestion = httpUrlSuggestion(raw);
  if (suggestion) return `Enter a valid http(s) URL — did you mean ${quoted(suggestion)}?`;
  return "Enter a valid http(s) URL, e.g. https://example.com/page.";
}

/** Message for a URL with an unsupported (non-http/https) scheme. */
export function urlProtocolSuggestionMessage(raw: string): string {
  const suggestion = httpUrlSuggestion(raw);
  if (suggestion)
    return `Only http and https URLs are supported — did you mean ${quoted(suggestion)}?`;
  return "Only http and https URLs are supported, e.g. https://example.com/page.";
}

/** Message for a malformed webhook URL. */
export function webhookUrlSuggestionMessage(raw: string): string {
  const suggestion = httpUrlSuggestion(raw);
  if (suggestion) return `Enter a valid webhook URL — did you mean ${quoted(suggestion)}?`;
  return "Enter a valid webhook URL starting with https://, e.g. https://hooks.example.com/abc.";
}

// ── Amount (money) ───────────────────────────────────────────────────────────

/**
 * Message for a malformed non-negative amount. When the entry is a recognizable
 * number wrapped in currency noise (`$`, commas, spaces) or made negative, we
 * suggest the cleaned, non-negative value; otherwise we state the format.
 */
export function amountSuggestionMessage(raw: string): string {
  const cleaned = raw.trim().replace(/[$,\s]/g, "");
  const n = Number(cleaned);
  if (cleaned !== "" && Number.isFinite(n)) {
    const positive = Math.abs(n);
    return `Enter a non-negative amount — try ${positive}.`;
  }
  return "Enter a non-negative amount, e.g. 100 or 49.99.";
}

// ── File type ────────────────────────────────────────────────────────────────

/** Message for an unsupported upload, listing the accepted extensions. */
export function unsupportedFileTypeMessage(allowedExtensions: readonly string[]): string {
  const list = allowedExtensions.map((e) => e.replace(/^\./, "")).join(", ");
  return `Unsupported file type — use one of: ${list}.`;
}

// ── Email ────────────────────────────────────────────────────────────────────

/** Common consumer email domains used for typo correction. */
export const COMMON_EMAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "yahoo.com",
  "icloud.com",
  "protonmail.com",
  "aol.com",
] as const;

/** Iterative Levenshtein edit distance (small inputs, no dependency). */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  let prev = Array.from({ length: n + 1 }, (_, i) => i);
  let curr = new Array<number>(n + 1);
  for (let i = 1; i <= m; i++) {
    curr[0] = i;
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[n];
}

/** True when the value has the basic shape of an email address. */
export function isLikelyEmail(raw: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw.trim());
}

/**
 * Suggest a corrected email when the domain is a close typo of a common
 * provider (edit distance 1–2), or `null` when no safe suggestion exists (empty,
 * no local part, unknown domain, or already a known-good domain).
 */
export function suggestEmail(raw: string): string | null {
  const trimmed = raw.trim();
  const at = trimmed.lastIndexOf("@");
  if (at <= 0 || at === trimmed.length - 1) return null;
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1).toLowerCase();

  let best: string | null = null;
  let bestDist = Infinity;
  for (const candidate of COMMON_EMAIL_DOMAINS) {
    if (candidate === domain) return null; // already good — nothing to suggest
    const d = editDistance(domain, candidate);
    if (d < bestDist) {
      bestDist = d;
      best = candidate;
    }
  }
  if (best && bestDist >= 1 && bestDist <= 2) return `${local}@${best}`;
  return null;
}

/** Message for a malformed email address. */
export function emailSuggestionMessage(raw: string): string {
  const suggestion = suggestEmail(raw);
  if (suggestion) return `Check the email address — did you mean ${quoted(suggestion)}?`;
  if (!raw.includes("@")) {
    return "Enter a valid email address — include an “@”, e.g. name@example.com.";
  }
  return "Enter a valid email address, e.g. name@example.com.";
}
