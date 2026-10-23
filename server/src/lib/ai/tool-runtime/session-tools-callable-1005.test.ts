/**
 * #1005 — the call-time re-check chat hands its sub-agent tools. A database
 * that cannot be read must make the check REJECT: resolving `false` (as the
 * offer's `safeCallable` does, by design, with an empty list) would be
 * reported to the analyst as the agent being turned off.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentDefinitionDto } from "@metis/shared";

const state = vi.hoisted(() => ({ fail: false }));

vi.mock("../../prisma.js", () => ({
  prisma: {
    customAgentEnablement: {
      findMany: vi.fn(async () => {
        if (state.fail) throw new Error("db unreachable");
        return [];
      }),
    },
    customAgent: {
      findMany: vi.fn(async () => [
        {
          id: "own",
          projectId: "p1",
          name: "Go SQL reviewer",
          description: "",
          systemPrompt: "",
          tools: "[]",
          model: null,
          reasoningEffort: null,
          skillKeys: "[]",
          approvalPolicy: null,
          version: "1.0.0",
        },
      ]),
    },
    projectAgentAllowlist: { findMany: vi.fn(async () => []) },
    agent: { findMany: vi.fn(async () => []) },
  },
}));
vi.mock("../../audit/audit-service.js", () => ({ audit: vi.fn() }));

import { callableCheck } from "./session-tools.js";

beforeEach(() => {
  state.fail = false;
});

describe("callableCheck (#1005)", () => {
  it("answers from the project's callable agents", async () => {
    const check = callableCheck("p1");
    expect(await check("custom:own")).toBe(true);
    expect(await check("custom:other")).toBe(false);
  });

  it("REJECTS when the agents cannot be read — it never reads as 'turned off'", async () => {
    state.fail = true;
    await expect(callableCheck("p1")("custom:own")).rejects.toThrow("db unreachable");
  });

  it("an injected list is used as is, without reading the database", async () => {
    state.fail = true;
    const fixed = [{ ref: "custom:x" }] as unknown as AgentDefinitionDto[];
    expect(await callableCheck("p1", fixed)("custom:x")).toBe(true);
    expect(await callableCheck("p1", fixed)("custom:own")).toBe(false);
  });
});
