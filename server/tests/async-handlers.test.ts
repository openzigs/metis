/**
 * Epic #156 — unit tests for the built-in run handlers.
 *
 * Each handler is exercised through a stub `RunHandlerContext`. The
 * `prisma.backgroundRun.findUnique` mock returns `runGroupId: null` so
 * `maybeRunGroupSelection` short-circuits without touching the real
 * `selectGroupWinner` path (which has its own coverage).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    backgroundRun: { findUnique: vi.fn(async () => ({ runGroupId: null })) },
  },
}));

import { prisma } from "../src/lib/prisma.js";
const findUniqueMock = prisma.backgroundRun.findUnique as ReturnType<typeof vi.fn>;

import { registerBuiltinRunHandlers } from "../src/lib/async/handlers.js";
import type { AsyncRunner, RunHandler, RunHandlerContext } from "../src/lib/async/runner.js";

function makeCtx(overrides: Partial<RunHandlerContext> = {}): RunHandlerContext {
  const ctrl = new AbortController();
  return {
    runId: "run1",
    projectId: "p1",
    sessionId: null,
    kind: "chat",
    payload: {},
    signal: ctrl.signal,
    heartbeat: vi.fn(async () => {}),
    nextSteer: vi.fn(async () => []),
    emitStep: vi.fn(() => {}),
    ...overrides,
  } as RunHandlerContext;
}

describe("registerBuiltinRunHandlers (#146)", () => {
  const handlers = new Map<string, RunHandler>();
  const fakeRunner: AsyncRunner = {
    registerHandler: vi.fn((kind: string, fn: RunHandler) => {
      handlers.set(kind, fn);
    }),
  } as unknown as AsyncRunner;

  beforeEach(() => {
    handlers.clear();
    findUniqueMock.mockClear();
    findUniqueMock.mockResolvedValue({ runGroupId: null });
    registerBuiltinRunHandlers(fakeRunner);
  });

  afterEach(() => vi.clearAllMocks());

  it("registers all four built-in kinds", () => {
    expect([...handlers.keys()].sort()).toEqual(["analysis", "browse", "chat", "custom"]);
  });

  it("chat handler synthesizes prompt + steer messages and scores the result", async () => {
    const handler = handlers.get("chat")!;
    const steers = [{ id: "m1", ord: 0, role: "user", content: "extra detail" }];
    const ctx = makeCtx({
      payload: { message: "hello world" },
      nextSteer: vi.fn(async () => steers as any),
    });
    const out = await handler(ctx);
    expect(out.result).toMatchObject({ steerCount: 1 });
    expect(typeof out.score).toBe("number");
    expect(ctx.emitStep).toHaveBeenCalled();
  });

  it("analysis handler runs plan/execute/synthesize and reports score", async () => {
    const handler = handlers.get("analysis")!;
    const ctx = makeCtx({ kind: "analysis" });
    const out = await handler(ctx);
    expect(out.result.synthesis).toMatch(/analysis\(p1\)/);
    expect(typeof out.score).toBe("number");
  });

  it("browse handler returns the requested url", async () => {
    const handler = handlers.get("browse")!;
    const ctx = makeCtx({
      kind: "browse",
      payload: { url: "https://example.com" },
    });
    const out = await handler(ctx);
    expect(out.result).toEqual({ url: "https://example.com" });
  });

  it("custom handler echoes the payload", async () => {
    const handler = handlers.get("custom")!;
    const ctx = makeCtx({ kind: "custom", payload: { foo: "bar" } });
    const out = await handler(ctx);
    expect(out.result.ok).toBe(true);
    expect((out.result as any).payload).toEqual({ foo: "bar" });
  });

  it("aborts mid-run when the context signal is set", async () => {
    const handler = handlers.get("analysis")!;
    const ctrl = new AbortController();
    ctrl.abort();
    const ctx = makeCtx({ kind: "analysis", signal: ctrl.signal });
    await expect(handler(ctx)).rejects.toThrow(/ABORTED/);
  });

  it("schedules group selection only when the run belongs to a group", async () => {
    findUniqueMock.mockResolvedValueOnce({ runGroupId: "g1" });
    const handler = handlers.get("chat")!;
    await handler(makeCtx());
    expect(findUniqueMock).toHaveBeenCalled();
  });
});
