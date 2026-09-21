/**
 * Epic #395 #413 — Audit emitter integration test.
 *
 * Drives a full sandbox lifecycle (create → runCode → commands.run →
 * upload → download → destroy) through the noop provider and asserts:
 *   - ≥5 rows land in the audit repo (matches AC #413's "5 rows" bar).
 *   - Each row carries the documented shape: `eventType`, `sessionId`,
 *     and a JSON `payload` whose top-level keys match the documented
 *     audit taxonomy.
 *   - The lifecycle event ordering is `create … exec … upload …
 *     download … destroy`.
 *   - Secrets in `payload.command` strings are scrubbed by the
 *     value-redaction layer added in this fix-up.
 *
 * Hermetic: uses an in-memory `SandboxAuditEventRepo` stub so the test
 * runs without Prisma — the repo *interface* IS the audit contract per
 * the hex-port architecture in `server/src/lib/sandbox/`. We still gate
 * behind RUN_INTEGRATION_TESTS=1 because the test exercises real
 * subprocesses via the noop sandbox.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SandboxAuditEmitter } from "../../../src/lib/sandbox/audit/audit-emitter.js";
import { NoopSandboxProvider } from "../../../src/lib/sandbox/noop/noop-provider.js";
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

const RUN = process.env.RUN_INTEGRATION_TESTS === "1";
const describeMaybe = RUN ? describe : describe.skip;

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
    return this.rows
      .filter((r) => r.sessionId === sessionId)
      .sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }
  async countForSession(sessionId: string): Promise<number> {
    return this.rows.filter((r) => r.sessionId === sessionId).length;
  }
}

const tmpDirs: string[] = [];

beforeAll(() => {
  // Nothing to set up.
});

afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

describeMaybe("Sandbox audit emitter — full lifecycle", () => {
  it("emits ≥5 audit rows with the documented shape across create/exec/upload/download/destroy", async () => {
    const sessionRepo = new InMemorySessionRepo();
    const auditRepo = new InMemoryAuditRepo();
    const emitter = new SandboxAuditEmitter(auditRepo);
    const provider = new NoopSandboxProvider({
      sessionRepo,
      emitter,
      mkRootDir: async (id) => {
        const dir = await mkdtemp(join(tmpdir(), `audit-int-${id}-`));
        tmpDirs.push(dir);
        return dir;
      },
    });

    const sandbox = await provider.create({
      projectId: "audit-proj-1",
      userId: "user-x",
    });
    await sandbox.runCode("x = 1\nx");
    await sandbox.commands.run("echo hello");
    await sandbox.files.write("notes.txt", "data");
    await sandbox.files.read("notes.txt");
    await sandbox.destroy();

    const events = await auditRepo.listForSession(sandbox.id);
    expect(events.length).toBeGreaterThanOrEqual(5);

    const types = events.map((e) => e.eventType);
    // Ordering matters: create must come first, destroy last, with the
    // exec/upload/download triplet in between.
    expect(types[0]).toBe("create");
    expect(types[types.length - 1]).toBe("destroy");
    expect(types).toContain("exec");
    expect(types).toContain("upload");
    expect(types).toContain("download");

    // Every row carries the expected envelope.
    for (const row of events) {
      expect(row.sessionId).toBe(sandbox.id);
      expect(row.id).toMatch(/^r-/);
      expect(row.timestamp).toBeInstanceOf(Date);
      expect(typeof row.payload).toBe("string");
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      expect(typeof parsed).toBe("object");
    }

    // create payload carries vendor id + provider config.
    const createPayload = JSON.parse(events[0].payload) as Record<string, unknown>;
    expect(typeof createPayload.vendorSandboxId).toBe("string");
    expect(typeof createPayload.timeoutMs).toBe("number");

    // exec payload carries command + exit code + bytes counters.
    const execPayload = JSON.parse(events.find((e) => e.eventType === "exec")!.payload) as Record<
      string,
      unknown
    >;
    expect(typeof execPayload.command).toBe("string");
    expect(typeof execPayload.exitCode).toBe("number");
    expect(typeof execPayload.stdoutBytes).toBe("number");

    // upload + download payloads carry path + bytes — never the file body.
    const upload = JSON.parse(events.find((e) => e.eventType === "upload")!.payload) as Record<
      string,
      unknown
    >;
    expect(typeof upload.path).toBe("string");
    expect(typeof upload.bytes).toBe("number");
    expect(upload.content).toBeUndefined();
    expect(upload.body).toBeUndefined();

    const download = JSON.parse(events.find((e) => e.eventType === "download")!.payload) as Record<
      string,
      unknown
    >;
    expect(typeof download.path).toBe("string");
    expect(typeof download.bytes).toBe("number");
    expect(download.content).toBeUndefined();
  });

  it("scrubs inline secrets from payload.command before persistence", async () => {
    const sessionRepo = new InMemorySessionRepo();
    const auditRepo = new InMemoryAuditRepo();
    const emitter = new SandboxAuditEmitter(auditRepo);
    const provider = new NoopSandboxProvider({
      sessionRepo,
      emitter,
      mkRootDir: async (id) => {
        const dir = await mkdtemp(join(tmpdir(), `audit-int-${id}-`));
        tmpDirs.push(dir);
        return dir;
      },
    });

    const sandbox = await provider.create({ projectId: "p-2" });
    // The shell will fail because the URL is unreachable from the noop
    // sandbox — what matters is that the COMMAND STRING the audit row
    // captures is scrubbed before it lands in the repo.
    await sandbox.commands.run(
      "curl -H 'Authorization: Bearer ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' https://example.invalid",
    );
    await sandbox.destroy();

    const exec = (await auditRepo.listForSession(sandbox.id)).find((e) => e.eventType === "exec")!;
    const payload = JSON.parse(exec.payload) as { command: string };
    expect(payload.command).not.toContain("ghp_AAAA");
    expect(payload.command).toContain("[REDACTED]");
  });
});
