/**
 * /api/sandbox — direct sandbox execution endpoints (Epic #395 #420).
 *
 * `POST /run-once` is the deterministic test seam used by the BA-loop
 * e2e. It accepts a `{ projectId, language, code, timeoutMs? }` payload,
 * runs the snippet via the configured sandbox provider, persists a
 * `SandboxSession` row (handled by the provider itself), and returns the
 * `ExecResult` plus the session id.
 *
 * Tenant isolation: caller must (a) be authenticated, (b) carry the
 * `analysis.run` permission, and (c) be in the project's access set —
 * the same admin / project-creator rule the scheduler routes apply
 * (see `actorCanAccessProject`).
 */
import { Router } from "express";
import type { ApiResponse } from "@metis/shared";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { sandboxRunOnceRateLimiter } from "../middleware/sandbox-run-once-rate-limit.js";
import { AppError } from "../middleware/error-handler.js";
import { actorCanAccessProject } from "../lib/scheduler/project-access.js";
import { getSandboxProvider } from "../lib/sandbox/factory.js";
import { withSandbox } from "../lib/sandbox/with-sandbox.js";
import { SANDBOX_HARD_LIMITS } from "../lib/sandbox/limits.js";

function ok<T>(data: T): ApiResponse<T> {
  return { success: true, data };
}

const RunOnceBody = z.object({
  projectId: z.string().min(1, "projectId is required"),
  language: z.enum(["python", "shell"]).default("python"),
  code: z
    .string()
    .min(1)
    .max(64 * 1024, "code payload exceeds 64 KiB cap"),
  timeoutMs: z
    .number()
    .int()
    .min(SANDBOX_HARD_LIMITS.minWallClockMs)
    .max(SANDBOX_HARD_LIMITS.maxWallClockMs)
    .optional(),
});

export function sandboxRouter(): Router {
  const r = Router();

  r.post(
    "/run-once",
    requireAuth,
    requirePermission("analysis.run"),
    sandboxRunOnceRateLimiter,
    async (req, res, next) => {
      try {
        const parsed = RunOnceBody.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            400,
            "INVALID_BODY",
            parsed.error.issues[0]?.message ?? "invalid body",
          );
        }
        const { projectId, language, code, timeoutMs } = parsed.data;
        // `requireAuth` populated `req.user` — paranoid runtime guard.
        if (!req.user) {
          throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
        }
        const actor = { id: req.user.userId, role: req.user.role };
        const allowed = await actorCanAccessProject(actor, projectId, {
          resource: "sandbox",
          resourceId: projectId,
          action: "sandbox.run-once",
        });
        if (!allowed) {
          throw new AppError(403, "FORBIDDEN", "Caller lacks access to the requested project");
        }

        const provider = getSandboxProvider();
        const result = await withSandbox(
          provider,
          {
            projectId,
            userId: req.user.userId,
            timeoutMs,
          },
          async (sandbox) => {
            const exec =
              language === "python"
                ? await sandbox.runCode(code, { timeoutMs })
                : await sandbox.commands.run(code, { timeoutMs });
            return {
              sessionId: sandbox.id,
              exitCode: exec.exitCode,
              stdout: exec.stdout,
              stderr: exec.stderr,
              wallClockMs: exec.durationMs,
              truncated: exec.truncated ?? false,
            };
          },
        );

        res.json(ok(result));
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
