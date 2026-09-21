/**
 * Tests for workspace routes and middleware (Epic #759).
 * Covers: CRUD, RBAC, invitation flow, workspace access scoping.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import express, { type Express } from "express";
import request from "supertest";

// Mock prisma
vi.mock("../src/lib/prisma.js", () => ({
  prisma: {
    workspace: {
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    workspaceMember: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    workspaceInvite: {
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    project: {
      findUnique: vi.fn(),
      updateMany: vi.fn(),
    },
    user: {
      findUnique: vi.fn(),
    },
    $transaction: vi.fn((ops: unknown[]) => Promise.all(ops)),
  },
}));

// Mock audit
vi.mock("../src/lib/audit/audit-service.js", () => ({
  audit: vi.fn(),
}));

// Mock requireAuth to be a passthrough (user injected in test app setup)
vi.mock("../src/middleware/auth.js", () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

import { prisma } from "../src/lib/prisma.js";
import { workspacesRouter } from "../src/routes/workspaces.js";
import { requireWorkspaceRole } from "../src/middleware/require-workspace-role.js";
import { AppError } from "../src/middleware/error-handler.js";

function createApp(authUser?: { userId: string; role: string; workspaces?: string[] }): Express {
  const app = express();
  app.use(express.json());
  // Inject mock user
  if (authUser) {
    app.use((req, _res, next) => {
      (req as unknown as { user: typeof authUser }).user = authUser;
      next();
    });
  }
  app.use("/workspaces", workspacesRouter());
  // Error handler
  app.use(
    (
      err: AppError | Error,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      const status = err instanceof AppError ? err.statusCode : 500;
      const code = err instanceof AppError ? err.code : "INTERNAL";
      const message = err.message;
      res.status(status).json({ success: false, error: { code, message } });
    },
  );
  return app;
}

describe("Workspace Routes", () => {
  const mockUser = { userId: "user-1", role: "developer", workspaces: ["ws-1"] };
  const mockAdmin = { userId: "user-1", role: "admin", workspaces: ["ws-1"] };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET /workspaces", () => {
    it("returns user's workspaces", async () => {
      const app = createApp(mockUser);
      vi.mocked(prisma.workspaceMember.findMany).mockResolvedValue([
        {
          id: "mem-1",
          workspaceId: "ws-1",
          userId: "user-1",
          role: "owner",
          joinedAt: new Date(),
          updatedAt: new Date(),
          workspace: {
            id: "ws-1",
            name: "Test",
            slug: "test",
            logoUrl: null,
            createdAt: new Date(),
          },
        },
      ] as never);

      const res = await request(app).get("/workspaces");
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe("Test");
    });
  });

  describe("POST /workspaces", () => {
    it("creates a workspace and assigns creator as owner", async () => {
      const app = createApp(mockUser);
      vi.mocked(prisma.workspace.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.workspace.create).mockResolvedValue({
        id: "ws-new",
        name: "My Org",
        slug: "my-org",
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as never);

      const res = await request(app).post("/workspaces").send({ name: "My Org", slug: "my-org" });

      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe("My Org");
    });

    it("rejects duplicate slug", async () => {
      const app = createApp(mockUser);
      vi.mocked(prisma.workspace.findUnique).mockResolvedValue({ id: "existing" } as never);

      const res = await request(app)
        .post("/workspaces")
        .send({ name: "Dup", slug: "existing-slug" });

      expect(res.status).toBe(409);
    });

    it("validates slug format", async () => {
      const app = createApp(mockUser);

      const res = await request(app)
        .post("/workspaces")
        .send({ name: "Bad Slug", slug: "BAD SLUG!" });

      expect(res.status).toBe(400);
    });
  });

  describe("DELETE /workspaces/:id", () => {
    it("soft-deletes workspace when user is owner", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: "mem-1",
        workspaceId: "ws-1",
        userId: "user-1",
        role: "owner",
        joinedAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
        id: "ws-1",
        slug: "test",
        name: "Test",
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as never);
      vi.mocked(prisma.workspace.update).mockResolvedValue({} as never);

      const res = await request(app).delete("/workspaces/ws-1");
      expect(res.status).toBe(200);
    });

    it("prevents deleting the default workspace", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: "mem-1",
        workspaceId: "ws-1",
        userId: "user-1",
        role: "owner",
        joinedAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
        id: "ws-1",
        slug: "default",
        name: "Default",
      } as never);

      const res = await request(app).delete("/workspaces/ws-1");
      expect(res.status).toBe(400);
    });
  });

  describe("POST /workspaces/:id/invites", () => {
    it("creates an invite and returns token", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: "mem-1",
        workspaceId: "ws-1",
        userId: "user-1",
        role: "admin",
        joinedAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.workspaceInvite.updateMany).mockResolvedValue({ count: 0 } as never);
      vi.mocked(prisma.workspaceInvite.create).mockResolvedValue({
        id: "inv-1",
        email: "new@example.com",
        role: "member",
        token: "test-token",
        expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
        workspaceId: "ws-1",
        invitedById: "user-1",
        consumedAt: null,
        createdAt: new Date(),
      } as never);

      const res = await request(app)
        .post("/workspaces/ws-1/invites")
        .send({ email: "new@example.com", role: "member" });

      expect(res.status).toBe(201);
      expect(res.body.data.email).toBe("new@example.com");
      expect(res.body.data.token).toBeDefined();
    });

    it("rejects invite for existing member", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockImplementation(
        async (args: { where: Record<string, unknown> }) => {
          if (args.where.workspaceId_userId) {
            return { id: "mem-existing" } as never;
          }
          return { id: "mem-1", role: "admin", workspaceId: "ws-1", userId: "user-1" } as never;
        },
      );
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "user-2",
        email: "existing@test.com",
      } as never);

      const res = await request(app)
        .post("/workspaces/ws-1/invites")
        .send({ email: "existing@test.com" });

      expect(res.status).toBe(409);
    });
  });

  describe("POST /workspaces/invites/:token/accept", () => {
    it("accepts a valid invite and creates membership", async () => {
      const app = createApp(); // No auth required for accept
      vi.mocked(prisma.workspaceInvite.findUnique).mockResolvedValue({
        id: "inv-1",
        workspaceId: "ws-1",
        email: "user@test.com",
        role: "member",
        token: "valid-token",
        consumedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
        invitedById: "inviter-1",
        workspace: { id: "ws-1", name: "Test", slug: "test" },
        invitedBy: { displayName: "Inviter" },
        createdAt: new Date(),
      } as never);
      vi.mocked(prisma.user.findUnique).mockResolvedValue({
        id: "user-2",
        email: "user@test.com",
      } as never);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);
      vi.mocked(prisma.workspaceMember.create).mockResolvedValue({} as never);
      vi.mocked(prisma.workspaceInvite.update).mockResolvedValue({} as never);

      const res = await request(app).post("/workspaces/invites/valid-token/accept");

      expect(res.status).toBe(200);
      expect(res.body.data.workspace.name).toBe("Test");
      expect(res.body.data.role).toBe("member");
    });

    it("rejects expired invite", async () => {
      const app = createApp();
      vi.mocked(prisma.workspaceInvite.findUnique).mockResolvedValue({
        id: "inv-1",
        workspaceId: "ws-1",
        email: "user@test.com",
        role: "member",
        token: "expired-token",
        consumedAt: null,
        expiresAt: new Date(Date.now() - 86400000), // expired yesterday
        invitedById: "inviter-1",
        workspace: { id: "ws-1", name: "Test", slug: "test" },
        invitedBy: { displayName: "Inviter" },
        createdAt: new Date(),
      } as never);

      const res = await request(app).post("/workspaces/invites/expired-token/accept");
      expect(res.status).toBe(410);
    });

    it("rejects already consumed invite", async () => {
      const app = createApp();
      vi.mocked(prisma.workspaceInvite.findUnique).mockResolvedValue({
        id: "inv-1",
        workspaceId: "ws-1",
        email: "user@test.com",
        role: "member",
        token: "consumed-token",
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 86400000),
        invitedById: "inviter-1",
        workspace: { id: "ws-1", name: "Test", slug: "test" },
        invitedBy: { displayName: "Inviter" },
        createdAt: new Date(),
      } as never);

      const res = await request(app).post("/workspaces/invites/consumed-token/accept");
      expect(res.status).toBe(410);
    });

    it("rejects invalid token", async () => {
      const app = createApp();
      vi.mocked(prisma.workspaceInvite.findUnique).mockResolvedValue(null);

      const res = await request(app).post("/workspaces/invites/invalid-token/accept");
      expect(res.status).toBe(404);
    });
  });

  describe("POST /:id/transfer", () => {
    it("transfers ownership to target user", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: "mem-2",
        workspaceId: "ws-1",
        userId: "user-2",
        role: "admin",
        joinedAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.workspaceMember.update).mockResolvedValue({} as never);
      vi.mocked(prisma.$transaction).mockResolvedValue([{}, {}] as never);

      const res = await request(app)
        .post("/workspaces/ws-1/transfer")
        .send({ targetUserId: "user-2" });

      expect(res.status).toBe(200);
      expect(res.body.data.transferred).toBe(true);
    });

    it("rejects transfer to non-member", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);

      const res = await request(app)
        .post("/workspaces/ws-1/transfer")
        .send({ targetUserId: "user-99" });

      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /:id/members/:memberId", () => {
    it("updates member role", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: "mem-2",
        workspaceId: "ws-1",
        userId: "user-2",
        role: "member",
        joinedAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.workspaceMember.update).mockResolvedValue({
        id: "mem-2",
        role: "admin",
      } as never);

      const res = await request(app)
        .patch("/workspaces/ws-1/members/mem-2")
        .send({ role: "admin" });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe("admin");
    });

    it("rejects demoting sole owner", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: "mem-1",
        workspaceId: "ws-1",
        userId: "user-1",
        role: "owner",
        joinedAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.workspaceMember.count).mockResolvedValue(1);

      const res = await request(app)
        .patch("/workspaces/ws-1/members/mem-1")
        .send({ role: "admin" });

      expect(res.status).toBe(400);
    });

    it("rejects admin promoting a member to owner", async () => {
      // A workspace admin (non-owner) should not be able to set role to owner
      const adminUser = { userId: "user-admin", role: "developer", workspaces: ["ws-1"] };
      const app = createApp(adminUser);
      // requireWorkspaceRole("admin") middleware calls findUnique first
      // then the handler's owner guard calls findUnique again
      vi.mocked(prisma.workspaceMember.findUnique)
        // 1st call: requireWorkspaceRole middleware checks user has admin role
        .mockResolvedValueOnce({
          id: "mem-admin",
          workspaceId: "ws-1",
          userId: "user-admin",
          role: "admin",
          joinedAt: new Date(),
          updatedAt: new Date(),
        } as never)
        // 2nd call: handler's owner guard checks if caller is owner
        .mockResolvedValueOnce({
          id: "mem-admin",
          workspaceId: "ws-1",
          userId: "user-admin",
          role: "admin",
          joinedAt: new Date(),
          updatedAt: new Date(),
        } as never);

      const res = await request(app)
        .patch("/workspaces/ws-1/members/mem-2")
        .send({ role: "owner" });

      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("allows workspace owner to promote a member to owner", async () => {
      const ownerUser = { userId: "user-owner", role: "developer", workspaces: ["ws-1"] };
      const app = createApp(ownerUser);
      vi.mocked(prisma.workspaceMember.findUnique)
        // 1st call: requireWorkspaceRole middleware checks user has admin+ role
        .mockResolvedValueOnce({
          id: "mem-owner",
          workspaceId: "ws-1",
          userId: "user-owner",
          role: "owner",
          joinedAt: new Date(),
          updatedAt: new Date(),
        } as never)
        // 2nd call: handler's owner guard verifies caller is owner
        .mockResolvedValueOnce({
          id: "mem-owner",
          workspaceId: "ws-1",
          userId: "user-owner",
          role: "owner",
          joinedAt: new Date(),
          updatedAt: new Date(),
        } as never)
        // 3rd call: target member lookup
        .mockResolvedValueOnce({
          id: "mem-2",
          workspaceId: "ws-1",
          userId: "user-2",
          role: "member",
          joinedAt: new Date(),
          updatedAt: new Date(),
        } as never);
      vi.mocked(prisma.workspaceMember.update).mockResolvedValue({
        id: "mem-2",
        role: "owner",
      } as never);

      const res = await request(app)
        .patch("/workspaces/ws-1/members/mem-2")
        .send({ role: "owner" });

      expect(res.status).toBe(200);
      expect(res.body.data.role).toBe("owner");
    });
  });

  describe("DELETE /:id/members/:memberId", () => {
    it("removes a member", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: "mem-2",
        workspaceId: "ws-1",
        userId: "user-2",
        role: "member",
        joinedAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.workspaceMember.delete).mockResolvedValue({} as never);

      const res = await request(app).delete("/workspaces/ws-1/members/mem-2");

      expect(res.status).toBe(200);
      expect(res.body.data.removed).toBe(true);
    });

    it("rejects removing sole owner", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
        id: "mem-1",
        workspaceId: "ws-1",
        userId: "user-1",
        role: "owner",
        joinedAt: new Date(),
        updatedAt: new Date(),
      } as never);
      vi.mocked(prisma.workspaceMember.count).mockResolvedValue(1);

      const res = await request(app).delete("/workspaces/ws-1/members/mem-1");

      expect(res.status).toBe(400);
    });
  });

  describe("GET /invites/:token", () => {
    it("returns invite details for valid token", async () => {
      const app = createApp();
      vi.mocked(prisma.workspaceInvite.findUnique).mockResolvedValue({
        id: "inv-1",
        workspaceId: "ws-1",
        email: "user@test.com",
        role: "member",
        token: "valid-token",
        consumedAt: null,
        expiresAt: new Date(Date.now() + 86400000),
        invitedById: "inviter-1",
        workspace: { id: "ws-1", name: "Test", slug: "test" },
        invitedBy: { displayName: "Inviter" },
        createdAt: new Date(),
      } as never);

      const res = await request(app).get("/workspaces/invites/valid-token");
      expect(res.status).toBe(200);
      expect(res.body.data.workspace.name).toBe("Test");
    });

    it("returns 404 for invalid token", async () => {
      const app = createApp();
      vi.mocked(prisma.workspaceInvite.findUnique).mockResolvedValue(null);

      const res = await request(app).get("/workspaces/invites/bad-token");
      expect(res.status).toBe(404);
    });

    it("returns expired status for expired token", async () => {
      const app = createApp();
      vi.mocked(prisma.workspaceInvite.findUnique).mockResolvedValue({
        id: "inv-1",
        workspaceId: "ws-1",
        email: "user@test.com",
        role: "member",
        token: "expired-token",
        consumedAt: null,
        expiresAt: new Date(Date.now() - 86400000),
        invitedById: "inviter-1",
        workspace: { id: "ws-1", name: "Test", slug: "test" },
        invitedBy: { displayName: "Inviter" },
        createdAt: new Date(),
      } as never);

      const res = await request(app).get("/workspaces/invites/expired-token");
      expect(res.status).toBe(200);
      expect(res.body.data.valid).toBe(false);
      expect(res.body.data.expired).toBe(true);
    });
  });

  describe("GET /:id", () => {
    it("returns workspace details", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspace.findUnique).mockResolvedValue({
        id: "ws-1",
        name: "Test",
        slug: "test",
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
        members: [],
        _count: { projects: 3 },
      } as never);

      const res = await request(app).get("/workspaces/ws-1");
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Test");
    });

    it("returns 404 for non-existent workspace", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspace.findUnique).mockResolvedValue(null);

      const res = await request(app).get("/workspaces/ws-nonexistent");
      expect(res.status).toBe(404);
    });
  });

  describe("PATCH /:id", () => {
    it("updates workspace settings", async () => {
      const app = createApp(mockAdmin);
      vi.mocked(prisma.workspace.update).mockResolvedValue({
        id: "ws-1",
        name: "Updated Name",
        slug: "test",
        logoUrl: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        deletedAt: null,
      } as never);

      const res = await request(app).patch("/workspaces/ws-1").send({ name: "Updated Name" });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe("Updated Name");
    });
  });
});

describe("requireWorkspaceRole middleware", () => {
  it("allows system admin to bypass", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { userId: string; role: string } }).user = {
        userId: "admin-1",
        role: "admin",
      };
      next();
    });
    app.get("/:id", requireWorkspaceRole("owner"), (_req, res) => {
      res.json({ ok: true });
    });

    const res = await request(app).get("/ws-1");
    expect(res.status).toBe(200);
  });

  it("rejects non-member", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { userId: string; role: string } }).user = {
        userId: "user-99",
        role: "developer",
      };
      next();
    });
    app.get("/:id", requireWorkspaceRole("member"), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(
      (
        err: AppError | Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        const status = err instanceof AppError ? err.statusCode : 500;
        res.status(status).json({ error: err.message });
      },
    );

    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue(null);

    const res = await request(app).get("/ws-1");
    expect(res.status).toBe(404);
  });

  it("rejects insufficient role", async () => {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as unknown as { user: { userId: string; role: string } }).user = {
        userId: "user-1",
        role: "developer",
      };
      next();
    });
    app.get("/:id", requireWorkspaceRole("owner"), (_req, res) => {
      res.json({ ok: true });
    });
    app.use(
      (
        err: AppError | Error,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction,
      ) => {
        const status = err instanceof AppError ? err.statusCode : 500;
        res.status(status).json({ error: err.message });
      },
    );

    vi.mocked(prisma.workspaceMember.findUnique).mockResolvedValue({
      id: "mem-1",
      workspaceId: "ws-1",
      userId: "user-1",
      role: "member",
      joinedAt: new Date(),
      updatedAt: new Date(),
    } as never);

    const res = await request(app).get("/ws-1");
    expect(res.status).toBe(403);
  });
});

/*
 * `requireWorkspaceAccess` and `workspaceScopeFilter` were tested here until
 * #1083. Both were deleted as unreachable: no module under `server/src` ever
 * imported either one. The rules they described are enforced in production by
 * `requireProjectAccess` (`middleware/require-project-access.ts`, covered by
 * `middleware/require-project-access.test.ts` and `project-access-*.test.ts`)
 * and expressed for list queries by `accessibleProjectWhere` (`lib/acp/authz.ts`),
 * `runProjectScope` (`lib/async/run-authz.ts`) and `listProjects`.
 */
