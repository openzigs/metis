/**
 * Tests for the saved-connection (`connectionId`) branch of the connector
 * pull routes (Issue #871 UI surface — server side).
 *
 * Mirrors the mocking strategy of `test-coverage.test.ts` but isolates the
 * `connectionId` plumbing: when `connectionId` is supplied, the route MUST
 * load the resolved connection via the connection service and use its
 * baseUrl + auth instead of any inline credentials. Audit metadata should
 * include the connectionId.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

vi.mock("../../src/lib/prisma.js", () => ({
  prisma: {
    testCaseImport: { create: vi.fn() },
    testCaseDoc: { upsert: vi.fn() },
    $transaction: vi.fn(async (cb: (tx: unknown) => unknown) => {
      const { prisma } = await import("../../src/lib/prisma.js");
      return cb(prisma);
    }),
  },
}));
vi.mock("../../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));
vi.mock("../../src/lib/projects/project-service.js", () => ({
  getProject: vi.fn(),
}));
vi.mock("../../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../src/middleware/require-permission.js", () => ({
  requirePermission: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock("../../src/lib/testcoverage/index.js", async () => {
  const actual = await vi.importActual<typeof import("../../src/lib/testcoverage/index.js")>(
    "../../src/lib/testcoverage/index.js",
  );
  return {
    ...actual,
    importXrayTests: vi.fn(async () => ({
      cases: [{ externalId: "X-1", title: "case", source: "xray", priority: null, tags: [] }],
      fetched: 1,
    })),
    importZephyrCases: vi.fn(async () => ({
      cases: [{ externalId: "Z-1", title: "case", source: "zephyr", priority: null, tags: [] }],
      fetched: 1,
    })),
    importTestRailCases: vi.fn(async () => ({
      cases: [{ externalId: "T-1", title: "case", source: "testrail", priority: null, tags: [] }],
      fetched: 1,
    })),
  };
});
vi.mock("../../src/lib/connectors/jira/jira-client.js", () => ({
  createJiraClient: vi.fn(),
}));
vi.mock("../../src/lib/connectors/testmgmt/connection-service.js", () => ({
  loadResolvedTestManagementConnection: vi.fn(),
}));

import { prisma } from "../../src/lib/prisma.js";
import { getProject } from "../../src/lib/projects/project-service.js";
import { audit } from "../../src/lib/audit/audit-service.js";
import { AppError } from "../../src/middleware/error-handler.js";
import { testCoverageRouter } from "../../src/routes/test-coverage.js";
import {
  importXrayTests,
  importZephyrCases,
  importTestRailCases,
} from "../../src/lib/testcoverage/index.js";
import { loadResolvedTestManagementConnection } from "../../src/lib/connectors/testmgmt/connection-service.js";

function createApp(): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: { userId: string; role: string } }).user = {
      userId: "user-1",
      role: "developer",
    };
    next();
  });
  app.use("/projects/:projectId/test-coverage", testCoverageRouter({}));
  app.use(
    (
      err: AppError | Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err instanceof AppError ? err.statusCode : 500;
      const code = err instanceof AppError ? err.code : "INTERNAL";
      res.status(status).json({
        success: false,
        error: { code, message: err.message },
      });
    },
  );
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getProject).mockResolvedValue({ id: "proj-1", status: "active" } as never);
  vi.mocked(prisma.testCaseImport.create).mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({ id: "imp-1", ...data }) as never,
  );
  vi.mocked(prisma.testCaseDoc.upsert).mockResolvedValue({ id: "doc-1" } as never);
});

describe("POST /imports/xray with connectionId", () => {
  it("loads the saved connection and uses its credentials (ignoring body baseUrl)", async () => {
    vi.mocked(loadResolvedTestManagementConnection).mockResolvedValue({
      id: "conn-x",
      projectId: "proj-1",
      label: "Saved",
      kind: "xray",
      baseUrl: "https://saved.xray.example.com",
      auth: { kind: "xray", clientId: "vault-cid", clientSecret: "vault-cs" },
      tls: null,
      proxy: null,
    } as never);

    const res = await request(createApp())
      .post("/projects/proj-1/test-coverage/imports/xray")
      .send({ connectionId: "conn-x", projectKey: "PROJ" });

    expect(res.status).toBe(201);
    expect(loadResolvedTestManagementConnection).toHaveBeenCalledWith("conn-x", "proj-1");
    expect(importXrayTests).toHaveBeenCalledWith(
      {
        baseUrl: "https://saved.xray.example.com",
        clientId: "vault-cid",
        clientSecret: "vault-cs",
      },
      { projectKey: "PROJ", pageSize: undefined },
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "test-coverage.import.connector",
        args: expect.objectContaining({ connectionId: "conn-x", source: "xray" }),
      }),
    );
  });

  it("rejects when saved connection kind does not match", async () => {
    vi.mocked(loadResolvedTestManagementConnection).mockResolvedValue({
      id: "conn-z",
      projectId: "proj-1",
      label: "Saved",
      kind: "zephyr",
      baseUrl: "https://saved.zephyr.example.com",
      auth: { kind: "zephyr", bearerToken: "tok" },
      tls: null,
      proxy: null,
    } as never);

    const res = await request(createApp())
      .post("/projects/proj-1/test-coverage/imports/xray")
      .send({ connectionId: "conn-z", projectKey: "PROJ" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CONNECTION_KIND_MISMATCH");
    expect(importXrayTests).not.toHaveBeenCalled();
  });

  it("requires inline credentials when no connectionId provided", async () => {
    const res = await request(createApp())
      .post("/projects/proj-1/test-coverage/imports/xray")
      .send({ projectKey: "PROJ" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CONNECTOR_CREDENTIALS_REQUIRED");
    expect(importXrayTests).not.toHaveBeenCalled();
  });
});

describe("POST /imports/zephyr with connectionId", () => {
  it("uses resolved bearer token from the vault", async () => {
    vi.mocked(loadResolvedTestManagementConnection).mockResolvedValue({
      id: "conn-z",
      projectId: "proj-1",
      label: "Saved",
      kind: "zephyr",
      baseUrl: "https://saved.zephyr.example.com",
      auth: { kind: "zephyr", bearerToken: "vault-tok" },
      tls: null,
      proxy: null,
    } as never);

    const res = await request(createApp())
      .post("/projects/proj-1/test-coverage/imports/zephyr")
      .send({ connectionId: "conn-z", projectKey: "PROJ" });

    expect(res.status).toBe(201);
    expect(importZephyrCases).toHaveBeenCalledWith(
      { baseUrl: "https://saved.zephyr.example.com", bearerToken: "vault-tok" },
      { projectKey: "PROJ", folderId: undefined, pageSize: undefined },
    );
  });

  it("rejects on kind mismatch", async () => {
    vi.mocked(loadResolvedTestManagementConnection).mockResolvedValue({
      id: "conn-x",
      projectId: "proj-1",
      label: "Saved",
      kind: "xray",
      baseUrl: "https://x.example.com",
      auth: { kind: "xray", clientId: "c", clientSecret: "s" },
      tls: null,
      proxy: null,
    } as never);

    const res = await request(createApp())
      .post("/projects/proj-1/test-coverage/imports/zephyr")
      .send({ connectionId: "conn-x", projectKey: "PROJ" });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("CONNECTION_KIND_MISMATCH");
  });
});

describe("POST /imports/testrail with connectionId", () => {
  it("uses resolved email + apiKey from the vault", async () => {
    vi.mocked(loadResolvedTestManagementConnection).mockResolvedValue({
      id: "conn-tr",
      projectId: "proj-1",
      label: "Saved",
      kind: "testrail",
      baseUrl: "https://saved.testrail.io",
      auth: { kind: "testrail", email: "u@x.com", apiKey: "vault-key" },
      tls: null,
      proxy: null,
    } as never);

    const res = await request(createApp())
      .post("/projects/proj-1/test-coverage/imports/testrail")
      .send({ connectionId: "conn-tr", projectId: 5, suiteId: 9 });

    expect(res.status).toBe(201);
    expect(importTestRailCases).toHaveBeenCalledWith(
      { baseUrl: "https://saved.testrail.io", email: "u@x.com", apiKey: "vault-key" },
      { projectId: 5, suiteId: 9, pageSize: undefined },
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        args: expect.objectContaining({ connectionId: "conn-tr", source: "testrail" }),
      }),
    );
  });

  it("falls back to inline creds (legacy path) when no connectionId", async () => {
    const res = await request(createApp())
      .post("/projects/proj-1/test-coverage/imports/testrail")
      .send({
        baseUrl: "https://inline.testrail.io",
        email: "u@x.com",
        apiKey: "inline-key",
        projectId: 1,
      });

    expect(res.status).toBe(201);
    expect(loadResolvedTestManagementConnection).not.toHaveBeenCalled();
    expect(importTestRailCases).toHaveBeenCalledWith(
      { baseUrl: "https://inline.testrail.io", email: "u@x.com", apiKey: "inline-key" },
      { projectId: 1, suiteId: undefined, pageSize: undefined },
    );
  });
});
