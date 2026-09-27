/**
 * Issue #257 — unified `/api/admin/config` REST surface.
 *
 *   GET    /api/admin/config              → list every registered key + redacted value + source
 *   GET    /api/admin/config/audit        → paginated audit log (replaces #253 split route)
 *   GET    /api/admin/config/:key         → single key + redacted value + source
 *   PUT    /api/admin/config/:key         → upsert a Tier-2 secret OR Tier-3 tunable value
 *   DELETE /api/admin/config/:key         → clear the override (vault delete OR runtime_config delete)
 *
 * All routes require `admin.read` (GETs) or `admin.write` (PUT/DELETE). The
 * narrower `/secrets/:key` route from Phase 1 is removed; the UI switches to
 * the unified path in #259.
 */
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import { AppError } from "../../middleware/error-handler.js";
import { requireAuth } from "../../middleware/auth.js";
import { requirePermission } from "../../middleware/require-permission.js";
import {
  ConfigBootstrapError,
  ConfigUnknownKeyError,
  ConfigValidationError,
  CONFIG_KEYS,
  getConfigService,
  getKeyDef,
  type ConfigKeyDef,
  type ConfigService,
} from "../../lib/config/index.js";
import { createChildLogger } from "../../lib/logger.js";

const log = createChildLogger("admin-config-routes");

// Match a registered key shape (UPPER_SNAKE_CASE).
const KEY_PARAM_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const keySchema = z.string().regex(KEY_PARAM_PATTERN, "Invalid key format");

// Body for PUT — value can be any JSON shape; the per-key Zod schema parses
// it. Bound at 8 KiB to keep an accidental megabyte JSON blob from blowing up
// the request pipeline.
const putBodySchema = z.object({
  value: z.unknown().refine((v) => v !== undefined, { message: "value is required" }),
});

const auditQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
});

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

interface RedactedKeyView {
  key: string;
  tier: ConfigKeyDef["tier"];
  valueType: ConfigKeyDef["valueType"];
  description: string;
  sensitive: boolean;
  source: "vault" | "db" | "env" | "unset";
  /** Redacted to `[REDACTED]` for sensitive keys, otherwise the live value. */
  value: string | null;
}

function projectKey(svc: ConfigService, key: string): RedactedKeyView {
  const def = getKeyDef(key);
  if (!def) throw new ConfigUnknownKeyError(key);
  const desc = svc.describeSource(key);
  let raw: string | undefined;
  try {
    raw = svc.get(key);
  } catch {
    raw = undefined;
  }
  const value = def.sensitive ? (raw === undefined ? null : "[REDACTED]") : (raw ?? null);
  return {
    key,
    tier: def.tier,
    valueType: def.valueType,
    description: def.description,
    sensitive: def.sensitive,
    source: desc.source,
    value,
  };
}

