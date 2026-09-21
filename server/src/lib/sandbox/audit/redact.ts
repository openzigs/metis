/**
 * Strip secret-shaped keys AND values from sandbox audit payloads
 * (Epic #395 #413).
 *
 * Audit payloads may contain command names, file paths, byte counts; they
 * MUST NOT contain file contents, env-var values, or auth tokens. This
 * module is the single chokepoint that the audit emitter calls before
 * persisting / logging.
 *
 * Redaction is two-layer:
 *   1. Key-shaped — drops values whose key matches `token`, `secret`,
 *      `apiKey`, `authorization`, etc.
 *   2. Value-shaped — scrubs free-text strings (e.g. `payload.command`)
 *      that contain inline auth headers, vendor API key prefixes, or
 *      long base64-looking secrets after a `=` / `:` separator.
 *
 * Value-shaped redaction is critical because callers like
 * `commands.run("curl -H 'Authorization: Bearer xyz' ...")` ship the
 * bearer token into `payload.command` verbatim — key redaction alone
 * would leak it.
 *
 * REDACTION_SINK_POLICY: no-token-count-exemption
 *
 * `logger.ts` and `audit-service.ts` exempt enumerated numeric token *counts*
 * from `/token/i` (#1263, #1268). This sink deliberately does not, and the
 * reason is evidence rather than symmetry: **no token count reaches it.** Every
 * payload key the four sandbox providers emit is enumerated by
 * `server/tests/redaction-sinks.enumeration.test.ts`, and none matches
 * `/token/i` — so the exemption would buy nothing, while this sink redacts by
 * *category* (`content`, `body`, `data`) rather than by secrecy and takes
 * free-text `command` values that carry literal bearer tokens from callers.
 * That test fails the moment a count does arrive, so the next person decides on
 * evidence instead of copying this note. Full rationale:
 * `docs/decisions/0008-redaction-sinks.md`.
 */

const SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /^content$/i,
  /^body$/i,
  /^data$/i,
  /secret/i,
  /token/i,
  /password/i,
  /api[-_]?key/i,
  /authorization/i,
  /credential/i,
  /private[-_]?key/i,
  /cookie/i,
  /session[-_]?id/i,
];

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 8;

/**
 * Value-level scrubber patterns. Each pattern's full match is replaced
 * with `[REDACTED]` (capture groups inside `(?:...)` are non-capturing
 * by design so the whole match — including the prefix — is replaced).
 *
 * Order matters: more specific patterns first so e.g. an
 * `Authorization: Bearer ghp_...` is matched as the auth-header pattern
 * rather than the bare GitHub-token pattern, leaving the header name
 * itself intact via post-processing.
 */
const VALUE_REDACTION_PATTERNS: ReadonlyArray<{ name: string; rx: RegExp; replacement: string }> = [
  // Authorization header — Bearer / Basic / Digest. Capture the header
  // name + scheme so the audit row still tells you "an auth header was
  // present" without exposing the credential.
  {
    name: "auth-header",
    rx: /(Authorization\s*:\s*)(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._\-+/=]+/gi,
    replacement: `$1$2 ${REDACTED}`,
  },
  // OpenAI-style API keys: `sk-` followed by ≥20 base62 chars.
  {
    name: "openai-key",
    rx: /\bsk-[A-Za-z0-9]{20,}/g,
    replacement: REDACTED,
  },
  // Anthropic API keys: sk-ant-... The OpenAI sk- pattern above stops at the
  // first hyphen, so sk-ant-api03-... slipped through (#685). METIS is a Claude
  // shop, so this is the realistic key shape; base64url alphabet.
  {
    name: "anthropic-key",
    rx: /\bsk-ant-[A-Za-z0-9_-]{20,}/g,
    replacement: REDACTED,
  },
  // Slack bot/user/app tokens: xoxb-/xoxp-/xoxa-/xoxr- followed by id-id-secret.
  {
    name: "slack-token",
    rx: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
    replacement: REDACTED,
  },
  // GitHub personal access token (classic): ghp_ + 36 chars.
  {
    name: "github-pat",
    rx: /\bghp_[A-Za-z0-9]{36}\b/g,
    replacement: REDACTED,
  },
  // GitHub app/server token: ghs_ + 36 chars.
  {
    name: "github-server",
    rx: /\bghs_[A-Za-z0-9]{36}\b/g,
    replacement: REDACTED,
  },
  // GitHub OAuth token: gho_ + 36 chars.
  {
    name: "github-oauth",
    rx: /\bgho_[A-Za-z0-9]{36}\b/g,
    replacement: REDACTED,
  },
  // GitLab personal access token: glpat- + ≥20 chars (alnum + _-).
  {
    name: "gitlab-pat",
    rx: /\bglpat-[A-Za-z0-9_-]{20,}/g,
    replacement: REDACTED,
  },
  // AWS access key id: AKIA + 16 uppercase alphanumerics.
  {
    name: "aws-akid",
    rx: /\bAKIA[A-Z0-9]{16}\b/g,
    replacement: REDACTED,
  },
  // Google Cloud / Firebase API key: AIza + 35 url-safe chars.
  {
    name: "google-api-key",
    rx: /AIza[0-9A-Za-z_-]{35}/g,
    replacement: REDACTED,
  },
  // Connection-string credentials: scheme://user:pass@host - redact the
  // user:pass credential but KEEP the scheme + host so the audit row still
  // shows which service was contacted (#685). User is optional (redis://:pass@);
  // the password may itself contain a colon.
  {
    name: "connection-string-credentials",
    rx: /(:\/\/)([^:@/\s]*:[^@/\s]+)@/g,
    replacement: `$1${REDACTED}@`,
  },
  // Long base64-looking secret after `=` or `:` (e.g. `password=…`,
  // `--token=AbCd…==`, `key: AbCd…`). Requires `=` padding so we don't
  // false-positive on long hex blobs or base64 file content fragments
  // — the padded form is what users typically paste from secret stores.
  {
    name: "long-base64-after-sep",
    rx: /([=:]\s*)([A-Za-z0-9+/_-]{32,}={1,2})/g,
    replacement: `$1${REDACTED}`,
  },
];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Scrub a free-text string for inline secrets. Pure — never mutates.
 * Exported for unit tests; production callers should go through
 * `redactSandboxPayload`.
 */
export function redactSecretsInString(input: string): string {
  if (input.length === 0) return input;
  let out = input;
  for (const { rx, replacement } of VALUE_REDACTION_PATTERNS) {
    out = out.replace(rx, replacement);
  }
  return out;
}

/** Recursively strip sensitive keys and values from a payload. Pure — never mutates. */
export function redactSandboxPayload(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH || value == null) return value;
  if (typeof value === "string") {
    return redactSecretsInString(value);
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactSandboxPayload(v, depth + 1));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(k))) {
        out[k] = REDACTED;
      } else {
        out[k] = redactSandboxPayload(v, depth + 1);
      }
    }
    return out;
  }
  return value;
}
