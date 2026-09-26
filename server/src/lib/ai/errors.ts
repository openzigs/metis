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
