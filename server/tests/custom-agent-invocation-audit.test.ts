/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Epic #260 (#83) — per-invocation audit row.
 *
 * Every playground invocation persists a SOC 2 audit row capturing who, which
 * agent, which project, timestamp, and outcome. Reuses the existing audit
 * service (we assert via the singleton's recordAndFlush -> prisma.auditLog).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const created: any[] = [];
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: {
      create: vi.fn(async ({ data }: any) => {
        created.push(data);
        return data;
      }),
    },
  },
}));

const { auditInvocation } = await import("../src/lib/custom-agents/invocation-audit.js");
const { __resetAuditSingleton, getAuditService } =
  await import("../src/lib/audit/audit-service.js");

beforeEach(() => {
  created.length = 0;
  __resetAuditSingleton();
});
afterEach(() => vi.restoreAllMocks());

describe("auditInvocation (#83)", () => {
  it("records a success row with actor, agent, project, and outcome", async () => {
    auditInvocation({
      actorId: "u1",
      agentId: "ag1",
      projectId: "p1",
      outcome: "success",
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
    });
    // flush the queued microtask write
    await new Promise((r) => setTimeout(r, 0));
    expect(getAuditService().inFlight).toBe(0);
    expect(created).toHaveLength(1);
    const row = created[0];
    expect(row.action).toBe("custom_agent.invoked");
    expect(row.actorId).toBe("u1");
    expect(row.targetType).toBe("custom_agent");
    expect(row.targetId).toBe("ag1");
    const meta = JSON.parse(row.metadata);
    expect(meta.projectId).toBe("p1");
    expect(meta.outcome).toBe("success");
    // #1268 — these were `promptUsage`/`completionUsage`/`totalUsage` until the
    // audit redactor learned the numeric-count exemption. The rename existed
    // only to dodge `/token/i`, and this assertion is what pinned it in place:
    // asserting the *workaround's* shape rather than the behaviour it bought.
    expect(meta.promptTokens).toBe(1);
    expect(meta.completionTokens).toBe(2);
    expect(meta.totalTokens).toBe(3);
    expect(meta.totalUsage).toBeUndefined();
  });

  it("persists the counts in the clear — not [REDACTED] (#1268)", async () => {
    auditInvocation({
      actorId: "u1",
      agentId: "ag1",
      projectId: "p1",
      outcome: "success",
      usage: { promptTokens: 1024, completionTokens: 2048, totalTokens: 3072 },
    });
    await new Promise((r) => setTimeout(r, 0));
    const meta = JSON.parse(created[0].metadata);
    for (const key of ["promptTokens", "completionTokens", "totalTokens"]) {
      expect(meta[key], `${key} must reach the audit row as a number`).not.toBe("[REDACTED]");
      expect(typeof meta[key]).toBe("number");
    }
  });

  it("records a failure row with the error reason", async () => {
    auditInvocation({
      actorId: "u1",
      agentId: "ag1",
      projectId: "p1",
      outcome: "error",
      error: "provider timeout",
    });
    await new Promise((r) => setTimeout(r, 0));
    const meta = JSON.parse(created[0].metadata);
    expect(meta.outcome).toBe("error");
    expect(meta.error).toBe("provider timeout");
  });

  it("records a denied row under the custom_agent.invoke_denied action", async () => {
    auditInvocation({
      actorId: "u1",
      agentId: "ag1",
      projectId: "p1",
      outcome: "denied",
      error: "agent not enabled for project",
    });
    await new Promise((r) => setTimeout(r, 0));
    const row = created[0];
    expect(row.action).toBe("custom_agent.invoke_denied");
    const meta = JSON.parse(row.metadata);
    expect(meta.outcome).toBe("denied");
    expect(meta.error).toBe("agent not enabled for project");
  });

  it("tolerates a null actor (system-initiated)", async () => {
    auditInvocation({ actorId: null, agentId: "ag1", projectId: "p1", outcome: "success" });
    await new Promise((r) => setTimeout(r, 0));
    expect(created[0].actorId).toBeNull();
  });
});
