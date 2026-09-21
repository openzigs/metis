/**
 * Epic #192 (A.1) — sandbox unit + endpoint tests.
 *
 * Stubs the sandbox factory so tests never load `@e2b/sdk` and never hit the
 * network. Covers config gating, timeout clamping, truncation, error mapping,
 * and the HTTP surface (auth, validation, success, fail-closed when the API
 * key is missing).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createApp, __resetClientCache, type CopilotClientLike } from "../src/app.js";
import {
  DEFAULT_TIMEOUT_MS,
  HARD_TIMEOUT_MS,
  MAX_OUTPUT_BYTES,
  SandboxConfigError,
  SandboxTimeoutError,
  SandboxUnavailableError,
  execInSandbox,
  isSandboxConfigured,
  setSandboxFactory,
  type SandboxLike,
} from "../src/sandbox.js";

const TOKEN = "test-secret-token-12345";

beforeEach(() => {
  process.env.COPILOT_NATIVE_TOKEN = TOKEN;
  process.env.E2B_API_KEY = "e2b_test_key";
  setSandboxFactory(null);
  __resetClientCache();
});

afterEach(() => {
  delete process.env.E2B_API_KEY;
  setSandboxFactory(null);
  __resetClientCache();
});

const stubClient: CopilotClientLike = {
  createSession: vi.fn(),
};

function makeSandbox(overrides: Partial<SandboxLike> = {}): SandboxLike {
  return {
    runCode: vi.fn(async ({ timeoutMs }) => ({
      stdout: "hello\n",
      stderr: "",
      exitCode: 0,
      durationMs: Math.min(timeoutMs, 50),
    })),
    close: vi.fn(async () => undefined),
    ...overrides,
  };
}

describe("sandbox unit", () => {
  it("isSandboxConfigured reflects E2B_API_KEY presence", () => {
    expect(isSandboxConfigured()).toBe(true);
    delete process.env.E2B_API_KEY;
    expect(isSandboxConfigured()).toBe(false);
    process.env.E2B_API_KEY = "x";
    expect(isSandboxConfigured()).toBe(true);
  });

  it("throws SandboxConfigError when API key is missing", async () => {
    delete process.env.E2B_API_KEY;
    await expect(execInSandbox({ language: "python", code: "print(1)" })).rejects.toBeInstanceOf(
      SandboxConfigError,
    );
  });

  it("throws SandboxConfigError when code is empty", async () => {
    await expect(execInSandbox({ language: "python", code: "" })).rejects.toBeInstanceOf(
      SandboxConfigError,
    );
  });

  it("invokes the factory with the api key and forwards run results", async () => {
    const factory = vi.fn(async () => makeSandbox());
    setSandboxFactory(factory);
    const out = await execInSandbox({ language: "node", code: "console.log(1)", timeoutMs: 5000 });
    expect(factory).toHaveBeenCalledWith("e2b_test_key");
    expect(out.stdout).toBe("hello\n");
    expect(out.exitCode).toBe(0);
    expect(out.truncated).toBe(false);
  });

  it("clamps timeout to the hard cap and floor", async () => {
    const captured: Array<{ timeoutMs: number }> = [];
    const sb = makeSandbox({
      runCode: vi.fn(async (input) => {
        captured.push({ timeoutMs: input.timeoutMs });
        return { stdout: "", stderr: "", exitCode: 0, durationMs: 1 };
      }),
    });
    setSandboxFactory(async () => sb);

    await execInSandbox({ language: "bash", code: "echo hi", timeoutMs: 999_999 });
    expect(captured[0]?.timeoutMs).toBe(HARD_TIMEOUT_MS);

    await execInSandbox({ language: "bash", code: "echo hi", timeoutMs: 10 });
    expect(captured[1]?.timeoutMs).toBe(1_000);

    await execInSandbox({ language: "bash", code: "echo hi" });
    expect(captured[2]?.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
  });

  it("truncates oversized stdout/stderr and flags truncation", async () => {
    const huge = "x".repeat(MAX_OUTPUT_BYTES + 100);
    setSandboxFactory(async () =>
      makeSandbox({
        runCode: vi.fn(async () => ({
          stdout: huge,
          stderr: huge,
          exitCode: 0,
          durationMs: 1,
        })),
      }),
    );
    const out = await execInSandbox({ language: "python", code: "print('x')" });
    expect(out.truncated).toBe(true);
    expect(Buffer.byteLength(out.stdout, "utf8")).toBe(MAX_OUTPUT_BYTES);
    expect(Buffer.byteLength(out.stderr, "utf8")).toBe(MAX_OUTPUT_BYTES);
  });

  it("closes the sandbox even when runCode throws", async () => {
    const close = vi.fn(async () => undefined);
    setSandboxFactory(async () =>
      makeSandbox({
        close,
        runCode: vi.fn(async () => {
          throw new Error("boom");
        }),
      }),
    );
    await expect(execInSandbox({ language: "python", code: "x" })).rejects.toThrow("boom");
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("swallows close() errors", async () => {
    setSandboxFactory(async () =>
      makeSandbox({
        close: vi.fn(async () => {
          throw new Error("close failed");
        }),
      }),
    );
    const out = await execInSandbox({ language: "python", code: "print(1)" });
    expect(out.exitCode).toBe(0);
  });

  it("races against a timeout deadline", async () => {
    setSandboxFactory(async () =>
      makeSandbox({
        runCode: vi.fn(
          () =>
            new Promise(() => {
              /* never resolves */
            }),
        ),
      }),
    );
    vi.useFakeTimers();
    const promise = execInSandbox({ language: "python", code: "x", timeoutMs: 1_000 });
    const expectation = expect(promise).rejects.toBeInstanceOf(SandboxTimeoutError);
    await vi.advanceTimersByTimeAsync(7_000);
    await expectation;
    vi.useRealTimers();
  });

  it("error classes carry their names", () => {
    expect(new SandboxConfigError("a").name).toBe("SandboxConfigError");
    expect(new SandboxTimeoutError("b").name).toBe("SandboxTimeoutError");
    expect(new SandboxUnavailableError("c").name).toBe("SandboxUnavailableError");
  });
});

