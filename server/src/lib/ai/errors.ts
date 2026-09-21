/**
 * Typed errors emitted by the AI engine. Routes pattern-match on `code` to
 * surface user-friendly messages while preserving the underlying cause.
 */
export type AIErrorCode =
  | "AI_OFFLINE"
  | "AI_PROVIDER_ERROR"
  | "AI_PROVIDER_UNREACHABLE"
  | "AI_CONFIG_INVALID"
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
  constructor(message: string, details?: unknown) {
    super("AI_CONFIG_INVALID", message, 500, details);
    this.name = "AIConfigError";
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
