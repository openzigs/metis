/**
 * Tests for the QA-agent sandbox runner (Epic #395 #415).
 *
 * Verifies pass / fail / timeout / file-upload paths, and that the
 * outer `runTestsWithProvider` wrapper destroys the sandbox in a
 * `finally` even when the test command throws.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runTestsInSandbox,
  runTestsWithProvider,
  TIMEOUT_EXIT_CODE,
} from "../../src/agents/qa-agent.sandbox-runner.js";
import type {
  ExecResult,
  SandboxLike,
  SandboxLikeProvider,
} from "../../src/agents/sandbox-port.js";

interface StubSandboxState {
  destroyed: boolean;
  uploads: Array<{ path: string; size: number }>;
  commands: string[];
  nextResult?: ExecResult | Error;
}

function makeSandbox(state: StubSandboxState): SandboxLike {
  return {
    id: "stub-sandbox",
    commands: {
      async run(command, _opts) {
        state.commands.push(command);
        if (state.nextResult instanceof Error) throw state.nextResult;
        if (state.nextResult) return state.nextResult;
        return {
          exitCode: 0,
          stdout: "ok",
          stderr: "",
          durationMs: 5,
        };
      },
    },
    files: {
      async write(path, data) {
        const size = typeof data === "string" ? Buffer.byteLength(data, "utf8") : data.byteLength;
        state.uploads.push({ path, size });
      },
    },
    async destroy() {
      state.destroyed = true;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("runTestsInSandbox", () => {
  it("uploads files relative to /workspace then runs the test command", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
    };
    const sandbox = makeSandbox(state);
    const result = await runTestsInSandbox(sandbox, {
      files: [
        { path: "package.json", contents: "{}" },
        { path: "test/foo.test.ts", contents: "// noop" },
      ],
      testCommand: "npm test",
    });
    expect(state.uploads.map((u) => u.path)).toEqual([
      "/workspace/package.json",
      "/workspace/test/foo.test.ts",
    ]);
    expect(state.commands).toEqual(["npm test"]);
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("respects an absolute file path (no /workspace prefix)", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
    };
    const sandbox = makeSandbox(state);
    await runTestsInSandbox(sandbox, {
      files: [{ path: "/etc/special", contents: "x" }],
      testCommand: "true",
    });
    expect(state.uploads[0].path).toBe("/etc/special");
  });

  it("returns passed=false when the test command exits non-zero", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
      nextResult: { exitCode: 1, stdout: "", stderr: "fail", durationMs: 1 },
    };
    const sandbox = makeSandbox(state);
    const result = await runTestsInSandbox(sandbox, {
      files: [],
      testCommand: "npm test",
    });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe("fail");
  });

  it("translates a sandbox timeout error into TIMEOUT_EXIT_CODE", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
      nextResult: new Error("watchdog timeout fired after 60000ms"),
    };
    const sandbox = makeSandbox(state);
    const result = await runTestsInSandbox(sandbox, {
      files: [],
      testCommand: "npm test",
    });
    expect(result.exitCode).toBe(TIMEOUT_EXIT_CODE);
    expect(result.timedOut).toBe(true);
    expect(result.stderr).toMatch(/sandbox timeout/);
  });

  it("translates a generic exec error into exitCode=1", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
      nextResult: new Error("network glitch"),
    };
    const sandbox = makeSandbox(state);
    const result = await runTestsInSandbox(sandbox, {
      files: [],
      testCommand: "npm test",
    });
    expect(result.exitCode).toBe(1);
    expect(result.timedOut).toBe(false);
    expect(result.stderr).toBe("network glitch");
  });

  it("does not destroy the sandbox (caller owns lifecycle)", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
    };
    const sandbox = makeSandbox(state);
    await runTestsInSandbox(sandbox, { files: [], testCommand: "true" });
    expect(state.destroyed).toBe(false);
  });
});

describe("runTestsWithProvider", () => {
  function makeProvider(state: StubSandboxState): SandboxLikeProvider {
    return {
      async create() {
        return makeSandbox(state);
      },
    };
  }

  it("destroys the sandbox after a successful run", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
    };
    const result = await runTestsWithProvider(
      makeProvider(state),
      { projectId: "p-1" },
      { files: [], testCommand: "true" },
    );
    expect(result.passed).toBe(true);
    expect(state.destroyed).toBe(true);
  });

  it("destroys the sandbox even when the test command throws", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
      nextResult: new Error("kaboom"),
    };
    const result = await runTestsWithProvider(
      makeProvider(state),
      { projectId: "p-1" },
      { files: [], testCommand: "true" },
    );
    expect(result.passed).toBe(false);
    expect(state.destroyed).toBe(true);
  });

  it("destroys the sandbox even when destroy() itself throws", async () => {
    const state: StubSandboxState = {
      destroyed: false,
      uploads: [],
      commands: [],
    };
    const provider: SandboxLikeProvider = {
      async create() {
        const sandbox = makeSandbox(state);
        sandbox.destroy = async () => {
          state.destroyed = true;
          throw new Error("destroy-failed");
        };
        return sandbox;
      },
    };
    const result = await runTestsWithProvider(
      provider,
      { projectId: "p-1" },
      { files: [], testCommand: "true" },
    );
    expect(result.passed).toBe(true);
    expect(state.destroyed).toBe(true);
  });
});
