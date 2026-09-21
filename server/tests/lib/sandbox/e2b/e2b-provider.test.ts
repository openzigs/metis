/**
 * Tests for the E2BSandboxProvider + E2BSandbox (Epic #395 #411).
 *
 * The real `@e2b/code-interpreter` SDK is NEVER imported here. We inject
 * an in-memory client factory via the provider's `clientFactory` seam.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxAuditEmitter } from "../../../../src/lib/sandbox/audit/audit-emitter.js";
import {
  E2B_UNAVAILABLE,
  E2BSandboxProvider,
} from "../../../../src/lib/sandbox/e2b/e2b-provider.js";
import type { E2BSandboxLike } from "../../../../src/lib/sandbox/e2b/e2b-sandbox.js";
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
      runId: null,
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

interface StubClientState {
  killed: boolean;
  vars: Record<string, number>;
}

function makeStubClient(state: StubClientState): E2BSandboxLike {
  return {
    sandboxId: "vendor-abc",
    async runCode(code, opts) {
      // Tiny mirror of the kernel semantics — supports `name = N` and
      // `name op= N\nname` so the stateful AC can be exercised.
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
      opts?.onStdout?.(result);
      return { text: result, logs: { stdout: [result], stderr: [] } };
    },
    commands: {
      async run(cmd, opts) {
        opts?.onStdout?.(cmd);
        return { exitCode: cmd === "false" ? 1 : 0, stdout: cmd, stderr: "" };
      },
    },
    files: {
      async read(_path, opts) {
        if (opts?.format === "bytes") return new Uint8Array([1, 2, 3]);
        return "file-contents";
      },
      async write() {
        /* no-op */
      },
    },
    async pause() {
      return "snap-1";
    },
    async kill() {
      state.killed = true;
    },
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("E2BSandboxProvider.create", () => {
  it("throws E2B_UNAVAILABLE when E2B_API_KEY is missing", async () => {
    const provider = new E2BSandboxProvider({
      apiKey: undefined,
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
      clientFactory: async () => makeStubClient({ killed: false, vars: {} }),
    });
    await expect(provider.create({ projectId: "p-1" })).rejects.toMatchObject({
      code: E2B_UNAVAILABLE,
    });
  });

  it("inserts a SandboxSession row with provider='e2b' and the vendor sandbox id", async () => {
    const sessionRepo = new StubSessionRepo();
    const auditRepo = new StubAuditRepo();
    const state: StubClientState = { killed: false, vars: {} };
    const provider = new E2BSandboxProvider({
      apiKey: "key-1",
      sessionRepo,
      emitter: new SandboxAuditEmitter(auditRepo),
      clientFactory: async () => makeStubClient(state),
    });
    const sandbox = await provider.create({ projectId: "p-1" });
    expect(sandbox.provider).toBe("e2b");
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.provider).toBe("e2b");
    expect(row?.outcome).toBeNull();
    await sandbox.destroy();
  });

  it("rejects vCpus > 4 BEFORE constructing the SDK client", async () => {
    let constructed = false;
    const provider = new E2BSandboxProvider({
      apiKey: "key-1",
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
      clientFactory: async () => {
        constructed = true;
        return makeStubClient({ killed: false, vars: {} });
      },
    });
    await expect(provider.create({ projectId: "p-1", vCpus: 99 })).rejects.toBeInstanceOf(
      SandboxLimitExceededError,
    );
    expect(constructed).toBe(false);
  });
});

describe("E2BSandbox runtime", () => {
  async function build() {
    const sessionRepo = new StubSessionRepo();
    const auditRepo = new StubAuditRepo();
    const state: StubClientState = { killed: false, vars: {} };
    const provider = new E2BSandboxProvider({
      apiKey: "key-1",
      sessionRepo,
      emitter: new SandboxAuditEmitter(auditRepo),
      clientFactory: async () => makeStubClient(state),
    });
    const sandbox = await provider.create({ projectId: "p-1" });
    return { sandbox, sessionRepo, auditRepo, state };
  }

  it("runCode is stateful: x = 1 then x += 1; x → '2'", async () => {
    const { sandbox } = await build();
    await sandbox.runCode("x = 1");
    const r = await sandbox.runCode("x += 1\nx");
    expect(r.stdout).toBe("2");
    await sandbox.destroy();
  });

  it("commands.run streams stdout via callback", async () => {
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

  it("destroy() calls the SDK kill() and finalises the session row", async () => {
    const { sandbox, sessionRepo, state } = await build();
    await sandbox.destroy();
    expect(state.killed).toBe(true);
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.destroyedAt).toBeInstanceOf(Date);
    expect(row?.outcome).toBe("completed");
  });

  it("operations after destroy() throw 'is destroyed'", async () => {
    const { sandbox } = await build();
    await sandbox.destroy();
    await expect(sandbox.commands.run("echo x")).rejects.toThrow(/destroyed/);
  });

  it("kills the sandbox when files.write exceeds 100 MiB", async () => {
    const { sandbox, sessionRepo, state } = await build();
    const big = new Uint8Array(101 * 1024 * 1024);
    await expect(sandbox.files.write("big.bin", big)).rejects.toBeInstanceOf(
      SandboxLimitExceededError,
    );
    expect(state.killed).toBe(true);
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.outcome).toBe("killed");
  });

  it("pause() returns a snapshot id from the SDK", async () => {
    const { sandbox } = await build();
    const snap = await sandbox.pause();
    expect(snap).toBe("snap-1");
    await sandbox.destroy();
  });

  it("resume() succeeds and emits an audit event", async () => {
    const { sandbox, auditRepo } = await build();
    await sandbox.resume("snap-1");
    const events = await auditRepo.listForSession(sandbox.id);
    expect(events.map((e) => e.eventType)).toContain("resume");
    await sandbox.destroy();
  });
});
