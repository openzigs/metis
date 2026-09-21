/**
 * Sub-issue #386 (epic #391) — ARN-swap hardening.
 *
 * Bedrock cost attribution relies on the BedrockDirectProvider replacing a raw
 * model ID with its application-inference-profile ARN before the request hits
 * the gateway. This suite proves:
 *
 *   1. The model-ID -> profile-ARN swap fires on the three real Bedrock-invoking
 *      shapes — the analysis/agent path, the default chat path, and the
 *      docs-gen paths — WHEN env profiles are configured (i.e. `modelProfileMap`
 *      is populated): `resolveModel` returns the ARN and the request body
 *      carries the ARN, not the raw `us.anthropic.*` ID.
 *   2. A structured `warn` fires when a raw `us.`-prefixed (cross-region) ID is
 *      sent while a profile map IS configured but lacks that key — the
 *      cost-attribution bypass observability signal. The request still proceeds
 *      (no throw) and the log leaks neither the API key nor the profile ARNs.
 *   3. NO warn and a passthrough (ID unchanged) when no profile map is
 *      configured.
 *
 * Cross-region routing (us-east-1 / us-east-2 / us-west-2) is INTENTIONAL — the
 * swap is purely for Cost Explorer attribution, NOT region pinning. These tests
 * assert nothing about residency.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Shared logger mock so the warn-log assertions can inspect calls. The provider
// builds its child logger at module import time via `createChildLogger`, so the
// mock must return a STABLE object whose `warn` we can read across the suite.
// `vi.hoisted` makes the object available to the hoisted `vi.mock` factory.
const logMock = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../../../src/lib/logger.js", () => ({
  createChildLogger: () => logMock,
}));

import {
  OpenAICompatibleProvider,
  BedrockDirectProvider,
  isCrossRegionModelId,
} from "../../../src/lib/ai/providers/openai-compatible-provider.js";

const BASE = "http://gateway.local/v1";

// Model IDs and PLACEHOLDER ARNs — never real account IDs / profile IDs.
const SONNET_ID = "us.anthropic.claude-sonnet-4-6";
const HAIKU_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const SONNET_ARN =
  "arn:aws:bedrock:us-east-1:ACCOUNT:application-inference-profile/SONNET_PROFILE_ID";
const HAIKU_ARN =
  "arn:aws:bedrock:us-east-1:ACCOUNT:application-inference-profile/HAIKU_PROFILE_ID";

/** The map config.ts `buildModelProfileMap` produces when both env vars are set. */
const FULL_PROFILE_MAP: Record<string, string> = {
  [SONNET_ID]: SONNET_ARN,
  [HAIKU_ID]: HAIKU_ARN,
};

function okJson(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: "ok" } }],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    }),
    { status: 200 },
  );
}

