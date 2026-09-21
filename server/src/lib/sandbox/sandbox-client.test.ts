/**
 * Epic #192 (A.1) — sandbox client tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxClient, SandboxClientError, isSandboxSidecarMode } from "./sandbox-client.js";

interface MockRes {
  statusCode: number;
  body: { json: () => Promise<unknown>; text: () => Promise<string> };
}

function mkRes(body: unknown, status = 200): MockRes {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    statusCode: status,
    body: {
      json: async () => (typeof body === "string" ? JSON.parse(body) : body),
      text: async () => text,
    },
  };
}

beforeEach(() => {
  process.env.COPILOT_NATIVE_TOKEN = "test-token";
  process.env.COPILOT_NATIVE_BASE_URL = "http://copilot.test:5060";
});

afterEach(() => {
  delete process.env.SANDBOX_MODE;
});

describe("isSandboxSidecarMode", () => {
  it("returns true only when SANDBOX_MODE=sidecar", () => {
    delete process.env.SANDBOX_MODE;
    expect(isSandboxSidecarMode()).toBe(false);
    process.env.SANDBOX_MODE = "off";
    expect(isSandboxSidecarMode()).toBe(false);
    process.env.SANDBOX_MODE = "sidecar";
    expect(isSandboxSidecarMode()).toBe(true);
    process.env.SANDBOX_MODE = "SIDECAR";
    expect(isSandboxSidecarMode()).toBe(true);
  });
});

describe("SandboxClient", () => {
  it("refuses to start without COPILOT_NATIVE_TOKEN", () => {
    delete process.env.COPILOT_NATIVE_TOKEN;
    expect(() => new SandboxClient()).toThrow(/COPILOT_NATIVE_TOKEN/);
  });

  it("posts to /sandbox/exec with bearer auth and parses success", async () => {
    const fetchImpl = vi.fn(async () =>
      mkRes({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        durationMs: 10,
        truncated: false,
      }),
    );
    const c = new SandboxClient({ fetchImpl: fetchImpl as never, timeoutMs: 1_000 });
    const out = await c.exec({ language: "python", code: "print(1)" });
    expect(out.stdout).toBe("ok");
    expect(out.exitCode).toBe(0);
    const callArgs = fetchImpl.mock.calls[0];
    expect(callArgs[0]).toBe("http://copilot.test:5060/sandbox/exec");
    const init = callArgs[1] as { headers: Record<string, string>; body: string };
    expect(init.headers.authorization).toBe("Bearer test-token");
    const sent = JSON.parse(init.body) as { language: string; code: string; timeoutMs: number };
    expect(sent.language).toBe("python");
    expect(sent.code).toBe("print(1)");
    expect(sent.timeoutMs).toBe(1_000);
  });

  it("forwards an explicit per-call timeoutMs", async () => {
    const fetchImpl = vi.fn(async () =>
      mkRes({ stdout: "", stderr: "", exitCode: 0, durationMs: 1, truncated: false }),
    );
    const c = new SandboxClient({ fetchImpl: fetchImpl as never });
    await c.exec({ language: "node", code: "1+1", timeoutMs: 5_000 });
    const init = fetchImpl.mock.calls[0][1] as { body: string };
    const body = JSON.parse(init.body) as { timeoutMs: number };
    expect(body.timeoutMs).toBe(5_000);
  });

  it("rejects empty code and bad language", async () => {
    const c = new SandboxClient({
      fetchImpl: (async () => mkRes({})) as never,
    });
    await expect(c.exec({ language: "python", code: "" })).rejects.toBeInstanceOf(
      SandboxClientError,
    );
    await expect(c.exec({ language: "ruby" as never, code: "puts 1" })).rejects.toBeInstanceOf(
      SandboxClientError,
    );
  });

  it("maps 503 to SANDBOX_UNAVAILABLE", async () => {
    const fetchImpl = vi.fn(async () => mkRes({ error: "no key" }, 503));
    const c = new SandboxClient({ fetchImpl: fetchImpl as never });
    await expect(c.exec({ language: "python", code: "print(1)" })).rejects.toMatchObject({
      status: 503,
      code: "SANDBOX_UNAVAILABLE",
    });
  });

  it("maps 504 to SANDBOX_TIMEOUT", async () => {
    const fetchImpl = vi.fn(async () => mkRes({ error: "timed out" }, 504));
    const c = new SandboxClient({ fetchImpl: fetchImpl as never });
    await expect(c.exec({ language: "python", code: "print(1)" })).rejects.toMatchObject({
      status: 504,
      code: "SANDBOX_TIMEOUT",
    });
  });

  it("maps 401 to UNAUTHORIZED", async () => {
    const fetchImpl = vi.fn(async () => mkRes({ error: "nope" }, 401));
    const c = new SandboxClient({ fetchImpl: fetchImpl as never });
    await expect(c.exec({ language: "python", code: "print(1)" })).rejects.toMatchObject({
      status: 401,
      code: "UNAUTHORIZED",
    });
  });

  it("translates AbortError into a 504 timeout", async () => {
    const fetchImpl = vi.fn(async () => {
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    });
    const c = new SandboxClient({ fetchImpl: fetchImpl as never, timeoutMs: 1_000 });
    await expect(c.exec({ language: "python", code: "print(1)" })).rejects.toMatchObject({
      status: 504,
      code: "SANDBOX_TIMEOUT",
    });
  });

  it("wraps generic network errors as 502", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const c = new SandboxClient({ fetchImpl: fetchImpl as never });
    await expect(c.exec({ language: "python", code: "print(1)" })).rejects.toMatchObject({
      status: 502,
      code: "SANDBOX_NETWORK",
    });
  });

  it("respects SANDBOX_TIMEOUT_MS env override", () => {
    process.env.SANDBOX_TIMEOUT_MS = "9000";
    const c = new SandboxClient({
      fetchImpl: (async () => mkRes({})) as never,
    });
    expect(c).toBeInstanceOf(SandboxClient);
    delete process.env.SANDBOX_TIMEOUT_MS;
  });
});
