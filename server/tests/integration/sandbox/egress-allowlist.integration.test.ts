/**
 * Epic #395 #414 — Egress allowlist live integration test.
 *
 * Drives a real E2B sandbox through the deny-by-default firewall path
 * and asserts:
 *   - `curl https://example.com` SUCCEEDS when `example.com` is in the
 *     per-call egress allowlist.
 *   - `curl https://example.org` FAILS when `example.org` is NOT in the
 *     allowlist (default-deny, system list does not include it).
 *
 * This is the live-network counterpart of the dual-shape silent-degrade
 * unit tests in `tests/lib/sandbox/e2b/firewall.test.ts` — it confirms
 * the chosen SDK shape actually applies the policy on the wire.
 *
 * Gated behind RUN_INTEGRATION_TESTS=1 AND a valid `E2B_API_KEY`.
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
    return {
      id: `r-${this.rows.length + 1}`,
      sessionId: input.sessionId,
      eventType: input.eventType,
      payload: JSON.stringify(input.payload ?? {}),
      timestamp: new Date(),
    };
  }
  async listForSession(): Promise<SandboxAuditEventRow[]> {
    return [];
  }
  async countForSession(): Promise<number> {
    return 0;
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

describeMaybe("E2B egress allowlist enforcement (live SDK)", () => {
  function makeProvider(): E2BSandboxProvider {
    return new E2BSandboxProvider({
      sessionRepo: new StubSessionRepo(),
      emitter: new SandboxAuditEmitter(new StubAuditRepo()),
    });
  }

  it("ALLOWS curl to a host on the per-call egress allowlist", async () => {
    const provider = makeProvider();
    const sandbox = await provider.create({
      projectId: "egress-allow-1",
      egressAllowlist: ["example.com"],
      timeoutMs: 60_000,
    });
    liveSandboxes.push(sandbox);
    const result = await sandbox.commands.run(
      "curl --max-time 10 -sS -o /dev/null -w '%{http_code}' https://example.com",
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toMatch(/^(2\d{2}|3\d{2})$/);
    await sandbox.destroy();
    liveSandboxes.splice(liveSandboxes.indexOf(sandbox), 1);
  }, 120_000);

  it("BLOCKS curl to a host that is NOT on the allowlist (deny-by-default)", async () => {
    const provider = makeProvider();
    const sandbox = await provider.create({
      projectId: "egress-deny-1",
      // Deliberately omit example.org — system defaults do not include it.
      egressAllowlist: ["example.com"],
      timeoutMs: 60_000,
    });
    liveSandboxes.push(sandbox);
    const result = await sandbox.commands.run(
      "curl --max-time 10 -sS -o /dev/null -w '%{http_code}' https://example.org",
    );
    // Either the curl exits non-zero (network blocked) OR returns 000
    // (could not establish connection). Both are valid "blocked" signals.
    const blocked = result.exitCode !== 0 || result.stdout.trim() === "000";
    expect(blocked).toBe(true);
    await sandbox.destroy();
    liveSandboxes.splice(liveSandboxes.indexOf(sandbox), 1);
  }, 120_000);
});
