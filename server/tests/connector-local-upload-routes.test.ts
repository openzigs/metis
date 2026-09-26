/**
 * Issue #288 — route layer for `local` + `upload` repo connectors.
 *
 * Proves:
 *   - AuthZ: POST /repos/local requires admin (coordinator with connector.write
 *     is rejected 403); POST /repos/upload requires connector.write (reader 403).
 *   - The generic JSON POST /repos refuses provider=local and provider=upload.
 *   - Provider routing: a github create + ingest still shallow-clones, while
 *     local/upload deep-ingest skip the clone (resolveNonGitIngestRoot used).
 *
 * The repo-service + ingest pipeline are mocked so we isolate routing/authZ.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "@prisma/client";

const h = vi.hoisted(() => ({
  tasks: new Map<string, Task>(),
  finished: vi.fn(),
  shallowCloneRepo: vi.fn(async () => ({ path: "/tmp/clone", sizeBytes: 10 })),
  resolveNonGitIngestRoot: vi.fn(async () => ({ path: "/tmp/extract" })),
  createRepoConnector: vi.fn(async (_p: string, input: Record<string, unknown>) => ({
    id: "repo_local_1",
    provider: input.provider,
    label: input.label,
    localPath: input.localPath,
  })),
  createUploadRepoConnector: vi.fn(async () => ({ id: "repo_upload_1", provider: "upload" })),
  listRepoConnectors: vi.fn(async () => [{ id: "repo_local_1" }]),
  getRepoConnector: vi.fn(async (_p: string, id: string) => ({
    id,
    label: "x",
    provider: id.includes("upload") ? "upload" : id.includes("local") ? "local" : "github",
  })),
}));
const shallowCloneRepo = h.shallowCloneRepo;
const resolveNonGitIngestRoot = h.resolveNonGitIngestRoot;
const createRepoConnector = h.createRepoConnector;
const createUploadRepoConnector = h.createUploadRepoConnector;

// Prisma is stubbed per-suite — real login persists provider grants through
// withRouteAuth so route and regeneration authorization read the same DB state.
vi.mock("../src/lib/prisma.js", async () => {
  const { withRouteAuth } = await import("./helpers/route-auth-prisma.js");
  const prisma = withRouteAuth({
    $queryRawUnsafe: vi.fn(async () => 1),
    workspaceMember: { findMany: vi.fn(async () => []) },
    user: {
      upsert: vi.fn(async ({ create }: { create: Record<string, unknown> }) => ({
        id: "user_test",
        ...create,
      })),
      findUnique: vi.fn(async () => null),
    },
    userRole: {},
    auditLog: { create: vi.fn(async () => ({})) },
    // #674 — the connectors router now runs the `requireProjectAccess`
    // chokepoint (assertProjectAccess → project.findUnique). A null workspaceId
    // keeps the project open to any authed caller.
    project: {
      findUnique: vi.fn(async () => ({ workspaceId: null })),
      findFirst: vi.fn(async () => ({ id: "proj_1", name: "Test", description: "" })),
    },
    generatedDocument: {
      findMany: vi.fn(
        async () =>
          [] as Array<{
            id: string;
            projectId: string;
            title: string;
            docType: string;
            scope: string;
            scopeFilter: string;
            evidencePolicy: string;
          }>,
      ),
    },
    generatedDocumentVersion: {
      findFirst: vi.fn(async () => ({ version: 2, provenanceManifest: null })),
    },
    codeSymbol: { findMany: vi.fn(async () => []) },
    codeEdge: { findMany: vi.fn(async () => []) },
    codeGraph: { findMany: vi.fn(async () => []) },
    knowledgeChunk: { findMany: vi.fn(async () => []) },
    task: {
      upsert: vi.fn(async ({ where, create }: { where: { id: string }; create: Partial<Task> }) => {
        const existing = h.tasks.get(where.id);
        if (existing) return existing;
        const task = {
          scheduledJobId: null,
          projectId: null,
          type: "",
          trigger: "manual",
          status: "pending",
          priority: 5,
          payload: "{}",
          result: null,
          errorMessage: null,
          progress: null,
          attempts: 0,
          maxAttempts: 3,
          scheduledFor: null,
          startedAt: null,
          completedAt: null,
          createdById: null,
          createdAt: new Date(),
          updatedAt: new Date(),
          ...create,
          id: where.id,
        } satisfies Task;
        h.tasks.set(task.id, task);
        return task;
      }),
      findUnique: vi.fn(
        async ({ where }: { where: { id: string } }) => h.tasks.get(where.id) ?? null,
      ),
      update: vi.fn(async ({ where, data }: { where: { id: string }; data: Partial<Task> }) => {
        const task = h.tasks.get(where.id);
        if (!task) throw new Error("Task not found");
        Object.assign(task, data);
        return task;
      }),
    },
  });
  return { prisma };
});

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

vi.mock("../src/lib/connectors/repo/repo-service.js", () => ({
  shallowCloneRepo: h.shallowCloneRepo,
  resolveNonGitIngestRoot: h.resolveNonGitIngestRoot,
  createRepoConnector: h.createRepoConnector,
  createUploadRepoConnector: h.createUploadRepoConnector,
  listRepoConnectors: h.listRepoConnectors,
  getRepoConnector: h.getRepoConnector,
  pullOrCloneRepo: vi.fn(async () => ({
    path: "/tmp/clone",
    sizeBytes: 10,
    pulled: true,
    filesChanged: 0,
  })),
  fetchRepoMetadata: vi.fn(async () => ({
    repo: {},
    languages: {},
    topLevel: [],
    readme: null,
    manifests: {},
    headSha: null,
  })),
  deleteRepoConnector: vi.fn(),
  getPrimaryRepo: vi.fn(async () => null),
  getRepoConnectorEmitter: vi.fn(() => ({
    progress: vi.fn((event: { status?: string }) => {
      if (event.status === "error") h.finished();
    }),
    status: vi.fn(),
    discovery: vi.fn(() => h.finished()),
  })),
  setPrimaryRepo: vi.fn(),
  testRepoConnector: vi.fn(),
  updateRepoConnector: vi.fn(),
}));

vi.mock("../src/lib/code-graph/ingest.js", () => ({
  ingestCodeGraph: vi.fn(async () => ({
    filesScanned: 1,
    filesParsed: 1,
    filesSkipped: 0,
    symbolsUpserted: 0,
    edgesUpserted: 0,
    rationaleFindings: 0,
    languageStats: {},
    durationMs: 1,
  })),
}));

vi.mock("../src/lib/connectors/connector-ingest.js", () => ({
  ingestSourceAsKnowledge: vi.fn(async () => ({
    documentsCreated: 1,
    documentsUpdated: 0,
    chunkCount: 1,
    failures: 0,
  })),
  ingestRepoMetadata: vi.fn(async () => ({
    documentsCreated: 0,
    documentsUpdated: 0,
    chunkCount: 0,
    failures: 0,
  })),
  ingestDbSchema: vi.fn(),
}));

vi.mock("../src/lib/connectors/repo/connection-discovery.js", () => ({
  discoverAndUpsertConnections: vi.fn(async () => ({
    filesScanned: 0,
    connectionsFound: 0,
    suggestionsUpserted: 0,
    errors: [],
  })),
}));

import request from "supertest";
import { createApp } from "../src/app.js";
import { prisma } from "../src/lib/prisma.js";
import {
  ingestRepoMetadata,
  ingestSourceAsKnowledge,
} from "../src/lib/connectors/connector-ingest.js";
import {
  fetchRepoMetadata,
  getRepoConnectorEmitter,
} from "../src/lib/connectors/repo/repo-service.js";
import { REPO_INGEST_FAILED_MESSAGE } from "../src/routes/connectors.js";
import {
  acquireConnectorIngest,
  isConnectorIngestActive,
} from "../src/lib/connectors/ingest-guard.js";
import { discoverAndUpsertConnections } from "../src/lib/connectors/repo/connection-discovery.js";
import { ConnectorError } from "../src/lib/connectors/types.js";
import {
  bootstrapScheduler,
  type SchedulerBootstrap,
  SCHEDULER_DEFAULTS,
} from "../src/lib/scheduler/index.js";

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
  vi.clearAllMocks();
  app = createApp();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("POST /repos/local — admin authZ", () => {
  it("admin can create a local connector", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/local")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "mounted", localPath: "/srv/code" });
    expect(res.status).toBe(201);
    expect(createRepoConnector).toHaveBeenCalled();
    const passed = createRepoConnector.mock.calls[0][1] as Record<string, unknown>;
    expect(passed.provider).toBe("local");
    expect(passed.localPath).toBe("/srv/code");
  });

  it("coordinator (has connector.write, NOT admin.write) is rejected 403", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/local")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "mounted", localPath: "/srv/code" });
    expect(res.status).toBe(403);
    expect(createRepoConnector).not.toHaveBeenCalled();
  });

  it("unauthenticated is rejected 401", async () => {
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/local")
      .send({ label: "mounted", localPath: "/srv/code" });
    expect(res.status).toBe(401);
  });

  it("missing localPath is a 400 validation error", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/local")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "mounted" });
    expect(res.status).toBe(400);
  });
});

describe("POST /repos/upload — write authZ + .zip enforcement", () => {
  it("coordinator (connector.write) can upload a .zip", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("label", "dropzone")
      .attach("file", Buffer.from("PK fake zip"), {
        filename: "code.zip",
        contentType: "application/zip",
      });
    expect(res.status).toBe(201);
    expect(createUploadRepoConnector).toHaveBeenCalled();
  });

  it("reader (no connector.write) is rejected 403", async () => {
    const token = await login("reader");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("label", "dropzone")
      .attach("file", Buffer.from("PK"), { filename: "code.zip", contentType: "application/zip" });
    expect(res.status).toBe(403);
    expect(createUploadRepoConnector).not.toHaveBeenCalled();
  });

  it("rejects a non-.zip filename", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/upload")
      .set("Authorization", `Bearer ${token}`)
      .field("label", "dropzone")
      .attach("file", Buffer.from("data"), {
        filename: "code.tar",
        contentType: "application/zip",
      });
    expect(res.status).toBe(400);
    expect(createUploadRepoConnector).not.toHaveBeenCalled();
  });

  it("rejects a missing label", async () => {
    const token = await login("coordinator");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/upload")
      .set("Authorization", `Bearer ${token}`)
      .attach("file", Buffer.from("PK"), { filename: "code.zip", contentType: "application/zip" });
    expect(res.status).toBe(400);
  });
});

describe("generic POST /repos refuses non-git providers", () => {
  it("rejects provider=local (must use /repos/local)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "x", provider: "local", localPath: "/srv/code" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("USE_LOCAL_ENDPOINT");
  });

  it("rejects provider=upload (must use /repos/upload)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos")
      .set("Authorization", `Bearer ${token}`)
      .send({ label: "x", provider: "upload" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("USE_UPLOAD_ENDPOINT");
  });
});

describe("provider routing on deep-ingest", () => {
  it("github connector shallow-clones (clone path), never resolveNonGitIngestRoot", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/repo_github_x/deep-ingest")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(shallowCloneRepo).toHaveBeenCalledTimes(1);
    expect(resolveNonGitIngestRoot).not.toHaveBeenCalled();
  });

  it("local connector skips the clone (resolveNonGitIngestRoot, never shallowCloneRepo)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/repo_local_x/deep-ingest")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(resolveNonGitIngestRoot).toHaveBeenCalledTimes(1);
    expect(shallowCloneRepo).not.toHaveBeenCalled();
  });

  it("upload connector skips the clone (resolveNonGitIngestRoot, never shallowCloneRepo)", async () => {
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos/repo_upload_x/deep-ingest")
      .set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(resolveNonGitIngestRoot).toHaveBeenCalledTimes(1);
    expect(shallowCloneRepo).not.toHaveBeenCalled();
  });
});

// #217 — one per-connector guard shared by the sync routes, the scheduled
// refresh and the eval runner. The routes take it before any clone/graph work.
describe("per-connector ingest guard on the sync routes (#217)", () => {
  for (const route of ["deep-ingest", "refresh-ingest"] as const) {
    it(`${route} answers 409 INGEST_IN_PROGRESS while another entry point holds the connector`, async () => {
      const token = await login("admin");
      const lease = acquireConnectorIngest("repo_github_x", "scheduled-refresh");
      try {
        const res = await request(app)
          .post(`/api/projects/proj_1/connectors/repos/repo_github_x/${route}`)
          .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(409);
        expect(res.body.error.code).toBe("INGEST_IN_PROGRESS");
        expect(ingestSourceAsKnowledge).not.toHaveBeenCalled();
        // The refusal leaves the holder's claim intact.
        expect(isConnectorIngestActive("repo_github_x")).toBe(true);
      } finally {
        lease.release();
      }
    });

    it(`${route} answers 404 — not 409 — for another project's connector while it ingests`, async () => {
      // The project-scoped lookup runs before the lease is tried, so a caller
      // outside the project learns neither that the id exists nor that it is busy.
      const token = await login("admin");
      const inProject = h.getRepoConnector.getMockImplementation()!;
      h.getRepoConnector.mockRejectedValue(
        new ConnectorError(404, "REPO_CONNECTOR_NOT_FOUND", "repo connector not found"),
      );
      const lease = acquireConnectorIngest("repo_github_x", "scheduled-refresh");
      try {
        const res = await request(app)
          .post(`/api/projects/proj_1/connectors/repos/repo_github_x/${route}`)
          .set("Authorization", `Bearer ${token}`);
        expect(res.status).toBe(404);
        expect(res.body.error.code).toBe("REPO_CONNECTOR_NOT_FOUND");
        expect(isConnectorIngestActive("repo_github_x")).toBe(true);
      } finally {
        lease.release();
        h.getRepoConnector.mockImplementation(inProject);
      }
    });

    it(`${route} holds the guard for the run, hands its lease to the source ingest, then releases it`, async () => {
      const token = await login("admin");
      let leaseSeen: unknown;
      vi.mocked(ingestSourceAsKnowledge).mockImplementationOnce(async (...args) => {
        const lease = args[4]?.lease;
        leaseSeen = lease && { connectorId: lease.connectorId, held: lease.held };
        return { documentsCreated: 1, documentsUpdated: 0, chunkCount: 1, failures: 0 };
      });
      const res = await request(app)
        .post(`/api/projects/proj_1/connectors/repos/repo_github_x/${route}`)
        .set("Authorization", `Bearer ${token}`);
      expect(res.status).toBe(200);
      expect(leaseSeen).toMatchObject({ connectorId: "repo_github_x", held: true });
      expect(isConnectorIngestActive("repo_github_x")).toBe(false);
    });
  }
});

/** Let background work started by a request (a `void`-ed promise) run to its next await. */
async function settleBackground(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
}

