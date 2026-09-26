/**
 * #134 — `/readyz` pings the provider the factory builds for EACH key, now that
 * openai / azure / bedrock-gateway are direct clients: the probe must reach the
 * key's own models endpoint, and AI_PING_TIMEOUT_MS must still bound it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../src/lib/prisma.js", () => ({
  prisma: {
    $queryRawUnsafe: vi.fn(async () => 1),
    user: { upsert: vi.fn(async () => ({ id: "user_admin" })) },
    userRole: { findFirst: vi.fn(async () => null) },
    auditLog: { create: vi.fn(async () => ({})) },
  },
}));

import request from "supertest";
import { createApp } from "../../../src/app.js";
import { setHealthProviderForTests } from "../../../src/routes/health.js";

const KEYS: Array<{ key: string; env: Record<string, string>; modelsUrl: string }> = [
  {
    key: "local-gemma",
    env: { LOCAL_GEMMA_BASE_URL: "http://127.0.0.1:11434/v1" },
    modelsUrl: "http://127.0.0.1:11434/v1/models",
  },
  {
    key: "bedrock-gateway",
    env: {
      BEDROCK_GATEWAY_URL: "http://gateway.internal:8080/api/v1",
      BEDROCK_GATEWAY_API_KEY: "k",
    },
    modelsUrl: "http://gateway.internal:8080/api/v1/models",
  },
  {
    key: "openai",
    env: { OPENAI_BASE_URL: "https://api.openai.com/v1", OPENAI_API_KEY: "sk" },
    modelsUrl: "https://api.openai.com/v1/models",
  },
  {
    key: "azure",
    env: { AZURE_OPENAI_ENDPOINT: "https://contoso.openai.azure.com", AZURE_OPENAI_API_KEY: "az" },
    modelsUrl: "https://contoso.openai.azure.com/openai/models?api-version=2024-10-21",
  },
];

const originalFetch = globalThis.fetch;
let touched: string[] = [];

beforeEach(() => {
  setHealthProviderForTests(null);
  process.env.AI_OFFLINE = "false";
  process.env.AI_PING_TIMEOUT_MS = "100";
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  for (const k of ["AI_OFFLINE", "AI_PROVIDER", "AI_PING_TIMEOUT_MS", ...touched])
    delete process.env[k];
  touched = [];
});

function configure(key: string, env: Record<string, string>): void {
  process.env.AI_PROVIDER = key;
  for (const [k, v] of Object.entries(env)) {
    process.env[k] = v;
    touched.push(k);
  }
}

describe("/readyz AI probe per provider key", () => {
  for (const { key, env, modelsUrl } of KEYS) {
    it(`${key}: ok when its models endpoint answers`, async () => {
      configure(key, env);
      const seen: string[] = [];
      globalThis.fetch = vi.fn(async (url: unknown) => {
        seen.push(String(url));
        return new Response(JSON.stringify({ data: [] }), { status: 200 });
      }) as unknown as typeof fetch;
      const res = await request(createApp()).get("/readyz");
      expect(res.body.checks.ai).toMatchObject({ status: "ok", message: key });
      expect(seen).toContain(modelsUrl);
    });
  }

  it("a hanging probe is bounded by AI_PING_TIMEOUT_MS and reads degraded", async () => {
    configure("openai", KEYS[2].env);
    globalThis.fetch = vi.fn(
      () => new Promise<Response>(() => undefined),
    ) as unknown as typeof fetch;
    const started = Date.now();
    const res = await request(createApp()).get("/readyz");
    expect(res.body.checks.ai).toMatchObject({ status: "degraded", message: "openai unreachable" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });
});
