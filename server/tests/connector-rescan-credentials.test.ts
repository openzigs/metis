/**
 * POST /repos/:id/rescan-credentials — lightweight credential-only rescan.
 *
 * Tests the endpoint in isolation by mocking repo-service and connection-discovery.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: { username: string } }) => ({
        id: "user_admin",
        ...create,
      })),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    repoConnection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => ({
        id: "repo-1",
        projectId: "proj-1",
        label: "test-repo",
        provider: "github",
        ownerOrOrg: "acme",
        repoName: "backend",
        defaultBranch: "main",
        isPrimary: true,
        apiBaseUrl: null,
        secretId: null,
        status: "ready",
        errorMessage: null,
        lastTestedAt: null,
        lastIngestAt: null,
        lastCommitSha: null,
        createdById: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      })),
      count: vi.fn(async () => 1),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
      updateMany: vi.fn(async () => ({ count: 0 })),
    },
    databaseConnection: {
      findMany: vi.fn(async () => []),
      findFirst: vi.fn(async () => null),
      create: vi.fn(async () => ({})),
      update: vi.fn(async () => ({})),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/connectors/network-allowlist.js", () => ({
  assertConnectorHostAllowed: vi.fn(async () => undefined),
  resolveAndAssertConnectorHost: vi.fn(async () => ({
    hostname: "db.example.com",
    address: "203.0.113.10",
    family: 4 as const,
  })),
  makePinnedLookup: vi.fn(() => undefined),
}));

vi.mock("../src/lib/connectors/vault-resolver.js", () => ({
  resolveVaultRef: vi.fn(async () => null),
}));

const mockDiscovery = vi.fn();
vi.mock("../src/lib/connectors/repo/connection-discovery.js", () => ({
  discoverAndUpsertConnections: (...args: unknown[]) => mockDiscovery(...args),
}));

const mockPullOrClone = vi.fn();
vi.mock("../src/lib/connectors/repo/repo-service.js", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    pullOrCloneRepo: (...args: unknown[]) => mockPullOrClone(...args),
    getRepoConnector: vi.fn(async () => ({
      id: "repo-1",
      label: "test-repo",
      provider: "github",
      ownerOrOrg: "acme",
      repoName: "backend",
      apiBaseUrl: null,
    })),
    getRepoConnectorEmitter: () => ({
      progress: vi.fn(),
      discovery: vi.fn(),
    }),
  };
});

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  vi.clearAllMocks();
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /repos/:id/rescan-credentials", () => {
  it("returns discovery summary on success", async () => {
    mockPullOrClone.mockResolvedValue({
      path: "/tmp/clone",
      pulled: true,
      filesChanged: 0,
      sizeBytes: 1024,
    });
    mockDiscovery.mockResolvedValue({
      filesScanned: 42,
      connectionsFound: 3,
      suggestionsUpserted: 2,
      errors: 0,
    });

    const token = await login();
    const res = await request(app)
      .post("/api/projects/proj-1/connectors/repos/repo-1/rescan-credentials")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      filesScanned: 42,
      connectionsFound: 3,
      suggestionsUpserted: 2,
      errors: 0,
    });
    expect(mockPullOrClone).toHaveBeenCalledWith("proj-1", "repo-1", expect.any(String));
    expect(mockDiscovery).toHaveBeenCalledWith("proj-1", "/tmp/clone");
  });

  it("returns 200 with zero connections when nothing found", async () => {
    mockPullOrClone.mockResolvedValue({
      path: "/tmp/clone",
      pulled: false,
      filesChanged: 0,
      sizeBytes: 512,
    });
    mockDiscovery.mockResolvedValue({
      filesScanned: 10,
      connectionsFound: 0,
      suggestionsUpserted: 0,
      errors: 0,
    });

    const token = await login();
    const res = await request(app)
      .post("/api/projects/proj-1/connectors/repos/repo-1/rescan-credentials")
      .set("Authorization", `Bearer ${token}`);

    expect(res.status).toBe(200);
    expect(res.body.data.connectionsFound).toBe(0);
  });

  it("rejects unauthenticated requests", async () => {
    const res = await request(app).post(
      "/api/projects/proj-1/connectors/repos/repo-1/rescan-credentials",
    );
    expect(res.status).toBe(401);
  });
});