// #217 — create-with-autoIngest starts the deep ingest in the background; it
// takes the same per-connector lease, so a busy connector is not ingested twice.
describe("per-connector ingest guard on create-with-autoIngest (#217)", () => {
  const createGithub = (token: string) =>
    request(app)
      .post("/api/projects/proj_1/connectors/repos")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "repo",
        provider: "github",
        ownerOrOrg: "acme",
        repoName: "backend",
        autoIngest: true,
      });
  let restoreCreate: (() => void) | undefined;

  beforeEach(() => {
    const original = h.createRepoConnector.getMockImplementation()!;
    h.createRepoConnector.mockImplementation(async (_projectId, input) => ({
      id: "repo_github_x",
      provider: input.provider,
      label: input.label,
      localPath: undefined,
    }));
    restoreCreate = () => h.createRepoConnector.mockImplementation(original);
  });

  afterEach(() => restoreCreate?.());

  it("does not start a second ingest while another entry point holds the connector", async () => {
    const token = await login("admin");
    const lease = acquireConnectorIngest("repo_github_x", "scheduled-refresh");
    try {
      const res = await createGithub(token);
      expect(res.status).toBe(201);
      expect(res.body.data.autoIngestTriggered).toBe(true);
      await settleBackground();
      expect(shallowCloneRepo).not.toHaveBeenCalled();
      expect(ingestSourceAsKnowledge).not.toHaveBeenCalled();
      // The refusal leaves the holder's claim intact.
      expect(isConnectorIngestActive("repo_github_x")).toBe(true);
    } finally {
      lease.release();
    }
  });

  it("holds the lease for its run, refuses a concurrent auto-ingest, then releases it", async () => {
    const token = await login("admin");
    let open!: () => void;
    const gate = new Promise<void>((resolve) => (open = resolve));
    let during: { active: boolean; lease?: { connectorId: string; held: boolean } } | undefined;
    vi.mocked(ingestSourceAsKnowledge).mockImplementationOnce(async (...args) => {
      const lease = args[4]?.lease;
      during = {
        active: isConnectorIngestActive("repo_github_x"),
        ...(lease ? { lease: { connectorId: lease.connectorId, held: lease.held } } : {}),
      };
      await gate;
      return { documentsCreated: 1, documentsUpdated: 0, chunkCount: 1, failures: 0 };
    });

    expect((await createGithub(token)).status).toBe(201);
    await vi.waitFor(() => expect(ingestSourceAsKnowledge).toHaveBeenCalledTimes(1));
    expect(during).toEqual({
      active: true,
      lease: { connectorId: "repo_github_x", held: true },
    });

    // A second create-with-autoIngest for the same connector while the first runs.
    expect((await createGithub(token)).status).toBe(201);
    await settleBackground();
    expect(shallowCloneRepo).toHaveBeenCalledTimes(1);
    expect(ingestSourceAsKnowledge).toHaveBeenCalledTimes(1);

    open();
    await vi.waitFor(() => expect(isConnectorIngestActive("repo_github_x")).toBe(false));
  });
});

