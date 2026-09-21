/**
 * AppError + global error handler + 404 handler.
 *
 * AppErrors carry an HTTP status, machine-readable code, optional details, and
 * the request's correlation id (echoed back to the client for trace
 * correlation). Unexpected errors degrade to a 500 with a generic message in
 * production.
 */
import type { ErrorRequestHandler, RequestHandler } from "express";
import { ZodError, type ZodIssue } from "zod";
import type { ApiResponse } from "@metis/shared";
import { createChildLogger } from "../lib/logger.js";
import { mapStatusCarryingError } from "./http-status-errors.js";

const log = createChildLogger("error-handler");

export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "AppError";
  }
}

/** A single safe, human-readable field-validation summary returned to clients. */
export interface FriendlyFieldError {
  /** Dotted path to the offending field (e.g. `owner`, `filter.repo`). */
  field: string;
  /** Human-readable message — never a raw Zod issue code. */
  message: string;
}

/**
 * Map a raw Zod issue to a SAFE, human-readable `{ field, message }` summary.
 *
 * OWASP A09 (info-leak): we MUST NOT echo the raw `ZodError.issues` array — its
 * `code`/`path`/`expected`/`received`/`minimum` internals leak schema shape and
 * confuse end users (the exact defect #426 fixes: a `[{"code":"too_small",
 * "path":["owner"]}…]` array rendered to the browser with a 500). Instead we
 * derive a friendly message keyed on the issue *kind* and surface only the
 * field's dotted path so the client can render an inline message beside it.
 */
function issueToFriendly(issue: ZodIssue): FriendlyFieldError {
  const field = issue.path.length > 0 ? issue.path.join(".") : "(form)";
  const label = issue.path.length > 0 ? String(issue.path[issue.path.length - 1]) : "This field";

  // Empty / too-short required fields are by far the common case (the #426
  // walkthrough hit empty `owner`/`repo`). Give them a plain "is required"
  // message; everything else falls back to a generic "is invalid".
  let message: string;
  if (issue.code === "too_small" && (issue as { minimum?: number }).minimum === 1) {
    message = `${label} is required`;
  } else if (
    issue.code === "invalid_type" &&
    (issue as { received?: string }).received === "undefined"
  ) {
    message = `${label} is required`;
  } else if (issue.code === "too_small") {
    message = `${label} is too short`;
  } else if (issue.code === "too_big") {
    message = `${label} is too long`;
  } else if (issue.code === "invalid_enum_value" || issue.code === "invalid_type") {
    message = `${label} is invalid`;
  } else {
    message = `${label} is invalid`;
  }
  return { field, message };
}

/**
 * Turn a `ZodError` into a friendly, structured 400 envelope.
 *
 * Returns ONLY a derived `{ field, message }[]` summary under `details.fields`
 * plus a generic top-level message — no raw issues array, no schema internals.
 * Deduplicates per-field so a field with multiple failing rules surfaces once.
 */
export function zodErrorToFriendly(err: ZodError): {
  message: string;
  fields: FriendlyFieldError[];
} {
  const seen = new Set<string>();
  const fields: FriendlyFieldError[] = [];
  for (const issue of err.issues) {
    const friendly = issueToFriendly(issue);
    if (seen.has(friendly.field)) continue;
    seen.add(friendly.field);
    fields.push(friendly);
  }
  return {
    message:
      fields.length === 1
        ? fields[0].message
        : "Some fields need your attention before you can continue.",
    fields,
  };
}

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const correlationId = (req as unknown as { correlationId?: string }).correlationId;

  // Centralized Zod validation mapping (#426, epic #407). A raw `ZodError` that
  // escapes a route handler (e.g. a strict `.parse()` deep in a service layer)
  // would otherwise fall through to the 500 branch below and, in non-production,
  // echo the raw issues array to the client — leaking schema internals (OWASP
  // A09) and confusing users. Map it here so NO route can leak a raw Zod array:
  // a friendly 400 `VALIDATION_ERROR` envelope with a safe field summary.
  if (err instanceof ZodError) {
    const friendly = zodErrorToFriendly(err);
    log.warn("ZodError → friendly 400", {
      correlationId,
      fields: friendly.fields.map((f) => f.field),
    });
    const body: ApiResponse = {
      success: false,
      error: {
        code: "VALIDATION_ERROR",
        message: friendly.message,
        details: { fields: friendly.fields },
      },
      correlationId,
    };
    res.status(400).json(body);
    return;
  }

  if (err instanceof AppError) {
    log.warn("AppError", {
      correlationId,
      code: err.code,
      message: err.message,
      statusCode: err.statusCode,
    });
    const body: ApiResponse = {
      success: false,
      error: { code: err.code, message: err.message, details: err.details },
      correlationId,
    };
    res.status(err.statusCode).json(body);
    return;
  }

  // Centralized mapping for the other status-carrying error classes (#1065).
  // Without this, a `JiraApiError(400, "INVALID_URL")` (#1054) or a
  // `ConnectorError(404, "JIRA_CONNECTION_NOT_FOUND")` (#1055) fell through to
  // the 500 below, discarding the status its author intended — and each route
  // that cared had to reinvent a local translation.
  //
  // `mapStatusCarryingError` maps only classes explicitly classified as
  // carrying OUR status (never an upstream dependency's), and never forwards
  // `err.message` — see http-status-errors.ts for both rules. The original
  // message is logged here, server-side only.
  const mapped = mapStatusCarryingError(err);
  if (mapped) {
    log.warn("Status-carrying error → mapped status", {
      correlationId,
      errorClass: (err as Error).name,
      code: mapped.code,
      statusCode: mapped.statusCode,
      message: (err as Error).message,
    });
    const body: ApiResponse = {
      success: false,
      error: { code: mapped.code, message: mapped.message },
      correlationId,
    };
    res.status(mapped.statusCode).json(body);
    return;
  }

  log.error("Unexpected error", {
    correlationId,
    error: err instanceof Error ? err.message : String(err),
    stack: err instanceof Error ? err.stack : undefined,
  });

  const body: ApiResponse = {
    success: false,
    error: {
      code: "INTERNAL_ERROR",
      message:
        process.env.NODE_ENV === "production"
          ? "An unexpected error occurred"
          : err instanceof Error
            ? err.message
            : "Unknown error",
    },
    correlationId,
  };
  res.status(500).json(body);
};

export const notFoundHandler: RequestHandler = (req, res) => {
  const correlationId = (req as unknown as { correlationId?: string }).correlationId;
  const body: ApiResponse = {
    success: false,
    error: {
      code: "NOT_FOUND",
      message: `Route ${req.method} ${req.originalUrl} not found`,
    },
    correlationId,
  };
  res.status(404).json(body);
};
