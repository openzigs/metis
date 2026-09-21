/**
 * Unit tests for the lifecycle hook bus.
 */
import { afterEach, describe, expect, it } from "vitest";
import { HookBus } from "../src/lib/hooks/bus.js";

describe("HookBus", () => {
  let _captured: string[] = [];
  afterEach(() => {
    _captured = [];
  });

  it("fires handlers in registration order", async () => {
    const bus = new HookBus();
    const order: number[] = [];
    bus.on("preToolUse", () => {
      order.push(1);
    });
    bus.on("preToolUse", () => {
      order.push(2);
    });
    bus.on("preToolUse", () => {
      order.push(3);
    });
    await bus.emit("preToolUse", {
      sessionId: "s1",
      projectId: null,
      toolName: "x",
      args: {},
    });
    expect(order).toEqual([1, 2, 3]);
  });

  it("threads payload through handlers when they return a new value", async () => {
    const bus = new HookBus();
    bus.on("preToolUse", (p) => ({ ...p, args: { ...p.args, a: 1 } }));
    bus.on("preToolUse", (p) => ({ ...p, args: { ...p.args, b: 2 } }));
    const result = await bus.emit("preToolUse", {
      sessionId: "s1",
      projectId: null,
      toolName: "x",
      args: {},
    });
    expect(result.args).toEqual({ a: 1, b: 2 });
  });

  it("isolates handlers by event", async () => {
    const bus = new HookBus();
    let pre = 0;
    let post = 0;
    bus.on("preToolUse", () => {
      pre++;
    });
    bus.on("postToolUse", () => {
      post++;
    });
    await bus.emit("preToolUse", { sessionId: "s", projectId: null, toolName: "x", args: {} });
    expect(pre).toBe(1);
    expect(post).toBe(0);
  });

  it("isolates handlers by project + session scope", async () => {
    const bus = new HookBus();
    let p1 = 0;
    let p2 = 0;
    bus.on(
      "preToolUse",
      () => {
        p1++;
      },
      { projectId: "p1" },
    );
    bus.on(
      "preToolUse",
      () => {
        p2++;
      },
      { projectId: "p2" },
    );
    await bus.emit("preToolUse", { sessionId: "s", projectId: "p1", toolName: "x", args: {} });
    expect(p1).toBe(1);
    expect(p2).toBe(0);
  });

  it("clears session-scoped handlers", async () => {
    const bus = new HookBus();
    let count = 0;
    bus.on(
      "preToolUse",
      () => {
        count++;
      },
      { sessionId: "s1" },
    );
    bus.clearSession("s1");
    await bus.emit("preToolUse", { sessionId: "s1", projectId: null, toolName: "x", args: {} });
    expect(count).toBe(0);
  });

  it("does not abort the chain when a handler throws", async () => {
    const errors: Array<{ event: string; name?: string }> = [];
    const bus = new HookBus({
      onError: (event, name) => errors.push({ event, name }),
    });
    let after = 0;
    bus.on(
      "preToolUse",
      () => {
        throw new Error("boom");
      },
      {},
      "thrower",
    );
    bus.on("preToolUse", () => {
      after++;
    });
    await bus.emit("preToolUse", { sessionId: "s", projectId: null, toolName: "x", args: {} });
    expect(after).toBe(1);
    expect(errors).toEqual([{ event: "preToolUse", name: "thrower" }]);
  });

  it("off() unregisters a single handler", async () => {
    const bus = new HookBus();
    let count = 0;
    const unsub = bus.on("preToolUse", () => {
      count++;
    });
    unsub();
    await bus.emit("preToolUse", { sessionId: "s", projectId: null, toolName: "x", args: {} });
    expect(count).toBe(0);
  });

  it("supports async handlers", async () => {
    const bus = new HookBus();
    const order: number[] = [];
    bus.on("postToolUse", async (p) => {
      await new Promise((r) => setTimeout(r, 5));
      order.push(1);
      return { ...p, durationMs: p.durationMs + 1 };
    });
    bus.on("postToolUse", (p) => {
      order.push(p.durationMs);
    });
    await bus.emit("postToolUse", {
      sessionId: "s",
      projectId: null,
      toolName: "x",
      args: {},
      result: null,
      durationMs: 10,
    });
    expect(order).toEqual([1, 11]);
  });

  it("count returns total or per-event registrations", () => {
    const bus = new HookBus();
    bus.on("preToolUse", () => {});
    bus.on("postToolUse", () => {});
    bus.on("postToolUse", () => {});
    expect(bus.count()).toBe(3);
    expect(bus.count("postToolUse")).toBe(2);
    expect(bus.count("notification")).toBe(0);
  });

  it("each of the six SDK events can fire", async () => {
    const bus = new HookBus();
    const events: string[] = [];
    for (const e of [
      "preToolUse",
      "postToolUse",
      "sessionStart",
      "sessionEnd",
      "userPromptSubmit",
      "notification",
    ] as const) {
      bus.on(e, () => {
        events.push(e);
      });
    }
    await bus.emit("preToolUse", { sessionId: "s", projectId: null, toolName: "x", args: {} });
    await bus.emit("postToolUse", {
      sessionId: "s",
      projectId: null,
      toolName: "x",
      args: {},
      result: null,
      durationMs: 0,
    });
    await bus.emit("sessionStart", {
      sessionId: "s",
      projectId: null,
      userId: "u",
      provider: "p",
      model: "m",
    });
    await bus.emit("sessionEnd", {
      sessionId: "s",
      projectId: null,
      userId: "u",
      totalTokens: 0,
      status: "active",
    });
    await bus.emit("userPromptSubmit", {
      sessionId: "s",
      projectId: null,
      userId: "u",
      prompt: "hi",
    });
    await bus.emit("notification", {
      sessionId: "s",
      projectId: null,
      level: "info",
      message: "x",
    });
    expect(events).toEqual([
      "preToolUse",
      "postToolUse",
      "sessionStart",
      "sessionEnd",
      "userPromptSubmit",
      "notification",
    ]);
    _captured = events;
  });
});
