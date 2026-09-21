/**
 * /api/projects/:projectId/inference-profile HTTP route tests
 * (Issue #127, Epic #119).
 *
 * Exercises GET + PUT over HTTP: load current profile, persist a new profile,
 * empty/default state, validation (bad ARN), and auth. Prisma is mocked.
 *
 * Provider guardrail (Epic #119): the picker/route only surface the existing
 * inference-profile value — no provider routing or request shaping changes.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ProfileRow {
  id: string;
  projectId: string;
  arn: string;
  modelId: string;
  costCenter: string | null;
  environment: string | null;
  tags: string;
  createdAt: Date;
  updatedAt: Date;
}

const profiles = new Map<string, ProfileRow>();

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "user_admin",
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    inferenceProfile: {
      findUnique: vi.fn(
        async ({ where }: { where: { projectId: string } }) =>
          profiles.get(where.projectId) ?? null,
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { projectId: string };
          create: Omit<ProfileRow, "id" | "createdAt" | "updatedAt">;
          update: Partial<ProfileRow>;
        }) => {
          const existing = profiles.get(where.projectId);
          const row: ProfileRow = existing
            ? { ...existing, ...update, updatedAt: new Date() }
            : {
                id: `ip_${profiles.size + 1}`,
                createdAt: new Date(),
                updatedAt: new Date(),
                ...(create as Omit<ProfileRow, "id" | "createdAt" | "updatedAt">),
              };
          profiles.set(where.projectId, row);
          return row;
        },
      ),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

import request from "supertest";
import { createApp } from "../src/app.js";
import { __resetInferenceProfileManagerSingleton } from "../src/lib/ai/inference-profile-manager.js";

let app: ReturnType<typeof createApp>;
let token: string;

const VALID_ARN =
  "arn:aws:bedrock:us-east-1:123456789012:inference-profile/us.anthropic.claude-sonnet-4-6";

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.AI_OFFLINE = "1";
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(async () => {
  profiles.clear();
  __resetInferenceProfileManagerSingleton();
  app = createApp();
  token = await login();
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/projects/:projectId/inference-profile", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).get("/api/projects/proj_1/inference-profile");
    expect(res.status).toBe(401);
  });

  it("returns a null profile for a project with none set", async () => {
    const res = await request(app)
      .get("/api/projects/proj_1/inference-profile")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.profile).toBeNull();
  });

  it("returns the stored profile", async () => {
    profiles.set("proj_1", {
      id: "ip_1",
      projectId: "proj_1",
      arn: VALID_ARN,
      modelId: "us.anthropic.claude-sonnet-4-6",
      costCenter: "eng",
      environment: "prod",
      tags: JSON.stringify({ team: "platform" }),
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const res = await request(app)
      .get("/api/projects/proj_1/inference-profile")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.profile.arn).toBe(VALID_ARN);
    expect(res.body.data.profile.tags).toEqual({ team: "platform" });
  });
});

describe("PUT /api/projects/:projectId/inference-profile", () => {
  it("rejects an invalid ARN with 400", async () => {
    const res = await request(app)
      .put("/api/projects/proj_1/inference-profile")
      .set("Authorization", `Bearer ${token}`)
      .send({ arn: "not-an-arn", modelId: "us.anthropic.claude-sonnet-4-6" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("VALIDATION_ERROR");
  });

  it("persists a valid profile and returns it", async () => {
    const res = await request(app)
      .put("/api/projects/proj_1/inference-profile")
      .set("Authorization", `Bearer ${token}`)
      .send({
        arn: VALID_ARN,
        modelId: "us.anthropic.claude-sonnet-4-6",
        costCenter: "eng",
        environment: "prod",
        tags: { team: "platform" },
      });
    expect(res.status).toBe(200);
    expect(res.body.data.profile.arn).toBe(VALID_ARN);
    expect(res.body.data.profile.tags).toEqual({ team: "platform" });
    expect(profiles.get("proj_1")).toBeDefined();
  });
});
