/**
 * Typed errors emitted by the AI engine. Routes pattern-match on `code` to
 * surface user-friendly messages while preserving the underlying cause.
 */
export type AIErrorCode =
  | "AI_OFFLINE"
  | "AI_PROVIDER_ERROR"
  | "AI_CONFIG_INVALID"
  | "AI_PROVIDER_RETIRED"
  | "AI_RATE_LIMITED"
  | "AI_CANCELLED"
  | "AI_TOOL_DENIED"
  | "AI_TOOL_INVALID_ARGS"
  | "AI_TOOL_NOT_FOUND";

export class AIError extends Error {
  readonly code: AIErrorCode;
  readonly status: number;
  readonly details?: unknown;
  constructor(code: AIErrorCode, message: string, status = 500, details?: unknown) {
    super(message);
    this.name = "AIError";
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class AIOfflineError extends AIError {
  constructor(message = "AI is in offline mode") {
    super("AI_OFFLINE", message, 503);
    this.name = "AIOfflineError";
  }
}

export class AIProviderError extends AIError {
  constructor(message: string, status = 502, details?: unknown) {
    super("AI_PROVIDER_ERROR", message, status, details);
    this.name = "AIProviderError";
  }
}

export class AIConfigError extends AIError {
  constructor(
    message: string,
    details?: unknown,
    /** Subclasses only: a more specific code/status for the same config failure. */
    shape: { code: AIErrorCode; status: number } = { code: "AI_CONFIG_INVALID", status: 500 },
  ) {
    super(shape.code, message, shape.status, details);
    this.name = "AIConfigError";
  }
}

/**
 * #149 — the configuration selects a provider METIS no longer ships (today
 * `copilot-native`), wherever it came from: env, the runtime configuration, a
 * project override. Still an {@link AIConfigError} (every `instanceof` catch
 * that refuses to fall back keeps doing so), but it answers **409
 * `AI_PROVIDER_RETIRED`** — the same code a session or project override gets —
 * rather than a generic 500 `AI_CONFIG_INVALID`. The message is built only by
 * `retiredProviderMessage` (fixed text plus the matched retired key), so it is
 * safe to show the caller and is what tells them what to change.
 */
export class AIProviderRetiredError extends AIConfigError {
  constructor(message: string, details?: unknown) {
    super(message, details, { code: "AI_PROVIDER_RETIRED", status: 409 });
    this.name = "AIProviderRetiredError";
  }
}

export class AIToolDeniedError extends AIError {
  constructor(message: string, details?: unknown) {
    super("AI_TOOL_DENIED", message, 403, details);
    this.name = "AIToolDeniedError";
  }
}

export class AIToolInvalidArgsError extends AIError {
  constructor(message: string, details?: unknown) {
    super("AI_TOOL_INVALID_ARGS", message, 400, details);
    this.name = "AIToolInvalidArgsError";
  }
}

const SAFE_TOKEN_RE = /^[A-Za-z0-9_.-]{1,60}$/;

/**
 * #1059 — a provider failure as it may be STORED and shown to other members of
 * a project: which provider, which operation, which error class and which HTTP
 * status, and never the upstream's own free text (which is not ours to vouch
 * for). The full message belongs in the server log.
 *
 * A message METIS wrote itself is passed through when its thrower marked it
 * `details.clientSafe`; an upstream failure is described from the structured
 * `details` its provider attached ({@link AIProviderError} built by a
 * provider's error mapper). Anything else is a fixed sentence.
 */
export function describeProviderErrorSafely(err: AIProviderError): string {
  const details = (err.details ?? {}) as Record<string, unknown>;
  if (details.clientSafe === true) return err.message.slice(0, 400);
  const status =
    Number.isInteger(err.status) && err.status >= 400 && err.status <= 599
      ? `, HTTP ${err.status}`
      : "";
  const token = (value: unknown): string | null =>
    typeof value === "string" && SAFE_TOKEN_RE.test(value) ? value : null;
  const provider = token(details.provider);
  const operation = token(details.operation);
  const errorName = token(details.errorName);
  if (provider && operation && errorName) {
    return `The AI provider call failed: ${provider} ${operation} (${errorName}${status}). The provider's own message is in the server log.`;
  }
  return `The AI provider call failed${status ? ` (${status.slice(2)})` : ""}. The detail is in the server log.`;
}
