/**
 * Tests for `withSandbox` (Epic #395 #411).
 */
import { describe, expect, it, vi } from "vitest";
import { withSandbox } from "../../../src/lib/sandbox/with-sandbox.js";
import type { Sandbox, SandboxOptions, SandboxProvider } from "../../../src/lib/sandbox/types.js";

function makeStubSandbox(destroySpy?: () => void): Sandbox {
  return {
    id: "s-1",
    vendorSandboxId: "v-1",
    provider: "noop",
    runCode: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    commands: {
      run: async () => ({ exitCode: 0, stdout: "", stderr: "", durationMs: 0 }),
    },
    files: {
      read: async () => "",
      write: async () => undefined,
    },
    pause: async () => "snap-1",
    resume: async () => undefined,
    destroy: async () => {
      destroySpy?.();
    },
  };
}

function makeProvider(sandbox: Sandbox): SandboxProvider {
  return {
    kind: "noop",
    create: async (_opts: SandboxOptions) => sandbox,
  };
}

describe("withSandbox", () => {
  it("invokes the callback and destroys after success", async () => {
    const destroy = vi.fn();
    const provider = makeProvider(makeStubSandbox(destroy));
    const result = await withSandbox(provider, { projectId: "p-1" }, async (s) => {
      expect(s.id).toBe("s-1");
      return 42;
    });
    expect(result).toBe(42);
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("destroys even when the callback throws", async () => {
    const destroy = vi.fn();
    const provider = makeProvider(makeStubSandbox(destroy));
    await expect(
      withSandbox(provider, { projectId: "p-1" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("does not mask the callback's error when destroy() throws", async () => {
    const sandbox = makeStubSandbox();
    sandbox.destroy = async () => {
      throw new Error("destroy-failed");
    };
    const provider = makeProvider(sandbox);
    await expect(
      withSandbox(provider, { projectId: "p-1" }, async () => {
        throw new Error("primary");
      }),
    ).rejects.toThrow("primary");
  });
});
