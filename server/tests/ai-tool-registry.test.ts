/**
 * Tests for the tool registry — risk classification, schema validation,
 * approval gating, and error wrapping.
 */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  AIToolDeniedError,
  AIToolInvalidArgsError,
  ToolRegistry,
  type ApprovalGate,
  type ToolDefinition,
} from "../src/lib/ai/index.js";
import { AIError } from "../src/lib/ai/errors.js";

const ctx = { sessionId: "s1", userId: "u1" } as const;
/** #142 — the gate is required; these tests exercise everything but the gate. */
const allowGate: ApprovalGate = { decide: async () => true };

const makeTool = (overrides: Partial<ToolDefinition> = {}): ToolDefinition => ({
  name: "echo",
  description: "echo the message",
  schema: z.object({ msg: z.string() }),
  risk: "low",
  exec: async (args) => ({ text: `you said ${(args as { msg: string }).msg}` }),
  ...overrides,
});

describe("ToolRegistry", () => {
  it("requires a valid risk level", () => {
    const r = new ToolRegistry();
    expect(() => r.register(makeTool({ risk: "extreme" as never }))).toThrow(/risk classification/);
  });

  it("rejects missing schema or exec", () => {
    const r = new ToolRegistry();
    expect(() => r.register(makeTool({ schema: undefined as never }))).toThrow(/zod schema/);
    expect(() => r.register(makeTool({ exec: undefined as never, name: "noop" }))).toThrow(
      /exec function/,
    );
  });

  it("prevents duplicate registration", () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    expect(() => r.register(makeTool())).toThrow(/already registered/);
  });

  it("invokes a low-risk tool through an allowing gate", async () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    const result = await r.invoke("echo", { msg: "hi" }, ctx, allowGate);
    expect(result.text).toBe("you said hi");
  });

  it("#142 — fails closed when no gate is supplied (the old default allowed everything)", async () => {
    const exec = vi.fn(async () => ({ text: "ran" }));
    const r = new ToolRegistry();
    r.register(makeTool({ exec, risk: "high" }));
    await expect(
      (r.invoke as (...a: unknown[]) => Promise<unknown>)("echo", { msg: "x" }, ctx),
    ).rejects.toBeInstanceOf(AIToolDeniedError);
    expect(exec).not.toHaveBeenCalled();
  });

  it("rejects malformed args before exec runs", async () => {
    const exec = vi.fn();
    const r = new ToolRegistry();
    r.register(makeTool({ exec }));
    await expect(r.invoke("echo", { wrong: 1 }, ctx, allowGate)).rejects.toBeInstanceOf(
      AIToolInvalidArgsError,
    );
    expect(exec).not.toHaveBeenCalled();
  });

  it("AI_TOOL_NOT_FOUND when missing", async () => {
    const r = new ToolRegistry();
    await expect(r.invoke("missing", {}, ctx, allowGate)).rejects.toMatchObject({
      code: "AI_TOOL_NOT_FOUND",
    });
  });

  it("approval gate denies high-risk tools by default", async () => {
    const r = new ToolRegistry();
    r.register(makeTool({ name: "danger", risk: "high" }));
    const denyGate: ApprovalGate = { decide: async () => false };
    await expect(r.invoke("danger", { msg: "x" }, ctx, denyGate)).rejects.toBeInstanceOf(
      AIToolDeniedError,
    );
  });

  it("wraps non-AI errors thrown by exec into ToolResult.isError", async () => {
    const r = new ToolRegistry();
    r.register(
      makeTool({
        name: "explode",
        exec: async () => {
          throw new Error("kaboom");
        },
      }),
    );
    const out = await r.invoke("explode", { msg: "x" }, ctx, allowGate);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("kaboom");
  });

  it("preserves AIError subclasses thrown by exec", async () => {
    const r = new ToolRegistry();
    r.register(
      makeTool({
        name: "boom",
        exec: async () => {
          throw new AIError("AI_RATE_LIMITED", "calm down", 429);
        },
      }),
    );
    await expect(r.invoke("boom", { msg: "x" }, ctx, allowGate)).rejects.toMatchObject({
      code: "AI_RATE_LIMITED",
    });
  });

  it("list returns name+description+risk only", async () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    r.register(makeTool({ name: "danger", risk: "high" }));
    const list = r.list();
    expect(list).toHaveLength(2);
    expect(list[1]).toEqual({
      name: "danger",
      description: "echo the message",
      risk: "high",
    });
  });

  it("unregister removes the tool", async () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    expect(r.has("echo")).toBe(true);
    expect(r.unregister("echo")).toBe(true);
    expect(r.has("echo")).toBe(false);
  });

  // M4 — get() must NEVER expose the raw exec function. Otherwise a caller
  // can do `registry.get("dangerous").exec(args, ctx)` and skip both the
  // zod validation and the approval gate, defeating the whole point of the
  // abstraction.
  it("get() returns metadata only — never the exec function", () => {
    const r = new ToolRegistry();
    r.register(makeTool({ name: "danger", risk: "high" }));
    const descriptor = r.get("danger");
    expect(descriptor).toEqual({
      name: "danger",
      description: "echo the message",
      risk: "high",
    });
    expect((descriptor as Record<string, unknown> | undefined)?.exec).toBeUndefined();
    expect((descriptor as Record<string, unknown> | undefined)?.schema).toBeUndefined();
  });

  it("get() returns undefined for unknown tools", () => {
    const r = new ToolRegistry();
    expect(r.get("missing")).toBeUndefined();
  });

  it("invoke still works after get() — internal access is unaffected", async () => {
    const r = new ToolRegistry();
    r.register(makeTool());
    expect(r.get("echo")).toBeDefined();
    const result = await r.invoke("echo", { msg: "ping" }, ctx, allowGate);
    expect(result.text).toBe("you said ping");
  });
});
