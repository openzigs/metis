/**
 * Tests for the DaytonaSandboxProvider + DaytonaSandbox (Epic #395 #416).
 *
 * The real `@daytona/sdk` is NEVER imported here — every test injects
 * an in-memory client via the provider's `clientFactory` seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxAuditEmitter } from "../../../../src/lib/sandbox/audit/audit-emitter.js";
import {
  DAYTONA_UNAVAILABLE,
  DaytonaSandboxProvider,
} from "../../../../src/lib/sandbox/daytona/daytona-provider.js";
import type { DaytonaSandboxLike } from "../../../../src/lib/sandbox/daytona/daytona-sandbox.js";
import type {
  SandboxAuditEventInput,
  SandboxAuditEventRepo,
  SandboxAuditEventRow,
} from "../../../../src/lib/sandbox/repos/sandbox-audit-event.repo.js";
import type {
  SandboxSessionFinalizeInput,
  SandboxSessionRepo,
  SandboxSessionRow,
  SandboxSessionStartInput,
} from "../../../../src/lib/sandbox/repos/sandbox-session.repo.js";
import { SandboxLimitExceededError } from "../../../../src/lib/sandbox/types.js";

class StubSessionRepo implements SandboxSessionRepo {
  rows = new Map<string, SandboxSessionRow>();
  async start(input: SandboxSessionStartInput): Promise<SandboxSessionRow> {
    const row: SandboxSessionRow = {
      id: `s-${this.rows.size + 1}`,
      projectId: input.projectId,
      userId: input.userId ?? null,
      runId: input.runId ?? null,
      provider: input.provider,
      vendorSandboxId: input.vendorSandboxId,
      templateId: input.templateId ?? null,
      vCpus: input.vCpus,
      memMiB: input.memMiB,
      createdAt: new Date(),
      destroyedAt: null,
      wallClockMs: null,
      cpuTimeMs: null,
      costMicroUsd: null,
      outcome: null,
      errorMessage: null,
    };
    this.rows.set(row.id, row);
    return row;
  }
  async finalize(
    sessionId: string,
    input: SandboxSessionFinalizeInput,
  ): Promise<SandboxSessionRow> {
    const row = this.rows.get(sessionId);
    if (!row) throw new Error("not found");
    Object.assign(row, input);
    return row;
  }
  async findById(id: string): Promise<SandboxSessionRow | null> {
    return this.rows.get(id) ?? null;
  }
  async listForProject(): Promise<SandboxSessionRow[]> {
    return Array.from(this.rows.values());
  }
  async listForRun(runId: string): Promise<SandboxSessionRow[]> {
    return Array.from(this.rows.values()).filter((r) => r.runId === runId);
  }
}

class StubAuditRepo implements SandboxAuditEventRepo {
  rows: SandboxAuditEventRow[] = [];
  async append(input: SandboxAuditEventInput): Promise<SandboxAuditEventRow> {
    const row: SandboxAuditEventRow = {
      id: `r-${this.rows.length + 1}`,
      sessionId: input.sessionId,
      eventType: input.eventType,
      payload: JSON.stringify(input.payload ?? {}),
      timestamp: new Date(),
    };
    this.rows.push(row);
    return row;
  }
  async listForSession(sessionId: string): Promise<SandboxAuditEventRow[]> {
    return this.rows.filter((r) => r.sessionId === sessionId);
  }
  async countForSession(sessionId: string): Promise<number> {
    return this.rows.filter((r) => r.sessionId === sessionId).length;
  }
}

interface StubState {
  deleted: boolean;
  vars: Record<string, number>;
}

function makeStubClient(state: StubState): DaytonaSandboxLike {
  return {
    id: "daytona-sb-1",
    process: {
      async codeRun(code) {
        // Mirror the kernel semantics for the stateful AC.
        const lines = code
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean);
        let result = "";
        for (const line of lines) {
          const compound = /^([a-z_]\w*)\s*([+\-*/])=\s*(\d+)$/i.exec(line);
          const assign = /^([a-z_]\w*)\s*=\s*(\d+)$/i.exec(line);
          if (compound) {
            const [, name, op, n] = compound;
            const lhs = state.vars[name] ?? 0;
            const rhs = Number(n);
            state.vars[name] =
              op === "+" ? lhs + rhs : op === "-" ? lhs - rhs : op === "*" ? lhs * rhs : lhs / rhs;
            result = String(state.vars[name]);
          } else if (assign) {
            const [, name, n] = assign;
            state.vars[name] = Number(n);
            result = String(state.vars[name]);
          } else if (line in state.vars) {
            result = String(state.vars[line]);
          }
        }
        return { result, exitCode: 0 };
      },
      async executeCommand(cmd) {
        return {
          exitCode: cmd === "false" ? 1 : 0,
          stdout: cmd,
          stderr: "",
        };
      },
    },
    fs: {
      async downloadFile() {
        return new Uint8Array([1, 2, 3]);
      },
      async uploadFile() {
        /* no-op */
      },
    },
    async delete() {
      state.deleted = true;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("DaytonaSandboxProvider.create", () => {
  it("throws DAYTONA_UNAVAILABLE when DAYTONA_API_KEY is missing", async () => {
    const provider = new DaytonaSandboxProvider({
      apiKey: undefined,
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
      clientFactory: async () => makeStubClient({ deleted: false, vars: {} }),
    });
    await expect(provider.create({ projectId: "p-1" })).rejects.toMatchObject({
      code: DAYTONA_UNAVAILABLE,
    });
  });

  it("inserts a SandboxSession row with provider='daytona' and vendor id", async () => {
    const sessionRepo = new StubSessionRepo();
    const auditRepo = new StubAuditRepo();
    const state: StubState = { deleted: false, vars: {} };
    const provider = new DaytonaSandboxProvider({
      apiKey: "key-1",
      sessionRepo,
      emitter: new SandboxAuditEmitter(auditRepo),
      clientFactory: async () => makeStubClient(state),
    });
    const sandbox = await provider.create({ projectId: "p-1" });
    expect(sandbox.provider).toBe("daytona");
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.provider).toBe("daytona");
    expect(row?.outcome).toBeNull();
    await sandbox.destroy();
  });

  it("rejects oversized vCpus before constructing the SDK client", async () => {
    let constructed = false;
    const provider = new DaytonaSandboxProvider({
      apiKey: "key-1",
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
      clientFactory: async () => {
        constructed = true;
        return makeStubClient({ deleted: false, vars: {} });
      },
    });
    await expect(provider.create({ projectId: "p-1", vCpus: 999 })).rejects.toBeInstanceOf(
      SandboxLimitExceededError,
    );
    expect(constructed).toBe(false);
  });

  it("persists runId on session.start when provided", async () => {
    const sessionRepo = new StubSessionRepo();
    const provider = new DaytonaSandboxProvider({
      apiKey: "key-1",
      sessionRepo,
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
      clientFactory: async () => makeStubClient({ deleted: false, vars: {} }),
    });
    const sandbox = await provider.create({ projectId: "p-1", runId: "run-42" });
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.runId).toBe("run-42");
    await sandbox.destroy();
  });
});

