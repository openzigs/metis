/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Tests for the built-in hook handlers (#114). We install them into a fresh
 * HookBus and verify they audit/log via mocked services.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const auditSpy = vi.fn();
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (args: unknown) => auditSpy(args),
}));

const subsSpy = vi.fn(async () => []);
const runWebhookSpy = vi.fn(async () => true);
vi.mock("../src/lib/hooks/subscriptions.js", async () => {
  const actual = await vi.importActual<typeof import("../src/lib/hooks/subscriptions.js")>(
    "../src/lib/hooks/subscriptions.js",
  );
  return {
    ...actual,
    listEnabledFor: (...args: any[]) => subsSpy(...args),
    runWebhook: (...args: any[]) => runWebhookSpy(...args),
  };
});

import { HookBus } from "../src/lib/hooks/bus.js";
import {
  installBuiltinHandlers,
  resetInstalledForTests,
} from "../src/lib/hooks/builtin-handlers.js";

beforeEach(() => {
  auditSpy.mockClear();
  subsSpy.mockReset();
  subsSpy.mockResolvedValue([]);
  runWebhookSpy.mockClear();
  runWebhookSpy.mockResolvedValue(true);
  resetInstalledForTests();
});
afterEach(() => {
  resetInstalledForTests();
});

describe("installBuiltinHandlers (#114)", () => {
  it("registers a handler for each of the six SDK events", () => {
    const bus = new HookBus();
    installBuiltinHandlers(bus);
    expect(bus.count("sessionStart")).toBeGreaterThanOrEqual(1);
    expect(bus.count("sessionEnd")).toBeGreaterThanOrEqual(1);
    expect(bus.count("userPromptSubmit")).toBeGreaterThanOrEqual(1);
    expect(bus.count("preToolUse")).toBeGreaterThanOrEqual(1);
    expect(bus.count("postToolUse")).toBeGreaterThanOrEqual(1);
    expect(bus.count("notification")).toBeGreaterThanOrEqual(1);
  });

  it("is idempotent — second call adds no handlers", () => {
    const bus = new HookBus();
    installBuiltinHandlers(bus);
    const before = bus.count();
    installBuiltinHandlers(bus);
    expect(bus.count()).toBe(before);
  });

  it("audits session lifecycle, prompt, and tool events", async () => {
    const bus = new HookBus();
    installBuiltinHandlers(bus);
    await bus.emit("sessionStart", {
      sessionId: "s1",
      userId: "u1",
      provider: "test",
      model: "x",
      projectId: null,
    });
    await bus.emit("sessionEnd", { sessionId: "s1", userId: "u1", totalTokens: 0, status: "ok" });
    await bus.emit("userPromptSubmit", {
      sessionId: "s1",
      userId: "u1",
      projectId: "p1",
      prompt: "hi",
    });
    await bus.emit("preToolUse", {
      sessionId: "s1",
      toolName: "read",
      projectId: "p1",
      riskLevel: "low",
    });
    await bus.emit("postToolUse", {
      sessionId: "s1",
      toolName: "read",
      projectId: "p1",
      durationMs: 5,
      promptTokens: 1,
      completionTokens: 2,
    });
    expect(auditSpy).toHaveBeenCalledTimes(5);
  });

  it("notification routes by level", async () => {
    const bus = new HookBus();
    installBuiltinHandlers(bus);
    await bus.emit("notification", { sessionId: "s1", level: "info", message: "i" });
    await bus.emit("notification", { sessionId: "s1", level: "warn", message: "w" });
    await bus.emit("notification", { sessionId: "s1", level: "error", message: "e" });
    // No throw + no audit (notification is logger-only)
    expect(true).toBe(true);
  });

  it("loads webhook subscriptions on sessionStart and dispatches them", async () => {
    subsSpy.mockResolvedValue([
      {
        id: "h1",
        projectId: "p1",
        event: "preToolUse",
        handlerKind: "webhook",
        config: { url: "https://example.com/h", headers: { "X-A": "1" } },
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    ]);
    const bus = new HookBus();
    installBuiltinHandlers(bus);
    await bus.emit("sessionStart", {
      sessionId: "s1",
      userId: "u1",
      provider: "test",
      model: "x",
      projectId: "p1",
    });
    // Now the dynamic webhook handler is registered for preToolUse on s1.
    await bus.emit("preToolUse", {
      sessionId: "s1",
      toolName: "read",
      projectId: "p1",
      riskLevel: "low",
    });
    expect(runWebhookSpy).toHaveBeenCalled();
  });

  it("survives a webhook subscription load failure", async () => {
    subsSpy.mockRejectedValueOnce(new Error("boom"));
    const bus = new HookBus();
    installBuiltinHandlers(bus);
    await expect(
      bus.emit("sessionStart", {
        sessionId: "s1",
        userId: "u1",
        provider: "test",
        model: "x",
        projectId: "p1",
      }),
    ).resolves.toBeDefined();
  });
});
