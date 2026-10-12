/**
 * Issue #1007 — `GET /api/runs/chat-turns`: chat turns read from the usage
 * ledger, scoped to the caller's projects exactly like `GET /api/runs`.
 *
 * The ledger read is faked by evaluating the `where` the route built against
 * rows of two projects, so dropping the project narrowing from production lets
 * the other tenant's row through and these go red.
 */
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface LedgerRow {
  id: string;
  projectId: string;
  sessionId: string;
  agentStep: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  requestTokens: string | null;
  costCents: number | null;
  costUsd: number | null;
  createdAt: Date;
}

const ledger: LedgerRow[] = [];
const { tokenUsageFindMany, agentRunFindUnique, projectFindMany, projectFindUnique } = vi.hoisted(
  () => ({
    tokenUsageFindMany: vi.fn(),
    agentRunFindUnique: vi.fn(async () => null),
    projectFindMany: vi.fn(async () => [] as Array<{ id: string }>),
    projectFindUnique: vi.fn(),
  }),
);

function matches(row: LedgerRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, cond]) => {
    if (!(key in row)) throw new Error(`fake ledger: unknown field ${key}`);
    const value = row[key as keyof LedgerRow];
    if (cond === null || typeof cond !== "object" || cond instanceof Date) return value === cond;
    return Object.entries(cond as Record<string, unknown>).every(([op, arg]) => {
      if (op === "in") return (arg as unknown[]).includes(value);
      if (op === "gte") return (value as Date) >= (arg as Date);
      if (op === "lte") return (value as Date) <= (arg as Date);
      throw new Error(`fake ledger: unsupported operator ${op}`);
    });
  });
}

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique, findMany: projectFindMany },
    agentRun: { findUnique: agentRunFindUnique, findMany: vi.fn(async () => []) },
    tokenUsage: { findMany: tokenUsageFindMany },
  },
}));

import express from "express";
import request from "supertest";
import { getPermissionsForRole } from "@metis/shared";
import { errorHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";
import { runsRouter } from "../src/routes/runs.js";

let adminToken: string;
let developerToken: string;

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/runs", runsRouter());
  app.use(errorHandler);
  return app;
}

const get = (path: string, token?: string) => {
  const req = request(makeApp()).get(path);
  return token ? req.set("Authorization", `Bearer ${token}`) : req;
};

function row(id: string, projectId: string, sessionId: string, minute: number): LedgerRow {
  return {
    id,
    projectId,
    sessionId,
    agentStep: "chat",
    provider: "anthropic",
    model: "claude-3-5-sonnet",
    inputTokens: 1_000,
    outputTokens: 100,
    cacheReadTokens: 400,
    cacheWriteTokens: 0,
    requestTokens: null,
    costCents: 0,
    costUsd: 0.00462,
    createdAt: new Date(Date.UTC(2026, 9, 9, 10, minute)),
  };
}

beforeAll(() => {
  adminToken = issueTokens({
    userId: "u1",
    username: "admin",
    role: "admin",
    permissions: getPermissionsForRole("admin"),
  }).accessToken;
  developerToken = issueTokens({
    userId: "u_dev",
    username: "developer",
    role: "developer",
    permissions: getPermissionsForRole("developer"),
  }).accessToken;
});

beforeEach(() => {
  vi.clearAllMocks();
  ledger.length = 0;
  ledger.push(
    row("t-mine", "p-mine", "chat-mine", 1),
    row("t-theirs", "p-theirs", "chat-theirs", 2),
    { ...row("t-analysis", "p-mine", "an-1", 3), agentStep: "analysis" },
  );
  tokenUsageFindMany.mockImplementation(
    async ({ where, take }: { where: Record<string, unknown>; take: number }) =>
      ledger
        .filter((r) => matches(r, where))
        .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
        .slice(0, take),
  );
  // The developer can reach `p-mine` only.
  projectFindMany.mockResolvedValue([{ id: "p-mine" }]);
  projectFindUnique.mockImplementation(async ({ where }: { where: { id: string } }) =>
    where.id === "p-mine" ? { workspaceId: null, workspace: null } : null,
  );
});

describe("GET /api/runs/chat-turns (#1007)", () => {
  it("requires authentication", async () => {
    expect((await get("/api/runs/chat-turns")).status).toBe(401);
    expect(tokenUsageFindMany).not.toHaveBeenCalled();
  });

  it("is not answered by the run-by-id route", async () => {
    const res = await get("/api/runs/chat-turns", adminToken);
    expect(res.status).toBe(200);
    expect(agentRunFindUnique).not.toHaveBeenCalled();
  });

  it("lists chat turns with ledger tokens and the exact cost, and no analysis row", async () => {
    const res = await get("/api/runs/chat-turns", adminToken);
    expect(res.body.data.items.map((t: { id: string }) => t.id)).toEqual(["t-theirs", "t-mine"]);
    expect(res.body.data.items[1]).toMatchObject({
      id: "t-mine",
      sessionId: "chat-mine",
      projectId: "p-mine",
      step: "chat",
      model: "claude-3-5-sonnet",
      requests: 1,
      tokens: { withoutCache: 1_100, withCache: 1_500 },
      costUsd: 0.00462,
    });
    // No message content, only the ledger's figures.
    expect(Object.keys(res.body.data.items[1]).sort()).toEqual([
      "costUsd",
      "createdAt",
      "id",
      "model",
      "projectId",
      "provider",
      "requests",
      "sessionId",
      "step",
      "tokens",
    ]);
  });

  it("narrows a non-admin to their own projects", async () => {
    const res = await get("/api/runs/chat-turns", developerToken);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((t: { id: string }) => t.id)).toEqual(["t-mine"]);
  });

  it("does not surface another tenant's turn by its session id", async () => {
    const res = await get("/api/runs/chat-turns?sessionId=chat-theirs", developerToken);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
    // The same request from an admin finds it: the filter itself works.
    const asAdmin = await get("/api/runs/chat-turns?sessionId=chat-theirs", adminToken);
    expect(asAdmin.body.data.items).toHaveLength(1);
  });

  it("404s an explicit project the caller cannot reach, before reading the ledger", async () => {
    const res = await get("/api/runs/chat-turns?projectId=p-theirs", developerToken);
    expect(res.status).toBe(404);
    expect(tokenUsageFindMany).not.toHaveBeenCalled();
  });

  it("answers for an explicit project the caller can reach", async () => {
    const res = await get("/api/runs/chat-turns?projectId=p-mine", developerToken);
    expect(res.status).toBe(200);
    expect(res.body.data.items.map((t: { id: string }) => t.id)).toEqual(["t-mine"]);
  });

  it("applies the date range and a bounded limit; a bad limit falls back to the default", async () => {
    ledger.push(row("t-mine-2", "p-mine", "chat-mine", 30));
    const ranged = await get(
      "/api/runs/chat-turns?from=2026-10-09T10:20:00Z&to=2026-10-09T11:00:00Z",
      adminToken,
    );
    expect(ranged.body.data.items.map((t: { id: string }) => t.id)).toEqual(["t-mine-2"]);

    await get("/api/runs/chat-turns?limit=1", adminToken);
    await get("/api/runs/chat-turns?limit=5000", adminToken);
    await get("/api/runs/chat-turns?limit=abc", adminToken);
    await get("/api/runs/chat-turns?limit=-3", adminToken);
    expect(
      tokenUsageFindMany.mock.calls.slice(1).map((c) => (c[0] as { take: number }).take),
    ).toEqual([1, 200, 50, 50]);
  });
});