// #114 — the auto-ingest (create-with-autoIngest) progress socket event carried
// the raw exception text (paths, git stderr, SQL) to the browser as both `step`
// and `errorMessage`.
describe("auto-ingest failure progress event", () => {
  it("sends fixed vocabulary, never the exception text", async () => {
    const RAW =
      "EACCES: permission denied, open '/srv/metis/server/data/repos/acme/secret/.git/config' " +
      "token=ghp_4f9a8b7c6d5e4f3a2b1c";
    h.createRepoConnector.mockImplementation(async (_projectId, input) => ({
      id: "repo_github_x",
      provider: input.provider,
      label: input.label,
    }));
    vi.mocked(ingestSourceAsKnowledge).mockRejectedValueOnce(new Error(RAW));
    const finished = new Promise<void>((resolve) => h.finished.mockImplementation(resolve));
    const token = await login("admin");
    const res = await request(app)
      .post("/api/projects/proj_1/connectors/repos")
      .set("Authorization", `Bearer ${token}`)
      .send({
        label: "repo",
        provider: "github",
        ownerOrOrg: "acme",
        repoName: "backend",
        autoIngest: true,
      });
    expect(res.status).toBe(201);
    await finished;
    const events = vi
      .mocked(getRepoConnectorEmitter)
      .mock.results.flatMap((r) =>
        vi
          .mocked((r.value as { progress: (e: unknown) => void }).progress)
          .mock.calls.map((c) => c[0] as { status?: string; step: string; errorMessage?: string }),
      );
    const failure = events.find((e) => e.status === "error");
    expect(failure).toBeDefined();
    expect(JSON.stringify(failure)).not.toContain("/srv");
    expect(JSON.stringify(failure)).not.toContain("ghp_");
    expect(failure!.errorMessage).toBe(REPO_INGEST_FAILED_MESSAGE);
    expect(failure!.step).toBe("Ingestion failed");
    h.finished.mockReset();
  });
});

