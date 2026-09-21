/**
 * AST cache rebuild route + helper tests (Issue #122, Epic #119).
 *
 * Covers:
 *   - POST /api/projects/:projectId/repositories/:repoId/rebuild-cache
 *     (success with real rebuild stats, 404 for a missing repo, 401 anon)
 *   - rebuildCacheFromCloneDir() unit path: indexes real source files from a
 *     temp clone dir and returns accurate stats (no stub no-op).
 *
 * The repo clone is mocked to point at a temp directory of sample source so we
 * exercise the real cache rebuild without hitting git.
 *
 * Provider guardrail (Epic #119): cache rebuild is analysis plumbing — no
 * provider routing is touched.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";

interface RepoRow {
  id: string;
  projectId: string;
  deletedAt: Date | null;
}

const repos = new Map<string, RepoRow>();
let cloneDir = "";

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
    repoConnection: {
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        for (const r of repos.values()) {
          if (r.deletedAt) continue;
          if (r.id === where.id && r.projectId === where.projectId) return r;
        }
        return null;
      }),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

vi.mock("../src/lib/connectors/repo/repo-service.js", () => ({
  pullOrCloneRepo: vi.fn(async () => ({
    path: cloneDir,
    sizeBytes: 1024,
    pulled: false,
    filesChanged: 0,
  })),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import {
  rebuildCacheFromCloneDir,
  getASTSummaryCache,
  __resetASTSummaryCacheSingleton,
} from "../src/lib/analysis/ast-summary-cache.js";

let app: ReturnType<typeof createApp>;
let token: string;

async function login(): Promise<string> {
  const res = await request(app)
    .post("/api/auth/login")
    .send({ username: "admin", password: "password" });
  expect(res.status).toBe(200);
  return res.body.data.accessToken as string;
}

beforeAll(async () => {
  process.env.AI_OFFLINE = "1";
  process.env.RATE_LIMIT_MAX = "100000";
  cloneDir = await fs.mkdtemp(path.join(os.tmpdir(), "metis-ast-cache-test-"));
  // A supported source file with a couple of symbols + a vendored dir to skip.
  await fs.writeFile(
    path.join(cloneDir, "sample.ts"),
    "export function add(a: number, b: number): number {\n  return a + b;\n}\n" +
      "export class Greeter {\n  greet(name: string): string {\n    return `hi ${name}`;\n  }\n}\n",
    "utf-8",
  );
  await fs.mkdir(path.join(cloneDir, "node_modules"), { recursive: true });
  await fs.writeFile(
    path.join(cloneDir, "node_modules", "ignored.ts"),
    "export const x = 1;\n",
    "utf-8",
  );
  await fs.writeFile(path.join(cloneDir, "README.bin"), "not source", "utf-8");
});

afterAll(async () => {
  if (cloneDir) await fs.rm(cloneDir, { recursive: true, force: true });
});

beforeEach(async () => {
  repos.clear();
  __resetASTSummaryCacheSingleton();
  app = createApp();
  token = await login();
});

afterEach(() => vi.clearAllMocks());

describe("rebuildCacheFromCloneDir", () => {
  it("indexes supported source files and skips vendored/binary files", async () => {
    __resetASTSummaryCacheSingleton();
    const cache = getASTSummaryCache();
    const result = await rebuildCacheFromCloneDir(cache, cloneDir);
    expect(result.indexed).toBeGreaterThanOrEqual(1);
    expect(result.totalSymbols).toBeGreaterThanOrEqual(2);
    // node_modules + the .bin file must not be indexed.
    expect(result.discovered).toBe(1);
  });
});

describe("POST /api/projects/:projectId/repositories/:repoId/rebuild-cache", () => {
  it("rejects anonymous calls with 401", async () => {
    const res = await request(app).post("/api/projects/proj_1/repositories/repo_1/rebuild-cache");
    expect(res.status).toBe(401);
  });

  it("returns 404 when the repo is not found", async () => {
    const res = await request(app)
      .post("/api/projects/proj_1/repositories/ghost/rebuild-cache")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe("NOT_FOUND");
  });

  it("rebuilds the cache and returns real stats", async () => {
    repos.set("repo_1", { id: "repo_1", projectId: "proj_1", deletedAt: null });
    const res = await request(app)
      .post("/api/projects/proj_1/repositories/repo_1/rebuild-cache")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body.data.message).toBe("Cache rebuild complete");
    expect(res.body.data.stats.indexedFiles).toBeGreaterThanOrEqual(1);
    expect(res.body.data.stats.totalSymbols).toBeGreaterThanOrEqual(2);
  });
});
