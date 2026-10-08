/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * #784 — `POST /api/projects/:projectId/spec-kit/commands/speckit.taskstoissues`
 * driven through the REAL `runTasksToIssues` (the sibling
 * `spec-kit-routes.test.ts` mocks every runner, so it cannot see what this
 * command does at the HTTP boundary). Only Prisma, audit and `requireAuth`
 * are replaced; `requirePermission` is real.
 *
 * Before #784 a real export "exported" every task to the no-op client and
 * wrote `SpecKitTaskExport` rows pinned to issue #0; #784/#936 refused it 501.
 * #953 wires the live, vault-bound client (`taskstoissues-github.ts`, covered
 * end to end on real SQLite in `spec-kit-taskstoissues-live-953.sqlite.test.ts`);
 * here: the route reaches it, and each refusal it adds arrives as the right
 * HTTP error with nothing persisted.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ADMIN = { userId: "u1", role: "admin" };
const auth = vi.hoisted(() => ({
  user: { userId: "u1", role: "admin" } as { userId: string; role: string },
}));
const db = vi.hoisted(() => ({
  projects: new Map<string, any>(),
  features: new Map<string, any>(),
  featureArtifacts: new Map<string, any>(),
  configs: new Map<string, any>(),
  taskExports: new Map<string, any>(),
  repoConnections: new Map<string, any>(),
}));

vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: any, _res: any, next: any) => {
    req.user = { ...auth.user, username: "tester" };
    next();
  },
}));

vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    auditLog: { create: vi.fn(async () => ({})) },
    project: {
      findUnique: vi.fn(async ({ where }: any) => db.projects.get(where.id) ?? null),
    },
    specKitFeature: {
      findUnique: vi.fn(async ({ where }: any) => {
        if (where.id) return db.features.get(where.id) ?? null;
        const k = where.projectId_slug;
        for (const r of db.features.values()) {
          if (k && r.projectId === k.projectId && r.slug === k.slug) return r;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...db.features.values()].filter((r) => r.projectId === where.projectId),
      ),
    },
    specKitFeatureArtifact: {
      findUnique: vi.fn(async ({ where }: any) => {
        const k = where.featureId_key;
        for (const r of db.featureArtifacts.values()) {
          if (k && r.featureId === k.featureId && r.key === k.key) return r;
        }
        return null;
      }),
      findMany: vi.fn(async ({ where }: any) =>
        [...db.featureArtifacts.values()].filter((r) => r.featureId === where.featureId),
      ),
    },
    specKitConfig: {
      findUnique: vi.fn(async ({ where }: any) => db.configs.get(where.projectId) ?? null),
    },
    repoConnection: {
      findMany: vi.fn(async ({ where }: any) =>
        [...db.repoConnections.values()].filter((r) => r.projectId === where.projectId),
      ),
    },
    specKitTaskExport: {
      findUnique: vi.fn(async () => null),
      create: vi.fn(async ({ data }: any) => {
        db.taskExports.set(`${data.featureSlug}|${data.taskId}`, data);
        return data;
      }),
    },
  },
}));

// Job-scope persistence (the socket bus' tenant record) is not under test here.
vi.mock("../src/lib/socket/job-scope-store.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/lib/socket/job-scope-store.js")>()),
  recordJobScope: vi.fn(async () => undefined),
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
  getAuditService: vi.fn(() => ({ record: vi.fn() })),
}));

// The command needs no model; fail loudly if the route ever resolves one here.
vi.mock("../src/lib/ai/project-provider.js", () => ({
  resolveProjectProvider: vi.fn(async () => {
    throw new Error("taskstoissues must not resolve a provider");
  }),
}));

import express from "express";
import request from "supertest";
import { specKitRouter } from "../src/routes/spec-kit.js";
import { errorHandler } from "../src/middleware/error-handler.js";
import { prisma } from "../src/lib/prisma.js";
import { audit } from "../src/lib/audit/audit-service.js";

