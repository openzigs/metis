/**
 * HTTP metrics middleware. Records one observation per request when the
 * response finishes, using the templated route path (e.g. `/api/projects/:id`)
 * to keep label cardinality bounded.
 *
 * Mounted before `apiRouter()` in `app.ts` so `/healthz`, `/readyz`, and
 * `/metrics` all show up in the histogram.
 */
import type { RequestHandler } from "express";
import { recordHttpRequest } from "./index.js";

export const metricsMiddleware: RequestHandler = (req, res, next) => {
  const start = process.hrtime.bigint();
  res.on("finish", () => {
    const durationNs = Number(process.hrtime.bigint() - start);
    const durationSeconds = durationNs / 1_000_000_000;
    // Prefer the matched route path; fall back to a sanitised originalUrl with
    // the query string stripped.
    const route =
      req.route?.path ??
      (req.baseUrl ? `${req.baseUrl}${req.route?.path ?? ""}` : null) ??
      stripQuery(req.originalUrl ?? req.url ?? "unknown");
    recordHttpRequest({
      method: req.method,
      route: route || "unknown",
      status: res.statusCode,
      durationSeconds,
    });
  });
  next();
};

function stripQuery(url: string): string {
  const i = url.indexOf("?");
  return i === -1 ? url : url.slice(0, i);
}
