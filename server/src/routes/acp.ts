/**
 * /api/acp — Epic #163, Issue #119.
 *
 * REST surface for managing the per-user ACP API tokens. The actual ACP
 * wire protocol runs over WebSocket at `/api/acp` (handled by
 * `attachAcpServer` on the http server, not Express).
 *
 *   GET    /tokens           → list this user's tokens
 *   POST   /tokens           → create a new token (plaintext returned ONCE)
 *   DELETE /tokens/:id       → revoke a token
 */
import { Router, type Request } from "express";
import { z, ZodError } from "zod";
import type { ApiResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import {
  ApiTokenError,
  createApiToken,
  listApiTokens,
  revokeApiToken,
} from "../lib/acp/api-tokens.js";
import { clampAcpScopes } from "../lib/acp/authz.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

function actor(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

const createSchema = z.object({
  name: z.string().min(1).max(128),
  scopes: z.array(z.string().min(1).max(64)).max(32).optional(),
  expiresAt: z.string().datetime().nullable().optional(),
});

function rethrow(err: unknown): never {
  if (err instanceof ApiTokenError) {
    throw new AppError(err.status, err.code, err.message);
  }
  if (err instanceof ZodError) {
    throw new AppError(400, "VALIDATION_ERROR", "Invalid request payload", {
      issues: err.flatten(),
    });
  }
  throw err;
}

export function acpRouter(): Router {
  const r = Router();
  r.use(requireAuth);

  r.get("/tokens", async (req, res, next) => {
    try {
      const tokens = await listApiTokens(actor(req));
      res.json(ok(tokens));
    } catch (err) {
      try {
        rethrow(err);
      } catch (e) {
        next(e);
      }
    }
  });

  r.post("/tokens", async (req, res, next) => {
    try {
      const input = createSchema.parse(req.body ?? {});
      // Restrict the minted scopes so a token can never carry more authority
      // than the platform grants (Issue #676). Unknown / over-privileged scopes
      // are dropped; an empty request defaults to the full grantable set. Each
      // ACP method is still tenant-authorized at call time, so no admin gate is
      // required on mint — that would break the per-user self-service token
      // model (GET/POST/DELETE /tokens are all per-user by design).
      const created = await createApiToken({
        userId: actor(req),
        name: input.name,
        scopes: clampAcpScopes(input.scopes),
        expiresAt: input.expiresAt ?? null,
      });
      res.status(201).json(ok(created));
    } catch (err) {
      try {
        rethrow(err);
      } catch (e) {
        next(e);
      }
    }
  });

  r.delete("/tokens/:id", async (req, res, next) => {
    try {
      const id = String(req.params.id ?? "");
      const updated = await revokeApiToken(actor(req), id);
      res.json(ok(updated));
    } catch (err) {
      try {
        rethrow(err);
      } catch (e) {
        next(e);
      }
    }
  });

  return r;
}
