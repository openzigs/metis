/**
 * Epic #192 (A.2) — `code_exec` tool tests.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../prisma.js", () => ({
  prisma: {
    aITokenUsage: {
      create: vi.fn(async () => ({})),
    },
  },
}));

import {
  CODE_EXEC_TOOL_NAME,
  codeExecSchema,
  createCodeExecTool,
  registerCodeExec,
} from "./code-exec.js";
import { SandboxClient, SandboxClientError } from "../../sandbox/sandbox-client.js";
import { ToolRegistry } from "../tool-registry.js";

const ctx = { sessionId: "s1", userId: "u1" } as const;
/** #142 — `invoke` requires a gate; these tests exercise the tool, not the gate. */
const allowGate = { decide: async () => true };

beforeEach(() => {
  process.env.COPILOT_NATIVE_TOKEN = "test-token";
});

afterEach(() => {
  delete process.env.SANDBOX_MODE;
});

function makeClient(impl: SandboxClient["exec"]): SandboxClient {
  return { exec: impl } as unknown as SandboxClient;
}

describe("code_exec tool", () => {
  it("schema requires language enum and non-empty code", () => {
    expect(codeExecSchema.safeParse({ language: "python", code: "" }).success).toBe(false);
    expect(codeExecSchema.safeParse({ language: "ruby", code: "x" }).success).toBe(false);
    expect(codeExecSchema.safeParse({ language: "python", code: "x" }).success).toBe(true);
  });

  it("schema rejects code over 64 KiB and timeoutMs over 120s", () => {
    const huge = "a".repeat(64 * 1024 + 1);
    expect(codeExecSchema.safeParse({ language: "python", code: huge }).success).toBe(false);
    expect(
      codeExecSchema.safeParse({ language: "python", code: "x", timeoutMs: 200_000 }).success,
    ).toBe(false);
  });

  it("returns success result on exitCode 0", async () => {
    const client = makeClient(
      vi.fn(async () => ({
        stdout: "hi",
        stderr: "",
        exitCode: 0,
        durationMs: 12,
        truncated: false,
      })),
    );
    const tool = createCodeExecTool({ client });
    const out = await tool.exec({ language: "python", code: "print('hi')" }, ctx);
    expect(out.isError).toBe(false);
    expect(out.text).toContain("exit 0");
    const data = out.data as { provider: string; durationMs: number };
    expect(data.provider).toBe("e2b");
    expect(data.durationMs).toBe(12);
  });

  it("flags isError when exitCode is non-zero", async () => {
    const client = makeClient(
      vi.fn(async () => ({
        stdout: "",
        stderr: "boom",
        exitCode: 1,
        durationMs: 1,
        truncated: false,
      })),
    );
    const tool = createCodeExecTool({ client });
    const out = await tool.exec({ language: "bash", code: "false" }, ctx);
    expect(out.isError).toBe(true);
    expect(out.text).toContain("exit 1");
  });

  it("returns error result when sandbox client throws", async () => {
    const client = makeClient(
      vi.fn(async () => {
        throw new SandboxClientError("E2B unreachable", 503, "SANDBOX_UNAVAILABLE");
      }),
    );
    const errors: string[] = [];
    const tool = createCodeExecTool({ client });
    const out = await tool.exec(
      { language: "python", code: "x" },
      {
        ...ctx,
        log: {
          info: () => {
            /* unused */
          },
          error: (m: string) => errors.push(m),
        },
      },
    );
    expect(out.isError).toBe(true);
    expect(out.text).toContain("SANDBOX_UNAVAILABLE");
    const data = out.data as { status: number; provider: string };
    expect(data.status).toBe(503);
    expect(data.provider).toBe("e2b");
    expect(errors.some((e) => e.includes("code_exec"))).toBe(true);
  });

  it("wraps generic Error as a 502 result", async () => {
    const client = makeClient(
      vi.fn(async () => {
        throw new Error("kaboom");
      }),
    );
    const tool = createCodeExecTool({ client });
    const out = await tool.exec({ language: "python", code: "x" }, ctx);
    const data = out.data as { status: number };
    expect(data.status).toBe(502);
  });

  it("registerCodeExec is a no-op when SANDBOX_MODE is unset", () => {
    delete process.env.SANDBOX_MODE;
    const reg = new ToolRegistry();
    const r = registerCodeExec(reg, { isEnabled: () => false });
    expect(r.registered).toBe(false);
    expect(r.reason).toMatch(/SANDBOX_MODE/);
    expect(reg.has(CODE_EXEC_TOOL_NAME)).toBe(false);
  });

  it("registerCodeExec is idempotent and registers when enabled", () => {
    const reg = new ToolRegistry();
    const client = makeClient(
      vi.fn(async () => ({
        stdout: "",
        stderr: "",
        exitCode: 0,
        durationMs: 1,
        truncated: false,
      })),
    );
    const first = registerCodeExec(reg, { isEnabled: () => true, client });
    expect(first.registered).toBe(true);
    expect(reg.has(CODE_EXEC_TOOL_NAME)).toBe(true);
    const second = registerCodeExec(reg, { isEnabled: () => true, client });
    expect(second.registered).toBe(true);
    expect(reg.has(CODE_EXEC_TOOL_NAME)).toBe(true);
  });

  it("integrates with ToolRegistry.invoke", async () => {
    const client = makeClient(
      vi.fn(async () => ({
        stdout: "ok",
        stderr: "",
        exitCode: 0,
        durationMs: 5,
        truncated: false,
      })),
    );
    const reg = new ToolRegistry();
    registerCodeExec(reg, { isEnabled: () => true, client });
    const result = await reg.invoke(
      CODE_EXEC_TOOL_NAME,
      { language: "python", code: "print(1)" },
      ctx,
      allowGate,
    );
    expect(result.isError).toBe(false);
    expect(result.text).toContain("exit 0");
  });
});
