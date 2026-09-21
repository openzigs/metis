/**
 * /api/vault — admin-facing CRUD route gating + happy-path coverage.
 *
 * Mocks `getVaultService()` so the test exercises the route layer's
 * responsibilities (auth, permissions, validation, audit hooks).
 *
 * Epic #196 / #222.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface SecretRow {
  id: string;
  label: string;
  scope: "global" | "project";
  description: string;
  algorithm: string;
  keyVersion: number;
  createdAt: Date;
  updatedAt: Date;
}

const secrets = new Map<string, SecretRow>();
let counter = 0;

const fakeService = {
  list: vi.fn(async () => [...secrets.values()]),
  create: vi.fn(
    async (
      label: string,
      _value: string,
      scope: "global" | "project",
      opts: { description?: string; createdById?: string } = {},
    ) => {
      counter += 1;
      const row: SecretRow = {
        id: `sec_${String(counter).padStart(8, "0")}`,
        label,
        scope,
        description: opts.description ?? "",
        algorithm: "aes-256-gcm",
        keyVersion: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      secrets.set(row.id, row);
      return row;
    },
  ),
  rotate: vi.fn(async (id: string, _value: string) => {
    const row = secrets.get(id);
    if (!row) throw new Error("not found");
    row.keyVersion += 1;
    row.updatedAt = new Date();
    secrets.set(id, row);
    return row;
  }),
  read: vi.fn(async (id: string) => {
    const row = secrets.get(id);
    if (!row) throw new Error("not found");
    return { summary: row, plaintext: "secret-plaintext" };
  }),
  delete: vi.fn(async (id: string) => {
    secrets.delete(id);
  }),
};

vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => fakeService,
}));

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(
        async ({
          create,
        }: {
          create: { username: string; displayName: string; email: string };
        }) => ({
          id: "user_admin",
          ...create,
        }),
      ),
    },
    userRole: {},
    auditLog: {
      create: vi.fn(async () => ({})),
      findMany: vi.fn(async () => [
        {
          id: "audit_1",
          action: "vault.read",
          actorId: "user_admin",
          ts: new Date("2026-04-25T12:30:00Z"),
          metadata: null,
          targetType: "secret",
          targetId: "sec_00000001",
        },
      ]),
    },
  });
  return { prisma };
});

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  secrets.clear();
  counter = 0;
  vi.clearAllMocks();
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("/api/vault", () => {
  it("rejects unauthenticated requests", async () => {
    const res = await request(app).get("/api/vault");
    expect(res.status).toBe(401);
  });

  it("admin can list (initially empty)", async () => {
    const token = await login("admin");
    const res = await request(app).get("/api/vault").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.items).toEqual([]);
  });

  it("admin can create + rotate + reveal + delete an entry", async () => {
    const token = await login("admin");
    const create = await request(app)
      .post("/api/vault")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "github-pat", value: "ghp_abc1234567890", scope: "global" });
    expect(create.status).toBe(201);
    expect(create.body.data).not.toHaveProperty("plaintext");
    const id = create.body.data.id as string;

    const rotate = await request(app)
      .post(`/api/vault/${id}/rotate`)
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "ghp_new_value" });
    expect(rotate.status).toBe(200);
    expect(rotate.body.data.keyVersion).toBe(2);

    const reveal = await request(app)
      .get(`/api/vault/${id}/reveal`)
      .set("Authorization", `Bearer ${token}`);
    expect(reveal.status).toBe(200);
    expect(reveal.body.data.plaintext).toBe("secret-plaintext");

    const audit = await request(app)
      .get(`/api/vault/${id}/audit`)
      .set("Authorization", `Bearer ${token}`);
    expect(audit.status).toBe(200);
    expect(audit.body.data.items[0].action).toBe("vault.read");

    const del = await request(app)
      .delete(`/api/vault/${id}`)
      .set("Authorization", `Bearer ${token}`);
    expect(del.status).toBe(204);
  });

  it("rejects an invalid label", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/vault")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "bad label!", value: "v", scope: "global" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_BODY");
  });

  it("returns 404 when rotating an unknown id", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/vault/unknown/rotate")
      .set("Authorization", `Bearer ${token}`)
      .send({ value: "v" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when deleting an unknown id", async () => {
    const token = await login("admin");
    const res = await request(app)
      .delete("/api/vault/unknown")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
  });
});
