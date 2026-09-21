/**
 * Unit tests for the in-memory session registry.
 *
 * Coverage focus: TTL setting, sliding-window touch, idempotent destroy,
 * default vs override TTL, and capture of caller-supplied copilotHome paths.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionRegistry, type CopilotSession } from "../src/sessions.js";

class FakeSession implements CopilotSession {
  destroyed = false;
  disconnected = false;
  constructor(public readonly sessionId: string) {}
  async destroy(): Promise<void> {
    this.destroyed = true;
  }
}

class FakeSessionDisconnectOnly implements CopilotSession {
  disconnected = false;
  constructor(public readonly sessionId: string) {}
  async disconnect(): Promise<void> {
    this.disconnected = true;
  }
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe("SessionRegistry", () => {
  it("stores and returns sessions by id", () => {
    const reg = new SessionRegistry(60_000);
    const a = new FakeSession("a");
    reg.set(a);
    expect(reg.get("a")).toBe(a);
    expect(reg.get("missing")).toBeUndefined();
    expect(reg.size()).toBe(1);
  });

  it("auto-destroys after TTL elapses", async () => {
    const reg = new SessionRegistry(1_000);
    const a = new FakeSession("a");
    reg.set(a);
    expect(reg.size()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(reg.size()).toBe(0);
    expect(a.destroyed).toBe(true);
  });

  it("touch() resets the TTL clock", async () => {
    const reg = new SessionRegistry(1_000);
    const a = new FakeSession("a");
    reg.set(a);
    await vi.advanceTimersByTimeAsync(800);
    reg.touch("a");
    await vi.advanceTimersByTimeAsync(800);
    expect(reg.size()).toBe(1); // still alive — TTL was reset
    await vi.advanceTimersByTimeAsync(300);
    expect(reg.size()).toBe(0); // now expired
  });

  it("touch() on a missing session is a no-op", () => {
    const reg = new SessionRegistry(1_000);
    expect(() => reg.touch("nope")).not.toThrow();
  });

  it("destroy() returns false for unknown ids", async () => {
    const reg = new SessionRegistry(60_000);
    expect(await reg.destroy("missing")).toBe(false);
  });

  it("destroy() falls back to disconnect() when destroy() is absent", async () => {
    const reg = new SessionRegistry(60_000);
    const s = new FakeSessionDisconnectOnly("d");
    reg.set(s);
    expect(await reg.destroy("d")).toBe(true);
    expect(s.disconnected).toBe(true);
    expect(reg.size()).toBe(0);
  });

  it("set() replacing the same id clears the previous timer", async () => {
    const reg = new SessionRegistry(1_000);
    const first = new FakeSession("same");
    reg.set(first);
    const second = new FakeSession("same");
    reg.set(second);
    await vi.advanceTimersByTimeAsync(2_000);
    // Only one destroy should fire — the second timer's. The first session
    // never gets reaped because its timer was cancelled on replace.
    expect(first.destroyed).toBe(false);
    expect(second.destroyed).toBe(true);
    expect(reg.size()).toBe(0);
  });

  it("clear() drops everything without invoking destroy()", () => {
    const reg = new SessionRegistry(60_000);
    const a = new FakeSession("a");
    const b = new FakeSession("b");
    reg.set(a);
    reg.set(b);
    expect(reg.size()).toBe(2);
    reg.clear();
    expect(reg.size()).toBe(0);
    expect(a.destroyed).toBe(false);
    expect(b.destroyed).toBe(false);
  });

  it("default TTL falls back to 30 minutes when env is unset", () => {
    delete process.env.COPILOT_NATIVE_SESSION_TTL_MS;
    const reg = new SessionRegistry();
    expect(reg.ttl()).toBe(30 * 60 * 1000);
  });

  it("default TTL honours COPILOT_NATIVE_SESSION_TTL_MS", () => {
    vi.stubEnv("COPILOT_NATIVE_SESSION_TTL_MS", "12345");
    const reg = new SessionRegistry();
    expect(reg.ttl()).toBe(12345);
  });

  it("default TTL ignores garbage env values", () => {
    vi.stubEnv("COPILOT_NATIVE_SESSION_TTL_MS", "not-a-number");
    const reg = new SessionRegistry();
    expect(reg.ttl()).toBe(30 * 60 * 1000);
  });

  it("default TTL ignores non-positive env values", () => {
    vi.stubEnv("COPILOT_NATIVE_SESSION_TTL_MS", "-100");
    const reg = new SessionRegistry();
    expect(reg.ttl()).toBe(30 * 60 * 1000);
  });

  it("destroy swallows session.destroy() errors", async () => {
    const reg = new SessionRegistry(60_000);
    const broken: CopilotSession = {
      sessionId: "boom",
      async destroy() {
        throw new Error("nope");
      },
    };
    reg.set(broken);
    await expect(reg.destroy("boom")).resolves.toBe(true);
    expect(reg.size()).toBe(0);
  });
});
