/**
 * Epic #108 — OPTIONAL live smoke test against a running Ollama server.
 *
 * This is skipped by default so CI stays deterministic and never depends on a
 * live Ollama. To run it locally:
 *
 *   ollama pull gemma4:12b
 *   LOCAL_GEMMA_LIVE=1 \
 *   LOCAL_GEMMA_BASE_URL=http://localhost:11434/v1 \
 *   LOCAL_GEMMA_MODEL=gemma4:12b \
 *     npx vitest run tests/lib/ai/local-gemma-live.test.ts
 *
 * It exercises the real `OpenAICompatibleProvider` end-to-end: a `/v1/models`
 * ping plus an SSE-streamed chat completion through the local Gemma model.
 */
import { describe, expect, it } from "vitest";
import { OpenAICompatibleProvider } from "../../../src/lib/ai/providers/openai-compatible-provider.js";

const LIVE = process.env.LOCAL_GEMMA_LIVE === "1";
const BASE = process.env.LOCAL_GEMMA_BASE_URL ?? "http://localhost:11434/v1";
const MODEL = process.env.LOCAL_GEMMA_MODEL ?? "gemma4:12b";
const API_KEY = process.env.LOCAL_GEMMA_API_KEY ?? "ollama";

describe.skipIf(!LIVE)("local-gemma live smoke (#108, LOCAL_GEMMA_LIVE=1)", () => {
  const provider = new OpenAICompatibleProvider({
    baseUrl: BASE,
    apiKey: API_KEY,
    model: MODEL,
    providerKey: "local-gemma",
  });

  it("pings the /v1/models endpoint", async () => {
    expect(await provider.ping()).toBe(true);
  }, 30_000);

  it("streams a chat completion from the local Gemma model", async () => {
    let text = "";
    let done = false;
    for await (const chunk of provider.stream([
      { role: "user", content: "Say hello in 5 words." },
    ])) {
      if (chunk.type === "delta") text += chunk.content;
      if (chunk.type === "done") done = true;
    }
    expect(done).toBe(true);
    expect(text.trim().length).toBeGreaterThan(0);
  }, 120_000);
});
