/**
 * /api/workspaces — Workspace CRUD, member management, and invitation flow.
 *
 * Epic #759 — Organization-Level Multi-Tenancy.
 * Issues: #760 (schema), #764 (RBAC), #765 (invitations).
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import crypto from "node:crypto";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requireWorkspaceRole } from "../middleware/require-workspace-role.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit/audit-service.js";

// Express 5 widened ParamsDictionary to Record<string, string | string[]>.
// Route parameters resolved from URL patterns are always single strings;
// this local alias restores the previous behaviour so handlers typecheck.
type Req = Request & { params: Record<string, string> };

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

// ── Validation schemas ──────────────────────────────────────────────────────
const createWorkspaceSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(60)
    .regex(/^[a-z0-9][a-z0-9-]*[a-z0-9]$/, "Slug must be lowercase alphanumeric with hyphens"),
});

const updateWorkspaceSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  logoUrl: z.string().url().max(500).nullable().optional(),
});

const inviteSchema = z.object({
  email: z.string().email().max(255),
  role: z.enum(["admin", "member"]).default("member"),
});

const updateMemberRoleSchema = z.object({
  role: z.enum(["owner", "admin", "member"]),
});

const INVITE_EXPIRY_DAYS = 7;

function generateInviteToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function workspacesRouter(): Router {
  const r = Router();

  // ── List user's workspaces ────────────────────────────────────────────────
  r.get("/", requireAuth, async (req: Req, res: Response) => {
    const userId = actorId(req);
    const memberships = await prisma.workspaceMember.findMany({
      where: { userId },
      include: {
        workspace: {
          select: { id: true, name: true, slug: true, logoUrl: true, createdAt: true },
        },
      },
    });
    const workspaces = memberships.map((m) => ({
      ...m.workspace,
      role: m.role,
      joinedAt: m.joinedAt,
    }));
    res.json(ok(workspaces));
  });

  // ── Create workspace ──────────────────────────────────────────────────────
  r.post("/", requireAuth, async (req: Req, res: Response) => {
    const userId = actorId(req);
    const parsed = createWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid workspace payload", {
        issues: parsed.error.errors,
      });
    }

    const existing = await prisma.workspace.findUnique({
      where: { slug: parsed.data.slug },
    });
    if (existing) {
      throw new AppError(409, "CONFLICT", "A workspace with this slug already exists");
    }

    const workspace = await prisma.workspace.create({
      data: {
        name: parsed.data.name,
        slug: parsed.data.slug,
        members: {
          create: { userId, role: "owner" },
        },
      },
    });

    audit({
      actor: { id: userId },
      action: "workspace.create",
      target: { type: "workspace", id: workspace.id },
      metadata: { name: workspace.name, slug: workspace.slug },
    });

    res.status(201).json(ok(workspace));
  });

  // ── Get workspace details ─────────────────────────────────────────────────
  r.get("/:id", requireAuth, requireWorkspaceRole("member"), async (req: Req, res: Response) => {
    const workspace = await prisma.workspace.findUnique({
      where: { id: req.params.id, deletedAt: null },
      include: {
        members: {
          include: {
            user: { select: { id: true, username: true, displayName: true, email: true } },
          },
        },
        _count: { select: { projects: true } },
      },
    });
    if (!workspace) {
      throw new AppError(404, "NOT_FOUND", "Workspace not found");
    }
    res.json(ok(workspace));
  });

  // ── Update workspace settings ─────────────────────────────────────────────
  r.patch("/:id", requireAuth, requireWorkspaceRole("admin"), async (req: Req, res: Response) => {
    const parsed = updateWorkspaceSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid update payload", {
        issues: parsed.error.errors,
      });
    }

    const workspace = await prisma.workspace.update({
      where: { id: req.params.id },
      data: parsed.data,
    });

    audit({
      actor: { id: actorId(req) },
      action: "workspace.update",
      target: { type: "workspace", id: workspace.id },
      metadata: parsed.data,
    });

    res.json(ok(workspace));
  });

  // ── Delete workspace (owner only) ─────────────────────────────────────────
  r.delete("/:id", requireAuth, requireWorkspaceRole("owner"), async (req: Req, res: Response) => {
    const workspaceId = req.params.id;

    // Don't allow deleting the default workspace
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
    });
    if (workspace?.slug === "default") {
      throw new AppError(400, "BAD_REQUEST", "Cannot delete the default workspace");
    }

    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { deletedAt: new Date() },
    });

    audit({
      actor: { id: actorId(req) },
      action: "workspace.delete",
      target: { type: "workspace", id: workspaceId },
    });

    res.json(ok({ deleted: true }));
  });

  // ── Transfer ownership ────────────────────────────────────────────────────
  r.post(
    "/:id/transfer",
    requireAuth,
    requireWorkspaceRole("owner"),
    async (req: Req, res: Response) => {
      const { targetUserId } = z.object({ targetUserId: z.string().min(1) }).parse(req.body);
      const workspaceId = req.params.id;
      const currentUserId = actorId(req);

      // Verify target is a member
      const targetMember = await prisma.workspaceMember.findUnique({
        where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
      });
      if (!targetMember) {
        throw new AppError(404, "NOT_FOUND", "Target user is not a member of this workspace");
      }

      await prisma.$transaction([
        prisma.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: targetUserId } },
          data: { role: "owner" },
        }),
        prisma.workspaceMember.update({
          where: { workspaceId_userId: { workspaceId, userId: currentUserId } },
          data: { role: "admin" },
        }),
      ]);

      audit({
        actor: { id: currentUserId },
        action: "workspace.transfer",
        target: { type: "workspace", id: workspaceId },
        metadata: { newOwnerId: targetUserId },
      });

      res.json(ok({ transferred: true }));
    },
  );

  // ── Member management ─────────────────────────────────────────────────────
  r.patch(
    "/:id/members/:memberId",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const parsed = updateMemberRoleSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid role", {
          issues: parsed.error.errors,
        });
      }

      // Only workspace owners (or system admins) can promote to owner
      if (parsed.data.role === "owner" && req.user!.role !== "admin") {
        const callerMembership = await prisma.workspaceMember.findUnique({
          where: {
            workspaceId_userId: {
              workspaceId: req.params.id,
              userId: req.user!.userId,
            },
          },
        });
        if (!callerMembership || callerMembership.role !== "owner") {
          throw new AppError(403, "FORBIDDEN", "Only workspace owners can promote to owner");
        }
      }

      const member = await prisma.workspaceMember.findUnique({
        where: { id: req.params.memberId },
      });
      if (!member || member.workspaceId !== req.params.id) {
        throw new AppError(404, "NOT_FOUND", "Member not found");
      }

      // Cannot demote the sole owner
      if (member.role === "owner" && parsed.data.role !== "owner") {
        const ownerCount = await prisma.workspaceMember.count({
          where: { workspaceId: req.params.id, role: "owner" },
        });
        if (ownerCount <= 1) {
          throw new AppError(400, "BAD_REQUEST", "Cannot demote the only workspace owner");
        }
      }

      const updated = await prisma.workspaceMember.update({
        where: { id: req.params.memberId },
        data: { role: parsed.data.role },
      });

      res.json(ok(updated));
    },
  );

  r.delete(
    "/:id/members/:memberId",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const member = await prisma.workspaceMember.findUnique({
        where: { id: req.params.memberId },
      });
      if (!member || member.workspaceId !== req.params.id) {
        throw new AppError(404, "NOT_FOUND", "Member not found");
      }

      // Cannot remove the sole owner
      if (member.role === "owner") {
        const ownerCount = await prisma.workspaceMember.count({
          where: { workspaceId: req.params.id, role: "owner" },
        });
        if (ownerCount <= 1) {
          throw new AppError(400, "BAD_REQUEST", "Cannot remove the only workspace owner");
        }
      }

      await prisma.workspaceMember.delete({ where: { id: req.params.memberId } });
      res.json(ok({ removed: true }));
    },
  );

  // ── Invitation flow (#765) ────────────────────────────────────────────────
  r.post(
    "/:id/invites",
    requireAuth,
    requireWorkspaceRole("admin"),
    async (req: Req, res: Response) => {
      const parsed = inviteSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid invite payload", {
          issues: parsed.error.errors,
        });
      }

      const workspaceId = req.params.id;
      const userId = actorId(req);

      // Check if user is already a member
      const existingUser = await prisma.user.findUnique({
        where: { email: parsed.data.email },
      });
      if (existingUser) {
        const existingMember = await prisma.workspaceMember.findUnique({
          where: {
            workspaceId_userId: { workspaceId, userId: existingUser.id },
          },
        });
        if (existingMember) {
          throw new AppError(409, "CONFLICT", "User is already a member of this workspace");
        }
      }

      // Invalidate previous pending invites for same email+workspace (re-invite)
      await prisma.workspaceInvite.updateMany({
        where: {
          workspaceId,
          email: parsed.data.email,
          consumedAt: null,
        },
        data: { consumedAt: new Date() }, // mark old tokens as consumed
      });

      const token = generateInviteToken();
      const expiresAt = new Date(Date.now() + INVITE_EXPIRY_DAYS * 24 * 60 * 60 * 1000);

      const invite = await prisma.workspaceInvite.create({
        data: {
          workspaceId,
          email: parsed.data.email,
          role: parsed.data.role,
          token,
          invitedById: userId,
          expiresAt,
        },
      });

      audit({
        actor: { id: userId },
        action: "workspace.invite.create",
        target: { type: "workspace", id: workspaceId },
        metadata: { email: parsed.data.email, role: parsed.data.role },
      });

      // In production, queue an email here. For now return the token.
      res.status(201).json(ok({ id: invite.id, email: invite.email, expiresAt, token }));
    },
  );

  // ── Accept invite (public — no auth required) ─────────────────────────────
  r.post("/invites/:token/accept", async (req: Req, res: Response) => {
    const { token } = req.params;

    const invite = await prisma.workspaceInvite.findUnique({
      where: { token },
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
        invitedBy: { select: { displayName: true } },
      },
    });

    if (!invite) {
      throw new AppError(404, "NOT_FOUND", "Invalid invitation token");
    }
    if (invite.consumedAt) {
      throw new AppError(410, "GONE", "Invitation has already been used");
    }
    if (invite.expiresAt < new Date()) {
      throw new AppError(410, "GONE", "Invitation has expired");
    }

    // Find user by email (must be registered)
    const user = await prisma.user.findUnique({
      where: { email: invite.email },
    });
    if (!user) {
      throw new AppError(
        400,
        "BAD_REQUEST",
        "No account found with this email. Please register first.",
      );
    }

    // Check if already a member
    const existing = await prisma.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId: invite.workspaceId, userId: user.id } },
    });

    if (!existing) {
      await prisma.workspaceMember.create({
        data: {
          workspaceId: invite.workspaceId,
          userId: user.id,
          role: invite.role,
        },
      });
    }

    // Mark invite as consumed
    await prisma.workspaceInvite.update({
      where: { id: invite.id },
      data: { consumedAt: new Date() },
    });

    audit({
      actor: { id: user.id },
      action: "workspace.invite.accept",
      target: { type: "workspace", id: invite.workspaceId },
      metadata: { email: invite.email },
    });

    res.json(ok({ workspace: invite.workspace, role: invite.role }));
  });

  // ── Validate invite token (public — for the accept page UI) ───────────────
  r.get("/invites/:token", async (req: Req, res: Response) => {
    const { token } = req.params;

    const invite = await prisma.workspaceInvite.findUnique({
      where: { token },
      include: {
        workspace: { select: { id: true, name: true, slug: true } },
        invitedBy: { select: { displayName: true } },
      },
    });

    if (!invite) {
      throw new AppError(404, "NOT_FOUND", "Invalid invitation token");
    }

    const expired = invite.expiresAt < new Date();
    const consumed = !!invite.consumedAt;

    res.json(
      ok({
        valid: !expired && !consumed,
        expired,
        consumed,
        workspace: invite.workspace,
        invitedBy: invite.invitedBy.displayName,
        email: invite.email,
        role: invite.role,
        expiresAt: invite.expiresAt,
      }),
    );
  });

  return r;
}
