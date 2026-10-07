/**
 * #733 — `/api/projects/:id/publish-destination` carries a persisted GitHub
 * publish target, so publishing no longer defaults to the analysed repo
 * connector's (upstream) repository. The target is read back through GET — the
 * same path the publish page and the Deep Dive dialog load it from.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

interface ProjectRow {
  id: string;
  deletedAt: Date | null;
  publishDestination: string;
  jiraProjectKey: string | null;
  jiraConnectionId: string | null;
  publishGithubOwner: string | null;
  publishGithubRepo: string | null;
}

const projects = new Map<string, ProjectRow>();

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
        }) => ({ id: `user_${create.username}`, ...create }),
      ),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    jiraConnection: { findFirst: vi.fn(async () => ({ id: "jira_conn_1" })) },
    project: {
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      ),
      findFirst: vi.fn(
        async ({ where }: { where: { id: string } }) => projects.get(where.id) ?? null,
      ),
      update: vi.fn(
        async ({ where, data }: { where: { id: string }; data: Partial<ProjectRow> }) => {
          const row = projects.get(where.id);
          if (!row) throw new Error("not found");
          const next = { ...row, ...data };
          projects.set(where.id, next);
          return next;
        },
      ),
    },
  });
  return { prisma };
});

const auditSpy = vi.fn();
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: (...args: unknown[]) => auditSpy(...args),
}));

import request from "supertest";
import { createApp } from "../src/app.js";

let app: ReturnType<typeof createApp>;
const PID = "proj_dest_001";
const url = `/api/projects/${PID}/publish-destination`;

async function login(username: string): Promise<string> {
  const res = await request(app).post("/api/auth/login").send({ username, password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

function row(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    id: PID,
    deletedAt: null,
    publishDestination: "github",
    jiraProjectKey: null,
    jiraConnectionId: null,
    publishGithubOwner: null,
    publishGithubRepo: null,
    ...overrides,
  };
}

beforeAll(() => {
  process.env.RATE_LIMIT_MAX = "100000";
});

beforeEach(() => {
  projects.clear();
  projects.set(PID, row());
  app = createApp();
});

afterEach(() => vi.clearAllMocks());

describe("GET /api/projects/:id/publish-destination — GitHub target", () => {
  it("reports no target when none is configured", async () => {
    const token = await login("reader");
    const res = await request(app).get(url).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      publishDestination: "github",
      jiraProjectKey: null,
      jiraConnectionId: null,
      githubOwner: null,
      githubRepo: null,
    });
  });
});

describe("PATCH /api/projects/:id/publish-destination — GitHub target", () => {
  it("persists the target so a later GET (a reload) reads it back", async () => {
    const token = await login("admin");
    const patch = await request(app)
      .patch(url)
      .set("Authorization", `Bearer ${token}`)
      .send({ publishDestination: "github", githubOwner: "openzigs", githubRepo: "flux-v2" });
    expect(patch.status).toBe(200);
    expect(patch.body.data.githubOwner).toBe("openzigs");
    expect(patch.body.data.githubRepo).toBe("flux-v2");

    const res = await request(app).get(url).set("Authorization", `Bearer ${token}`);
    expect(res.body.data.githubOwner).toBe("openzigs");
    expect(res.body.data.githubRepo).toBe("flux-v2");
    expect(auditSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "project.publishDestination.update",
        metadata: expect.objectContaining({ githubOwner: "openzigs", githubRepo: "flux-v2" }),
      }),
    );
  });

  it("leaves a stored target alone when an edit omits it", async () => {
    projects.set(PID, row({ publishGithubOwner: "openzigs", publishGithubRepo: "flux-v2" }));
    const token = await login("admin");
    const res = await request(app).patch(url).set("Authorization", `Bearer ${token}`).send({
      publishDestination: "both",
      jiraConnectionId: "jira_conn_1",
      jiraProjectKey: "PROJ",
    });
    expect(res.status).toBe(200);
    expect(projects.get(PID)?.publishGithubOwner).toBe("openzigs");
    expect(projects.get(PID)?.publishGithubRepo).toBe("flux-v2");
  });

  it("clears the target when both are sent as null", async () => {
    projects.set(PID, row({ publishGithubOwner: "openzigs", publishGithubRepo: "flux-v2" }));
    const token = await login("admin");
    const res = await request(app)
      .patch(url)
      .set("Authorization", `Bearer ${token}`)
      .send({ publishDestination: "github", githubOwner: null, githubRepo: null });
    expect(res.status).toBe(200);
    expect(projects.get(PID)?.publishGithubOwner).toBeNull();
    expect(projects.get(PID)?.publishGithubRepo).toBeNull();
  });

  it("rejects a half-set target (400) without writing", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch(url)
      .set("Authorization", `Bearer ${token}`)
      .send({ publishDestination: "github", githubOwner: "openzigs" });
    expect(res.status).toBe(400);
    expect(projects.get(PID)?.publishGithubOwner).toBeNull();
  });

  it("rejects a path-shaped repo name (400)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .patch(url)
      .set("Authorization", `Bearer ${token}`)
      .send({ publishDestination: "github", githubOwner: "openzigs", githubRepo: "../../x" });
    expect(res.status).toBe(400);
  });
});