/** Capture the JSON request body of the single `chat()` fetch. */
async function chatBody(
  opts: ConstructorParameters<typeof OpenAICompatibleProvider>[0],
  chatOpts?: Parameters<OpenAICompatibleProvider["chat"]>[1],
): Promise<Record<string, unknown>> {
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(okJson());
  const p = new OpenAICompatibleProvider(opts);
  await p.chat([{ role: "user", content: "hi" }], chatOpts);
  const init = fetchSpy.mock.calls[0]?.[1] as RequestInit & { dispatcher?: unknown };
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

beforeEach(() => {
  logMock.warn.mockClear();
  logMock.info.mockClear();
  logMock.debug.mockClear();
  logMock.error.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("isCrossRegionModelId", () => {
  it("flags us. and global. system inference profiles", () => {
    expect(isCrossRegionModelId(SONNET_ID)).toBe(true);
    expect(isCrossRegionModelId(HAIKU_ID)).toBe(true);
    expect(isCrossRegionModelId("global.anthropic.claude-haiku-4-5")).toBe(true);
  });

  it("does not flag bare/native IDs or profile ARNs", () => {
    expect(isCrossRegionModelId("claude-sonnet-4-6")).toBe(false);
    expect(isCrossRegionModelId("gemma4:12b")).toBe(false);
    expect(isCrossRegionModelId(SONNET_ARN)).toBe(false);
    expect(isCrossRegionModelId("")).toBe(false);
  });
});

describe("ARN swap fires when modelProfileMap is configured (#386)", () => {
  it("default chat path: provider default model (sonnet) -> ARN in request body", async () => {
    // Mirrors server.ts / analysis.ts construction: model = config.model
    // (DEFAULT_BEDROCK_MODEL = the sonnet map key), no per-call override.
    const body = await chatBody({
      baseUrl: BASE,
      apiKey: "gateway-secret-key",
      model: SONNET_ID,
      providerKey: "bedrock-gateway",
      modelProfileMap: FULL_PROFILE_MAP,
    });
    expect(body.model).toBe(SONNET_ARN);
    expect(body.model).not.toBe(SONNET_ID);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("analysis/agent path: per-call model from the model-router (sonnet) -> ARN", async () => {
    // Mirrors agent-loop / orchestrator passing opts.model = SONNET_MODEL_ID.
    const body = await chatBody(
      {
        baseUrl: BASE,
        apiKey: "gateway-secret-key",
        model: SONNET_ID,
        providerKey: "bedrock-gateway",
        modelProfileMap: FULL_PROFILE_MAP,
      },
      { model: SONNET_ID },
    );
    expect(body.model).toBe(SONNET_ARN);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("analysis/agent path: per-call model from the model-router (haiku) -> ARN", async () => {
    // The Haiku map key is the FULL string `us.anthropic.claude-haiku-4-5-20251001-v1:0`.
    const body = await chatBody(
      {
        baseUrl: BASE,
        apiKey: "gateway-secret-key",
        model: SONNET_ID,
        providerKey: "bedrock-gateway",
        modelProfileMap: FULL_PROFILE_MAP,
      },
      { model: HAIKU_ID },
    );
    expect(body.model).toBe(HAIKU_ARN);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("docs-gen path: per-phase pinned model (sonnet) -> ARN in request body", async () => {
    // Mirrors holistic-synthesizer constructing a provider with model =
    // tuning.phase2Model (defaults to the sonnet map key) + config.modelProfileMap.
    const body = await chatBody({
      baseUrl: BASE,
      apiKey: "gateway-secret-key",
      model: SONNET_ID,
      providerKey: "bedrock-gateway",
      defaultMaxTokens: 8192,
      modelProfileMap: FULL_PROFILE_MAP,
    });
    expect(body.model).toBe(SONNET_ARN);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("never logs the API key on any path during a successful swap", async () => {
    // The resolved ARN legitimately appears in the existing debug log of the
    // model being invoked (an ARN is an identifier, not a credential). The
    // OWASP guard is that the API key / Authorization secret is NEVER logged.
    await chatBody({
      baseUrl: BASE,
      apiKey: "gateway-secret-key",
      model: SONNET_ID,
      providerKey: "bedrock-gateway",
      modelProfileMap: FULL_PROFILE_MAP,
    });
    const allLogs = JSON.stringify([
      ...logMock.debug.mock.calls,
      ...logMock.info.mock.calls,
      ...logMock.warn.mock.calls,
      ...logMock.error.mock.calls,
    ]);
    expect(allLogs).not.toContain("gateway-secret-key");
    expect(allLogs).not.toContain("Bearer");
  });
});

describe("warn-log on unmapped cross-region ID with a configured profile map (#386)", () => {
  it("warns when a us.-prefixed ID has no matching key but a map IS configured", async () => {
    // Map has only the sonnet key; a haiku ID (or any unmapped us. id) arrives.
    const body = await chatBody(
      {
        baseUrl: BASE,
        apiKey: "gateway-secret-key",
        model: SONNET_ID,
        providerKey: "bedrock-gateway",
        modelProfileMap: { [SONNET_ID]: SONNET_ARN },
      },
      { model: HAIKU_ID },
    );
    // Request still proceeds with the RAW id (no throw, no swap).
    expect(body.model).toBe(HAIKU_ID);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    const [msg, meta] = logMock.warn.mock.calls[0] as [string, Record<string, unknown>];
    expect(msg).toMatch(/bypass/i);
    expect(meta).toMatchObject({
      provider: "bedrock-gateway",
      model: HAIKU_ID,
      profileMapConfigured: true,
    });
  });

  it("the warn payload leaks neither the API key, Authorization header, nor the ARN", async () => {
    await chatBody(
      {
        baseUrl: BASE,
        apiKey: "gateway-secret-key",
        model: SONNET_ID,
        providerKey: "bedrock-gateway",
        modelProfileMap: { [SONNET_ID]: SONNET_ARN },
      },
      { model: HAIKU_ID },
    );
    const serialized = JSON.stringify(logMock.warn.mock.calls);
    expect(serialized).not.toContain("gateway-secret-key");
    expect(serialized).not.toContain("Bearer");
    expect(serialized).not.toContain("Authorization");
    expect(serialized).not.toContain(SONNET_ARN);
  });

  it("also warns for a global.-prefixed unmapped ID", async () => {
    await chatBody(
      {
        baseUrl: BASE,
        apiKey: "k",
        model: SONNET_ID,
        providerKey: "bedrock-gateway",
        modelProfileMap: { [SONNET_ID]: SONNET_ARN },
      },
      { model: "global.anthropic.claude-haiku-4-5" },
    );
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it("does NOT warn for an unmapped BARE/native ID even with a map configured", async () => {
    // A native id (no us./global. prefix) is normal operation, not a bypass.
    const body = await chatBody(
      {
        baseUrl: BASE,
        apiKey: "k",
        model: SONNET_ID,
        providerKey: "bedrock-gateway",
        modelProfileMap: { [SONNET_ID]: SONNET_ARN },
      },
      { model: "claude-sonnet-4-6" },
    );
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("warns once per request via the stream() path too", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
            controller.close();
          },
        }),
        { status: 200, headers: { "Content-Type": "text/event-stream" } },
      ),
    );
    const p = new OpenAICompatibleProvider({
      baseUrl: BASE,
      apiKey: "k",
      model: SONNET_ID,
      providerKey: "bedrock-gateway",
      modelProfileMap: { [SONNET_ID]: SONNET_ARN },
    });
    for await (const _c of p.stream([{ role: "user", content: "hi" }], { model: HAIKU_ID })) {
      // drain
    }
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });
});

describe("no profile map configured: passthrough, no warn (#386)", () => {
  it("passes a us.-prefixed ID through unchanged and emits NO warn", async () => {
    const body = await chatBody(
      {
        baseUrl: BASE,
        apiKey: "gateway-secret-key",
        model: SONNET_ID,
        providerKey: "bedrock-gateway",
        // modelProfileMap intentionally omitted (defaults to {} inside the provider)
      },
      { model: SONNET_ID },
    );
    expect(body.model).toBe(SONNET_ID);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("treats an explicit empty map the same as no map (passthrough, no warn)", async () => {
    const body = await chatBody({
      baseUrl: BASE,
      apiKey: "k",
      model: HAIKU_ID,
      providerKey: "bedrock-gateway",
      modelProfileMap: {},
    });
    expect(body.model).toBe(HAIKU_ID);
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it("BedrockDirectProvider alias resolves the same class (back-compat)", () => {
    expect(BedrockDirectProvider).toBe(OpenAICompatibleProvider);
  });
});
