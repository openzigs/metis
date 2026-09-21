/**
 * Issue #1228 (sweep) — the discovery agent's two `provider.chat()` calls.
 *
 * Neither passed a `maxTokens`, so both inherited the provider's 4096
 * `defaultMaxTokens`. A module writeup or symbol summary cut off at that cap is
 * NOT an error: only a thrown error reaches the mechanical fallback, so a
 * truncated answer was accepted verbatim as the documentation.
 *
 * These tests assert on the OPTIONS OBJECT handed to `provider.chat`. Asserting
 * on the returned text would pass with the argument removed, because the repo's
 * stub providers have no output cap of their own (#1224).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ChatOptions } from "../../src/lib/ai/types.js";

const { chatSpy, providerState } = vi.hoisted(() => ({
  chatSpy: vi.fn(),
  providerState: { model: "us.anthropic.claude-sonnet-4-6-v1:0" as string | undefined },
}));

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    codeSymbol: { findMany: vi.fn() },
    codeEdge: { findMany: vi.fn(async () => []) },
    finding: { findMany: vi.fn(async () => []) },
  },
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => "function hello(name) {\n  return name;\n}\n"),
}));

vi.mock("../../src/lib/ai/index.js", () => ({
  loadAIConfig: vi.fn(() => ({})),
  buildProvider: vi.fn(() => ({
    key: "bedrock",
    model: providerState.model,
    offline: false,
    chat: chatSpy,
  })),
}));

import { prisma } from "../../src/lib/prisma.js";
import {
  runDiscoveryAgent,
  synthesizeBusinessRequirements,
} from "../../src/lib/docs-gen/discovery-agent.js";
import { modelOutputCeiling } from "../../src/lib/docs-gen/output-caps.js";

const mockPrisma = vi.mocked(prisma);

function symbol(overrides: Record<string, unknown> = {}) {
  return {
    id: "sym-1",
    projectId: "proj-1",
    qualifiedName: "billing.Invoice",
    kind: "class",
    filePath: "src/billing/invoice.ts",
    signature: "class Invoice",
    startLine: 1,
    endLine: 40,
    language: "typescript",
    ...overrides,
  };
}

/** Every `maxTokens` the run actually handed to the provider. */
function capsPassed(): Array<number | undefined> {
  return chatSpy.mock.calls.map((c) => (c[1] as ChatOptions | undefined)?.maxTokens);
}

beforeEach(() => {
  vi.clearAllMocks();
  providerState.model = "us.anthropic.claude-sonnet-4-6-v1:0";
  chatSpy.mockResolvedValue({ content: "## Purpose\n\nDocumentation." });
});

describe("#1228 sweep — discovery agent passes an explicit output cap", () => {
  it("caps the per-symbol summary call", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([symbol()]);

    await runDiscoveryAgent("proj-1");

    expect(chatSpy).toHaveBeenCalled();
    for (const cap of capsPassed()) {
      expect(cap).toBeTypeOf("number");
      expect(cap).toBeGreaterThan(4096);
      expect(cap).toBeLessThanOrEqual(modelOutputCeiling(providerState.model) as number);
    }
  });

  it("caps the module-synthesis call", async () => {
    mockPrisma.codeSymbol.findMany.mockResolvedValue([
      symbol({ id: "s1", qualifiedName: "billing.Invoice", kind: "class" }),
      symbol({
        id: "s2",
        qualifiedName: "billing.charge",
        kind: "function",
        startLine: 41,
        endLine: 80,
      }),
      symbol({
        id: "s3",
        qualifiedName: "billing.refund",
        kind: "function",
        startLine: 81,
        endLine: 120,
      }),
    ]);

    await synthesizeBusinessRequirements("proj-1");

    expect(chatSpy).toHaveBeenCalled();
    for (const cap of capsPassed()) {
      expect(cap).toBeTypeOf("number");
      expect(cap).toBeGreaterThan(4096);
    }
  });

  it("clamps to a small model's documented ceiling rather than over-asking", async () => {
    providerState.model = "us.anthropic.claude-3-5-haiku-20241022-v1:0";
    mockPrisma.codeSymbol.findMany.mockResolvedValue([symbol()]);

    await runDiscoveryAgent("proj-1");

    expect(chatSpy).toHaveBeenCalled();
    for (const cap of capsPassed()) expect(cap).toBe(8192);
  });
});
