/**
 * Tests for the approval policy + audit gate.
 *
 * Mocks Prisma so we can assert audit rows without a real database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const created: Array<Record<string, unknown>> = [];
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    aIToolApproval: {
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        created.push(data);
        return data;
      }),
    },
  },
}));

import {
  ApprovalGateService,
  hashArgs,
  normalizePolicy,
  parsePolicyJson,
  policyToJson,
  isValidPolicy,
  isValidRisk,
} from "../src/lib/ai/approval-policy.js";

beforeEach(() => {
  created.length = 0;
});

describe("policy parsing", () => {
  it("returns defaults for null/empty", () => {
    expect(normalizePolicy(null)).toEqual({
      low: "auto",
      medium: "prompt-once",
      high: "always-prompt",
    });
  });

  it("partial input keeps the rest at defaults", () => {
    expect(normalizePolicy({ high: "auto" })).toEqual({
      low: "auto",
      medium: "prompt-once",
      high: "auto",
    });
  });

  it("ignores invalid policy values", () => {
    expect(normalizePolicy({ low: "yolo" })).toEqual({
      low: "auto",
      medium: "prompt-once",
      high: "always-prompt",
    });
  });

  it("parsePolicyJson tolerates malformed JSON", () => {
    expect(parsePolicyJson("not json")).toEqual({
      low: "auto",
      medium: "prompt-once",
      high: "always-prompt",
    });
    expect(parsePolicyJson(null)).toEqual({
      low: "auto",
      medium: "prompt-once",
      high: "always-prompt",
    });
  });

  it("policyToJson roundtrips", () => {
    const json = policyToJson({ low: "auto", medium: "auto", high: "deny" });
    expect(parsePolicyJson(json)).toEqual({ low: "auto", medium: "auto", high: "deny" });
  });

  it("isValidPolicy / isValidRisk type guards", () => {
    expect(isValidPolicy("auto")).toBe(true);
    expect(isValidPolicy("nope")).toBe(false);
    expect(isValidRisk("low")).toBe(true);
    expect(isValidRisk("extreme")).toBe(false);
  });
});

describe("ApprovalGateService", () => {
  it("auto-approves auto-policy tools and writes audit", async () => {
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "auto", medium: "deny", high: "always-prompt" },
    });
    const ok = await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "ls",
      risk: "low",
      args: { path: "/" },
    });
    expect(ok).toBe(true);
    expect(created).toHaveLength(1);
    expect(created[0]?.decision).toBe("auto-approve");
  });

  it("denies on policy=deny without prompting", async () => {
    const prompter = { ask: vi.fn(async () => true) };
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "deny", medium: "deny", high: "deny" },
      prompter,
    });
    const ok = await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "rm",
      risk: "high",
      args: {},
    });
    expect(ok).toBe(false);
    expect(prompter.ask).not.toHaveBeenCalled();
    expect(created[0]?.decision).toBe("deny");
  });

  it("prompt-once caches an approval per tool name", async () => {
    const prompter = { ask: vi.fn(async () => true) };
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "prompt-once", medium: "prompt-once", high: "always-prompt" },
      prompter,
    });
    const a = await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "pkg.install",
      risk: "medium",
      args: { name: "x" },
    });
    const b = await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "pkg.install",
      risk: "medium",
      args: { name: "y" },
    });
    expect(a && b).toBe(true);
    expect(prompter.ask).toHaveBeenCalledTimes(1);
    expect(created.map((r) => r.decision)).toEqual(["approve", "auto-approve"]);
  });

  it("always-prompt re-prompts every invocation", async () => {
    const prompter = { ask: vi.fn(async () => true) };
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "auto", medium: "auto", high: "always-prompt" },
      prompter,
    });
    await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "shell",
      risk: "high",
      args: { cmd: "ls" },
    });
    await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "shell",
      risk: "high",
      args: { cmd: "pwd" },
    });
    expect(prompter.ask).toHaveBeenCalledTimes(2);
  });

  it("records error decision when prompter throws", async () => {
    const prompter = {
      ask: vi.fn(async () => {
        throw new Error("disconnected");
      }),
    };
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "always-prompt", medium: "always-prompt", high: "always-prompt" },
      prompter,
    });
    const ok = await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "x",
      risk: "high",
      args: {},
    });
    expect(ok).toBe(false);
    expect(created[0]?.decision).toBe("error");
  });

  it("records denied decision when user says no", async () => {
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "always-prompt", medium: "always-prompt", high: "always-prompt" },
      prompter: { ask: async () => false },
    });
    const ok = await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "x",
      risk: "high",
      args: {},
    });
    expect(ok).toBe(false);
    expect(created[0]?.decision).toBe("deny");
  });

  it("persist=false skips audit", async () => {
    const gate = new ApprovalGateService({
      sessionId: "s1",
      userId: "u1",
      policy: { low: "auto", medium: "auto", high: "auto" },
      persist: false,
    });
    await gate.decide({
      sessionId: "s1",
      userId: "u1",
      toolName: "x",
      risk: "low",
      args: {},
    });
    expect(created).toHaveLength(0);
  });
});

describe("hashArgs", () => {
  it("is stable regardless of key order", () => {
    expect(hashArgs({ a: 1, b: 2 })).toBe(hashArgs({ b: 2, a: 1 }));
  });

  it("differs for different values", () => {
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
  });

  it("falls back to String() when JSON-stringify fails", () => {
    const cyc: Record<string, unknown> = {};
    cyc.self = cyc;
    expect(typeof hashArgs(cyc)).toBe("string");
  });
});
