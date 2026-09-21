/**
 * SCIM 2.0 endpoints — Users + Groups CRUD per RFC 7644.
 *
 * Epic #748, Issues #752, #753.
 * - Bearer-token auth for SCIM provisioning
 * - /scim/v2/Users GET (list + paginated), POST, PATCH, DELETE
 * - /scim/v2/Groups GET, POST, PATCH, DELETE
 * - /scim/v2/ServiceProviderConfig
 */
import crypto from "node:crypto";
import { Router, type Request, type Response } from "express";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit/audit-service.js";
import { AppError } from "../middleware/error-handler.js";
import { revokeAllUserSessions } from "../lib/auth/jwt.js";
import type {
  SCIMUser,
  SCIMGroup,
  SCIMListResponse,
  SCIMPatchOp,
  SCIMError,
  SCIMServiceProviderConfig,
} from "../lib/auth/sso-types.js";

/** Helper to coerce Express v5 params (string | string[]) to string. */
function param(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] : (value ?? "");
}

/** SCIM schema URNs. */
const SCIM_USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const SCIM_GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const SCIM_LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const SCIM_ERROR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";
const SCIM_SPC_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig";

/** In-memory SCIM bearer tokens (rotated via admin UI). */
const scimTokens = new Set<string>();
const defaultToken = process.env.SCIM_BEARER_TOKEN ?? "";
if (defaultToken) scimTokens.add(defaultToken);

/** Generate a cryptographically secure SCIM bearer token. */
export function generateScimToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

/** Add a SCIM token. Returns the token value. */
export function addScimToken(token: string): void {
  scimTokens.add(token);
}

/** Rotate the SCIM token: remove all old tokens, generate a new CSPRNG token. Returns the new token. */
export function rotateScimToken(newToken?: string): string {
  scimTokens.clear();
  const token = newToken ?? generateScimToken();
  scimTokens.add(token);
  return token;
}

