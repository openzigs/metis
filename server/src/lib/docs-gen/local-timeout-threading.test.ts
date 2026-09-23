/**
 * #111 — the `LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS` knob reaches the provider at
 * EVERY local-gemma construction site the issue names: the provider factory,
 * docs-gen's single-provider bundle, and docs-gen's hybrid local bundle. A site
 * that hardcoded its own `firstByteTimeoutMs` would silently shadow the knob, so
 * each is asserted by behaviour — when the stream actually times out — not by
 * reading a private field.
 *
 * `globalThis.fetch` is stubbed with a fetch that never answers, and the clock is
 * faked: no network, no Ollama host.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadAIConfig } from "../ai/config.js";
import { buildProvider } from "../ai/providers/factory.js";
import type { AIProvider } from "../ai/types.js";
import { buildDocsGenProvider, resolvePhase2Router } from "./holistic-synthesizer.js";

const ENV_KEYS = [
  "AI_PROVIDER",
  "AI_MODEL",
  "AI_OFFLINE",
  "LOCAL_GEMMA_BASE_URL",
  "LOCAL_GEMMA_MODEL",
  "LOCAL_GEMMA_API_KEY",
  "LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS",
  "DOCS_GEN_HYBRID_ROUTING",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_MODEL",
  "BEDROCK_GATEWAY_URL",
  "BEDROCK_GATEWAY_API_KEY",
] as const;
const saved: Record<string, string | undefined> = {};
const originalFetch = globalThis.fetch;

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  process.env.AI_PROVIDER = "local-gemma";
  process.env.LOCAL_GEMMA_BASE_URL = "http://127.0.0.1:11434/v1";
  process.env.LOCAL_GEMMA_MODEL = "laguna-s-2.1";
  process.env.LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS = "900000";
  vi.useFakeTimers();
  globalThis.fetch = vi.fn(
    (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const e = new Error("aborted");
          e.name = "AbortError";
          reject(e);
        });
      }),
  ) as unknown as typeof fetch;
});

afterEach(() => {
  vi.useRealTimers();
  globalThis.fetch = originalFetch;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

/** Fake-time ms at which `provider.stream()` rejected, stepping 60s at a time. */
async function firstTokenTimeoutAt(provider: AIProvider): Promise<number | null> {
  let settled = false;
  void (async () => {
    for await (const _c of provider.stream([{ role: "user", content: "hi" }])) {
      /* drain */
    }
  })()
    .catch(() => undefined)
    .finally(() => {
      settled = true;
    });
  for (let t = 60_000; t <= 1_200_000; t += 60_000) {
    await vi.advanceTimersByTimeAsync(60_000);
    if (settled) return t;
  }
  return null;
}

describe("LOCAL_GEMMA_FIRST_BYTE_TIMEOUT_MS reaches every local-gemma construction site", () => {
  it("the provider factory (buildProvider)", async () => {
    const provider = buildProvider({ config: loadAIConfig({ ...process.env }) });
    expect(provider.key).toBe("local-gemma");
    expect(await firstTokenTimeoutAt(provider)).toBe(900_000);
  });

  it("docs-gen's single-provider local bundle (buildDocsGenProvider)", async () => {
    const { provider } = buildDocsGenProvider(2, 8192);
    expect(provider.key).toBe("local-gemma");
    expect(await firstTokenTimeoutAt(provider)).toBe(900_000);
  });

  it("docs-gen's hybrid local bundle (resolvePhase2Router)", async () => {
    process.env.DOCS_GEN_HYBRID_ROUTING = "1";
    process.env.ANTHROPIC_API_KEY = "sk-test-key";
    process.env.ANTHROPIC_MODEL = "claude-sonnet-4-6";
    const router = resolvePhase2Router(8192);
    expect(router.hybrid).not.toBeNull();
    const local = router.hybrid!.local.provider;
    expect(local.key).toBe("local-gemma");
    expect(await firstTokenTimeoutAt(local)).toBe(900_000);
  });
});
