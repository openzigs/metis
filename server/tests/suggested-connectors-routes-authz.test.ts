/**
 * #1053 (finding F2, epic #1051) — object-level project scope for
 * `/api/projects/:projectId/suggested-connectors`.
 *
 * `GET /:id` returns a ONE-SHOT DECRYPTED database password. The router
 * previously gated only on `requireAuth` + a GLOBAL-role
 * `requirePermission("connector.write")`, so a coordinator in workspace A could
 * list workspace B's suggestions and then read the plaintext credential for
 * another tenant's discovered database — direct credential theft.
 *
 * These tests exercise the REAL `requirePermission` + `requireProjectAccess`
 * middleware: a cross-tenant caller gets 404 (no existence oracle) before the
 * handler body runs — in particular before the vault is ever read — while a
 * same-workspace caller is still served.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

interface TestUser {
  userId: string;
  role: string;
  workspaces?: string[];
}
let currentUser: TestUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: TestUser }).user = currentUser;
    next();
  },
}));

const projectFindUnique = vi.fn();
const suggestionFindMany = vi.fn();
const suggestionFindFirst = vi.fn();
const suggestionUpdate = vi.fn();
const suggestionDelete = vi.fn();
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    project: { findUnique: projectFindUnique },
    suggestedConnector: {
      findMany: suggestionFindMany,
      findFirst: suggestionFindFirst,
      update: suggestionUpdate,
      delete: suggestionDelete,
    },
  },
}));

const vaultRead = vi.fn();
vi.mock("../src/lib/vault/vault-service.js", () => ({
  getVaultService: () => ({ read: vaultRead }),
}));

vi.mock("../src/lib/audit/audit-service.js", () => ({ audit: vi.fn() }));

const { suggestedConnectorsRouter } = await import("../src/routes/suggested-connectors.js");
const { errorHandler } = await import("../src/middleware/error-handler.js");

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use("/api/projects/:projectId/suggested-connectors", suggestedConnectorsRouter());
  app.use(errorHandler);
  return app;
}

function suggestionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sug-1",
    projectId: "proj-1",
    driverType: "postgresql",
    host: "db.internal",
    port: 5432,
    database: "app",
    username: "app",
    passwordVaultRef: "vault-1",
    confidence: "high",
    status: "pending",
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

let app: ReturnType<typeof buildApp>;
beforeEach(() => {
  vi.clearAllMocks();
  currentUser = { userId: "user-1", role: "coordinator", workspaces: ["ws-1"] };
  // Default: the path project lives in a workspace the caller belongs to.
  projectFindUnique.mockResolvedValue({ workspaceId: "ws-1" });
  vaultRead.mockResolvedValue({ plaintext: "s3cret" });
  app = buildApp();
});

describe("suggested-connectors — object-level scope (requireProjectAccess) → 404 cross-tenant", () => {
  it("404s a non-member listing another tenant's suggestions (read route)", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app).get("/api/projects/proj-victim/suggested-connectors");
    expect(res.status).toBe(404);
    expect(suggestionFindMany).not.toHaveBeenCalled();
  });

  it("404s a non-member reading the one-shot decrypted password — vault is never touched", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app).get("/api/projects/proj-victim/suggested-connectors/sug-1");
    expect(res.status).toBe(404);
    expect(suggestionFindFirst).not.toHaveBeenCalled();
    expect(vaultRead).not.toHaveBeenCalled();
    expect(JSON.stringify(res.body)).not.toContain("s3cret");
  });

  it("404s a non-member PATCHing a suggestion in another tenant's project (write route)", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app)
      .patch("/api/projects/proj-victim/suggested-connectors/sug-1")
      .send({ status: "dismissed" });
    expect(res.status).toBe(404);
    expect(suggestionUpdate).not.toHaveBeenCalled();
  });

  it("404s a non-member deleting a suggestion in another tenant's project", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app).delete("/api/projects/proj-victim/suggested-connectors/sug-1");
    expect(res.status).toBe(404);
    expect(suggestionDelete).not.toHaveBeenCalled();
  });

  it("404s a non-member probing another tenant's database via /test", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app)
      .post("/api/projects/proj-victim/suggested-connectors/sug-1/test")
      .send({});
    expect(res.status).toBe(404);
    expect(suggestionFindFirst).not.toHaveBeenCalled();
    expect(vaultRead).not.toHaveBeenCalled();
  });

  it("404s a non-member provisioning a connector into another tenant's project", async () => {
    projectFindUnique.mockResolvedValueOnce({ workspaceId: "ws-other" });
    const res = await request(app)
      .post("/api/projects/proj-victim/suggested-connectors/sug-1/provision")
      .send({ label: "stolen", driver: "postgres", host: "db.internal", database: "app" });
    expect(res.status).toBe(404);
    expect(suggestionFindFirst).not.toHaveBeenCalled();
  });

  it("404s an unknown project id (no existence oracle)", async () => {
    projectFindUnique.mockResolvedValueOnce(null);
    const res = await request(app).get("/api/projects/nope/suggested-connectors");
    expect(res.status).toBe(404);
    expect(suggestionFindMany).not.toHaveBeenCalled();
  });
});

describe("suggested-connectors — same-workspace caller is still served (no over-blocking)", () => {
  it("lists suggestions for a project in the caller's workspace", async () => {
    suggestionFindMany.mockResolvedValueOnce([suggestionRow()]);
    const res = await request(app).get("/api/projects/proj-1/suggested-connectors");
    expect(res.status).toBe(200);
    expect(res.body.data.count).toBe(1);
    expect(suggestionFindMany).toHaveBeenCalledWith({ where: { projectId: "proj-1" } });
  });

  it("returns the one-shot password to a same-workspace coordinator", async () => {
    suggestionFindFirst.mockResolvedValueOnce(suggestionRow());
    const res = await request(app).get("/api/projects/proj-1/suggested-connectors/sug-1");
    expect(res.status).toBe(200);
    expect(res.body.data.password).toBe("s3cret");
  });

  it("serves a system admin regardless of workspace membership", async () => {
    currentUser = { userId: "admin-1", role: "admin", workspaces: [] };
    suggestionFindMany.mockResolvedValueOnce([]);
    const res = await request(app).get("/api/projects/proj-any/suggested-connectors");
    expect(res.status).toBe(200);
    expect(projectFindUnique).not.toHaveBeenCalled();
  });

  it("still applies the role layer on top — a reader cannot read credentials", async () => {
    currentUser = { userId: "reader-1", role: "reader", workspaces: ["ws-1"] };
    const res = await request(app).get("/api/projects/proj-1/suggested-connectors/sug-1");
    expect(res.status).toBe(403);
    expect(vaultRead).not.toHaveBeenCalled();
  });
});