export function configRouter(): Router {
  const r = Router();

  // GET /  → all keys
  r.get(
    "/",
    requireAuth,
    requirePermission("admin.read"),
    (_req: Request, res: Response, next: NextFunction) => {
      try {
        const svc = getConfigService();
        const items = Object.keys(CONFIG_KEYS).map((k) => projectKey(svc, k));
        res.json(ok({ items }));
      } catch (err) {
        next(translateError(err));
      }
    },
  );

  // GET /audit
  r.get(
    "/audit",
    requireAuth,
    requirePermission("admin.read"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const parsed = auditQuerySchema.safeParse(req.query);
        if (!parsed.success) {
          throw new AppError(400, "INVALID_QUERY", "Invalid audit query", {
            issues: parsed.error.flatten(),
          });
        }
        const svc = getConfigService();
        const page = await svc.listAudit({
          limit: parsed.data.limit,
          cursor: parsed.data.cursor,
        });
        res.json(ok(page));
      } catch (err) {
        next(translateError(err));
      }
    },
  );

  // GET /:key
  r.get(
    "/:key",
    requireAuth,
    requirePermission("admin.read"),
    (req: Request, res: Response, next: NextFunction) => {
      try {
        const key = parseKeyParam(req.params.key);
        const svc = getConfigService();
        res.json(ok(projectKey(svc, key)));
      } catch (err) {
        next(translateError(err));
      }
    },
  );

  // PUT /:key
  r.put(
    "/:key",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const key = parseKeyParam(req.params.key);
        const def = ensureWritableTier(key);
        const body = putBodySchema.safeParse(req.body);
        if (!body.success) {
          throw new AppError(400, "INVALID_BODY", "Invalid request body", {
            issues: body.error.flatten(),
          });
        }
        const svc = getConfigService();
        const actorId = req.user?.userId ?? null;

        if (def.tier === "secret") {
          const valueResult = def.schema.safeParse(body.data.value);
          if (!valueResult.success) {
            throw new ConfigValidationError(key, valueResult.error.flatten());
          }
          const oldValue = safeGet(svc, key);
          await svc.setSecret(key, String(valueResult.data), { actorId });
          await svc.recordAudit({
            key,
            oldValue,
            newValue: String(valueResult.data),
            actorId: actorId ?? "unknown",
          });
        } else {
          // tunable
          const oldValue = safeGet(svc, key);
          const result = await svc.set(key, body.data.value, { actorId: actorId ?? "unknown" });
          await svc.recordAudit({
            key,
            oldValue,
            newValue: result.value,
            actorId: actorId ?? "unknown",
          });
        }

        res.json(ok(projectKey(svc, key)));
      } catch (err) {
        next(translateError(err));
      }
    },
  );

  // DELETE /:key
  r.delete(
    "/:key",
    requireAuth,
    requirePermission("admin.write"),
    async (req: Request, res: Response, next: NextFunction) => {
      try {
        const key = parseKeyParam(req.params.key);
        const def = ensureWritableTier(key);
        const svc = getConfigService();
        const actorId = req.user?.userId ?? null;
        const oldValue = safeGet(svc, key);
        if (def.tier === "secret") {
          await svc.clearSecret(key);
        } else {
          await svc.clearTunable(key, { actorId: actorId ?? "unknown" });
        }
        await svc.recordAudit({
          key,
          oldValue,
          newValue: null,
          actorId: actorId ?? "unknown",
        });
        res.json(ok(projectKey(svc, key)));
      } catch (err) {
        next(translateError(err));
      }
    },
  );

  return r;
}

function parseKeyParam(raw: string | string[] | undefined): string {
  const value = Array.isArray(raw) ? raw[0] : raw;
  const parsed = keySchema.safeParse(value);
  if (!parsed.success) {
    throw new AppError(400, "INVALID_KEY", "Invalid config key", {
      issues: parsed.error.flatten(),
    });
  }
  return parsed.data;
}

function ensureWritableTier(key: string): ConfigKeyDef {
  const def = getKeyDef(key);
  if (!def) throw new AppError(400, "UNKNOWN_KEY", `Unknown config key: ${key}`);
  if (def.tier === "bootstrap") {
    throw new AppError(
      400,
      "BOOTSTRAP_KEY",
      `${key} is bootstrap config — set it in .env and restart the server.`,
    );
  }
  return def;
}

function safeGet(svc: ConfigService, key: string): string | null {
  try {
    const v = svc.get(key);
    return v ?? null;
  } catch {
    return null;
  }
}

/**
 * #93 — a Prisma client error, by class name or by its `P####` code. Its message
 * quotes the invocation site and the violated fields, so it must never be the
 * text of an API response.
 */
function isPrismaError(err: unknown): err is Error & { code?: unknown } {
  if (!(err instanceof Error)) return false;
  if (err.name.startsWith("PrismaClient")) return true;
  const { code } = err as { code?: unknown };
  return typeof code === "string" && /^P\d{4}$/.test(code);
}

function translateError(err: unknown): unknown {
  if (err instanceof AppError) return err;
  if (isPrismaError(err)) {
    const code = typeof err.code === "string" ? err.code : undefined;
    // #112 — the RESPONSE is fixed vocabulary; the LOG keeps the cause. Before
    // #93 these errors reached the generic handler, which logged both.
    log.warn("Config store error mapped to a fixed response", {
      errorClass: err.name,
      code,
      error: err.message,
      stack: err.stack,
    });
    if (code === "P2002") {
      return new AppError(
        409,
        "CONFIG_WRITE_CONFLICT",
        "The value was changed by another request. Retry the save.",
      );
    }
    return new AppError(
      500,
      "CONFIG_STORE_ERROR",
      "The configuration store could not complete the request.",
    );
  }
  if (err instanceof ConfigUnknownKeyError) {
    return new AppError(400, "UNKNOWN_KEY", err.message);
  }
  if (err instanceof ConfigBootstrapError) {
    return new AppError(400, "BOOTSTRAP_KEY", err.message);
  }
  if (err instanceof ConfigValidationError) {
    return new AppError(400, "INVALID_VALUE", err.message, { issues: err.issues });
  }
  return err;
}
