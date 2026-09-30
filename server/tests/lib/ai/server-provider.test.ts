/**
 * #558 — `buildServerProvider` is the server's one provider construction, and
 * the e2e fixture builder shares it. It must honour the environment it is
 * GIVEN (not `process.env`), including the record/replay flags, on both of its
 * construction paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServerProvider } from "../../../src/lib/ai/server-provider.js";
import { OfflineStubProvider } from "../../../src/lib/ai/providers/offline-stub-provider.js";
import { BedrockDirectProvider } from "../../../src/lib/ai/providers/bedrock-direct-provider.js";
import { ReplayProvider } from "../../../src/lib/ai/fixtures/replay-provider.js";

const LOCAL = {
  AI_PROVIDER: "local-gemma",
  LOCAL_GEMMA_BASE_URL: "http://127.0.0.1:11434/v1",
  LOCAL_GEMMA_MODEL: "gemma-558",
};
const OPENAI = {
  AI_PROVIDER: "openai",
  OPENAI_BASE_URL: "https://api.openai.com/v1",
  OPENAI_API_KEY: "sk-test-558",
  AI_MODEL: "gpt-558",
};

beforeEach(() => {
  // The flags must come from the env argument; keep the process's out of it.
  vi.stubEnv("AI_REPLAY", undefined);
  vi.stubEnv("AI_RECORD", undefined);
  vi.stubEnv("AI_FIXTURE_DIR", "/tmp/metis-558-fixtures");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("buildServerProvider (#558)", () => {
  it("builds the offline stub for AI_PROVIDER=offline-stub", () => {
    const p = buildServerProvider({ AI_PROVIDER: "offline-stub" });
    expect(p).toBeInstanceOf(OfflineStubProvider);
  });

  it("builds the configured provider for openai", () => {
    const p = buildServerProvider(OPENAI);
    expect(p.key).toBe("openai");
    expect(p.model).toBe("gpt-558");
  });

  it("builds the Bedrock-direct client for local-gemma", () => {
    const p = buildServerProvider(LOCAL);
    expect(p).toBeInstanceOf(BedrockDirectProvider);
    expect(p.key).toBe("local-gemma");
    expect(p.model).toBe("gemma-558");
  });

  it.each([
    ["the factory path", OPENAI, "openai", "gpt-558"],
    ["the Bedrock-direct path", LOCAL, "local-gemma", "gemma-558"],
  ])("replays when the GIVEN env says so, on %s", (_label, env, key, model) => {
    const p = buildServerProvider({ ...env, AI_REPLAY: "1" });
    expect(p).toBeInstanceOf(ReplayProvider);
    // Replay keeps the wrapped provider's identity, so tier resolution agrees.
    expect(p.key).toBe(key);
    expect(p.model).toBe(model);
  });

  it("does not replay when only the process env says so", () => {
    vi.stubEnv("AI_REPLAY", "1");
    expect(buildServerProvider({ ...OPENAI, AI_REPLAY: "0" })).not.toBeInstanceOf(ReplayProvider);
    expect(buildServerProvider({ ...LOCAL, AI_REPLAY: "0" })).not.toBeInstanceOf(ReplayProvider);
  });
});