const ROUTE = "/api/projects/p1/spec-kit/commands/speckit.taskstoissues";

function makeApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/spec-kit", specKitRouter());
  app.use(errorHandler);
  return app;
}

function seed(): void {
  db.projects.set("p1", {
    id: "p1",
    specKitEnabled: true,
    publishGithubOwner: null,
    publishGithubRepo: null,
  });
  db.features.set("f1", {
    id: "f1",
    projectId: "p1",
    slug: "001-foo",
    title: "Foo",
    status: "draft",
    branchName: null,
    createdById: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
  const tasks = [
    "| ID | Title | SP | Deps | Notes |",
    "| --- | --- | --- | --- | --- |",
    "| T01 | Build A | 3 |  | files: src/a.ts |",
    "| T02 | Build B | 2 | T01 | files: src/b.ts |",
  ].join("\n");
  for (const [key, content] of [
    ["spec.md", "x"],
    ["plan.md", "x"],
    ["tasks.md", tasks],
  ] as const) {
    db.featureArtifacts.set(`f1|${key}`, {
      id: `fa_${key}`,
      featureId: "f1",
      key,
      content,
      version: 1,
      updatedById: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
}

let prevEnvRepo: string | undefined;

beforeEach(() => {
  for (const m of Object.values(db)) m.clear();
  auth.user = { ...ADMIN };
  prevEnvRepo = process.env.SPECKIT_TASKS_DEFAULT_REPO;
  delete process.env.SPECKIT_TASKS_DEFAULT_REPO;
  seed();
});

afterEach(() => {
  if (prevEnvRepo === undefined) delete process.env.SPECKIT_TASKS_DEFAULT_REPO;
  else process.env.SPECKIT_TASKS_DEFAULT_REPO = prevEnvRepo;
  vi.clearAllMocks();
});

describe("POST /commands/speckit.taskstoissues (real runner, #784)", () => {
  it("a live run without a vault secret is refused 400 TOKEN_REQUIRED, audited, nothing written (#953)", async () => {
    Object.assign(db.projects.get("p1"), {
      publishGithubOwner: "openzigs",
      publishGithubRepo: "flux-v2",
    });
    const res = await request(makeApp()).post(ROUTE).send({ featureSlug: "001-foo" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("TOKEN_REQUIRED");
    expect(res.body.error.message).toMatch(/vault/);
    expect(prisma.specKitTaskExport.create).not.toHaveBeenCalled();
    expect(db.taskExports.size).toBe(0);
    expect(vi.mocked(audit)).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "speckit.tasks_export_refused",
        metadata: expect.objectContaining({ code: "TOKEN_REQUIRED" }),
      }),
    );
  });

  it("a live run naming its own repository is refused 400 — the target cannot be redirected (#953)", async () => {
    const res = await request(makeApp())
      .post(ROUTE)
      .send({ featureSlug: "001-foo", dryRun: false, repo: { owner: "openzigs", name: "x" } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SPECKIT_TARGET_OVERRIDE_REFUSED");
    expect(db.taskExports.size).toBe(0);
  });

  it("a live run with no dry run plan is refused 409 SPECKIT_DRY_RUN_REQUIRED (#953)", async () => {
    const res = await request(makeApp())
      .post(ROUTE)
      .send({ featureSlug: "001-foo", dryRun: false, secretRef: "${vault:gh}" });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("SPECKIT_DRY_RUN_REQUIRED");
    expect(db.taskExports.size).toBe(0);
  });

  it("a malformed plan or secret ref is a 400 before anything runs (#953)", async () => {
    for (const extra of [
      { expectedPlan: { tasksVersion: 1, digest: "not-a-digest" } },
      { expectedPlan: { tasksVersion: 0, digest: "a".repeat(64) } },
      { secretRef: "x".repeat(257) },
    ]) {
      const res = await request(makeApp())
        .post(ROUTE)
        .send({ featureSlug: "001-foo", ...extra });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("BAD_REQUEST");
    }
    expect(prisma.specKitFeature.findUnique).not.toHaveBeenCalled();
  });

  it("a dry run refuses a target that is the analysed repository (#953)", async () => {
    Object.assign(db.projects.get("p1"), {
      publishGithubOwner: "miniflux",
      publishGithubRepo: "v2",
    });
    db.repoConnections.set("rc1", {
      projectId: "p1",
      ownerOrOrg: "miniflux",
      repoName: "v2",
      provider: "github",
      status: "connected",
      lastIngestAt: null,
      lastCommitSha: null,
      deletedAt: null,
    });
    const res = await request(makeApp()).post(ROUTE).send({ featureSlug: "001-foo", dryRun: true });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("PUBLISH_TARGET_IS_ANALYSED_REPO");
  });

  it("a dry run with no resolvable repo is 400 SPECKIT_NO_REPO_CONFIGURED", async () => {
    const res = await request(makeApp()).post(ROUTE).send({ featureSlug: "001-foo", dryRun: true });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("SPECKIT_NO_REPO_CONFIGURED");
    expect(db.taskExports.size).toBe(0);
  });

  it("a dry run plans against the saved publish target and persists nothing", async () => {
    Object.assign(db.projects.get("p1"), {
      publishGithubOwner: "openzigs",
      publishGithubRepo: "flux-v2",
    });
    const res = await request(makeApp()).post(ROUTE).send({ featureSlug: "001-foo", dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.data.repo).toEqual({ owner: "openzigs", name: "flux-v2" });
    expect(res.body.data.count).toBe(2);
    expect(db.taskExports.size).toBe(0);
  });

  it("a dry run lists every planned issue title, its plan, and that publishing is available (#936, #953)", async () => {
    Object.assign(db.projects.get("p1"), {
      publishGithubOwner: "openzigs",
      publishGithubRepo: "flux-v2",
    });
    const res = await request(makeApp()).post(ROUTE).send({ featureSlug: "001-foo", dryRun: true });
    expect(res.status).toBe(200);
    expect(res.body.data.created.map((c: any) => c.title)).toEqual([
      "[T01] Build A",
      "[T02] Build B",
    ]);
    // #953 — the route's live run builds a real client, so the UI may offer Publish.
    expect(res.body.data.publishAvailable).toBe(true);
    expect(res.body.data.tasksVersion).toBe(1);
    expect(res.body.data.planDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(res.body.data.credentialCheck).toBe("missing");
  });

  it("a refusal speaks to a UI user, not in API field names (#936)", async () => {
    const res = await request(makeApp())
      .post(ROUTE)
      .send({ featureSlug: "001-foo", secretRef: "${vault:gh}" });
    expect(res.status).toBe(409);
    expect(res.body.error.message).not.toMatch(/dryRun|expectedPlan/);
    expect(res.body.error.message).toMatch(/dry run/);
  });

  it("a project.update holder outside the project's workspace gets 404, dry run or live (#953 BOLA)", async () => {
    auth.user = { userId: "u3", role: "coordinator" };
    Object.assign(db.projects.get("p1"), {
      publishGithubOwner: "openzigs",
      publishGithubRepo: "flux-v2",
      workspaceId: "w-other",
      workspace: { deletedAt: null, members: [] },
    });
    for (const extra of [{ dryRun: true }, { secretRef: "${vault:mine}" }]) {
      const res = await request(makeApp())
        .post(ROUTE)
        .send({ featureSlug: "001-foo", ...extra });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("NOT_FOUND");
    }
    expect(prisma.specKitFeature.findUnique).not.toHaveBeenCalled();
  });

  it("a non-admin without project.update is refused 403 before the command runs", async () => {
    auth.user = { userId: "u2", role: "reader" };
    const res = await request(makeApp()).post(ROUTE).send({ featureSlug: "001-foo", dryRun: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(prisma.specKitFeature.findUnique).not.toHaveBeenCalled();
    expect(db.taskExports.size).toBe(0);
  });
});
