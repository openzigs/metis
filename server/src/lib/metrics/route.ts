/**
 * `/metrics` endpoint handler.
 *
 * Auth is gated by an `Authorization: Bearer <METRICS_TOKEN>` header. When
 * `METRICS_TOKEN` is unset, the route is disabled (returns 404) to avoid
 * accidental exposure in misconfigured environments. Constant-time comparison
 * prevents token-length / first-byte timing attacks.
 *
 * Also re-syncs MCP gauge values on each scrape so the gauge stays accurate
 * even between status-change events.
 */
import { type Router, Router as makeRouter, type RequestHandler } from "express";
import { timingSafeEqual } from "node:crypto";
import { getMetricsRegistry, setMcpServerStatus } from "./index.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("metrics");

export function isMetricsEnabled(): boolean {
  return Boolean(process.env.METRICS_TOKEN && process.env.METRICS_TOKEN.length > 0);
}

/**
 * Validate the Bearer token using constant-time comparison.
 * Exported for unit tests.
 */
export function isAuthorizedMetricsRequest(authHeader: string | undefined): boolean {
  const token = process.env.METRICS_TOKEN;
  if (!token) return false;
  if (!authHeader || typeof authHeader !== "string") return false;
  const trimmed = authHeader.trim();
  if (!/^Bearer\s+/i.test(trimmed)) return false;
  const provided = trimmed.replace(/^Bearer\s+/i, "").trim();
  if (!provided) return false;
  // Buffer.from + length check avoids RangeError in timingSafeEqual.
  const a = Buffer.from(provided, "utf8");
  const b = Buffer.from(token, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const handler: RequestHandler = async (req, res) => {
  if (!isMetricsEnabled()) {
    res.status(404).json({ error: "Not Found" });
    return;
  }
  if (!isAuthorizedMetricsRequest(req.header("authorization"))) {
    res.setHeader("WWW-Authenticate", 'Bearer realm="metrics"');
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  // Re-sync MCP gauge on scrape — best-effort, never throws into the response.
  try {
    const { getMCPRegistry } = await import("../mcp/index.js");
    let reg;
    try {
      reg = getMCPRegistry();
    } catch {
      reg = null;
    }
    if (reg) {
      const items = (await reg.list()) as Array<{
        id: string;
        label: string;
        status: string;
        enabled: boolean;
      }>;
      for (const it of items) {
        const status = !it.enabled
          ? "disabled"
          : it.status === "ready"
            ? "ready"
            : it.status === "error"
              ? "error"
              : "stopped";
        setMcpServerStatus({
          server: it.id,
          name: it.label,
          status: status as "ready" | "stopped" | "disabled" | "error",
        });
      }
    }
  } catch (err) {
    log.debug("MCP gauge sync failed", { error: (err as Error).message });
  }

  const registry = getMetricsRegistry();
  res.setHeader("Content-Type", registry.contentType);
  res.status(200).send(await registry.metrics());
};

export function metricsRouter(): Router {
  const r = makeRouter();
  r.get("/", handler);
  return r;
}

export const metricsHandler: RequestHandler = handler;
