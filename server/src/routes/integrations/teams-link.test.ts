/**
 * Epic #547 (Phase 1, #549) — link + identity route tests.
 *
 * Covers the member-only thread↔channel link endpoints and the workspace-admin
 * AAD-identity binding endpoint, with `canAccessThread` and `prisma` mocked so
 * the route's authz branches are exercised without a real DB.
 *
 * Per the repo convention, prisma.js is mocked so a non-admin workspace-role
 * path would not hit a real DB; canAccessThread is mocked so the discussions
 * member-only gate is driven deterministically.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";

let currentUser: { userId: string; role: string } = { userId: "u-1", role: "developer" };
vi.mock("../../middleware/auth.js", () => ({
  requireAuth: (req: express.Request, _res: express.Response, next: () => void) => {
    (req as unknown as { user: typeof currentUser }).user = currentUser;
    next();
  },
}));

// require-workspace-role reads prisma.workspaceMember; the identity route uses
// admin. Mock prisma: workspaceMember role is controlled per-test via `wsRole`,
// and project.findFirst returns the thread's workspace for the link route.
let wsRole = "admin";
let projectWorkspaceId: string | null = "ws-1";
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    workspaceMember: { findUnique: vi.fn(async () => ({ role: wsRole })) },
    project: {
      findFirst: vi.fn(async () =>
        projectWorkspaceId === null ? null : { workspaceId: projectWorkspaceId },
      ),
    },
  },
}));

// canAccessThread is the member-only gate; drive it deterministically.
let threadAccess:
  | { ok: true; projectId: string }
  | { ok: false; reason: "not_found" | "forbidden" } = { ok: true, projectId: "pr-1" };
vi.mock("../../lib/discussions/access.js", () => ({
  canAccessThread: vi.fn(async () => threadAccess),
}));

import { teamsIntegrationRouter } from "./teams.js";
import { errorHandler } from "../../middleware/error-handler.js";
import type { TeamsInstallationStore } from "../../lib/teams/installation-store.js";
import type {
  TeamsChannelLinkStore,
  ChannelLinkSummary,
} from "../../lib/teams/channel-link-store.js";
import { TeamsLinkError } from "../../lib/teams/channel-link-store.js";
import type {
  TeamsAadIdentityResolver,
  LinkOutcome,
} from "../../lib/teams/aad-identity-resolver.js";

function stubInstallStore(): TeamsInstallationStore {
  return {
    install: vi.fn(),
    getByWorkspace: vi.fn(async () => null),
    resolveAppPassword: vi.fn(async () => null),
    uninstall: vi.fn(async () => false),
  } as unknown as TeamsInstallationStore;
}

function summary(over: Partial<ChannelLinkSummary> = {}): ChannelLinkSummary {
  return {
    id: "lnk-1",
    workspaceId: "ws-1",
    threadId: "th-1",
    projectId: "pr-1",
    conversationId: "convo-1",
    channelId: "msteams",
    tenantId: "tenant-a",
    status: "active",
    createdById: "u-1",
    createdAt: new Date(),
    updatedAt: new Date(),
    ...over,
  };
}

function stubLinkStore(over: Partial<TeamsChannelLinkStore> = {}): TeamsChannelLinkStore {
  return {
    create: vi.fn(async () => summary()),
    getByThread: vi.fn(async () => null),
    getByConversation: vi.fn(async () => null),
    listByWorkspace: vi.fn(async () => [summary()]),
    delete: vi.fn(async () => true),
    ...over,
  } as unknown as TeamsChannelLinkStore;
}

function stubResolver(over: Partial<TeamsAadIdentityResolver> = {}): TeamsAadIdentityResolver {
  return {
    resolveUserFromAadObjectId: vi.fn(async () => null),
    linkByEmail: vi.fn(async (): Promise<LinkOutcome> => ({ ok: true, userId: "u-alice" })),
    linkExplicit: vi.fn(async (): Promise<LinkOutcome> => ({ ok: true, userId: "u-alice" })),
    unlink: vi.fn(async () => true),
    ...over,
  } as unknown as TeamsAadIdentityResolver;
}

function createApp(
  link: TeamsChannelLinkStore = stubLinkStore(),
  resolver: TeamsAadIdentityResolver = stubResolver(),
) {
  const app = express();
  app.use(express.json());
  app.use("/api/integrations/teams", teamsIntegrationRouter(stubInstallStore(), link, resolver));
  app.use(errorHandler);
  return app;
}

describe("Teams link + identity routes (#549)", () => {
  beforeEach(() => {
    currentUser = { userId: "u-1", role: "developer" };
    wsRole = "admin";
    projectWorkspaceId = "ws-1";
    threadAccess = { ok: true, projectId: "pr-1" };
  });

  describe("POST /workspaces/:id/links (create)", () => {
    it("creates a link for a member of the thread's project → 201", async () => {
      const link = stubLinkStore();
      const res = await request(createApp(link))
        .post("/api/integrations/teams/workspaces/ws-1/links")
        .send({ threadId: "th-1", conversationId: "convo-1", tenantId: "tenant-a" });
      expect(res.status).toBe(201);
      expect(res.body.data.threadId).toBe("th-1");
      expect(link.create).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", projectId: "pr-1", threadId: "th-1" }),
      );
    });

    it("rejects a NON-member (canAccessThread forbidden) → 403", async () => {
      threadAccess = { ok: false, reason: "forbidden" };
      const res = await request(createApp())
        .post("/api/integrations/teams/workspaces/ws-1/links")
        .send({ threadId: "th-1", conversationId: "convo-1" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("FORBIDDEN");
    });

    it("returns 404 for a missing/soft-deleted thread", async () => {
      threadAccess = { ok: false, reason: "not_found" };
      const res = await request(createApp())
        .post("/api/integrations/teams/workspaces/ws-1/links")
        .send({ threadId: "th-x", conversationId: "convo-1" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("THREAD_NOT_FOUND");
    });

    it("rejects when the thread's project is in a DIFFERENT workspace → 403", async () => {
      projectWorkspaceId = "ws-other";
      const res = await request(createApp())
        .post("/api/integrations/teams/workspaces/ws-1/links")
        .send({ threadId: "th-1", conversationId: "convo-1" });
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe("WORKSPACE_MISMATCH");
    });

    it("maps a store LINK_CONFLICT to 409", async () => {
      const link = stubLinkStore({
        create: vi.fn(async () => {
          throw new TeamsLinkError(409, "LINK_CONFLICT", "already linked");
        }),
      });
      const res = await request(createApp(link))
        .post("/api/integrations/teams/workspaces/ws-1/links")
        .send({ threadId: "th-1", conversationId: "convo-1" });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("LINK_CONFLICT");
    });

    it("validates the payload (missing conversationId) → 400", async () => {
      const res = await request(createApp())
        .post("/api/integrations/teams/workspaces/ws-1/links")
        .send({ threadId: "th-1" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });
  });

  describe("GET /workspaces/:id/links (list)", () => {
    it("lists only links whose thread the actor can access", async () => {
      const link = stubLinkStore({
        listByWorkspace: vi.fn(async () => [
          summary({ id: "a", threadId: "th-1" }),
          summary({ id: "b", threadId: "th-2", conversationId: "convo-2" }),
        ]),
      });
      // First thread allowed, second forbidden.
      const { canAccessThread } = await import("../../lib/discussions/access.js");
      (canAccessThread as unknown as ReturnType<typeof vi.fn>)
        .mockResolvedValueOnce({ ok: true, projectId: "pr-1" })
        .mockResolvedValueOnce({ ok: false, reason: "forbidden" });

      const res = await request(createApp(link)).get(
        "/api/integrations/teams/workspaces/ws-1/links",
      );
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].id).toBe("a");
    });
  });

  describe("DELETE /workspaces/:id/links/:linkId (unlink)", () => {
    it("unlinks for a member → 200", async () => {
      const link = stubLinkStore();
      const res = await request(createApp(link)).delete(
        "/api/integrations/teams/workspaces/ws-1/links/lnk-1",
      );
      expect(res.status).toBe(200);
      expect(res.body.data.unlinked).toBe(true);
      expect(link.delete).toHaveBeenCalledWith("ws-1", "lnk-1");
    });

    it("returns 404 when the link id is not in the workspace", async () => {
      const link = stubLinkStore({ listByWorkspace: vi.fn(async () => []) });
      const res = await request(createApp(link)).delete(
        "/api/integrations/teams/workspaces/ws-1/links/nope",
      );
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("LINK_NOT_FOUND");
    });

    it("rejects a non-member trying to unlink → 403", async () => {
      threadAccess = { ok: false, reason: "forbidden" };
      const link = stubLinkStore();
      const res = await request(createApp(link)).delete(
        "/api/integrations/teams/workspaces/ws-1/links/lnk-1",
      );
      expect(res.status).toBe(403);
      expect(link.delete).not.toHaveBeenCalled();
    });
  });

  describe("POST /workspaces/:id/identities (admin bind)", () => {
    it("binds by email (SSO match) → 201", async () => {
      const resolver = stubResolver();
      const res = await request(createApp(stubLinkStore(), resolver))
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-1", email: "alice@corp.com" });
      expect(res.status).toBe(201);
      expect(res.body.data.userId).toBe("u-alice");
      expect(resolver.linkByEmail).toHaveBeenCalled();
    });

    it("binds explicitly by userId → 201", async () => {
      const resolver = stubResolver();
      const res = await request(createApp(stubLinkStore(), resolver))
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-1", userId: "u-alice" });
      expect(res.status).toBe(201);
      expect(resolver.linkExplicit).toHaveBeenCalled();
    });

    it("returns 404 AAD_USER_UNMAPPED when no METIS user matches (never silently attributed)", async () => {
      const resolver = stubResolver({
        linkByEmail: vi.fn(
          async (): Promise<LinkOutcome> => ({
            ok: false,
            reason: "no_matching_user",
          }),
        ),
      });
      const res = await request(createApp(stubLinkStore(), resolver))
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-1", email: "ghost@corp.com" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("AAD_USER_UNMAPPED");
    });

    it("requires either email or userId → 400", async () => {
      const res = await request(createApp())
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-1" });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("rejects a non-admin actor (workspace-role) → 403", async () => {
      currentUser = { userId: "u-2", role: "developer" };
      wsRole = "member";
      const res = await request(createApp())
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-1", email: "alice@corp.com" });
      expect(res.status).toBe(403);
    });
  });
});
