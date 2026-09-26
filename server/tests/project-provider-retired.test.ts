/**
 * #149 — the Spec Kit path (`resolveProjectProvider`) with a project override
 * still naming the removed `copilot-native` provider.
 *
 * Uses the REAL provider factory (only the config loader and Prisma are
 * mocked), so this proves the refusal end to end: nothing is built, nothing
 * falls back to another provider, and the refusal reaches the route as the
 * retired-provider error rather than a "credentials unavailable" 502.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const loadAIConfig = vi.fn();
const projectFindFirst = vi.fn();

vi.mock("../src/lib/ai/config.js", async () => {
  const actual =
    await vi.importActual<typeof import("../src/lib/ai/config.js")>("../src/lib/ai/config.js");
  return { ...actual, loadAIConfig: (...args: unknown[]) => loadAIConfig(...args) };
});
vi.mock("../src/lib/prisma.js", () => ({
  prisma: { project: { findFirst: (...args: unknown[]) => projectFindFirst(...args) } },
}));

import { resolveProjectProvider } from "../src/lib/ai/project-provider.js";
import { AIConfigError, AIProviderError } from "../src/lib/ai/errors.js";
import { isRetiredProviderError } from "../src/lib/ai/retired-providers.js";

beforeEach(() => {
  loadAIConfig.mockReturnValue({
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    offline: false,
    rateLimit: { windowMs: 1000, max: 60 },
    pingTimeoutMs: 1500,
    sdkProvider: { type: "anthropic", baseUrl: "", apiKey: "sk-test" },
  });
});

describe("resolveProjectProvider — retired project override (#149)", () => {
  it("refuses by name with the retired-provider error, never a 502 or a fallback", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: "copilot-native", aiModel: null });

    const err = await resolveProjectProvider("p1").then(
      () => null,
      (e: unknown) => e,
    );

    expect(err).toBeInstanceOf(AIConfigError);
    expect(err).not.toBeInstanceOf(AIProviderError);
    expect(isRetiredProviderError(err)).toBe(true);
    expect((err as Error).message).toContain(
      `This project's AI provider override is "copilot-native"`,
    );
    expect((err as Error).message).not.toContain("Provider credentials unavailable");
  });

  it("still builds the configured provider when the override is a supported one", async () => {
    projectFindFirst.mockResolvedValue({ aiProviderId: null, aiModel: null });
    const provider = await resolveProjectProvider("p1");
    expect(provider.key).toBe("anthropic");
  });
});

describe("isRetiredProviderError", () => {
  it("is true only for a config error carrying the retired key", () => {
    expect(
      isRetiredProviderError(new AIConfigError("x", { retiredProvider: "copilot-native" })),
    ).toBe(true);
    expect(isRetiredProviderError(new AIConfigError("x"))).toBe(false);
    expect(isRetiredProviderError(new AIConfigError("x", { other: 1 }))).toBe(false);
    expect(
      isRetiredProviderError(new AIProviderError("x", 502, { retiredProvider: "copilot-native" })),
    ).toBe(false);
    expect(isRetiredProviderError(null)).toBe(false);
  });
});