/** Timing-safe comparison of two strings. */
function timingSafeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) {
    // Compare against itself to keep constant time, then return false
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/** Verify a SCIM bearer token using constant-time comparison. */
function verifyScimToken(req: Request): void {
  const auth = req.headers.authorization;
  if (!auth?.startsWith("Bearer ")) {
    throw scimError(401, "Authentication required");
  }
  const token = auth.slice(7).trim();
  let matched = false;
  for (const stored of scimTokens) {
    if (timingSafeCompare(token, stored)) {
      matched = true;
      break;
    }
  }
  if (!matched) {
    throw scimError(401, "Invalid bearer token");
  }
}

function scimError(status: number, detail: string): AppError {
  return new AppError(status, "SCIM_ERROR", detail);
}

function scimErrorResponse(status: string, detail: string): SCIMError {
  return { schemas: [SCIM_ERROR_SCHEMA], status, detail };
}

function buildScimUserFromDb(user: {
  id: string;
  username: string;
  displayName: string;
  email: string;
  status: string;
  createdAt: Date;
  updatedAt: Date;
}): SCIMUser {
  const baseUrl = process.env.APP_URL ?? "http://localhost:4000";
  return {
    schemas: [SCIM_USER_SCHEMA],
    id: user.id,
    externalId: user.username,
    userName: user.username,
    name: { formatted: user.displayName },
    displayName: user.displayName,
    emails: [{ value: user.email, type: "work", primary: true }],
    active: user.status === "active",
    meta: {
      resourceType: "User",
      created: user.createdAt.toISOString(),
      lastModified: user.updatedAt.toISOString(),
      location: `${baseUrl}/scim/v2/Users/${user.id}`,
    },
  };
}

export function scimRouter(): Router {
  const r = Router();

  // All SCIM routes require bearer token auth
  r.use((req, _res, next) => {
    try {
      verifyScimToken(req);
      next();
    } catch (err) {
      next(err);
    }
  });

  // --- ServiceProviderConfig ---
  r.get("/ServiceProviderConfig", (_req: Request, res: Response) => {
    const config: SCIMServiceProviderConfig = {
      schemas: [SCIM_SPC_SCHEMA],
      documentationUri: "https://metis.dev/docs/scim",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: true, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          type: "oauthbearertoken",
          name: "OAuth Bearer Token",
          description: "Bearer token for SCIM provisioning",
        },
      ],
    };
    res.json(config);
  });

  // --- Users CRUD (#752) ---

  r.get("/Users", async (req: Request, res: Response) => {
    const startIndex = Math.max(1, parseInt(req.query.startIndex as string) || 1);
    const count = Math.min(200, Math.max(1, parseInt(req.query.count as string) || 100));
    const filter = req.query.filter as string | undefined;

    let where: Record<string, unknown> = { deletedAt: null };
    if (filter) {
      // Basic filter support: userName eq "value"
      const match = filter.match(/userName\s+eq\s+"([^"]+)"/i);
      if (match) {
        where = { ...where, username: match[1] };
      }
    }

    const [users, total] = await Promise.all([
      prisma.user.findMany({
        where,
        skip: startIndex - 1,
        take: count,
        orderBy: { createdAt: "asc" },
      }),
      prisma.user.count({ where }),
    ]);

    const response: SCIMListResponse<SCIMUser> = {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: users.length,
      Resources: users.map(buildScimUserFromDb),
    };
    res.json(response);
  });

  r.get("/Users/:id", async (req: Request, res: Response) => {
    const user = await prisma.user.findFirst({
      where: { id: param(req.params.id), deletedAt: null },
    });
    if (!user) {
      res.status(404).json(scimErrorResponse("404", "User not found"));
      return;
    }
    res.json(buildScimUserFromDb(user));
  });

  r.post("/Users", async (req: Request, res: Response) => {
    const body = req.body as SCIMUser;
    if (!body.userName) {
      res.status(400).json(scimErrorResponse("400", "userName is required"));
      return;
    }

    const existing = await prisma.user.findUnique({ where: { username: body.userName } });
    if (existing && !existing.deletedAt) {
      res.status(409).json(scimErrorResponse("409", "User already exists"));
      return;
    }

    const email = body.emails?.[0]?.value ?? `${body.userName}@scim.local`;
    const displayName = body.displayName ?? body.name?.formatted ?? body.userName;

    const user = await prisma.$transaction(
      async (tx) => {
        const provisioned = await tx.user.upsert({
          where: { username: body.userName },
          update: {
            displayName,
            email,
            status: body.active !== false ? "active" : "disabled",
            deletedAt: null,
            authRolesInitializedAt: new Date(),
            authRoleAuthority: "scim",
          },
          create: {
            username: body.userName,
            displayName,
            email,
            status: body.active !== false ? "active" : "disabled",
            authRolesInitializedAt: new Date(),
            authRoleAuthority: "scim",
          },
        });
        // Re-provisioning must not expose provider grants left on a deleted user.
        await tx.userRole.deleteMany({ where: { userId: provisioned.id, source: "provider" } });
        return provisioned;
      },
      { isolationLevel: "Serializable" },
    );

    audit({
      actor: null,
      action: "scim.user.created",
      target: { type: "user", id: user.id },
      metadata: { username: user.username },
    });

    res.status(201).json(buildScimUserFromDb(user));
  });

  r.patch("/Users/:id", async (req: Request, res: Response) => {
    const user = await prisma.user.findFirst({
      where: { id: param(req.params.id), deletedAt: null },
    });
    if (!user) {
      res.status(404).json(scimErrorResponse("404", "User not found"));
      return;
    }

    const patch = req.body as SCIMPatchOp;
    const update: Record<string, unknown> = {};

    for (const op of patch.Operations ?? []) {
      if (op.path === "active" || op.path === "urn:ietf:params:scim:schemas:core:2.0:User:active") {
        update.status = op.value === true || op.value === "true" ? "active" : "disabled";
      } else if (op.path === "displayName") {
        update.displayName = String(op.value);
      } else if (op.path === "userName") {
        update.username = String(op.value);
      } else if (op.op === "replace" && !op.path && typeof op.value === "object") {
        // Bulk replace
        const val = op.value as Record<string, unknown>;
        if ("active" in val) update.status = val.active ? "active" : "disabled";
        if ("displayName" in val) update.displayName = String(val.displayName);
      }
    }

    if (Object.keys(update).length === 0) {
      res.json(buildScimUserFromDb(user));
      return;
    }

    const updated = await prisma.$transaction(
      async (tx) => {
        const current = await tx.user.findFirst({
          where: { id: user.id, deletedAt: null },
        });
        if (!current) return null;
        const statusChanged = update.status !== undefined && update.status !== current.status;
        const provisioned = await tx.user.update({
          where: { id: user.id },
          data: {
            ...update,
            ...(statusChanged
              ? { authRolesInitializedAt: new Date(), authRoleAuthority: "scim" }
              : {}),
          },
        });
        // Only an actual lifecycle transition transfers access authority to SCIM.
        if (statusChanged) {
          await tx.userRole.deleteMany({ where: { userId: user.id, source: "provider" } });
        }
        return provisioned;
      },
      { isolationLevel: "Serializable" },
    );
    if (!updated) {
      res.status(404).json(scimErrorResponse("404", "User not found"));
      return;
    }

    // Revoke all sessions when user is deactivated (Epic #748 AC #4)
    if (update.status === "disabled") {
      await revokeAllUserSessions(updated.id);
    }

    audit({
      actor: null,
      action: "scim.user.updated",
      target: { type: "user", id: updated.id },
      metadata: { ops: patch.Operations?.length },
    });

    res.json(buildScimUserFromDb(updated));
  });

  r.delete("/Users/:id", async (req: Request, res: Response) => {
    const user = await prisma.user.findFirst({
      where: { id: param(req.params.id), deletedAt: null },
    });
    if (!user) {
      res.status(404).json(scimErrorResponse("404", "User not found"));
      return;
    }

    await prisma.$transaction(
      async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: {
            deletedAt: new Date(),
            status: "disabled",
            authRolesInitializedAt: new Date(),
            authRoleAuthority: "scim",
          },
        });
        await tx.userRole.deleteMany({ where: { userId: user.id, source: "provider" } });
      },
      { isolationLevel: "Serializable" },
    );

    // Revoke all sessions when user is deprovisioned (Epic #748 AC #4)
    await revokeAllUserSessions(param(req.params.id));

    audit({
      actor: null,
      action: "scim.user.deleted",
      target: { type: "user", id: param(req.params.id) },
    });

    res.status(204).send();
  });

  // --- Groups CRUD (#753) ---

  r.get("/Groups", async (req: Request, res: Response) => {
    const startIndex = Math.max(1, parseInt(req.query.startIndex as string) || 1);
    const count = Math.min(200, Math.max(1, parseInt(req.query.count as string) || 100));

    const [roles, total] = await Promise.all([
      prisma.role.findMany({ skip: startIndex - 1, take: count }),
      prisma.role.count(),
    ]);

    const baseUrl = process.env.APP_URL ?? "http://localhost:4000";
    const groups: SCIMGroup[] = roles.map((role) => ({
      schemas: [SCIM_GROUP_SCHEMA],
      id: role.id,
      displayName: role.key,
      meta: {
        resourceType: "Group",
        created: role.createdAt.toISOString(),
        lastModified: role.updatedAt.toISOString(),
        location: `${baseUrl}/scim/v2/Groups/${role.id}`,
      },
    }));

    const response: SCIMListResponse<SCIMGroup> = {
      schemas: [SCIM_LIST_SCHEMA],
      totalResults: total,
      startIndex,
      itemsPerPage: groups.length,
      Resources: groups,
    };
    res.json(response);
  });

  r.get("/Groups/:id", async (req: Request, res: Response) => {
    const role = await prisma.role.findUnique({
      where: { id: param(req.params.id) },
      include: { users: { include: { user: true } } },
    });
    if (!role) {
      res.status(404).json(scimErrorResponse("404", "Group not found"));
      return;
    }

    const baseUrl = process.env.APP_URL ?? "http://localhost:4000";
    const group: SCIMGroup = {
      schemas: [SCIM_GROUP_SCHEMA],
      id: role.id,
      displayName: role.key,
      members: (
        role as unknown as { users: Array<{ user: { id: string; displayName: string } }> }
      ).users.map((ur) => ({
        value: ur.user.id,
        display: ur.user.displayName,
      })),
      meta: {
        resourceType: "Group",
        created: role.createdAt.toISOString(),
        lastModified: role.updatedAt.toISOString(),
        location: `${baseUrl}/scim/v2/Groups/${role.id}`,
      },
    };
    res.json(group);
  });

  r.post("/Groups", async (req: Request, res: Response) => {
    const body = req.body as SCIMGroup;
    if (!body.displayName) {
      res.status(400).json(scimErrorResponse("400", "displayName is required"));
      return;
    }

    const existing = await prisma.role.findFirst({ where: { key: body.displayName } });
    if (existing) {
      res.status(409).json(scimErrorResponse("409", "Group already exists"));
      return;
    }

    const role = await prisma.role.create({
      data: { key: body.displayName, name: body.displayName },
    });

    audit({
      actor: null,
      action: "scim.group.created",
      target: { type: "role", id: role.id },
      metadata: { key: role.key },
    });

    const baseUrl = process.env.APP_URL ?? "http://localhost:4000";
    const group: SCIMGroup = {
      schemas: [SCIM_GROUP_SCHEMA],
      id: role.id,
      displayName: role.key,
      meta: {
        resourceType: "Group",
        created: role.createdAt.toISOString(),
        lastModified: role.updatedAt.toISOString(),
        location: `${baseUrl}/scim/v2/Groups/${role.id}`,
      },
    };
    res.status(201).json(group);
  });

  r.patch("/Groups/:id", async (req: Request, res: Response) => {
    const role = await prisma.role.findUnique({ where: { id: param(req.params.id) } });
    if (!role) {
      res.status(404).json(scimErrorResponse("404", "Group not found"));
      return;
    }

    const patch = req.body as SCIMPatchOp;
    for (const op of patch.Operations ?? []) {
      if (op.path === "members" || op.path?.startsWith("members")) {
        if (op.op === "add" && Array.isArray(op.value)) {
          for (const member of op.value as Array<{ value: string }>) {
            await changeScimMembership(member.value, role.id, "add");
          }
        } else if (op.op === "remove" && Array.isArray(op.value)) {
          for (const member of op.value as Array<{ value: string }>) {
            await changeScimMembership(member.value, role.id, "remove");
          }
        } else if (op.op === "remove" && op.path?.includes("[")) {
          // SCIM path filter: members[value eq "userId"]
          const userIdMatch = op.path.match(/value\s+eq\s+"([^"]+)"/);
          if (userIdMatch) {
            await changeScimMembership(userIdMatch[1], role.id, "remove");
          }
        }
      } else if (op.path === "displayName" && op.op === "replace") {
        await prisma.role.update({
          where: { id: role.id },
          data: { name: String(op.value) },
        });
      }
    }

    audit({
      actor: null,
      action: "scim.group.updated",
      target: { type: "role", id: role.id },
      metadata: { ops: patch.Operations?.length },
    });

    // Return updated group
    const updated = await prisma.role.findUnique({
      where: { id: param(req.params.id) },
      include: { users: { include: { user: true } } },
    });
    const baseUrl = process.env.APP_URL ?? "http://localhost:4000";
    const updatedWithUsers = updated as unknown as {
      users: Array<{ user: { id: string; displayName: string } }>;
    } | null;
    const group: SCIMGroup = {
      schemas: [SCIM_GROUP_SCHEMA],
      id: role.id,
      displayName: updated?.name ?? role.key,
      members: updatedWithUsers?.users.map((ur) => ({
        value: ur.user.id,
        display: ur.user.displayName,
      })),
      meta: {
        resourceType: "Group",
        created: role.createdAt.toISOString(),
        lastModified: role.updatedAt.toISOString(),
        location: `${baseUrl}/scim/v2/Groups/${role.id}`,
      },
    };
    res.json(group);
  });

  r.delete("/Groups/:id", async (req: Request, res: Response) => {
    const role = await prisma.role.findUnique({ where: { id: param(req.params.id) } });
    if (!role) {
      res.status(404).json(scimErrorResponse("404", "Group not found"));
      return;
    }

    // Don't delete built-in roles
    const builtIn = ["admin", "coordinator", "developer", "reader"];
    if (builtIn.includes(role.key)) {
      res.status(400).json(scimErrorResponse("400", "Cannot delete built-in roles"));
      return;
    }

    const deleted = await prisma.$transaction(
      async (tx) => {
        const assignments = await tx.userRole.findMany({ where: { roleId: role.id } });
        // Roles are shared with local administration. Deleting one would cascade
        // its local grants, so reject the whole operation without changing users.
        if (assignments.some((assignment) => assignment.source === "local")) return false;
        const userIds = assignments.map((assignment) => assignment.userId);
        await tx.user.updateMany({
          where: { id: { in: userIds } },
          data: { authRolesInitializedAt: new Date(), authRoleAuthority: "scim" },
        });
        await tx.userRole.deleteMany({ where: { userId: { in: userIds }, source: "provider" } });
        await tx.userRole.deleteMany({ where: { roleId: role.id } });
        await tx.role.delete({ where: { id: role.id } });
        return true;
      },
      { isolationLevel: "Serializable" },
    );
    if (!deleted) {
      res
        .status(409)
        .json(scimErrorResponse("409", "Cannot delete a group with local assignments"));
      return;
    }

    audit({
      actor: null,
      action: "scim.group.deleted",
      target: { type: "role", id: role.id },
    });

    res.status(204).send();
  });

  return r;
}

