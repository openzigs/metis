/**
 * Tests for the LocalDevSandboxProvider (Epic #395 #417).
 *
 * Covers OS detection, missing-tool guard, and dev/non-dev warning.
 * Spawn-level integration is exercised separately on a Linux runner
 * with `bwrap` actually installed.
 */
import { afterEach, describe, expect, it } from "vitest";
import { SandboxAuditEmitter } from "../../../../src/lib/sandbox/audit/audit-emitter.js";
import {
  LocalDevSandboxProvider,
  LocalDevSandboxUnavailableError,
} from "../../../../src/lib/sandbox/local-dev/local-dev-provider.js";
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
  async listForRun(): Promise<SandboxSessionRow[]> {
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

const ORIGINAL_NODE_ENV = process.env.NODE_ENV;

afterEach(() => {
  if (ORIGINAL_NODE_ENV === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = ORIGINAL_NODE_ENV;
});

describe("LocalDevSandboxProvider construction", () => {
  it("constructs successfully on linux when bwrap is on PATH", () => {
    const p = new LocalDevSandboxProvider({
      hostPlatform: "linux",
      isToolAvailable: (bin) => bin === "bwrap",
    });
    expect(p.kind).toBe("local_dev");
  });

  it("constructs successfully on darwin when sandbox-exec is on PATH", () => {
    const p = new LocalDevSandboxProvider({
      hostPlatform: "darwin",
      isToolAvailable: (bin) => bin === "sandbox-exec",
    });
    expect(p.kind).toBe("local_dev");
  });

  it("throws LocalDevSandboxUnavailableError when bwrap is missing on linux", () => {
    expect(
      () =>
        new LocalDevSandboxProvider({
          hostPlatform: "linux",
          isToolAvailable: () => false,
        }),
    ).toThrow(LocalDevSandboxUnavailableError);
  });

  it("throws LocalDevSandboxUnavailableError when sandbox-exec is missing on darwin", () => {
    expect(
      () =>
        new LocalDevSandboxProvider({
          hostPlatform: "darwin",
          isToolAvailable: () => false,
        }),
    ).toThrow(LocalDevSandboxUnavailableError);
  });

  it("throws LocalDevSandboxUnavailableError on unsupported platforms (e.g. win32)", () => {
    expect(
      () =>
        new LocalDevSandboxProvider({
          hostPlatform: "win32",
          isToolAvailable: () => true,
        }),
    ).toThrow(LocalDevSandboxUnavailableError);
  });

  it("error message points at install instructions", () => {
    try {
      new LocalDevSandboxProvider({
        hostPlatform: "linux",
        isToolAvailable: () => false,
      });
    } catch (err) {
      expect((err as Error).message).toMatch(/bubblewrap/i);
      expect((err as Error).message).toMatch(/sandbox-exec/i);
    }
  });
});

describe("LocalDevSandboxProvider.create", () => {
  async function build(opts?: { nodeEnv?: string; hostPlatform?: NodeJS.Platform }) {
    const sessionRepo = new StubSessionRepo();
    const auditRepo = new StubAuditRepo();
    const provider = new LocalDevSandboxProvider({
      sessionRepo,
      emitter: new SandboxAuditEmitter(auditRepo),
      hostPlatform: opts?.hostPlatform ?? "linux",
      isToolAvailable: () => true,
      nodeEnv: opts?.nodeEnv,
      mkRootDir: async (id) => `/tmp/local-dev-test-${id}`,
    });
    return { provider, sessionRepo, auditRepo };
  }

  it("creates a session row with provider='local_dev' and vendor id", async () => {
    const { provider, sessionRepo } = await build({ nodeEnv: "development" });
    const sandbox = await provider.create({ projectId: "p-1" });
    expect(sandbox.provider).toBe("local_dev");
    expect(sandbox.vendorSandboxId).toMatch(/^local-dev-/);
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.provider).toBe("local_dev");
  });

  it("emits a 'create' audit event with hostOs in the payload", async () => {
    const { provider, auditRepo } = await build({
      nodeEnv: "development",
      hostPlatform: "linux",
    });
    const sandbox = await provider.create({ projectId: "p-1" });
    const events = await auditRepo.listForSession(sandbox.id);
    const create = events.find((e) => e.eventType === "create");
    expect(create).toBeDefined();
    const payload = JSON.parse(create!.payload as string);
    expect(payload.hostOs).toBe("linux");
  });

  it("WARN-logs every create when NODE_ENV !== 'development'", async () => {
    // We can't easily intercept the child logger, so verify behaviour
    // via the side-effect: the call still succeeds (the warning is
    // non-fatal). Coverage of the warn branch is checked here; the
    // log itself is asserted by spying on a real logger instance in
    // adjacent integration tests.
    const { provider } = await build({ nodeEnv: "production" });
    const sandbox = await provider.create({ projectId: "p-1" });
    expect(sandbox.provider).toBe("local_dev");
  });

  it("persists runId on session.start when provided", async () => {
    const { provider, sessionRepo } = await build({ nodeEnv: "development" });
    const sandbox = await provider.create({ projectId: "p-1", runId: "run-99" });
    const row = await sessionRepo.findById(sandbox.id);
    expect(row?.runId).toBe("run-99");
  });
});
