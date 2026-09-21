/**
 * Unit tests for the Bedrock Guardrails SafetyHook (Epic #164).
 *
 * The AWS SDK is loaded lazily and overridden via
 * `__setBedrockSdkLoaderForTests` so we never reach the network.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BedrockGuardrailSafetyHook,
  __setBedrockSdkLoaderForTests,
} from "../src/lib/safety/bedrock-guardrails.js";

function makeClient(response: Record<string, unknown>) {
  return {
    send: vi.fn(async () => response),
  };
}

function installSdk(client: { send: ReturnType<typeof vi.fn> }): void {
  __setBedrockSdkLoaderForTests(
    async () => client,
    async (input: Record<string, unknown>) => ({ input }),
  );
}

const ctx = {
  projectId: "p1",
  sessionId: "s1",
  mode: "standard" as const,
};

beforeEach(() => {
  process.env.BEDROCK_GUARDRAIL_ID = "gr-test-id";
  process.env.BEDROCK_GUARDRAIL_VERSION = "1";
});

afterEach(() => {
  delete process.env.BEDROCK_GUARDRAIL_ID;
  delete process.env.BEDROCK_GUARDRAIL_VERSION;
  __setBedrockSdkLoaderForTests(null, null);
});

describe("BedrockGuardrailSafetyHook", () => {
  it("returns allowed when guardrail action is NONE", async () => {
    const client = makeClient({ action: "NONE" });
    installSdk(client);
    const hook = new BedrockGuardrailSafetyHook();
    const r = await hook.applyInput("hello world", ctx);
    expect(r.allowed).toBe(true);
    expect(client.send).toHaveBeenCalledOnce();
  });

  it("blocks when GUARDRAIL_INTERVENED with assessment.action=BLOCKED", async () => {
    const client = makeClient({
      action: "GUARDRAIL_INTERVENED",
      assessments: [{ contentPolicy: [{ action: "BLOCKED", type: "HATE" }] }],
    });
    installSdk(client);
    const hook = new BedrockGuardrailSafetyHook();
    const r = await hook.applyInput("naughty content", ctx);
    expect(r.allowed).toBe(false);
    expect(r.findings.length).toBeGreaterThan(0);
  });

  it("returns redacted text when guardrail rewrote the output", async () => {
    const client = makeClient({
      action: "GUARDRAIL_INTERVENED",
      outputs: [{ text: "I cannot help with that." }],
      assessments: [{ contentPolicy: [{ action: "ANONYMIZED" }] }],
    });
    installSdk(client);
    const hook = new BedrockGuardrailSafetyHook();
    const r = await hook.applyInput("private text", ctx);
    expect(r.allowed).toBe(true);
    expect(r.redacted).toBe("I cannot help with that.");
  });

  it("short-circuits when BEDROCK_GUARDRAIL_ID is unset", async () => {
    delete process.env.BEDROCK_GUARDRAIL_ID;
    const hook = new BedrockGuardrailSafetyHook();
    const r = await hook.applyInput("hello", ctx);
    expect(r.allowed).toBe(true);
    expect(r.findings).toHaveLength(0);
  });

  it("returns allowed (fail-open) when the SDK throws", async () => {
    const client = {
      send: vi.fn(async () => {
        throw new Error("boom");
      }),
    };
    installSdk(client);
    const hook = new BedrockGuardrailSafetyHook();
    const r = await hook.applyInput("hello", ctx);
    expect(r.allowed).toBe(true);
  });

  it("respects mode=off and skips the SDK entirely", async () => {
    const client = makeClient({ action: "GUARDRAIL_INTERVENED" });
    installSdk(client);
    const hook = new BedrockGuardrailSafetyHook();
    const r = await hook.applyInput("hello", { ...ctx, mode: "off" });
    expect(r.allowed).toBe(true);
    expect(client.send).not.toHaveBeenCalled();
  });

  it("uses the lazily-loaded SDK loader override", async () => {
    const client = makeClient({ action: "NONE" });
    __setBedrockSdkLoaderForTests(
      async () => client,
      async (input: Record<string, unknown>) => ({ input }),
    );
    const hook = new BedrockGuardrailSafetyHook();
    const r = await hook.applyInput("hi", ctx);
    expect(r.allowed).toBe(true);
    expect(client.send).toHaveBeenCalled();
  });
});
