/**
 * Phase 12 — settings env-vars endpoint tests.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
          id: `user_${create.username}`,
          ...create,
        }),
      ),
      findUnique: vi.fn(async ({ where }: { where: { username?: string; id?: string } }) => ({
        id: `user_${where.username ?? where.id}`,
        username: where.username ?? "x",
        displayName: where.username ?? "x",
        email: `${where.username ?? "x"}@x`,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    project: { findMany: vi.fn(async () => []) },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import request from "supertest";
import { createApp } from "../src/app.js";
import { listRedactedEnv } from "../src/lib/settings/env-vars.js";

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
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("listRedactedEnv", () => {
  it("redacts values for SECRET_ENV_VARS that are set", () => {
    const rows = listRedactedEnv({
      OPENAI_API_KEY: "sk-12345",
      NODE_ENV: "test",
    });
    const openai = rows.find((r) => r.key === "OPENAI_API_KEY");
    expect(openai).toBeDefined();
    expect(openai?.classification).toBe("secret");
    expect(openai?.value).toBe("[REDACTED]");
    expect(openai?.set).toBe(true);
  });

  it("shows public env vars verbatim", () => {
    const rows = listRedactedEnv({ NODE_ENV: "production", LOG_LEVEL: "info" });
    const node = rows.find((r) => r.key === "NODE_ENV");
    expect(node?.value).toBe("production");
    expect(node?.classification).toBe("public");
  });

  it("marks unset secrets as [unset]", () => {
    const rows = listRedactedEnv({});
    const openai = rows.find((r) => r.key === "OPENAI_API_KEY");
    expect(openai?.value).toBe("[unset]");
    expect(openai?.set).toBe(false);
  });

  it("never includes env vars outside the allowlist", () => {
    const rows = listRedactedEnv({ HOSTNAME: "leak.example.com", USER: "evil" });
    expect(rows.find((r) => r.key === "HOSTNAME")).toBeUndefined();
    expect(rows.find((r) => r.key === "USER")).toBeUndefined();
  });

  it("treats empty string as unset", () => {
    const rows = listRedactedEnv({ NODE_ENV: "" });
    const node = rows.find((r) => r.key === "NODE_ENV");
    expect(node?.value).toBe("[unset]");
    expect(node?.set).toBe(false);
  });
});

describe("GET /api/settings/env", () => {
  it("rejects anonymous callers with 401", async () => {
    const res = await request(app).get("/api/settings/env");
    expect(res.status).toBe(401);
  });

  it("rejects readers with 403 (admin.read required)", async () => {
    const token = await login("reader");
    const res = await request(app).get("/api/settings/env").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("rejects developers with 403", async () => {
    const token = await login("developer");
    const res = await request(app).get("/api/settings/env").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("rejects coordinators with 403", async () => {
    const token = await login("coordinator");
    const res = await request(app).get("/api/settings/env").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(403);
  });

  it("returns redacted env list for admins", async () => {
    const token = await login("admin");
    const res = await request(app).get("/api/settings/env").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    const items: Array<{ key: string; value: string; classification: string }> =
      res.body.data.items;
    expect(items.length).toBeGreaterThan(0);
    expect(items.find((i) => i.key === "NODE_ENV")).toBeDefined();
    const secret = items.find((i) => i.classification === "secret" && i.set);
    if (secret) expect(secret.value).toBe("[REDACTED]");
  });
});
