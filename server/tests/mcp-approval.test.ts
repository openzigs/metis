/**
 * Issue #104 — per-tool, per-session approval gate.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const approvalRows = new Map<
  string,
  {
    id: string;
    sessionId: string;
    serverId: string;
    toolName: string;
    args: string | null;
    status: string;
    decidedBy: string | null;
    decidedAt: Date | null;
  }
>();
let seq = 0;

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    mCPToolApproval: {
      create: vi.fn(
        async ({
          data,
        }: {
          data: {
            sessionId: string;
            serverId: string;
            toolName: string;
            args: string | null;
            status: string;
          };
        }) => {
          seq += 1;
          const id = `apv_${seq}`;
          const row = { id, ...data, decidedBy: null, decidedAt: null };
          approvalRows.set(id, row);
          return { ...row, createdAt: new Date() };
        },
      ),
      updateMany: vi.fn(
        async ({
          where,
          data,
        }: {
          where: { id: string; status: string };
          data: { status: string; decidedAt: Date; decidedBy: string | null };
        }) => {
          const row = approvalRows.get(where.id);
          if (!row || row.status !== where.status) return { count: 0 };
          row.status = data.status;
          row.decidedAt = data.decidedAt;
          row.decidedBy = data.decidedBy;
          approvalRows.set(where.id, row);
          return { count: 1 };
        },
      ),
    },
  },
}));

import {
  _resetApprovalsForTests,
  decideApproval,
  McpApprovalDeniedError,
  requestApproval,
  setApprovalNotifier,
  getPendingApprovalCount,
} from "../src/lib/mcp/approval.js";

beforeEach(() => {
  approvalRows.clear();
  seq = 0;
  _resetApprovalsForTests();
});
afterEach(() => {
  setApprovalNotifier(null);
  _resetApprovalsForTests();
});

describe("requestApproval", () => {
  it("emits an approval event with hidden-char ranges and resolves on approve", async () => {
    const events: unknown[] = [];
    setApprovalNotifier({
      emit: (e) => events.push(e),
      emitDecision: (e) => events.push(e),
    });
    const promise = requestApproval({
      sessionId: "sess-1",
      serverId: "srv-1",
      serverLabel: "github",
      toolName: "create_issue",
      args: { title: "hello\u200bworld" },
      risk: "high",
      timeoutMs: 5_000,
    });
    // Yield so the create + setTimeout both fire before we assert.
    await waitForCondition(() => events.length > 0);
    expect(getPendingApprovalCount()).toBe(1);
    const apvId = approvalRows.keys().next().value!;
    const requested = events[0] as { hiddenCharRanges: Array<{ label: string }> };
    expect(requested.hiddenCharRanges.some((r) => r.label === "ZWSP")).toBe(true);

    await decideApproval(apvId, "approved", "user-1");
    await promise;
    expect(approvalRows.get(apvId)?.status).toBe("approved");
    expect(approvalRows.get(apvId)?.decidedBy).toBe("user-1");
    expect(getPendingApprovalCount()).toBe(0);
    expect(events.some((e) => (e as { decision?: string }).decision === "approved")).toBe(true);
  });

  it("rejects with McpApprovalDeniedError when denied", async () => {
    setApprovalNotifier({ emit: () => {}, emitDecision: () => {} });
    const promise = requestApproval({
      sessionId: "sess-1",
      serverId: "srv-1",
      serverLabel: "fs",
      toolName: "read",
      args: {},
      risk: "low",
      timeoutMs: 5_000,
    });
    promise.catch(() => undefined);
    await waitForCondition(() => approvalRows.size > 0);
    const apvId = approvalRows.keys().next().value!;
    await decideApproval(apvId, "denied", null);
    await expect(promise).rejects.toMatchObject({
      name: "McpApprovalDeniedError",
      reason: "denied",
      code: "tool_denied",
    });
    expect(approvalRows.get(apvId)?.status).toBe("denied");
  });

  it("times out to denial when no decision arrives in time", async () => {
    setApprovalNotifier({ emit: () => {}, emitDecision: () => {} });
    const promise = requestApproval({
      sessionId: "sess-1",
      serverId: "srv-1",
      serverLabel: "github",
      toolName: "destroy",
      args: {},
      risk: "high",
      timeoutMs: 10,
    });
    await expect(promise).rejects.toMatchObject({
      name: "McpApprovalDeniedError",
      reason: "timeout",
    });
    // Give the finalize() update a tick to land.
    await waitForCondition(() => approvalRows.values().next().value?.status === "timeout");
    const apvId = approvalRows.keys().next().value!;
    expect(approvalRows.get(apvId)?.status).toBe("timeout");
  });
});

async function waitForCondition(fn: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!fn()) {
    if (Date.now() - start > timeoutMs) throw new Error("waitForCondition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe("McpApprovalDeniedError", () => {
  it("carries the structured tool_denied code", () => {
    const e = new McpApprovalDeniedError("apv-1", "denied");
    expect(e.code).toBe("tool_denied");
    expect(e.reason).toBe("denied");
    expect(e.approvalId).toBe("apv-1");
  });
});
