/**
 * Unit tests for the metrics module — registry collectors, RED counters,
 * MCP gauge, and the `/metrics` route handler with token auth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import {
  getMetricsRegistry,
  recordHttpRequest,
  recordSocketEvent,
  resetMetricsForTests,
  setMcpServerStatus,
} from "../src/lib/metrics/index.js";
import {
  isAuthorizedMetricsRequest,
  isMetricsEnabled,
  metricsHandler,
} from "../src/lib/metrics/route.js";
import { metricsMiddleware } from "../src/lib/metrics/middleware.js";

const ORIGINAL_TOKEN = process.env.METRICS_TOKEN;

beforeEach(() => {
  resetMetricsForTests();
  delete process.env.METRICS_TOKEN;
});

afterEach(() => {
  if (ORIGINAL_TOKEN === undefined) {
    delete process.env.METRICS_TOKEN;
  } else {
    process.env.METRICS_TOKEN = ORIGINAL_TOKEN;
  }
  vi.restoreAllMocks();
});

describe("metrics registry", () => {
  it("records http requests with method, route, status bucket labels", async () => {
    recordHttpRequest({
      method: "get",
      route: "/api/projects",
      status: 200,
      durationSeconds: 0.05,
    });
    recordHttpRequest({
      method: "GET",
      route: "/api/projects",
      status: 404,
      durationSeconds: 0.01,
    });
    recordHttpRequest({
      method: "POST",
      route: "/api/projects",
      status: 500,
      durationSeconds: 1.2,
    });

    const text = await getMetricsRegistry().metrics();
    expect(text).toMatch(
      /metis_http_requests_total\{[^}]*method="GET"[^}]*route="\/api\/projects"[^}]*status="2xx"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /metis_http_requests_total\{[^}]*method="GET"[^}]*route="\/api\/projects"[^}]*status="4xx"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /metis_http_requests_total\{[^}]*method="POST"[^}]*route="\/api\/projects"[^}]*status="5xx"[^}]*\} 1/,
    );
    expect(text).toContain("metis_http_request_errors_total");
    expect(text).toContain("metis_http_request_duration_seconds_bucket");
  });

  it("buckets non-standard status codes under 'other'", async () => {
    recordHttpRequest({ method: "GET", route: "/x", status: 102, durationSeconds: 0.001 });
    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('status="other"');
  });

  it("sets MCP server gauge per status", async () => {
    setMcpServerStatus({ server: "s1", name: "github", status: "ready" });
    setMcpServerStatus({ server: "s2", name: "filesystem", status: "error" });
    setMcpServerStatus({ server: "s3", name: "playwright", status: "stopped" });
    setMcpServerStatus({ server: "s4", name: "context7", status: "disabled" });

    const text = await getMetricsRegistry().metrics();
    expect(text).toMatch(/metis_mcp_server_status\{[^}]*server="s1"[^}]*name="github"[^}]*\} 1/);
    expect(text).toMatch(
      /metis_mcp_server_status\{[^}]*server="s2"[^}]*name="filesystem"[^}]*\} -1/,
    );
    expect(text).toMatch(
      /metis_mcp_server_status\{[^}]*server="s3"[^}]*name="playwright"[^}]*\} 0/,
    );
    expect(text).toMatch(/metis_mcp_server_status\{[^}]*server="s4"[^}]*name="context7"[^}]*\} 0/);
  });

  it("records socket events", async () => {
    recordSocketEvent({ namespace: "/", event: "publish:status" });
    recordSocketEvent({ namespace: "/", event: "publish:status" });
    const text = await getMetricsRegistry().metrics();
    expect(text).toMatch(
      /metis_socket_events_total\{[^}]*namespace="\/"[^}]*event="publish:status"[^}]*\} 2/,
    );
  });

  it("includes default Node.js process metrics", async () => {
    const text = await getMetricsRegistry().metrics();
    expect(text).toContain("process_cpu_user_seconds_total");
    expect(text).toContain("nodejs_eventloop_lag_seconds");
  });
});

describe("metrics auth", () => {
  it("isMetricsEnabled returns false when METRICS_TOKEN unset", () => {
    delete process.env.METRICS_TOKEN;
    expect(isMetricsEnabled()).toBe(false);
  });

  it("isMetricsEnabled returns true when METRICS_TOKEN set", () => {
    process.env.METRICS_TOKEN = "abc";
    expect(isMetricsEnabled()).toBe(true);
  });

  it("rejects when token unset regardless of header", () => {
    delete process.env.METRICS_TOKEN;
    expect(isAuthorizedMetricsRequest("Bearer anything")).toBe(false);
  });

  it("rejects when no Authorization header", () => {
    process.env.METRICS_TOKEN = "secret-token";
    expect(isAuthorizedMetricsRequest(undefined)).toBe(false);
    expect(isAuthorizedMetricsRequest("")).toBe(false);
  });

  it("rejects non-Bearer schemes", () => {
    process.env.METRICS_TOKEN = "secret-token";
    expect(isAuthorizedMetricsRequest("Basic c2VjcmV0LXRva2Vu")).toBe(false);
  });

  it("rejects mismatched token", () => {
    process.env.METRICS_TOKEN = "secret-token";
    expect(isAuthorizedMetricsRequest("Bearer wrong-token-x")).toBe(false);
  });

  it("rejects empty Bearer value", () => {
    process.env.METRICS_TOKEN = "secret-token";
    expect(isAuthorizedMetricsRequest("Bearer    ")).toBe(false);
  });

  it("accepts matching Bearer token", () => {
    process.env.METRICS_TOKEN = "secret-token";
    expect(isAuthorizedMetricsRequest("Bearer secret-token")).toBe(true);
  });

  it("accepts case-insensitive Bearer scheme", () => {
    process.env.METRICS_TOKEN = "secret-token";
    expect(isAuthorizedMetricsRequest("bearer secret-token")).toBe(true);
  });

  it("uses constant-time comparison (length differences rejected)", () => {
    process.env.METRICS_TOKEN = "secret-token";
    expect(isAuthorizedMetricsRequest("Bearer secret")).toBe(false);
    expect(isAuthorizedMetricsRequest("Bearer secret-token-extra")).toBe(false);
  });
});

describe("metrics route handler", () => {
  function appWithMetrics(): express.Express {
    const app = express();
    app.get("/metrics", metricsHandler);
    return app;
  }

  it("returns 404 when METRICS_TOKEN is unset", async () => {
    delete process.env.METRICS_TOKEN;
    const res = await request(appWithMetrics()).get("/metrics");
    expect(res.status).toBe(404);
  });

  it("returns 401 + WWW-Authenticate when token missing", async () => {
    process.env.METRICS_TOKEN = "scrape-me";
    const res = await request(appWithMetrics()).get("/metrics");
    expect(res.status).toBe(401);
    expect(res.headers["www-authenticate"]).toContain("Bearer");
  });

  it("returns 401 when token wrong", async () => {
    process.env.METRICS_TOKEN = "scrape-me";
    const res = await request(appWithMetrics())
      .get("/metrics")
      .set("Authorization", "Bearer wrong");
    expect(res.status).toBe(401);
  });

  it("returns 200 + prom format when token matches", async () => {
    process.env.METRICS_TOKEN = "scrape-me";
    recordHttpRequest({ method: "GET", route: "/x", status: 200, durationSeconds: 0.01 });
    const res = await request(appWithMetrics())
      .get("/metrics")
      .set("Authorization", "Bearer scrape-me");
    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toContain("text/plain");
    expect(res.text).toContain("metis_http_requests_total");
  });
});

describe("metrics middleware", () => {
  it("records one request per response finish", async () => {
    process.env.METRICS_TOKEN = "t";
    const app = express();
    app.use(metricsMiddleware);
    app.get("/api/test", (_req, res) => res.json({ ok: true }));
    app.get("/api/err", (_req, res) => res.status(500).json({ error: "boom" }));

    await request(app).get("/api/test");
    await request(app).get("/api/test");
    await request(app).get("/api/err");

    const text = await getMetricsRegistry().metrics();
    expect(text).toMatch(
      /metis_http_requests_total\{[^}]*method="GET"[^}]*route="\/api\/test"[^}]*status="2xx"[^}]*\} 2/,
    );
    expect(text).toMatch(
      /metis_http_requests_total\{[^}]*method="GET"[^}]*route="\/api\/err"[^}]*status="5xx"[^}]*\} 1/,
    );
    expect(text).toMatch(
      /metis_http_request_errors_total\{[^}]*method="GET"[^}]*route="\/api\/err"[^}]*\} 1/,
    );
  });

  it("strips query string from unknown routes", async () => {
    const app = express();
    app.use(metricsMiddleware);
    app.use((_req, res) => res.status(404).end());
    await request(app).get("/no-such?token=secret&page=1");
    const text = await getMetricsRegistry().metrics();
    expect(text).toContain('route="/no-such"');
    expect(text).not.toContain("token=secret");
  });
});
