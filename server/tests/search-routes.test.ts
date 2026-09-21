/**
 * /api/search HTTP route tests (Issue #120, Epic #119).
 *
 * Exercises the federated search router over HTTP: query validation, auth,
 * success + empty-result paths, and the accessible-projects listing. The RAG
 * federated-search service and the accessible-projects lookup are mocked so we
 * focus on the route surface.
 *
 * Provider guardrail (Epic #119): the federated search service is mocked at its
 * own boundary — provider routing for Bedrock / local-gemma is never touched.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const searchAcrossProjects = vi.fn();
const getUserAccessibleProjects = vi.fn();

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
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

vi.mock("../src/lib/rag/federated-search-service.js", () => ({
  getFederatedSearchService: () => ({ searchAcrossProjects }),
}));

vi.mock("../src/lib/auth/accessible-projects.js", () => ({
  getUserAccessibleProjects: (...args: unknown[]) => getUserAccessibleProjects(...args),
}));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
let token: string;

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
  searchAcrossProjects.mockReset();
  getUserAccessibleProjects.mockReset();
  app = createApp();
  token = await login();
});

afterEach(() => vi.clearAllMocks());

describe("POST /api/search/federated", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).post("/api/search/federated").send({ query: "hi" });
    expect(res.status).toBe(401);
  });

  it("returns federated results for a valid query", async () => {
    searchAcrossProjects.mockResolvedValue({
      query: "auth flow",
      hits: [{ projectId: "p1", chunk: "x", score: 0.9 }],
      projectsSearched: ["p1"],
    });
    const res = await request(app)
      .post("/api/search/federated")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "auth flow", k: 5 });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.data.hits).toHaveLength(1);
    expect(searchAcrossProjects).toHaveBeenCalledWith(
      expect.objectContaining({ query: "auth flow", k: 5, userId: "user_admin" }),
    );
  });

  it("returns an empty result set without erroring", async () => {
    searchAcrossProjects.mockResolvedValue({
      query: "nothing",
      hits: [],
      projectsSearched: [],
    });
    const res = await request(app)
      .post("/api/search/federated")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "nothing" });
    expect(res.status).toBe(200);
    expect(res.body.data.hits).toHaveLength(0);
  });

  it("rejects an empty query with 400", async () => {
    const res = await request(app)
      .post("/api/search/federated")
      .set("Authorization", `Bearer ${token}`)
      .send({ query: "" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("INVALID_INPUT");
    expect(searchAcrossProjects).not.toHaveBeenCalled();
  });
});

describe("GET /api/search/projects", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).get("/api/search/projects");
    expect(res.status).toBe(401);
  });

  it("returns the accessible project list", async () => {
    getUserAccessibleProjects.mockResolvedValue([
      { id: "p1", name: "Alpha" },
      { id: "p2", name: "Beta" },
    ]);
    const res = await request(app)
      .get("/api/search/projects")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(2);
    expect(getUserAccessibleProjects).toHaveBeenCalledWith("user_admin");
  });
});
