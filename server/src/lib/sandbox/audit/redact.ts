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
 * ERROR_SERIALISATION_POLICY: reduce-at-call-site
 *
 * Same decision as `audit-service.ts`, and for the same reason one degree
 * stronger: `SandboxAuditEvent` rows are SOC 2 evidence. An `Error` reaching
 * {@link redactSandboxPayload} keeps only its own enumerable properties — the
 * non-enumerable `name` / `message` / `stack` / `cause` / `errors` are dropped,
 * so it persists as `{}` rather than as a stack. The audit emitter's own
 * failure path already reduces to `(err as Error).message`.
 * Decision: `docs/decisions/0016-error-serialisation-in-the-persisting-sinks.md`.
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
import { redactSecrets } from "../../safety/secret-patterns.js";

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
 * #2333 — the vendor key shapes (Anthropic, Slack, GitHub, GitLab, AWS and the
 * rest) are NOT listed here: {@link redactSecretsInString} runs the one shared
 * set, `safety/secret-patterns.ts`, and collapses its `[REDACTED:<class>]`
 * markers to this sink's plain `[REDACTED]`, so an audit row reads as before.
 * The shared set is a superset of the vendor shapes this file used to copy, but
 * for one edge: its prefixed shapes do not start right after a `-` (`x-sk-ant-…`).
 *
 * What stays here is this sink's own behaviour, which the shared set does not
 * have, and must not: it is tuned against false positives in SOURCE CODE,
 * while an audit row is better over-redacted.
 *
 *   - `auth-header` runs FIRST and keeps the header name and scheme
 *     (`Authorization: Basic [REDACTED]`); the shared set knows only `Bearer`.
 *   - `openai-key-short` takes `sk-` + 20 characters; the shared OpenAI shape
 *     needs 32.
 *   - `google-api-key-prefix` takes the first 35 characters after `AIza` even
 *     when more follow; the shared shape wants exactly 35 then a boundary.
 *   - `connection-string-credentials` redacts a template slot too
 *     (`://u:${PASS}@`), which the shared `url_credentials` keeps.
 *   - `long-base64-after-sep`: a padded base64 value after `=` or `:`.
 */
const AUTH_HEADER = {
  name: "auth-header",
  rx: /(Authorization\s*:\s*)(Bearer|Basic|Digest|Token)\s+[A-Za-z0-9._\-+/=]+/gi,
  replacement: `$1$2 ${REDACTED}`,
} as const;

/** Run after the shared set; see the note above for why each is this sink's own. */
const SINK_ONLY_PATTERNS: ReadonlyArray<{ name: string; rx: RegExp; replacement: string }> = [
  {
    name: "openai-key-short",
    rx: /\bsk-[A-Za-z0-9]{20,}/g,
    replacement: REDACTED,
  },
  {
    name: "google-api-key-prefix",
    rx: /AIza[0-9A-Za-z_-]{35}/g,
    replacement: REDACTED,
  },
  // User is optional (redis://:pass@); the password may itself contain a colon.
  {
    name: "connection-string-credentials",
    rx: /(:\/\/)([^:@/\s]*:[^@/\s]+)@/g,
    replacement: `$1${REDACTED}@`,
  },
  // `password=…`, `--token=AbCd…==`, `key: AbCd…`. Requires `=` padding so we
  // don't false-positive on long hex blobs or base64 file content fragments.
  {
    name: "long-base64-after-sep",
    rx: /([=:]\s*)([A-Za-z0-9+/_-]{32,}={1,2})/g,
    replacement: `$1${REDACTED}`,
  },
];

/** A shared-set marker (`[REDACTED:github_pat]`), collapsed to this sink's plain one. */
const SHARED_MARKER = /\[REDACTED:[a-z_]{1,40}\]/g;

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
  let out = input.replace(AUTH_HEADER.rx, AUTH_HEADER.replacement);
  out = redactSecrets(out).text.replace(SHARED_MARKER, REDACTED);
  for (const { rx, replacement } of SINK_ONLY_PATTERNS) {
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
