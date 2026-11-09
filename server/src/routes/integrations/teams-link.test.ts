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
// #2089 — the binding notice reads the workspace's owner row, its name and the
// people it names, and writes one notification per recipient.
let ownerId: string | null = "u-owner";
const notificationCreate = vi.fn(async (_args: { data: Record<string, unknown> }) => ({
  id: "n-1",
}));
const ownerLookup = vi.fn(async () => (ownerId ? { userId: ownerId } : null));
vi.mock("../../lib/prisma.js", () => ({
  prisma: {
    workspaceMember: {
      findUnique: vi.fn(async () => ({ role: wsRole })),
      findFirst: (...a: unknown[]) => ownerLookup(...(a as [])),
    },
    project: {
      findFirst: vi.fn(async () =>
        projectWorkspaceId === null ? null : { workspaceId: projectWorkspaceId },
      ),
    },
    workspace: { findUnique: vi.fn(async () => ({ name: "Acme" })) },
    user: {
      findMany: vi.fn(async ({ where }: { where: { id: { in: string[] } } }) =>
        where.id.in.map((id) => ({ id, displayName: `Name ${id}`, username: id })),
      ),
    },
    notification: { create: (args: { data: Record<string, unknown> }) => notificationCreate(args) },
  },
}));

const auditMock = vi.fn();
vi.mock("../../lib/audit/audit-service.js", () => ({
  audit: (...a: unknown[]) => auditMock(...a),
}));

