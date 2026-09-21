/**
 * /api/vault — admin-facing CRUD over the encrypted secret vault.
 *
 * Backed by the existing `VaultService` (server/src/lib/vault/vault-service.ts).
 * No plaintext is ever returned by `list`/`create`/`rotate`; the dedicated
 * `GET /:id/reveal` endpoint returns plaintext exactly once per call and is
 * recorded in the audit log.
 *
 * Routes:
 *   GET    /                list summaries (vault.read)
 *   POST   /                create entry  (vault.write)
 *   POST   /:id/rotate      rotate value  (vault.write)
 *   GET    /:id/reveal      decrypt one (vault.read, audited)
 *   DELETE /:id             soft-delete   (vault.write)
 *   GET    /:id/audit       audit log entries for this secret (vault.read)
 *
 * Epic #196 / #222 — wires the standalone /vault admin UI to the service.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import { getVaultService, type SecretSummary } from "../lib/vault/vault-service.js";
import { audit } from "../lib/audit/audit-service.js";
import { prisma } from "../lib/prisma.js";
import { pagerDutyVaultRotationFailure } from "../lib/pagerduty/alerting-hooks.js";
import { opsWorkspaceId } from "../lib/pagerduty/ops-workspace.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

const createSchema = z.object({
  label: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-zA-Z0-9_.\-:]+$/, "label may only contain letters, digits, _ . - :"),
  value: z
    .string()
    .min(1)
    .max(64 * 1024),
  scope: z.enum(["global", "project"]).default("global"),
  description: z.string().max(500).optional(),
});

const rotateSchema = z.object({
  value: z
    .string()
    .min(1)
    .max(64 * 1024),
});

function summaryToView(s: SecretSummary): {
  id: string;
  label: string;
  scope: SecretSummary["scope"];
  description: string;
  algorithm: string;
  keyVersion: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: s.id,
    label: s.label,
    scope: s.scope,
    description: s.description,
    algorithm: s.algorithm,
    keyVersion: s.keyVersion,
    createdAt: s.createdAt.toISOString(),
    updatedAt: s.updatedAt.toISOString(),
  };
}

export function vaultRouter(): Router {
  const r = Router();

  // ── List ────────────────────────────────────────────────────────────────
  r.get("/", requireAuth, requirePermission("vault.read"), async (req, res) => {
    const scope = typeof req.query.scope === "string" ? req.query.scope : undefined;
    const filter = scope === "global" || scope === "project" ? scope : undefined;
    const items = await getVaultService().list(filter);
    res.json(ok({ items: items.map(summaryToView) }));
  });

  // ── Create ──────────────────────────────────────────────────────────────
  r.post("/", requireAuth, requirePermission("vault.write"), async (req, res) => {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "INVALID_BODY", "Invalid vault entry", parsed.error.flatten());
    }
    const aId = actorId(req);
    const summary = await getVaultService().create(
      parsed.data.label,
      parsed.data.value,
      parsed.data.scope,
      { description: parsed.data.description, createdById: aId },
    );
    audit({
      actor: { id: aId },
      action: "vault.write",
      target: { type: "secret", id: summary.id },
      metadata: { label: parsed.data.label, scope: parsed.data.scope, source: "vault_ui" },
    });
    res.status(201).json(ok(summaryToView(summary)));
  });

  // ── Rotate ──────────────────────────────────────────────────────────────
  r.post("/:id/rotate", requireAuth, requirePermission("vault.write"), async (req, res) => {
    const parsed = rotateSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "INVALID_BODY", "Invalid rotation body", parsed.error.flatten());
    }
    const id = String(req.params.id);
    let summary: SecretSummary;
    try {
      summary = await getVaultService().rotate(id, parsed.data.value);
    } catch (err) {
      // Issue #580 — a key rotation FAILURE is a sev-1 operational event. Fire a
      // best-effort PagerDuty incident to the designated ops workspace (env
      // PAGERDUTY_OPS_WORKSPACE_ID) before surfacing the HTTP error. Vault secrets
      // are platform/project scoped (not workspace-scoped), so platform infra
      // alerts route to the ops workspace's PagerDuty service. Fire-and-forget:
      // it must not change the route's behaviour. No-op when unconfigured.
      const ws = opsWorkspaceId();
      if (ws) {
        void pagerDutyVaultRotationFailure({
          workspaceId: ws,
          secretId: id,
          label: id,
          reason: (err as Error).message,
        });
      }
      throw new AppError(404, "SECRET_NOT_FOUND", `Secret not found: ${(err as Error).message}`);
    }
    audit({
      actor: { id: actorId(req) },
      action: "vault.rotate",
      target: { type: "secret", id: summary.id },
      metadata: { label: summary.label, scope: summary.scope, source: "vault_ui" },
    });
    res.json(ok(summaryToView(summary)));
  });

  // ── Reveal (audited) ────────────────────────────────────────────────────
  r.get("/:id/reveal", requireAuth, requirePermission("vault.read"), async (req, res) => {
    const id = String(req.params.id);
    let result: { summary: SecretSummary; plaintext: string };
    try {
      result = await getVaultService().read(id);
    } catch (err) {
      throw new AppError(404, "SECRET_NOT_FOUND", `Secret not found: ${(err as Error).message}`);
    }
    audit({
      actor: { id: actorId(req) },
      action: "vault.read",
      target: { type: "secret", id: result.summary.id },
      metadata: {
        label: result.summary.label,
        scope: result.summary.scope,
        source: "vault_ui",
      },
    });
    res.json(
      ok({
        summary: summaryToView(result.summary),
        plaintext: result.plaintext,
      }),
    );
  });

  // ── Delete ──────────────────────────────────────────────────────────────
  r.delete("/:id", requireAuth, requirePermission("vault.write"), async (req, res) => {
    const id = String(req.params.id);
    // Soft delete via service. Find first to return 404 vs 204 cleanly.
    const items = await getVaultService().list();
    const target = items.find((i) => i.id === id);
    if (!target) throw new AppError(404, "SECRET_NOT_FOUND", "Secret not found");
    await getVaultService().delete(id);
    audit({
      actor: { id: actorId(req) },
      action: "vault.delete",
      target: { type: "secret", id },
      metadata: { label: target.label, scope: target.scope, source: "vault_ui" },
    });
    res.status(204).end();
  });

  // ── Audit trail for one entry ───────────────────────────────────────────
  r.get("/:id/audit", requireAuth, requirePermission("vault.read"), async (req, res) => {
    const id = String(req.params.id);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
    const rows = await prisma.auditLog.findMany({
      where: { targetType: "secret", targetId: id },
      orderBy: { ts: "desc" },
      take: limit,
    });
    res.json(
      ok({
        items: rows.map((row) => ({
          id: row.id,
          action: row.action,
          actorId: row.actorId,
          createdAt: row.ts instanceof Date ? row.ts.toISOString() : row.ts,
          metadata: row.metadata,
        })),
      }),
    );
  });

  return r;
}