describe("DaytonaSandbox runtime", () => {
  async function build() {
    const sessionRepo = new StubSessionRepo();
    const auditRepo = new StubAuditRepo();
    const state: StubState = { deleted: false, vars: {} };
    const provider = new DaytonaSandboxProvider({
      apiKey: "key-1",
      sessionRepo,
      emitter: new SandboxAuditEmitter(auditRepo),
      clientFactory: async () => makeStubClient(state),
    });
    const sandbox = await provider.create({ projectId: "p-1" });
    return { sandbox, sessionRepo, auditRepo, state };
  }

  it("runCode is stateful: x = 1, x += 1, x → '2'", async () => {
    const { sandbox } = await build();
    await sandbox.runCode("x = 1");
    const r = await sandbox.runCode("x += 1\nx");
    expect(r.stdout).toBe("2");
    await sandbox.destroy();
  });

  it("commands.run returns stdout/stderr/exitCode from process.executeCommand", async () => {
    const { sandbox } = await build();
    const r = await sandbox.commands.run("echo hi");
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("echo hi");
    await sandbox.destroy();
  });

  it("commands.run streams stdout via the onStdout callback (post-resolve)", async () => {
    const { sandbox } = await build();
    const chunks: string[] = [];
    await sandbox.commands.run("echo hi", { onStdout: (s) => chunks.push(s) });
    expect(chunks.join("")).toContain("echo hi");
    await sandbox.destroy();
  });

  it("files.read with format='bytes' returns Uint8Array", async () => {
    const { sandbox } = await build();
    const out = await sandbox.files.read("/x", { format: "bytes" });
    expect(out).toBeInstanceOf(Uint8Array);
    await sandbox.destroy();
  });

  it("files.write rejects oversized payloads and kills the sandbox", async () => {
    const { sandbox, state } = await build();
    const big = new Uint8Array(101 * 1024 * 1024);
    await expect(sandbox.files.write("big.bin", big)).rejects.toBeInstanceOf(
      SandboxLimitExceededError,
    );
    expect(state.deleted).toBe(true);
  });

  it("destroy() calls the SDK delete() and finalises the session row with cost", async () => {
    const { sandbox, sessionRepo, state } = await build();
    await sandbox.destroy();
    expect(state.deleted).toBe(true);
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.destroyedAt).toBeInstanceOf(Date);
    expect(row?.outcome).toBe("completed");
    // Cost meter populated — daytona has a non-zero rate.
    expect(row?.costMicroUsd).not.toBeNull();
    expect(typeof row?.costMicroUsd).toBe("number");
  });

  it("operations after destroy() throw 'is destroyed'", async () => {
    const { sandbox } = await build();
    await sandbox.destroy();
    await expect(sandbox.commands.run("echo x")).rejects.toThrow(/destroyed/);
  });

  it("pause() returns a stable snapshot id", async () => {
    const { sandbox } = await build();
    const snap = await sandbox.pause();
    expect(snap).toContain("daytona-pause-");
    await sandbox.destroy();
  });

  it("resume() emits an audit event", async () => {
    const { sandbox, auditRepo } = await build();
    await sandbox.resume("snap-1");
    const events = await auditRepo.listForSession(sandbox.id);
    expect(events.map((e) => e.eventType)).toContain("resume");
    await sandbox.destroy();
  });
});
