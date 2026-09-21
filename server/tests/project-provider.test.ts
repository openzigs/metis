/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Unit tests for the project-scoped provider resolver (#381).
 *
 * `resolveProjectProvider` is the shared helper that the Spec Kit command
 * dispatch uses to build the project's REAL AI provider (instead of silently
 * falling back to the offline stub). It mirrors the chat route's
 * `buildProvider({ config: loadAIConfig() })` construction plus the
 * per-project `aiProviderId` / `aiModel` override (`ai.ts:428-443`).
 *
 * Strategy: mock the three collaborators (`loadAIConfig`, `buildProvider`,
 * `prisma`) so we can assert exactly which config is handed to the factory,
 * and that construction failures become a typed `AIProviderError` (502) with
 * NO secret material in the message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const loadAIConfig = vi.fn();
const buildProvider = vi.fn();
const projectFindFirst = vi.fn();

vi.mock("../src/lib/ai/config.js", () => ({
  loadAIConfig: (...args: unknown[]) => loadAIConfig(...args),
}));
vi.mock("../src/lib/ai/providers/factory.js", () => ({
  buildProvider: (...args: unknown[]) => buildProvider(...args),
}));
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: {
      findFirst: (...args: unknown[]) => projectFindFirst(...args),
    },
  },
}));

import {
  resolveProjectProvider,
  applyProjectProviderOverride,
} from "../src/lib/ai/project-provider.js";
import { AIProviderError } from "../src/lib/ai/errors.js";

const baseConfig = () => ({
  provider: "anthropic" as const,
  model: "claude-sonnet-4-6",
  offline: false,
  rateLimit: { windowMs: 1000, max: 60 },
  pingTimeoutMs: 1500,
  // sdkProvider deliberately carries a "secret" so we can prove it never leaks
  // into the thrown error / logs.
  sdkProvider: { type: "openai" as const, baseUrl: "https://x", apiKey: "sk-SECRET-123" },
});

const fakeProvider = { key: "anthropic", chat: vi.fn(), stream: vi.fn(), ping: vi.fn() };

beforeEach(() => {
  loadAIConfig.mockReturnValue(baseConfig());
  buildProvider.mockReturnValue(fakeProvider);
  projectFindFirst.mockResolvedValue(null);
});

afterEach(() => vi.clearAllMocks());

describe("applyProjectProviderOverride", () => {
  it("returns the base config untouched when override is null", () => {
    const cfg = baseConfig();
    expect(applyProjectProviderOverride(cfg, null)).toEqual(cfg);
  });

  it("overrides the provider key when aiProviderId is set", () => {
    const out = applyProjectProviderOverride(baseConfig(), {
      aiProviderId: "openai",
      aiModel: null,
    });
    expect(out.provider).toBe("openai");
    expect(out.model).toBe("claude-sonnet-4-6");
  });

  it("overrides the model when aiModel is set", () => {
    const out = applyProjectProviderOverride(baseConfig(), {
      aiProviderId: null,
      aiModel: "gpt-4.1",
    });
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe("gpt-4.1");
  });

  it("ignores empty-string override fields (falls back to config)", () => {
    const out = applyProjectProviderOverride(baseConfig(), {
      aiProviderId: "",
      aiModel: "",
    });
    expect(out.provider).toBe("anthropic");
    expect(out.model).toBe("claude-sonnet-4-6");
  });

  it("does not mutate the input config", () => {
    const cfg = baseConfig();
    applyProjectProviderOverride(cfg, { aiProviderId: "openai", aiModel: "gpt-4.1" });
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.model).toBe("claude-sonnet-4-6");
  });
});

describe("resolveProjectProvider", () => {
  it("builds the env/config provider when the project has no override", async () => {
    const provider = await resolveProjectProvider("p1");
    expect(provider).toBe(fakeProvider);
    expect(buildProvider).toHaveBeenCalledTimes(1);
    const cfgArg = buildProvider.mock.calls[0][0].config;
    expect(cfgArg.provider).toBe("anthropic");
    expect(cfgArg.model).toBe("claude-sonnet-4-6");
  });

  it("honors the per-project provider + model override", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "openai", aiModel: "gpt-4.1" });
    await resolveProjectProvider("p1");
    const cfgArg = buildProvider.mock.calls[0][0].config;
    expect(cfgArg.provider).toBe("openai");
    expect(cfgArg.model).toBe("gpt-4.1");
  });

  it("queries only non-deleted projects", async () => {
    await resolveProjectProvider("p1");
    expect(projectFindFirst).toHaveBeenCalledWith({
      where: { id: "p1", deletedAt: null },
      select: { aiProviderId: true, aiModel: true },
    });
  });

  it("surfaces provider-construction failures as AIProviderError (502)", async () => {
    buildProvider.mockImplementation(() => {
      throw new Error("anthropic provider reached the factory without a resolved sdkProvider");
    });
    await expect(resolveProjectProvider("p1")).rejects.toBeInstanceOf(AIProviderError);
    await expect(resolveProjectProvider("p1")).rejects.toMatchObject({ status: 502 });
  });

  it("never leaks the API key in the thrown error (OWASP)", async () => {
    buildProvider.mockImplementation(() => {
      throw new Error("boom while constructing");
    });
    let caught: unknown;
    try {
      await resolveProjectProvider("p1");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(AIProviderError);
    const serialized = `${(caught as Error).message} ${JSON.stringify((caught as any).details ?? {})}`;
    expect(serialized).not.toContain("sk-SECRET-123");
  });
});
