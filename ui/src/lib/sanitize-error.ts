/**
 * S4 (#145) — Safe error-message surfacing for the shared `ErrorState`
 * component and `error.tsx` route boundaries.
 *
 * SECURITY: error UIs must never leak secrets, tokens, or stack traces. This
 * module extracts a single-line, length-capped, redacted message from an
 * arbitrary thrown value. It is intentionally conservative — when in doubt it
 * falls back to a generic message rather than risk surfacing server internals.
 */
import { ApiError } from "./api-client";

const MAX_LENGTH = 300;
const GENERIC_FALLBACK = "Something went wrong. Please try again.";

/** Friendly, non-revealing copy per HTTP status class. */
function statusFallback(status: number): string {
  if (status === 401) return "Your session has expired. Please sign in again.";
  if (status === 403) return "You do not have permission to perform this action.";
  if (status === 404) return "We couldn't find what you were looking for.";
  if (status === 429) return "Too many requests. Please slow down and try again.";
  if (status >= 500) return "A server error occurred. Please try again later.";
  if (status >= 400) return "The request could not be completed.";
  return GENERIC_FALLBACK;
}

/**
 * Redact substrings that look like credentials/secrets. Order matters: redact
 * structured tokens (JWT, bearer, key=value) before the generic high-entropy
 * sweep so we don't double-process.
 */
export function redactSecrets(input: string): string {
  let out = input;

  // JWTs (header.payload.signature, base64url segments).
  out = out.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, "[redacted]");

  // Authorization: Bearer <token>
  out = out.replace(/\b(bearer)\s+[A-Za-z0-9._~+/=-]+/gi, "$1 [redacted]");

  // Provider-style API keys (OpenAI sk-, GitHub ghp_, generic prefixes).
  out = out.replace(/\b(sk|pk|rk|ghp|gho|ghu|ghs|ghr|xoxb|xoxp)[-_][A-Za-z0-9]{8,}/g, "[redacted]");

  // key/secret/password/token = value (quoted or bare).
  out = out.replace(
    /\b(password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key|client[_-]?secret|authorization)\b\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi,
    "$1=[redacted]",
  );

  // Generic high-entropy runs (long hex/base64-ish blobs).
  out = out.replace(/\b[A-Za-z0-9+/=_-]{32,}\b/g, "[redacted]");

  return out;
}

/** True if the line looks like a stack frame or absolute file path. */
function looksLikeStackOrPath(line: string): boolean {
  if (/\bat\s+.+\(.*:\d+:\d+\)/.test(line)) return true; // "at fn (file:line:col)"
  if (/\bat\s+\/?(?:[\w.-]+\/){2,}/.test(line)) return true; // "at /a/b/c"
  if (/\.(?:tsx?|jsx?|mjs|cjs):\d+:\d+/.test(line)) return true; // file.ts:1:2
  if (/(?:\/[\w.@-]+){3,}/.test(line)) return true; // deep absolute path
  return false;
}

/**
 * Extract a safe, human-readable, redacted single-line message from any thrown
 * value. Never returns stack traces or secret material.
 */
export function sanitizeErrorMessage(error: unknown, fallback = GENERIC_FALLBACK): string {
  let raw: string | undefined;

  if (error instanceof ApiError) {
    raw = error.message?.trim() || statusFallback(error.status);
  } else if (error instanceof Error) {
    raw = error.message;
  } else if (typeof error === "string") {
    raw = error;
  }

  if (!raw) return fallback;

  // Only ever take the first line — stack traces live on subsequent lines.
  const firstLine = raw.split(/\r?\n/, 1)[0]?.trim() ?? "";
  if (!firstLine || looksLikeStackOrPath(firstLine)) return fallback;

  const redacted = redactSecrets(firstLine).trim();
  if (!redacted) return fallback;

  return redacted.length > MAX_LENGTH ? `${redacted.slice(0, MAX_LENGTH - 1)}…` : redacted;
}