// canAccessThread is the member-only gate; drive it deterministically.
let threadAccess:
  { ok: true; projectId: string } | { ok: false; reason: "not_found" | "forbidden" } = {
  ok: true,
  projectId: "pr-1",
};
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
    ownerId = "u-owner";
    notificationCreate.mockClear();
    ownerLookup.mockClear();
    auditMock.mockClear();
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
        linkByEmail: vi.fn(async (): Promise<LinkOutcome> => ({
          ok: false,
          reason: "no_matching_user",
        })),
      });
      const res = await request(createApp(stubLinkStore(), resolver))
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-1", email: "ghost@corp.com" });
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe("AAD_USER_UNMAPPED");
    });

    it("#1431 — scopes the bind to the route's workspace; a system-admin target needs a system-admin caller", async () => {
      const resolver = stubResolver();
      await request(createApp(stubLinkStore(), resolver))
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-1", userId: "u-alice" });
      expect(resolver.linkExplicit).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", allowSystemAdminTarget: false }),
      );

      currentUser = { userId: "u-root", role: "admin" };
      await request(createApp(stubLinkStore(), resolver))
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-1", email: "alice@corp.com" });
      expect(resolver.linkByEmail).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", allowSystemAdminTarget: true }),
      );
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
      expect(auditMock).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });
  });

  // #2089 — no MFA gate on binding (owner decision), but a binding is never
  // silent: it is audited, and the owner and the bound member are told.
  describe("POST /workspaces/:id/identities — audit and owner notice (#2089)", () => {
    /** A resolver that binds whichever userId the caller names. */
    function bindAsRequested(): TeamsAadIdentityResolver {
      return stubResolver({
        linkExplicit: vi.fn(async (p: { userId: string }): Promise<LinkOutcome> => ({
          ok: true,
          userId: p.userId,
        })),
      });
    }

    async function bind(userId: string) {
      return request(createApp(stubLinkStore(), bindAsRequested()))
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-9", userId });
    }

    const notified = () => notificationCreate.mock.calls.map((c) => c[0].data.userId);

    it("an admin binding a chat account to the owner succeeds, is audited and tells the owner", async () => {
      currentUser = { userId: "u-admin", role: "developer" };
      const res = await bind("u-owner");
      expect(res.status).toBe(201);
      expect(res.body.data.userId).toBe("u-owner");

      expect(auditMock).toHaveBeenCalledTimes(1);
      expect(auditMock).toHaveBeenCalledWith({
        actor: "u-admin",
        action: "chatops.identity.bind",
        target: { type: "user", id: "u-owner" },
        metadata: {
          workspaceId: "ws-1",
          provider: "teams",
          boundUserId: "u-owner",
          externalScope: "tenant-a",
          externalId: "aad-9",
        },
      });

      expect(notified()).toEqual(["u-owner"]);
      const data = notificationCreate.mock.calls[0][0].data;
      expect(data).toMatchObject({
        type: "chat_identity_bound",
        title: "A Microsoft Teams account can now act as you",
        projectId: null,
      });
      expect(data.message).toBe(
        'Name u-admin linked Microsoft Teams account aad-9 to you in the workspace "Acme". ' +
          "Chat commands from that account now run with your permissions in this workspace.",
      );
    });

    it("the owner binding their own chat account is notified once", async () => {
      currentUser = { userId: "u-owner", role: "developer" };
      const res = await bind("u-owner");
      expect(res.status).toBe(201);
      expect(notified()).toEqual(["u-owner"]);
      expect(auditMock).toHaveBeenCalledWith(expect.objectContaining({ actor: "u-owner" }));
    });

    it("an admin binding another member tells both the owner and that member", async () => {
      currentUser = { userId: "u-admin", role: "developer" };
      await bind("u-alice");
      expect(notified().sort()).toEqual(["u-alice", "u-owner"]);
      const toOwner = notificationCreate.mock.calls.find((c) => c[0].data.userId === "u-owner");
      expect(toOwner?.[0].data.title).toBe("A Microsoft Teams account can now act as Name u-alice");
      expect(toOwner?.[0].data.message).toContain("to Name u-alice in the workspace");
      expect(toOwner?.[0].data.message).toContain("run with their permissions");
    });

    it("an admin binding their own chat account tells the owner, not themselves", async () => {
      currentUser = { userId: "u-admin", role: "developer" };
      await bind("u-admin");
      expect(notified()).toEqual(["u-owner"]);
    });

    it("a refused binding is neither audited nor announced", async () => {
      const resolver = stubResolver({
        linkExplicit: vi.fn(async (): Promise<LinkOutcome> => ({
          ok: false,
          reason: "no_matching_user",
        })),
      });
      const res = await request(createApp(stubLinkStore(), resolver))
        .post("/api/integrations/teams/workspaces/ws-1/identities")
        .send({ tenantId: "tenant-a", aadObjectId: "aad-9", userId: "u-owner" });
      expect(res.status).toBe(404);
      expect(auditMock).not.toHaveBeenCalled();
      expect(notificationCreate).not.toHaveBeenCalled();
    });

    it("a failed notice write is logged, never fails the bind, and the other recipient still gets theirs", async () => {
      currentUser = { userId: "u-admin", role: "developer" };
      notificationCreate.mockImplementationOnce(async () => {
        throw new Error("db down");
      });
      const res = await bind("u-alice");
      expect(res.status).toBe(201);
      expect(notificationCreate).toHaveBeenCalledTimes(2);
      expect(auditMock).toHaveBeenCalledTimes(1);
    });

    it("a workspace with no owner row still audits and tells the bound member", async () => {
      ownerId = null;
      currentUser = { userId: "u-admin", role: "developer" };
      const res = await bind("u-alice");
      expect(res.status).toBe(201);
      expect(notified()).toEqual(["u-alice"]);
      expect(auditMock).toHaveBeenCalledTimes(1);
    });

    it("a failed recipient lookup never fails the bind; the audit row is still queued", async () => {
      ownerLookup.mockImplementationOnce(async () => {
        throw new Error("db down");
      });
      currentUser = { userId: "u-admin", role: "developer" };
      const res = await bind("u-owner");
      expect(res.status).toBe(201);
      expect(notificationCreate).not.toHaveBeenCalled();
      expect(auditMock).toHaveBeenCalledTimes(1);
    });
  });
});
