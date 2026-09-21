/**
 * Prometheus metrics registry + collectors.
 *
 * Exposes RED-style HTTP metrics (rate, errors, duration), plus per-MCP-server
 * status as a gauge. Default Node.js process metrics (CPU, memory, GC, event
 * loop lag) are enabled via `prom-client` defaults.
 *
 * The registry is a module-level singleton — call `resetMetricsForTests()`
 * between test cases to clear counter state.
 */
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

let registry = new Registry();
let httpRequestsTotal: Counter<string>;
let httpRequestDurationSeconds: Histogram<string>;
let httpRequestErrorsTotal: Counter<string>;
let mcpServerStatus: Gauge<string>;
let socketEventsTotal: Counter<string>;
let initialized = false;

function ensureInit(): void {
  if (initialized) return;
  registry.setDefaultLabels({ service: "metis-server" });
  collectDefaultMetrics({ register: registry });

  httpRequestsTotal = new Counter({
    name: "metis_http_requests_total",
    help: "Total HTTP requests received, labelled by method, route, and status code class.",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });

  httpRequestDurationSeconds = new Histogram({
    name: "metis_http_request_duration_seconds",
    help: "HTTP request duration in seconds.",
    labelNames: ["method", "route", "status"],
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10],
    registers: [registry],
  });

  httpRequestErrorsTotal = new Counter({
    name: "metis_http_request_errors_total",
    help: "Total HTTP responses with status >= 500.",
    labelNames: ["method", "route"],
    registers: [registry],
  });

  mcpServerStatus = new Gauge({
    name: "metis_mcp_server_status",
    help: "Current status per MCP server: 1=ready, 0=stopped/disabled, -1=error.",
    labelNames: ["server", "name"],
    registers: [registry],
  });

  socketEventsTotal = new Counter({
    name: "metis_socket_events_total",
    help: "Total Socket.IO events emitted, labelled by namespace and event name.",
    labelNames: ["namespace", "event"],
    registers: [registry],
  });

  initialized = true;
}

/** Underlying registry — exposed for tests and the `/metrics` route handler. */
export function getMetricsRegistry(): Registry {
  ensureInit();
  return registry;
}

/** Record one completed HTTP request. `route` should be the templated path. */
export function recordHttpRequest(opts: {
  method: string;
  route: string;
  status: number;
  durationSeconds: number;
}): void {
  ensureInit();
  const statusBucket = bucketStatus(opts.status);
  const labels = { method: opts.method.toUpperCase(), route: opts.route, status: statusBucket };
  httpRequestsTotal.inc(labels, 1);
  httpRequestDurationSeconds.observe(labels, opts.durationSeconds);
  if (opts.status >= 500) {
    httpRequestErrorsTotal.inc({ method: labels.method, route: labels.route }, 1);
  }
}

/** Update the gauge for one MCP server. */
export function setMcpServerStatus(opts: {
  server: string;
  name: string;
  status: "ready" | "stopped" | "disabled" | "error";
}): void {
  ensureInit();
  const value = opts.status === "ready" ? 1 : opts.status === "error" ? -1 : 0;
  mcpServerStatus.set({ server: opts.server, name: opts.name }, value);
}

/** Record one Socket.IO server-side emit. */
export function recordSocketEvent(opts: { namespace: string; event: string }): void {
  ensureInit();
  socketEventsTotal.inc({ namespace: opts.namespace, event: opts.event }, 1);
}

/** Bucket status code into 2xx/3xx/4xx/5xx/other for cardinality control. */
function bucketStatus(code: number): string {
  if (code >= 500) return "5xx";
  if (code >= 400) return "4xx";
  if (code >= 300) return "3xx";
  if (code >= 200) return "2xx";
  return "other";
}

/**
 * Reset registry state between tests. Tears down all collectors so the next
 * `getMetricsRegistry()` call rebuilds a clean instance.
 */
export function resetMetricsForTests(): void {
  registry.clear();
  registry = new Registry();
  initialized = false;
}
