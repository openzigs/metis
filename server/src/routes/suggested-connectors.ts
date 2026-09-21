/**
 * Suggested Connectors REST API — Epic #467 / Issue #471 + Epic #701 / Issue #704.
 *
 * GET    /api/projects/:projectId/suggested-connectors             — list
 * GET    /api/projects/:projectId/suggested-connectors/:id         — detail
 *                                                                    (incl. one-shot
 *                                                                    decrypted password)
 * PATCH  /api/projects/:projectId/suggested-connectors/:id         — update status
 * DELETE /api/projects/:projectId/suggested-connectors/:id         — remove
 * POST   /api/projects/:projectId/suggested-connectors/:id/test    — liveness probe
 *                                                                    with explicit
 *                                                                    creds
 * POST   /api/projects/:projectId/suggested-connectors/:id/provision
 *                                                                  — atomically
 *                                                                    create vault
 *                                                                    secret + db
 *                                                                    connector
 */
import { Router } from "express";
import type { Request } from "express";
import {
  type ApiResponse,
  suggestedConnectorProvisionSchema,
  suggestedConnectorTestSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { suggestedConnectorCredentialReadRateLimiter } from "../middleware/connector-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { audit } from "../lib/audit/audit-service.js";
import { getVaultService } from "../lib/vault/vault-service.js";
import {
  createDbConnector,
  deleteDbConnector,
  testDbWithExplicitCredentials,
} from "../lib/connectors/db/db-service.js";
import { ConnectorError } from "../lib/connectors/types.js";
import { sanitizeDriverError } from "../lib/connectors/driver-error.js";
import { createChildLogger } from "../lib/logger.js";

const log = createChildLogger("suggested-connectors-route");

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function projectIdOf(req: Request): string {
  const id = String(req.params.projectId ?? "");
  if (!id) throw new AppError(400, "PROJECT_REQUIRED", "projectId path parameter is required");
  return id;
}

const VALID_STATUSES = new Set(["pending", "accepted", "dismissed"]);

/**
 * Scanner emits "postgresql"; the shared DbDriver enum uses "postgres".
 * Other drivers map 1:1.
 */
const DRIVER_TYPE_TO_DB_DRIVER: Record<string, string> = {
  postgresql: "postgres",
  mysql: "mysql",
  oracle: "oracle",
  sqlserver: "sqlserver",
  sqlite: "sqlite",
};

function actorIdOf(req: Request): string | null {
  // requireAuth attaches AuthPayload to req.user; the stable identifier is
  // `userId` (a cuid from the User row). Returning null when absent is safe —
  // callers must NOT fall back to a literal like "system" because that string
  // is not a valid User PK and would violate the FK on Secret.createdById.
  return req.user?.userId ?? null;
}

export function suggestedConnectorsRouter(): Router {
  const r = Router({ mergeParams: true });

  // #1053 (F2) — object-level project scope (OWASP A01 / BOLA, CWE-639).
  // `requirePermission` checks the caller's GLOBAL role, which does not confine
  // them to their own workspace, and every handler below scopes its query by the
  // caller-supplied `projectId` alone. GET /:id returns a ONE-SHOT DECRYPTED
  // database password, so without this gate a coordinator in workspace A could
  // enumerate workspace B's suggestions and steal the plaintext credential for
  // another tenant's database. Non-members get 404 (no existence oracle);
  // system admins bypass. MUST stay above every route below.
  r.use(requireAuth, requireProjectAccess());

  // GET /suggested-connectors — list suggestions (optionally filter by status)
  r.get("/", requireAuth, requirePermission("connector.read"), async (req, res) => {
    const projectId = projectIdOf(req);
    const statusFilter = req.query.status as string | undefined;

    const where: { projectId: string; status?: string } = { projectId };
    if (statusFilter && VALID_STATUSES.has(statusFilter)) {
      where.status = statusFilter;
    }

    const suggestions = await prisma.suggestedConnector.findMany({
      where,
    });

    // Sort by confidence priority: high > medium > low
    const CONFIDENCE_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
    suggestions.sort((a, b) => {
      const ca = CONFIDENCE_ORDER[a.confidence] ?? 99;
      const cb = CONFIDENCE_ORDER[b.confidence] ?? 99;
      if (ca !== cb) return ca - cb;
      return b.createdAt.getTime() - a.createdAt.getTime();
    });

    // Strip vault ref from the list view — never leak even the id.
    const safe = suggestions.map((s) => ({
      ...s,
      passwordVaultRef: undefined as string | undefined,
      hasStoredPassword: Boolean(s.passwordVaultRef),
    }));

    res.json(ok({ suggestions: safe, count: safe.length }));
  });

  // GET /suggested-connectors/:id — single suggestion + one-shot password.
  //
  // Requires connector.write because returning plaintext is equivalent to
  // being able to provision the connector with it. We audit every read.
  // Rate-limited (default 10/min/user) to make bulk enumeration noisy in
  // the audit log instead of silent — :id (cuid) is NOT a secrecy boundary.
  r.get(
    "/:id",
    requireAuth,
    suggestedConnectorCredentialReadRateLimiter,
    requirePermission("connector.write"),
    async (req, res) => {
      const projectId = projectIdOf(req);
      const id = String(req.params.id);

      const row = await prisma.suggestedConnector.findFirst({
        where: { id, projectId },
      });
      if (!row) throw new AppError(404, "NOT_FOUND", "Suggested connector not found");

      let password: string | null = null;
      if (row.passwordVaultRef) {
        try {
          const { plaintext } = await getVaultService().read(row.passwordVaultRef);
          password = plaintext;
        } catch (err) {
          // Vault unavailable shouldn't 500 the whole GET — surface as
          // metadata so the wizard can prompt the user to re-enter manually.
          password = null;
          audit({
            actor: actorIdOf(req),
            action: "suggested_connector.credential_read.failed",
            target: { type: "suggested_connector", id: row.id },
            metadata: { projectId, error: String(err) },
          });
        }
      }

      audit({
        actor: actorIdOf(req),
        action: "suggested_connector.credential_read",
        target: { type: "suggested_connector", id: row.id },
        metadata: { projectId, hasPassword: password !== null },
      });

      res.json(
        ok({
          ...row,
          passwordVaultRef: undefined as string | undefined,
          hasStoredPassword: Boolean(row.passwordVaultRef),
          password, // one-shot decrypted plaintext (may be null)
        }),
      );
    },
  );

  // PATCH /suggested-connectors/:id — update status (accept/dismiss)
  r.patch("/:id", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const projectId = projectIdOf(req);
    const id = String(req.params.id);
    const { status } = req.body as { status?: string };

    if (!status || !VALID_STATUSES.has(status)) {
      throw new AppError(
        400,
        "INVALID_STATUS",
        `status must be one of: ${[...VALID_STATUSES].join(", ")}`,
      );
    }

    // Verify the suggestion belongs to this project
    const existing = await prisma.suggestedConnector.findFirst({
      where: { id, projectId },
    });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Suggested connector not found");
    }

    const updated = await prisma.suggestedConnector.update({
      where: { id },
      data: { status },
    });

    res.json(ok(updated));
  });

  // DELETE /suggested-connectors/:id — remove
  r.delete("/:id", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const projectId = projectIdOf(req);
    const id = String(req.params.id);

    // Verify the suggestion belongs to this project
    const existing = await prisma.suggestedConnector.findFirst({
      where: { id, projectId },
    });
    if (!existing) {
      throw new AppError(404, "NOT_FOUND", "Suggested connector not found");
    }

    await prisma.suggestedConnector.delete({ where: { id } });
    res.json(ok({ deleted: true }));
  });

  // POST /suggested-connectors/:id/test — credential-explicit liveness probe.
  r.post("/:id/test", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const projectId = projectIdOf(req);
    const id = String(req.params.id);

    const parsed = suggestedConnectorTestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "INVALID_BODY", parsed.error.message);
    }

    const row = await prisma.suggestedConnector.findFirst({
      where: { id, projectId },
    });
    if (!row) throw new AppError(404, "NOT_FOUND", "Suggested connector not found");

    // Resolve password: explicit > vault-stored
    let password: string | null = parsed.data.password ?? null;
    if (password === null && row.passwordVaultRef) {
      try {
        const { plaintext } = await getVaultService().read(row.passwordVaultRef);
        password = plaintext;
      } catch {
        password = null;
      }
    }

    const driver = DRIVER_TYPE_TO_DB_DRIVER[row.driverType] ?? row.driverType;
    const started = Date.now();
    try {
      const result = await testDbWithExplicitCredentials({
        driver,
        host: parsed.data.host ?? row.host ?? null,
        port: parsed.data.port ?? row.port ?? null,
        database: parsed.data.database ?? row.database ?? null,
        username: parsed.data.username ?? row.username ?? null,
        password,
      });
      audit({
        actor: actorIdOf(req),
        action: "suggested_connector.test",
        target: { type: "suggested_connector", id: row.id },
        metadata: {
          projectId,
          driver,
          latencyMs: result.latencyMs,
          status: "ok",
        },
      });
      res.json(ok({ ok: true, latencyMs: result.latencyMs }));
    } catch (err) {
      const ce = err instanceof ConnectorError ? err : null;
      const code = ce?.code ?? "TEST_FAILED";
      const rawMessage = err instanceof Error ? err.message : String(err);
      const sanitized = sanitizeDriverError(code, rawMessage);
      // SECURITY: keep the raw driver error server-side only — it commonly
      // includes usernames, hostnames, SQLSTATE, and connection-string
      // fragments (OWASP A05). The client gets the mapped errorCode +
      // generic errorMessage only.
      log.warn("suggested_connector test failed", {
        suggestionId: row.id,
        projectId,
        driver,
        code,
        rawError: rawMessage,
      });
      audit({
        actor: actorIdOf(req),
        action: "suggested_connector.test",
        target: { type: "suggested_connector", id: row.id },
        metadata: {
          projectId,
          driver,
          status: "error",
          code,
          latencyMs: Date.now() - started,
        },
      });
      res.json(
        ok({
          ok: false,
          errorCode: sanitized.errorCode,
          errorMessage: sanitized.errorMessage,
        }),
      );
    }
  });

  // POST /suggested-connectors/:id/provision — atomic: vault → db connector → mark accepted.
  r.post("/:id/provision", requireAuth, requirePermission("connector.write"), async (req, res) => {
    const projectId = projectIdOf(req);
    const id = String(req.params.id);

    const parsed = suggestedConnectorProvisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "INVALID_BODY", parsed.error.message);
    }
    const body = parsed.data;

    const row = await prisma.suggestedConnector.findFirst({
      where: { id, projectId },
    });
    if (!row) throw new AppError(404, "NOT_FOUND", "Suggested connector not found");

    const actorId = actorIdOf(req);
    const vault = getVaultService();

    // Decide whether to reuse the existing vault secret. If the body's
    // password matches what's already vaulted, reuse the same id; if it
    // differs, rotate. Otherwise create fresh.
    let vaultRef: string | null = null;
    let mutation: "reused" | "rotated" | "created" = "created";
    if (body.password) {
      if (row.passwordVaultRef) {
        let existingPlaintext: string | null = null;
        try {
          const { plaintext } = await vault.read(row.passwordVaultRef);
          existingPlaintext = plaintext;
        } catch {
          existingPlaintext = null;
        }
        if (existingPlaintext === body.password) {
          vaultRef = row.passwordVaultRef;
          mutation = "reused";
        } else {
          await vault.rotate(row.passwordVaultRef, body.password);
          vaultRef = row.passwordVaultRef;
          mutation = "rotated";
        }
      } else {
        const label = `provisioned-cred:project:${projectId}:suggestion:${row.id}`;
        const summary = await vault.create(label, body.password, "project", {
          description: `Provisioned dev DB password from suggestion ${row.id}`,
          createdById: actorId,
        });
        vaultRef = summary.id;
        mutation = "created";
      }
    }

    let createdConnectorId: string | null = null;
    let suggestionUpdated = false;
    try {
      const created = await createDbConnector(
        projectId,
        {
          label: body.label,
          driver: body.driver,
          host: body.host ?? undefined,
          port: body.port ?? undefined,
          databaseName: body.database ?? undefined,
          username: body.username ?? undefined,
          secretRef: vaultRef ? `\${vault:${vaultRef}}` : undefined,
          options: body.options ? JSON.stringify(body.options) : undefined,
        },
        actorId,
      );
      createdConnectorId = created.id;

      await prisma.suggestedConnector.update({
        where: { id: row.id },
        data: { status: "accepted", acceptedConnectorId: created.id },
      });
      suggestionUpdated = true;

      audit({
        actor: actorId,
        action: "suggested_connector.provisioned",
        target: { type: "suggested_connector", id: row.id },
        metadata: {
          projectId,
          driver: body.driver,
          connectorId: created.id,
          vaultMutation: mutation,
        },
      });

      res.json(
        ok({
          ok: true,
          connectorId: created.id,
          suggestionId: row.id,
        }),
      );
    } catch (err) {
      // Compensating cleanup so the resource trio (vault / connector /
      // suggestion) cannot end up in a partially-provisioned state.
      //
      // 1. Vault: roll back ONLY when we created it on this request. Reused
      //    or rotated rows existed before and must survive.
      // 2. Connector: if step 2 succeeded but step 3 (suggestion update)
      //    failed, soft-delete the orphan so a retry doesn't trip
      //    DB_LABEL_TAKEN. Best-effort — a delete failure is logged but
      //    does not mask the original error to the caller.
      if (mutation === "created" && vaultRef) {
        await vault.delete(vaultRef).catch((cleanupErr) => {
          log.warn("vault rollback failed during provision", {
            vaultRef,
            error: String(cleanupErr),
          });
        });
      }
      if (createdConnectorId && !suggestionUpdated) {
        await deleteDbConnector(projectId, createdConnectorId, actorId).catch((cleanupErr) => {
          log.warn("connector rollback failed during provision", {
            connectorId: createdConnectorId,
            error: String(cleanupErr),
          });
        });
      }
      audit({
        actor: actorId,
        action: "suggested_connector.provisioned.failed",
        target: { type: "suggested_connector", id: row.id },
        metadata: {
          projectId,
          driver: body.driver,
          phase: createdConnectorId === null ? "connector_create" : "suggestion_update",
          error: err instanceof Error ? err.message : String(err),
        },
      });
      if (err instanceof ConnectorError) {
        throw new AppError(err.status, err.code, err.message);
      }
      throw err;
    }
  });

  return r;
}
