/**
 * #142 — `POST /api/mcp/approvals/:id/decide` used to let ANY caller holding
 * `mcp.write` answer ANY pending MCP approval, including another user's, and
 * to "decide" one that was no longer pending. Only the owner of the chat
 * session the approval was raised in may answer it, and only while it pends.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import request from "supertest";
import express from "express";

type Row = Record<string, unknown>;
const approvals = new Map<string, Row>();
const sessions: Row[] = [
  { id: "s-alice", userId: "alice", projectId: null, deletedAt: null },
  { id: "s-bob", userId: "bob", projectId: null, deletedAt: null },
];

vi.mock("../src/lib/prisma.js", () => {
  const generic = (): Record<string, unknown> =>
    new Proxy({}, { get: () => vi.fn(async () => null) });
  const models: Record<string, unknown> = {
    mCPToolApproval: {
      create: vi.fn(async ({ data }: { data: Row }) => {
        const row = { id: `mcpa_${approvals.size + 1}`, ...data };
        approvals.set(row.id as string, row);
        return row;
      }),
      findFirst: vi.fn(async ({ where }: { where: Row }) => {
        const row = approvals.get(String(where.id));
        return row && row.status === where.status ? row : null;
      }),
      updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
        const row = approvals.get(String(where.id));
        if (row && row.status === where.status) Object.assign(row, data);
        return { count: row ? 1 : 0 };
      }),
    },
    aISession: {
      findFirst: vi.fn(
        async ({ where }: { where: Row }) =>
          sessions.find((s) => s.id === where.id && s.userId === where.userId) ?? null,
      ),
    },
  };
  return {
    prisma: new Proxy(models, {
      get: (t, k: string) => {
        if (!(k in t)) t[k] = generic();
        return t[k];
      },
    }),
  };
});

import { mcpRouter } from "../src/routes/mcp.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { requestApproval, _resetApprovalsForTests } from "../src/lib/mcp/approval.js";

let alice: string;
let bob: string;
beforeAll(() => {
  const tok = (userId: string) =>
    issueTokens({ userId, username: userId, role: "coordinator", permissions: [] }).accessToken;
  alice = tok("alice");
  bob = tok("bob");
});
afterEach(() => {
  approvals.clear();
  _resetApprovalsForTests();
});

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/mcp", mcpRouter());
  a.use(notFoundHandler);
  a.use(errorHandler);
  return a;
}

const decide = (token: string, id: string, decision = "approved") =>
  request(app())
    .post(`/api/mcp/approvals/${id}/decide`)
    .set("Authorization", `Bearer ${token}`)
    .send({ decision });

describe("#142 MCP approval decisions are owner-only", () => {
  it("another mcp.write user cannot answer it; the owner can, once", async () => {
    const pending = requestApproval({
      sessionId: "s-alice",
      serverId: "srv",
      serverLabel: "srv",
      toolName: "delete_repo",
      args: {},
      risk: "high",
      timeoutMs: 5_000,
    });
    await new Promise((r) => setTimeout(r, 5));
    const id = [...approvals.keys()][0]!;

    expect((await decide(bob, id)).status).toBe(404);
    expect(approvals.get(id)!.status).toBe("pending");

    expect((await decide(alice, id)).status).toBe(200);
    await expect(pending).resolves.toBeUndefined();
    expect(approvals.get(id)!.status).toBe("approved");

    // No longer pending: a replay is refused and cannot flip it.
    expect((await decide(alice, id, "denied")).status).toBe(404);
    expect(approvals.get(id)!.status).toBe("approved");
  });

  it("a made-up id is not found", async () => {
    expect((await decide(alice, "mcpa_nope")).status).toBe(404);
  });
});
