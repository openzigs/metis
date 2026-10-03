/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * #784 — `POST /api/projects/:projectId/spec-kit/commands/speckit.taskstoissues`
 * driven through the REAL `runTasksToIssues` (the sibling
 * `spec-kit-routes.test.ts` mocks every runner, so it cannot see what this
 * command does at the HTTP boundary). Only Prisma, audit and `requireAuth`
 * are replaced; `requirePermission` is real.
 *
 * The route never injects an issue client, so a real export must be refused
 * 501 with nothing persisted — before #784 it "exported" every task to the
 * no-op client and wrote `SpecKitTaskExport` rows pinned to issue #0.
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
  it("a non-dry run is refused 501 SPECKIT_ISSUE_EXPORT_UNAVAILABLE and writes no export row", async () => {
    Object.assign(db.projects.get("p1"), {
      publishGithubOwner: "openzigs",
      publishGithubRepo: "flux-v2",
    });
    const res = await request(makeApp()).post(ROUTE).send({ featureSlug: "001-foo" });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe("SPECKIT_ISSUE_EXPORT_UNAVAILABLE");
    expect(prisma.specKitTaskExport.create).not.toHaveBeenCalled();
    expect(db.taskExports.size).toBe(0);
  });

  it("an explicit dryRun:false is refused the same way", async () => {
    const res = await request(makeApp())
      .post(ROUTE)
      .send({ featureSlug: "001-foo", dryRun: false, repo: { owner: "openzigs", name: "x" } });
    expect(res.status).toBe(501);
    expect(res.body.error.code).toBe("SPECKIT_ISSUE_EXPORT_UNAVAILABLE");
    expect(db.taskExports.size).toBe(0);
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

  it("a non-admin without project.update is refused 403 before the command runs", async () => {
    auth.user = { userId: "u2", role: "reader" };
    const res = await request(makeApp()).post(ROUTE).send({ featureSlug: "001-foo", dryRun: true });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("FORBIDDEN");
    expect(prisma.specKitFeature.findUnique).not.toHaveBeenCalled();
    expect(db.taskExports.size).toBe(0);
  });
});
