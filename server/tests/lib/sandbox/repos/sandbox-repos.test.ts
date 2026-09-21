/**
 * Tests for the SandboxSession + SandboxAuditEvent repos (Epic #395 #410).
 *
 * Uses `vi.mock("../../../../src/lib/prisma.js")` per the project
 * convention — the unit gate must not touch a real database.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/lib/prisma.js", () => {
  const sessionTable = new Map<string, Record<string, unknown>>();
  const auditTable: Array<Record<string, unknown>> = [];
  let nextId = 1;
  return {
    prisma: {
      sandboxSession: {
        async create({ data }: { data: Record<string, unknown> }) {
          const id = `mock-sess-${nextId++}`;
          const row: Record<string, unknown> = {
            id,
            projectId: data.projectId,
            userId: data.userId ?? null,
            provider: data.provider,
            vendorSandboxId: data.vendorSandboxId,
            templateId: data.templateId ?? null,
            vCpus: data.vCpus,
            memMiB: data.memMiB,
            createdAt: new Date(),
            destroyedAt: null,
            wallClockMs: null,
            cpuTimeMs: null,
            costMicroUsd: null,
            runId: null,
            outcome: null,
            errorMessage: null,
          };
          sessionTable.set(id, row);
          return row;
        },
        async update({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
          const row = sessionTable.get(where.id);
          if (!row) throw new Error("not found");
          Object.assign(row, data);
          return row;
        },
        async findUnique({ where }: { where: { id: string } }) {
          return sessionTable.get(where.id) ?? null;
        },
        async findMany({ where, take }: { where: { projectId: string }; take?: number }) {
          const rows = Array.from(sessionTable.values())
            .filter((r) => r.projectId === where.projectId)
            .sort((a, b) => (b.createdAt as Date).getTime() - (a.createdAt as Date).getTime());
          return take ? rows.slice(0, take) : rows;
        },
      },
      sandboxAuditEvent: {
        async create({ data }: { data: Record<string, unknown> }) {
          const row: Record<string, unknown> = {
            id: `mock-audit-${nextId++}`,
            sessionId: data.sessionId,
            eventType: data.eventType,
            payload: data.payload,
            timestamp: new Date(),
          };
          auditTable.push(row);
          return row;
        },
        async findMany({ where }: { where: { sessionId: string } }) {
          return auditTable
            .filter((r) => r.sessionId === where.sessionId)
            .sort((a, b) => (a.timestamp as Date).getTime() - (b.timestamp as Date).getTime());
        },
        async count({ where }: { where: { sessionId: string } }) {
          return auditTable.filter((r) => r.sessionId === where.sessionId).length;
        },
      },
      __reset() {
        sessionTable.clear();
        auditTable.length = 0;
        nextId = 1;
      },
    },
  };
});

import { prisma } from "../../../../src/lib/prisma.js";
import { SandboxAuditEventRepo } from "../../../../src/lib/sandbox/repos/sandbox-audit-event.repo.js";
import { SandboxSessionRepo } from "../../../../src/lib/sandbox/repos/sandbox-session.repo.js";

beforeEach(() => {
  (prisma as unknown as { __reset: () => void }).__reset();
});

describe("SandboxSessionRepo", () => {
  it("starts and finalises a session row", async () => {
    const repo = new SandboxSessionRepo();
    const row = await repo.start({
      projectId: "p-1",
      userId: "u-1",
      provider: "noop",
      vendorSandboxId: "vendor-1",
      vCpus: 2,
      memMiB: 1024,
    });
    expect(row.outcome).toBeNull();
    const finalised = await repo.finalize(row.id, {
      destroyedAt: new Date(),
      wallClockMs: 123,
      outcome: "completed",
    });
    expect(finalised.outcome).toBe("completed");
    expect(finalised.wallClockMs).toBe(123);
  });

  it("listForProject returns rows scoped to the project", async () => {
    const repo = new SandboxSessionRepo();
    const a = await repo.start({
      projectId: "p-A",
      provider: "noop",
      vendorSandboxId: "v-1",
      vCpus: 1,
      memMiB: 512,
    });
    await repo.start({
      projectId: "p-B",
      provider: "noop",
      vendorSandboxId: "v-2",
      vCpus: 1,
      memMiB: 512,
    });
    const list = await repo.listForProject("p-A");
    expect(list.map((r) => r.id)).toEqual([a.id]);
  });

  it("findById returns null for unknown ids", async () => {
    const repo = new SandboxSessionRepo();
    expect(await repo.findById("nope")).toBeNull();
  });

  it("normalises null userId and templateId on insert", async () => {
    const repo = new SandboxSessionRepo();
    const row = await repo.start({
      projectId: "p-1",
      provider: "noop",
      vendorSandboxId: "v-1",
      vCpus: 1,
      memMiB: 512,
    });
    expect(row.userId).toBeNull();
    expect(row.templateId).toBeNull();
  });
});

describe("SandboxAuditEventRepo (append-only)", () => {
  it("appends and lists in timestamp order", async () => {
    const sessionRepo = new SandboxSessionRepo();
    const auditRepo = new SandboxAuditEventRepo();
    const session = await sessionRepo.start({
      projectId: "p-1",
      provider: "noop",
      vendorSandboxId: "v-1",
      vCpus: 1,
      memMiB: 512,
    });
    await auditRepo.append({
      sessionId: session.id,
      eventType: "create",
      payload: {},
    });
    await auditRepo.append({
      sessionId: session.id,
      eventType: "exec",
      payload: { command: "true", exitCode: 0 },
    });
    await auditRepo.append({
      sessionId: session.id,
      eventType: "destroy",
      payload: {},
    });
    const events = await auditRepo.listForSession(session.id);
    expect(events.map((e) => e.eventType)).toEqual(["create", "exec", "destroy"]);
    expect(await auditRepo.countForSession(session.id)).toBe(3);
  });

  it("payload is stored as a JSON-encoded string (not native JSON)", async () => {
    const sessionRepo = new SandboxSessionRepo();
    const auditRepo = new SandboxAuditEventRepo();
    const session = await sessionRepo.start({
      projectId: "p-1",
      provider: "noop",
      vendorSandboxId: "v-1",
      vCpus: 1,
      memMiB: 512,
    });
    await auditRepo.append({
      sessionId: session.id,
      eventType: "exec",
      payload: { command: "echo", exitCode: 0 },
    });
    const events = await auditRepo.listForSession(session.id);
    expect(typeof events[0].payload).toBe("string");
    expect(JSON.parse(events[0].payload as string)).toEqual({
      command: "echo",
      exitCode: 0,
    });
  });

  it("does NOT expose update/delete methods (append-only contract)", () => {
    const repo = new SandboxAuditEventRepo();
    expect((repo as unknown as Record<string, unknown>).update).toBeUndefined();
    expect((repo as unknown as Record<string, unknown>).delete).toBeUndefined();
  });

  it("countForSession returns 0 for unknown sessions", async () => {
    const repo = new SandboxAuditEventRepo();
    expect(await repo.countForSession("does-not-exist")).toBe(0);
  });
});
