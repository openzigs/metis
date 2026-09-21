/**
 * Request logging middleware.
 *
 * - Reads `X-Correlation-Id` from the request, or mints a new ULID.
 * - Echoes the id on the response and stashes it on `req.correlationId`.
 * - Logs request completion at info / warn / error depending on status code.
 *
 * Sensitive headers and known-secret keys are removed from log meta by the
 * logger's redaction format (see `lib/logger.ts`).
 */
import type { RequestHandler } from "express";
import { ulid } from "ulid";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("http");

export const requestLogger: RequestHandler = (req, res, next) => {
  const correlationId = (req.headers["x-correlation-id"] as string | undefined)?.trim() || ulid();
  req.correlationId = correlationId;
  res.setHeader("X-Correlation-Id", correlationId);
  // Mirror as `X-Trace-Id` so log shippers expecting OpenTelemetry-style
  // trace correlation can join HTTP request rows to log lines.
  res.setHeader("X-Trace-Id", correlationId);

  const start = Date.now();
  res.on("finish", () => {
    const meta = {
      correlationId,
      traceId: correlationId,
      method: req.method,
      url: req.originalUrl,
      route: req.route?.path,
      status: res.statusCode,
      latencyMs: Date.now() - start,
      userAgent: req.headers["user-agent"],
      userId: (req as unknown as { user?: { userId?: string } }).user?.userId,
    };
    if (res.statusCode >= 500) log.error("request", meta);
    else if (res.statusCode >= 400) log.warn("request", meta);
    else log.info("request", meta);
  });

  next();
};
