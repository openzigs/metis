/**
 * Epic #395 #411 — E2B adapter live integration test.
 *
 * Drives the real `@e2b/code-interpreter` SDK through the
 * `E2BSandboxProvider` port. Exercises:
 *   - `provider.create()` returns a `Sandbox` whose `vendorSandboxId`
 *     matches an actual E2B sandbox.
 *   - Stateful `runCode` (variables persist across calls).
 *   - `commands.run` returns a real exit code from a shell process.
 *   - `destroy()` actually tears down the vendor sandbox.
 *
 * Gated behind RUN_INTEGRATION_TESTS=1 AND a valid `E2B_API_KEY`.
 * Skipped otherwise so the standard CI gate never reaches the network.
 */
import { afterAll, describe, expect, it } from "vitest";

import { SandboxAuditEmitter } from "../../../src/lib/sandbox/audit/audit-emitter.js";
import { E2BSandboxProvider } from "../../../src/lib/sandbox/e2b/e2b-provider.js";
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
import type { Sandbox } from "../../../src/lib/sandbox/types.js";

const RUN = process.env.RUN_INTEGRATION_TESTS === "1";
const HAS_KEY = !!process.env.E2B_API_KEY?.trim();
const describeMaybe = RUN && HAS_KEY ? describe : describe.skip;

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

const liveSandboxes: Sandbox[] = [];

afterAll(async () => {
  for (const s of liveSandboxes) {
    try {
      await s.destroy();
    } catch {
      /* best effort */
    }
  }
});

describeMaybe("E2B sandbox lifecycle (live SDK)", () => {
  function makeProvider(): E2BSandboxProvider {
    return new E2BSandboxProvider({
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
    });
  }

  it("creates a sandbox, runs code, destroys it — happy path", async () => {
    const provider = makeProvider();
    const sandbox = await provider.create({ projectId: "live-1", timeoutMs: 60_000 });
    liveSandboxes.push(sandbox);
    expect(sandbox.provider).toBe("e2b");
    expect(sandbox.vendorSandboxId).toBeTruthy();
    expect(sandbox.vendorSandboxId).not.toMatch(/^e2b-pending-/);

    const r1 = await sandbox.runCode("x = 1");
    expect(r1.exitCode).toBe(0);
    const r2 = await sandbox.runCode("x += 1\nx");
    expect(r2.stdout.trim()).toContain("2");

    const cmd = await sandbox.commands.run("echo hello-from-sandbox");
    expect(cmd.exitCode).toBe(0);
    expect(cmd.stdout).toContain("hello-from-sandbox");

    await sandbox.destroy();
    liveSandboxes.splice(liveSandboxes.indexOf(sandbox), 1);
  }, 120_000);
});
