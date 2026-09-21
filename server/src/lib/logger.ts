/**
 * Structured logger built on Winston.
 *
 * - Pretty colourised output in development for human grepping.
 * - Newline-delimited JSON in production so log shippers can parse it.
 * - Top-level redaction of any meta key whose name implies a secret
 *   (Authorization, Cookie, JWT, password, *_KEY, *_SECRET, *_TOKEN, etc.)
 *   plus any field tagged with `vault:` value markers.
 * - One narrow exemption, {@link TOKEN_COUNT_META_KEYS}: an explicitly
 *   enumerated token *count* carrying a numeric value is not a credential and
 *   is logged in the clear (#1263).
 *
 * REDACTION_SINK_POLICY: exempt-token-counts
 * (one of three registered sinks — `docs/decisions/0008-redaction-sinks.md`)
 */
import winston from "winston";

const { combine, timestamp, printf, colorize, json, errors } = winston.format;

/** Header / field names that must never appear in plaintext in log output. */
export const SENSITIVE_KEY_PATTERNS = [
  /authorization/i,
  /cookie/i,
  /set-cookie/i,
  /password/i,
  /passwd/i,
  /secret/i,
  /token/i,
  /api[-_]?key/i,
  /private[-_]?key/i,
  /credential/i,
  /vault[-_]?master[-_]?key/i,
  /jwt[-_]?secret/i,
];

const REDACTED = "[REDACTED]";