/** Serialize explicit provisioning decisions with login reconciliation. */
async function changeScimMembership(userId: string, roleId: string, operation: "add" | "remove") {
  await prisma.$transaction(
    async (tx) => {
      if (operation === "remove") {
        const membership = await tx.userRole.findUnique({
          where: { userId_roleId: { userId, roleId } },
        });
        // An absent or explicitly local membership must not revoke other grants.
        if (!membership || membership.source === "local") return;
      }
      await tx.user.update({
        where: { id: userId },
        data: { authRolesInitializedAt: new Date(), authRoleAuthority: "scim" },
      });
      // An explicit SCIM decision supersedes IdP grants, including on revocation.
      // Otherwise removing the last SCIM reader could uncover a provider admin.
      await tx.userRole.deleteMany({ where: { userId, source: "provider" } });
      if (operation === "add") {
        await tx.userRole.upsert({
          where: { userId_roleId: { userId, roleId } },
          create: { userId, roleId, source: "scim" },
          update: {}, // Preserve an existing local assignment's provenance.
        });
      } else {
        // Legacy assignments predate provenance. Preserve the pre-migration SCIM
        // removal contract for the explicitly targeted membership, while never
        // removing a positively identified local grant.
        await tx.userRole.deleteMany({
          where: { userId, roleId, source: { in: ["scim", "unknown"] } },
        });
      }
    },
    { isolationLevel: "Serializable" },
  );
}

/** Test helper — reset SCIM tokens. */
export function __resetScimTokens(): void {
  scimTokens.clear();
}

export { addScimToken as addScimTokenForTest };