describe("POST /sandbox/exec", () => {
  it("requires Bearer auth", async () => {
    setSandboxFactory(async () => makeSandbox());
    const app = createApp({ loadClient: async () => stubClient });
    const res = await request(app)
      .post("/sandbox/exec")
      .send({ language: "python", code: "print(1)" });
    expect(res.status).toBe(401);
  });

  it("returns 503 when E2B_API_KEY is missing", async () => {
    delete process.env.E2B_API_KEY;
    const app = createApp({ loadClient: async () => stubClient });
    const res = await request(app)
      .post("/sandbox/exec")
      .set("authorization", `Bearer ${TOKEN}`)
      .send({ language: "python", code: "print(1)" });
    expect(res.status).toBe(503);
    expect(res.body.error).toBe("sandbox_unavailable");
  });

  it("returns 400 on bad request body", async () => {
    setSandboxFactory(async () => makeSandbox());
    const app = createApp({ loadClient: async () => stubClient });
    const res = await request(app)
      .post("/sandbox/exec")
      .set("authorization", `Bearer ${TOKEN}`)
      .send({ language: "ruby", code: "puts 1" });
    expect(res.status).toBe(400);
  });

  it("executes and returns truncated/exitCode/duration", async () => {
    setSandboxFactory(async () =>
      makeSandbox({
        runCode: vi.fn(async () => ({
          stdout: "ok",
          stderr: "warn",
          exitCode: 0,
          durationMs: 12,
        })),
      }),
    );
    const app = createApp({ loadClient: async () => stubClient });
    const res = await request(app)
      .post("/sandbox/exec")
      .set("authorization", `Bearer ${TOKEN}`)
      .send({ language: "python", code: "print('ok')", timeoutMs: 5000 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      stdout: "ok",
      stderr: "warn",
      exitCode: 0,
      truncated: false,
    });
    expect(typeof res.body.durationMs).toBe("number");
  });

  it("returns 504 on timeout error", async () => {
    setSandboxFactory(async () =>
      makeSandbox({
        runCode: vi.fn(async () => {
          throw new SandboxTimeoutError("nope");
        }),
      }),
    );
    const app = createApp({ loadClient: async () => stubClient });
    const res = await request(app)
      .post("/sandbox/exec")
      .set("authorization", `Bearer ${TOKEN}`)
      .send({ language: "python", code: "print(1)" });
    expect(res.status).toBe(504);
    expect(res.body.error).toBe("sandbox_timeout");
  });

  it("returns 502 on generic sandbox error", async () => {
    setSandboxFactory(async () =>
      makeSandbox({
        runCode: vi.fn(async () => {
          throw new Error("upstream down");
        }),
      }),
    );
    const app = createApp({ loadClient: async () => stubClient });
    const res = await request(app)
      .post("/sandbox/exec")
      .set("authorization", `Bearer ${TOKEN}`)
      .send({ language: "python", code: "print(1)" });
    expect(res.status).toBe(502);
    expect(res.body.error).toBe("sandbox_failed");
  });
});