/**
 * Normalise a meta key for allowlist lookup: case-fold and drop every
 * separator, so `promptTokens`, `prompt_tokens`, `PROMPT-TOKENS` and
 * `prompttokens` are one entry. Providers emit the snake form
 * (`thinking_tokens`, `cache_read_input_tokens`) while METIS's own mapped
 * shapes are camel, and both must resolve identically.
 */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Meta keys that are token *counts*, not credentials — the only exemption from
 * {@link SENSITIVE_KEY_PATTERNS}.
 *
 * **This is an allowlist, and that is the whole point (#1263).** `/token/i` was
 * written to catch `access_token` / `refresh_token` / `bearer_token`, and it
 * does — but it also blanked every token count in the repo, so all token
 * accounting logged `[REDACTED]` and always had. The obvious repair, excluding
 * `*Tokens` from the pattern, re-exposes exactly the credentials the guard
 * exists for: `promptTokens` and `refresh_token` are not distinguishable
 * lexically at a glance, and `accessTokens` would sail straight through.
 *
 * So the discriminator is enumeration, not shape. A key redacts unless it is
 * named here. A **new credential-shaped key redacts by default**; a new count
 * key is redacted until someone adds it — noisy, never unsafe. A denylist of
 * credential names would have the opposite failure mode, and this repo has
 * shipped enough fail-open gates already (#1215).
 *
 * Every entry below is a count, a budget or a cap observed in a real log call
 * or on a real logged object in `server/src`. `logger.enumeration.test.ts`
 * re-derives that set from the sources and fails on any key not classified
 * here or explicitly classified as a credential.
 */
const TOKEN_COUNT_META_KEYS: ReadonlySet<string> = new Set(
  [
    // Provider usage, both the mapped camel shape and the raw snake shape.
    "tokens",
    "totalTokens",
    "promptTokens",
    "completionTokens",
    "inputTokens",
    "outputTokens",
    // Extended thinking / reasoning spend. `thinking_tokens` is the field
    // #1257 needs in order to size output caps honestly; `reasoningTokens` is
    // the same count under the OpenAI-family name.
    "thinkingTokens",
    "reasoningTokens",
    // Prompt-cache accounting.
    "cachedTokens",
    "cacheReadTokens",
    "cacheWriteTokens",
    "cacheReadInputTokens",
    "cacheCreationInputTokens",
    "totalPromptTokens",
    "freshInputTokens",
    // Context-window and compaction accounting (#1225).
    "estimatedTokens",
    "savedTokens",
    "watermarkTokens",
    "currentTokens",
    "beforeTokens",
    "afterTokens",
    "tokensBefore",
    "tokensAfter",
    "originalTokens",
    // Caps and budgets.
    "maxTokens",
    "maxOutputTokens",
    "defaultMaxTokens",
    "maxTranscriptTokens",
    "targetTokens",
    "tokenBudget",
    "llmTokenBudget",
    // #1268 — counts that reach the *audit* sink rather than a log call, found
    // by `redaction-sinks.enumeration.test.ts`. Kept as one block because the
    // allowlist is shared: whether a key is a count is a fact about the key,
    // not about which sink happens to see it.
    "tokensConsumed", // analysis/orchestrator.ts — delta.totalTokens
    "tokensUsed", // routes/analysis.ts — result.usage.totalTokens
    "tokenSpend", // scanner/orchestrator.ts — number, budget accounting
    "monthlyTokenBudget", // autopilot-runner.ts — Project.monthlyTokenBudget cap
  ].map(normalizeKey),
);

/**
 * A count is exempt only when it is *both* an allowlisted name and carries a
 * value that cannot hold a secret — a finite number, or nothing at all.
 *
 * The second clause is the belt to the allowlist's braces: `tokens: 4096`
 * survives, while `tokens` carrying an opaque credential string still redacts.
 * It means a mistaken allowlist entry cannot leak a string credential, and it
 * keeps generic names like `tokens` safe to allow.
 */
function isTokenCountValue(value: unknown): boolean {
  return value == null || (typeof value === "number" && Number.isFinite(value));
}

/**
 * The token-count exemption on its own, without this module's denylist —
 * **the one predicate the other redaction sinks share** (#1268).
 *
 * Whether a key is a token *count* rather than a credential is a fact about the
 * key and its value, not about the sink, so three copies of that judgement is
 * exactly the thing that drifts. Whether a sink *consults* it is per-sink
 * policy, recorded in `docs/decisions/0008-redaction-sinks.md`; the count
 * allowlist itself stays here, where it is already maintained.
 */
export function isTokenCountExempt(key: string, value: unknown): boolean {
  return TOKEN_COUNT_META_KEYS.has(normalizeKey(key)) && isTokenCountValue(value);
}

function isSensitiveKey(key: string, value: unknown): boolean {
  if (isTokenCountExempt(key, value)) return false;
  return SENSITIVE_KEY_PATTERNS.some((rx) => rx.test(key));
}

/** Test seam: the exact allowlist the redactor consults, already normalised. */
export function tokenCountMetaKeys(): ReadonlySet<string> {
  return TOKEN_COUNT_META_KEYS;
}

/**
 * Recursively walk a meta object and return a redacted clone.
 * Leaves the original untouched (winston shares meta across transports).
 */
export function redact(input: unknown, depth = 0): unknown {
  if (depth > 6 || input == null) return input;
  if (Array.isArray(input)) return input.map((v) => redact(v, depth + 1));
  if (typeof input === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
      if (isSensitiveKey(k, v)) {
        out[k] = REDACTED;
      } else {
        out[k] = redact(v, depth + 1);
      }
    }
    return out;
  }
  return input;
}

/**
 * Redact a winston `info` record in place — the top-level pass that the format
 * applies before any transport sees it. Exported so tests can exercise the
 * same path production logs through, rather than only the recursive
 * {@link redact}: the two must agree, and they agree by sharing
 * `isSensitiveKey`.
 */
export function redactInfo(info: Record<string, unknown>): Record<string, unknown> {
  for (const key of Object.keys(info)) {
    if (
      key === "level" ||
      key === "message" ||
      key === "timestamp" ||
      key === "service" ||
      key === "module"
    )
      continue;
    const value = info[key];
    if (isSensitiveKey(key, value)) {
      info[key] = REDACTED;
    } else {
      info[key] = redact(value);
    }
  }
  return info;
}

const redactionFormat = winston.format((info) => {
  redactInfo(info as unknown as Record<string, unknown>);
  return info;
})();

const isDev = process.env.NODE_ENV === "development" || process.env.NODE_ENV === undefined;

const devFormat = combine(
  errors({ stack: true }),
  redactionFormat,
  colorize(),
  timestamp({ format: "HH:mm:ss" }),
  printf(({ level, message, timestamp: ts, correlationId, module, ...meta }) => {
    const cid = correlationId ? ` [${String(correlationId)}]` : "";
    const mod = module ? ` (${String(module)})` : "";
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : "";
    return `${ts as string} ${level}${cid}${mod}: ${String(message)}${metaStr}`;
  }),
);

const prodFormat = combine(errors({ stack: true }), redactionFormat, timestamp(), json());

export const logger = winston.createLogger({
  level: process.env.LOG_LEVEL ?? (isDev ? "debug" : "info"),
  format: isDev ? devFormat : prodFormat,
  defaultMeta: { service: "metis-server" },
  transports: [
    new winston.transports.Console({
      // Errors and warnings keep going to stderr in prod for k8s log shippers
      stderrLevels: ["error"],
    }),
  ],
});

/** Returns a child logger pre-tagged with `module=<name>`. */
export function createChildLogger(module: string): winston.Logger {
  return logger.child({ module });
}
