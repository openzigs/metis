/**
 * Tests for the NoopSandbox + NoopSandboxProvider (Epic #395 #409).
 *
 * Uses a real tmp directory (the noop sandbox is in-process by design),
 * but injects in-memory stubs for the session repo + audit emitter so
 * the test never touches Prisma.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SandboxAuditEmitter } from "../../../src/lib/sandbox/audit/audit-emitter.js";
import { NoopSandboxProvider } from "../../../src/lib/sandbox/noop/noop-provider.js";
import { NoopSandbox } from "../../../src/lib/sandbox/noop/noop-sandbox.js";
import type {
  SandboxAuditEventInput,
  SandboxAuditEventRepo,
  SandboxAuditEventRow,
} from "../../../src/lib/sandbox/repos/sandbox-audit-event.repo.js";
import type {
  SandboxSessionFinalizeInput,
  SandboxSessionRepo,
  SandboxSessionRow,
  SandboxSessionStartInput,
} from "../../../src/lib/sandbox/repos/sandbox-session.repo.js";
import { SandboxLimitExceededError } from "../../../src/lib/sandbox/types.js";

class InMemorySessionRepo implements SandboxSessionRepo {
  rows = new Map<string, SandboxSessionRow>();
  async start(input: SandboxSessionStartInput): Promise<SandboxSessionRow> {
    const row: SandboxSessionRow = {
      id: `sess-${this.rows.size + 1}`,
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
    if (!row) throw new Error("session not found");
    Object.assign(row, {
      destroyedAt: input.destroyedAt,
      wallClockMs: input.wallClockMs,
      outcome: input.outcome,
      errorMessage: input.errorMessage ?? null,
    });
    return row;
  }
  async findById(id: string): Promise<SandboxSessionRow | null> {
    return this.rows.get(id) ?? null;
  }
  async listForProject(): Promise<SandboxSessionRow[]> {
    return Array.from(this.rows.values());
  }
}

class InMemoryAuditRepo implements SandboxAuditEventRepo {
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

let tmpDirs: string[] = [];

async function makeProvider() {
  const sessionRepo = new InMemorySessionRepo();
  const auditRepo = new InMemoryAuditRepo();
  const emitter = new SandboxAuditEmitter(auditRepo);
  const provider = new NoopSandboxProvider({
    sessionRepo,
    emitter,
    mkRootDir: async (id) => {
      const dir = await mkdtemp(join(tmpdir(), `noop-test-${id}-`));
      tmpDirs.push(dir);
      return dir;
    },
  });
  return { provider, sessionRepo, auditRepo };
}

beforeEach(() => {
  tmpDirs = [];
});

afterEach(async () => {
  for (const dir of tmpDirs) {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
});

describe("NoopSandboxProvider.create", () => {
  it("inserts a SandboxSession row with provider='noop'", async () => {
    const { provider, sessionRepo } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.provider).toBe("noop");
    expect(row?.outcome).toBeNull();
    await sandbox.destroy();
  });

  it("emits a 'create' audit event", async () => {
    const { provider, auditRepo } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    const events = await auditRepo.listForSession(sandbox.id);
    expect(events.map((e) => e.eventType)).toContain("create");
    await sandbox.destroy();
  });

  it("rejects vCpus > 4 BEFORE creating a session row", async () => {
    const { provider, sessionRepo } = await makeProvider();
    await expect(provider.create({ projectId: "p-1", vCpus: 99 })).rejects.toBeInstanceOf(
      SandboxLimitExceededError,
    );
    expect(sessionRepo.rows.size).toBe(0);
  });

  it("rejects wildcard egressAllowlist", async () => {
    const { provider } = await makeProvider();
    await expect(provider.create({ projectId: "p-1", egressAllowlist: ["*"] })).rejects.toThrow(
      /wildcard/,
    );
  });
});

describe("NoopSandbox runtime", () => {
  it("runs a stateful kernel: x = 1; x += 1 returns '2'", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    const r1 = await sandbox.runCode("x = 1");
    expect(r1.exitCode).toBe(0);
    const r2 = await sandbox.runCode("x += 1\nx");
    expect(r2.stdout).toBe("2");
    await sandbox.destroy();
  });

  it("commands.run streams stdout/stderr via callbacks", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    const chunks: string[] = [];
    const result = await sandbox.commands.run("echo hello", {
      onStdout: (s) => chunks.push(s),
    });
    expect(result.exitCode).toBe(0);
    expect(chunks.join("")).toContain("hello");
    await sandbox.destroy();
  });

  it("commands.run returns a non-zero exitCode on failing command", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    const result = await sandbox.commands.run("false");
    expect(result.exitCode).not.toBe(0);
    await sandbox.destroy();
  });

  it("files.write + files.read round-trips utf8", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    await sandbox.files.write("hello.txt", "world");
    const txt = await sandbox.files.read("hello.txt");
    expect(txt).toBe("world");
    await sandbox.destroy();
  });

  it("files.read with format='bytes' returns Uint8Array (binary safe)", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    await sandbox.files.write("bin.dat", new Uint8Array([0, 1, 2, 3]));
    const bytes = await sandbox.files.read("bin.dat", { format: "bytes" });
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect((bytes as Uint8Array).byteLength).toBe(4);
    await sandbox.destroy();
  });

  it("rejects path traversal outside the sandbox root", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    await expect(sandbox.files.write("../escape.txt", "x")).rejects.toThrow(
      /outside the sandbox root/,
    );
    await sandbox.destroy();
  });

  it("kills the sandbox when files.write exceeds 100 MiB", async () => {
    const { provider, sessionRepo } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    const big = new Uint8Array(101 * 1024 * 1024); // 101 MiB
    await expect(sandbox.files.write("big.bin", big)).rejects.toBeInstanceOf(
      SandboxLimitExceededError,
    );
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.outcome).toBe("killed");
    expect(row?.errorMessage).toMatch(/exceeded/);
  });

  it("destroy() finalises the session row with outcome='completed'", async () => {
    const { provider, sessionRepo } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    await sandbox.destroy();
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.outcome).toBe("completed");
    expect(row?.destroyedAt).toBeInstanceOf(Date);
    expect(row?.wallClockMs).toBeGreaterThanOrEqual(0);
  });

  it("destroy() is idempotent", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    await sandbox.destroy();
    await expect(sandbox.destroy()).resolves.toBeUndefined();
  });

  it("operations after destroy() throw 'is destroyed'", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    await sandbox.destroy();
    await expect(sandbox.runCode("x = 1")).rejects.toThrow(/destroyed/);
    await expect(sandbox.commands.run("true")).rejects.toThrow(/destroyed/);
    await expect(sandbox.files.write("a.txt", "x")).rejects.toThrow(/destroyed/);
    await expect(sandbox.files.read("a.txt")).rejects.toThrow(/destroyed/);
  });

  it("pause() returns a snapshot id and emits an audit event", async () => {
    const { provider, auditRepo } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    const snapshotId = await sandbox.pause();
    expect(snapshotId).toMatch(/^[0-9A-Z]+/);
    const events = await auditRepo.listForSession(sandbox.id);
    expect(events.map((e) => e.eventType)).toContain("pause");
    await sandbox.destroy();
  });

  it("resume() emits a resume audit event", async () => {
    const { provider, auditRepo } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    await sandbox.resume("snap-1");
    const events = await auditRepo.listForSession(sandbox.id);
    expect(events.map((e) => e.eventType)).toContain("resume");
    await sandbox.destroy();
  });
});

describe("NoopSandbox env isolation (Critical — secret exfiltration regression)", () => {
  it("does NOT leak host process.env secrets into commands.run subprocesses", async () => {
    const sentinelKey = "METIS_SANDBOX_TEST_SECRET_SENTINEL";
    const sentinelValue = "should-NOT-leak-into-sandbox";
    const previous = process.env[sentinelKey];
    process.env[sentinelKey] = sentinelValue;
    try {
      const { provider } = await makeProvider();
      const sandbox = await provider.create({ projectId: "p-1" });
      const result = await sandbox.commands.run("env");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(sentinelValue);
      expect(result.stdout).not.toContain(sentinelKey);
      await sandbox.destroy();
    } finally {
      if (previous === undefined) delete process.env[sentinelKey];
      else process.env[sentinelKey] = previous;
    }
  });

  it("propagates ONLY the env vars the caller passed via opts.env", async () => {
    const { provider } = await makeProvider();
    const sandbox = await provider.create({ projectId: "p-1" });
    const result = await sandbox.commands.run('echo "$EXPLICIT_VAR"', {
      env: { EXPLICIT_VAR: "hello-from-caller" },
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("hello-from-caller");
    await sandbox.destroy();
  });

  it("inherits the host PATH so binaries resolve, but no secret-shaped vars", async () => {
    const sentinelKey = "AWS_SECRET_ACCESS_KEY";
    const previous = process.env[sentinelKey];
    process.env[sentinelKey] = "fake-aws-secret-do-not-leak";
    try {
      const { provider } = await makeProvider();
      const sandbox = await provider.create({ projectId: "p-1" });
      const result = await sandbox.commands.run("env");
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("PATH=");
      expect(result.stdout).not.toContain("fake-aws-secret-do-not-leak");
      await sandbox.destroy();
    } finally {
      if (previous === undefined) delete process.env[sentinelKey];
      else process.env[sentinelKey] = previous;
    }
  });
});

describe("NoopSandbox watchdog", () => {
  it("watchdog timeout finalises the session as 'timeout' even without destroy()", async () => {
    const { provider, sessionRepo } = await makeProvider();
    const sandbox = await provider.create({
      projectId: "p-1",
      timeoutMs: 1_000,
    });
    // Reach into the watchdog by directly triggering the kill path —
    // we simulate the timer callback firing, since waiting for real
    // wall-clock would slow the test gate.
    const noop = sandbox as unknown as NoopSandbox;
    // Trigger the private timeout handler via the explicit kill-with-reason
    // method (kept private — use bracket access from the test bundle).
    const handler = (noop as unknown as { handleTimeout: () => Promise<void> }).handleTimeout;
    await (handler.bind(noop) as () => Promise<void>)();
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.outcome).toBe("killed");
  });
});
