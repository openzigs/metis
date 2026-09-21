/**
 * /api/acp/* token-management routes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

vi.mock("../src/lib/prisma.js", () => {
  const rows = new Map<
    string,
    {
      id: string;
      userId: string;
      name: string;
      prefix: string;
      tokenHash: string;
      scopes: string;
      createdAt: Date;
      lastUsedAt: Date | null;
      expiresAt: Date | null;
      revokedAt: Date | null;
    }
  >();
  let nextId = 0;
  return {
    prisma: {
      apiToken: {
        create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
          nextId += 1;
          const row = {
            id: `tok_${nextId}`,
            userId: data.userId as string,
            name: data.name as string,
            prefix: data.prefix as string,
            tokenHash: data.tokenHash as string,
            scopes: data.scopes as string,
            createdAt: new Date(),
            lastUsedAt: null,
            expiresAt: (data.expiresAt as Date | null) ?? null,
            revokedAt: null,
          };
          rows.set(row.id, row);
          return row;
        }),
        findMany: vi.fn(async ({ where }: { where: { userId: string } }) =>
          Array.from(rows.values()).filter((r) => r.userId === where.userId),
        ),
        findUnique: vi.fn(async ({ where }: { where: { id?: string } }) =>
          where.id ? (rows.get(where.id) ?? null) : null,
        ),
        update: vi.fn(
          async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
            const r = rows.get(where.id);
            if (!r) throw new Error("not found");
            const next = { ...r, ...data } as typeof r;
            rows.set(where.id, next);
            return next;
          },
        ),
      },
    },
  };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import { acpRouter } from "../src/routes/acp.js";
import { errorHandler, notFoundHandler } from "../src/middleware/error-handler.js";
import { issueTokens } from "../src/lib/auth/jwt.js";

let token: string;
beforeAll(() => {
  token = issueTokens({
    userId: "u1",
    username: "alice",
    role: "developer",
    permissions: [],
  }).accessToken;
});

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/acp", acpRouter());
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

const auth = (r: request.Test): request.Test => r.set("Authorization", `Bearer ${token}`);

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => vi.clearAllMocks());

describe("/api/acp/tokens", () => {
  it("requires auth", async () => {
    const res = await request(makeApp()).get("/api/acp/tokens");
    expect(res.status).toBe(401);
  });

  it("creates, lists, and revokes a token", async () => {
    const create = await auth(request(makeApp()).post("/api/acp/tokens").send({ name: "ci" }));
    expect(create.status).toBe(201);
    expect(create.body.data.token).toMatch(/^metis_/);
    const id = create.body.data.id as string;

    const list = await auth(request(makeApp()).get("/api/acp/tokens"));
    expect(list.status).toBe(200);
    expect(list.body.data.find((t: { id: string }) => t.id === id)).toBeDefined();

    const revoke = await auth(request(makeApp()).delete(`/api/acp/tokens/${id}`));
    expect(revoke.status).toBe(200);
    expect(revoke.body.data.revokedAt).not.toBeNull();
  });

  it("validates the create payload", async () => {
    const res = await auth(request(makeApp()).post("/api/acp/tokens").send({}));
    expect(res.status).toBe(400);
  });

  it("returns 404 when revoking a missing token", async () => {
    const res = await auth(request(makeApp()).delete("/api/acp/tokens/nope"));
    expect(res.status).toBe(404);
  });
});
