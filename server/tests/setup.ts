/**
 * Shared test setup helpers.
 *
 * Tests stub out Prisma per-suite using `vi.mock("../src/lib/prisma.js", ...)`
 * so we never need a real database. We also pin a known JWT secret + vault key
 * before any module under test loads.
 */
import { afterEach, beforeAll, beforeEach, vi } from "vitest";
import { isolateSupertestLoopback } from "./helpers/supertest-loopback.js";

// These must be set BEFORE any source module imports, so they execute at
// module-load time (top of this setup file), not in beforeAll.
process.env.NODE_ENV = "test";
process.env.JWT_SECRET = "test-jwt-secret-must-be-long-enough-for-tests";
process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
process.env.METIS_NO_LISTEN = "1";
process.env.RATE_LIMIT_MAX = "100000";
// Connector route limiters are lazy module-level singletons that survive across
// `createApp()` instances, so a large suite can exhaust the per-user budget
// purely by ordering. Set sky-high limits in tests; production envs override.
process.env.CONNECTOR_QUERY_LIMIT_MAX = "100000";
process.env.CONNECTOR_TEST_LIMIT_MAX = "100000";
process.env.CONNECTOR_METADATA_LIMIT_MAX = "100000";
process.env.AI_OFFLINE = process.env.AI_OFFLINE ?? "1";
// Issue #189 — the in-process ONNX embedders run in a worker_thread by default.
// Suites that `vi.mock("@huggingface/transformers")` need them in THIS thread (a
// module mock does not cross a thread boundary); the worker path is exercised by
// its own tests, which pass `inProcessRuntime` explicitly.
process.env.EMBED_INPROCESS_RUNTIME = process.env.EMBED_INPROCESS_RUNTIME ?? "inline";
// Epic #158 — never auto-start OTel during tests so individual specs can
// install their own SpanProcessor.
process.env.OTEL_SDK_DISABLED = process.env.OTEL_SDK_DISABLED ?? "true";
process.env.METIS_OTEL_AUTOSTART = process.env.METIS_OTEL_AUTOSTART ?? "false";

beforeAll(() => {
  isolateSupertestLoopback();
  process.env.NODE_ENV = "test";
  process.env.JWT_SECRET = "test-jwt-secret-must-be-long-enough-for-tests";
  // 32 bytes of base64 — keeps the vault happy without going through openssl.
  process.env.VAULT_MASTER_KEY = Buffer.alloc(32, 7).toString("base64");
  process.env.METIS_NO_LISTEN = "1";
  process.env.RATE_LIMIT_MAX = "100000";
  process.env.CONNECTOR_QUERY_LIMIT_MAX = "100000";
  process.env.CONNECTOR_TEST_LIMIT_MAX = "100000";
  process.env.CONNECTOR_METADATA_LIMIT_MAX = "100000";
  // Default to offline AI so deep-health and provider construction never
  // reach for the real Copilot SDK during tests.
  process.env.AI_OFFLINE = process.env.AI_OFFLINE ?? "1";
});

// restoreAllMocks removes the transport spy after each test. Reinstall it for
// every fixture, including integration suites, without changing application IO.
beforeEach(isolateSupertestLoopback);

afterEach(() => {
  vi.restoreAllMocks();
});