/** #1356: HTTP caller → real input capture/planning → durable task → real queue.
 * Only external ingestion and Prisma are stubbed. A zero-capacity queue keeps
 * synthesis out of this caller test (the production execution has its own suite).
 */
describe("manual connector regeneration callers (#1356)", () => {
  let scheduler: SchedulerBootstrap;
  let token: string;

  beforeEach(async () => {
    h.tasks.clear();
    h.finished.mockReset();
    scheduler = bootstrapScheduler({ config: { ...SCHEDULER_DEFAULTS, concurrency: 0 } });
    vi.mocked(prisma.generatedDocument.findMany).mockResolvedValue([
      {
        id: "doc_manual",
        projectId: "proj_1",
        title: "Manual regeneration",
        docType: "architecture",
        scope: "full",
        scopeFilter: "{}",
        evidencePolicy: JSON.stringify({
          version: 1,
          principal: { kind: "initiating-user", userId: "user_test" },
          sharedDocumentIds: [],
          allowWebResearch: false,
        }),
      },
    ] as Awaited<ReturnType<typeof prisma.generatedDocument.findMany>>);
    vi.mocked(discoverAndUpsertConnections).mockResolvedValue({
      filesScanned: 1,
      connectionsFound: 1,
      suggestionsUpserted: 1,
      errors: [],
    });
    token = await login("admin");
  });

  afterEach(async () => {
    await scheduler.shutdown();
    vi.mocked(prisma.generatedDocument.findMany).mockResolvedValue([]);
    h.finished.mockReset();
  });

  const success = { documentsCreated: 1, documentsUpdated: 0, chunkCount: 1, failures: 0 };

  for (const caller of ["create", "deep-ingest", "refresh-ingest"] as const) {
    describe(caller, () => {
      async function ingest(provider = "github") {
        // Discovery/error is the last observable pipeline boundary for the
        // fire-and-forget create route; no sleeps or scheduler mocks needed.
        const finished = new Promise<void>((resolve) => h.finished.mockImplementation(resolve));
        const endpoint = caller === "create" ? "/repos" : `/repos/repo_${provider}_x/${caller}`;
        const response = await request(app)
          .post(`/api/projects/proj_1/connectors${endpoint}`)
          .set("Authorization", `Bearer ${token}`)
          .send(
            caller === "create"
              ? {
                  label: "repo",
                  provider: "github",
                  ownerOrOrg: "acme",
                  repoName: "backend",
                  autoIngest: true,
                }
              : {},
          );
        if (caller === "create") await finished;
        return response;
      }

      beforeEach(() => {
        // The older routing fixture creates local connectors by default.
        h.createRepoConnector.mockImplementation(async (_projectId, input) => ({
          id: "repo_github_x",
          provider: input.provider,
          label: input.label,
          localPath: input.localPath,
        }));
      });

      function expectScheduled() {
        expect(prisma.generatedDocument.findMany).toHaveBeenCalledWith({
          select: {
            id: true,
            projectId: true,
            title: true,
            scope: true,
            scopeFilter: true,
            evidencePolicy: true,
          },
          where: {
            projectId: "proj_1",
            autoUpdate: true,
            deletedAt: null,
            status: { in: ["ready", "degraded", "failed", "generating"] },
            scope: { in: ["full", "repository", "module", "symbol"] },
          },
        });
        expect(h.tasks.size).toBe(1);
        const [task] = h.tasks.values();
        expect(task).toMatchObject({
          id: expect.stringMatching(/^docs-regen:/),
          projectId: "proj_1",
          type: "regenerate-generated-document",
          maxAttempts: 3,
          createdById: "user_test",
          status: "pending",
        });
        expect(JSON.parse(task.payload)).toEqual({
          projectId: "proj_1",
          generatedDocumentId: "doc_manual",
          expectedVersion: 2,
          fingerprint: expect.any(String),
        });
        expect(scheduler.queue.snapshot()).toMatchObject({ queueDepth: 1, running: 0 });
      }

      it("schedules only after source and metadata settle; replay reuses the durable task", async () => {
        const response = await ingest();
        expect(response.status).toBe(caller === "create" ? 201 : 200);
        expectScheduled();
        expect(ingestSourceAsKnowledge).toHaveBeenCalled();
        expect(ingestRepoMetadata).toHaveBeenCalled();
        const scheduledAt = vi.mocked(prisma.task.upsert).mock.invocationCallOrder[0];
        expect(scheduledAt).toBeGreaterThan(
          vi.mocked(ingestSourceAsKnowledge).mock.invocationCallOrder[0],
        );
        expect(scheduledAt).toBeGreaterThan(
          vi.mocked(ingestRepoMetadata).mock.invocationCallOrder[0],
        );
        await ingest();
        expectScheduled();
        expect(prisma.task.upsert).toHaveBeenCalledTimes(2);
        const [first, replay] = vi.mocked(prisma.task.upsert).mock.calls;
        expect(replay[0]).toEqual(first[0]);
      });

      it.each([
        "source failures",
        "metadata failures",
        "metadata fetch throws",
        "metadata ingest throws",
      ])("does not regenerate when %s, despite completing discovery", async (failure) => {
        if (failure === "source failures")
          vi.mocked(ingestSourceAsKnowledge).mockResolvedValueOnce({ ...success, failures: 1 });
        if (failure === "metadata failures")
          vi.mocked(ingestRepoMetadata).mockResolvedValueOnce({ ...success, failures: 1 });
        if (failure === "metadata fetch throws")
          vi.mocked(fetchRepoMetadata).mockRejectedValueOnce(new Error("Metadata unavailable"));
        if (failure === "metadata ingest throws")
          vi.mocked(ingestRepoMetadata).mockRejectedValueOnce(
            new Error("Metadata ingest unavailable"),
          );
        const response = await ingest();
        expect(response.status).toBe(caller === "create" ? 201 : 200);
        expect(discoverAndUpsertConnections).toHaveBeenCalled();
        expect(prisma.generatedDocument.findMany).not.toHaveBeenCalled();
        expect(prisma.task.upsert).not.toHaveBeenCalled();
        expect(h.tasks.size).toBe(0);
        expect(scheduler.queue.snapshot().queueDepth).toBe(0);
      });

      it("does not schedule on a rejected source ingestion and allows a successful replay", async () => {
        vi.mocked(ingestSourceAsKnowledge).mockRejectedValueOnce(
          new Error("Source ingest unavailable"),
        );
        const response = await ingest();
        expect(response.status).toBe(caller === "create" ? 201 : 500);
        expect(prisma.task.upsert).not.toHaveBeenCalled();
        expect(discoverAndUpsertConnections).not.toHaveBeenCalled();
        expect((await ingest()).status).toBe(caller === "create" ? 201 : 200);
        expectScheduled();
      });

      it("surfaces a durable scheduling failure and schedules successfully on replay", async () => {
        vi.mocked(prisma.task.upsert).mockRejectedValueOnce(new Error("Task store unavailable"));
        const response = await ingest();
        expect(response.status).toBe(caller === "create" ? 201 : 500);
        expect(prisma.task.upsert).toHaveBeenCalledTimes(1);
        expect(h.tasks.size).toBe(0);
        expect(scheduler.queue.snapshot().queueDepth).toBe(0);
        expect((await ingest()).status).toBe(caller === "create" ? 201 : 200);
        expectScheduled();
      });

      if (caller !== "create") {
        it.each(["local", "upload"])(
          "schedules %s ingestion without requiring Git metadata",
          async (provider) => {
            expect((await ingest(provider)).status).toBe(200);
            expect(fetchRepoMetadata).not.toHaveBeenCalled();
            expect(ingestRepoMetadata).not.toHaveBeenCalled();
            expectScheduled();
          },
        );
      }
    });
  }
});
