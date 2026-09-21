/**
 * `/api/projects/:projectId/spec-kit/*` — Spec Kit Mode REST surface
 * (Epic #193).
 *
 * Routes (all require auth + `project.read` for GET, `project.update` for
 * mutating endpoints):
 *
 *   GET  /enabled              — { enabled }
 *   PUT  /enabled              — { enabled: boolean }
 *   GET  /files                — { enabled, artifacts: [...] }
 *   GET  /files/:name          — single artifact
 *   PUT  /files/:name          — overwrite content (manual edits)
 *   DELETE /files/:name        — drop an artifact (resets the workflow)
 *   POST /commands/:cmd        — execute a slash command
 *   POST /constitution         — run the constitution generator
 *
 * Errors are normalised through `AppError` so the global error handler
 * surfaces them with the project's standard envelope.
 */
import { Router, type Request } from "express";
import { z } from "zod";
import {
  isSpecKitArtifactName,
  isSpecKitCommand,
  type SpecKitCommand,
  normalizeSpecKitCommand,
  specKitCommandRequestSchema,
  specKitWriteRequestSchema,
  hasPermission,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { AppError } from "../middleware/error-handler.js";
import {
  SpecKitArtifactError,
  deleteArtifact,
  getArtifact,
  isSpecKitEnabled,
  listArtifacts,
  setSpecKitEnabled,
  writeArtifact,
} from "../lib/spec-kit/artifacts.js";
import { generateConstitution } from "../lib/spec-kit/constitution.js";
import { runSpecify } from "../lib/spec-kit/commands/specify.js";
import { runPlan } from "../lib/spec-kit/commands/plan.js";
import { runTasks } from "../lib/spec-kit/commands/tasks.js";
import { runClarify } from "../lib/spec-kit/commands/clarify.js";
import { runAnalyze } from "../lib/spec-kit/commands/analyze.js";
import { runImplement } from "../lib/spec-kit/commands/implement.js";
import { runConstitution } from "../lib/spec-kit/commands/constitution.js";
import { runChecklist } from "../lib/spec-kit/commands/checklist.js";
import { runPlanExpanded } from "../lib/spec-kit/commands/plan-expanded.js";
import { runSpecifyFeature } from "../lib/spec-kit/commands/specify-feature.js";
import { runTasksToIssues } from "../lib/spec-kit/commands/taskstoissues.js";
import {
  listFeatures,
  resolveFeatureBySlug,
  archiveFeature,
  restoreFeature,
  SpecKitFeatureLifecycleError,
} from "../lib/spec-kit/features.js";
import {
  getFeatureArtifact,
  listFeatureArtifacts,
  writeFeatureArtifact,
} from "../lib/spec-kit/feature-artifacts.js";
import { computeStatus, GateUnmetError } from "../lib/spec-kit/gates.js";
import { BudgetExceededError } from "../lib/finops/budget-enforcer.js";
import { SafetyDeniedError } from "../lib/safety/safety-hook.js";
import { resolveProjectProvider } from "../lib/ai/project-provider.js";
import { AIProviderError } from "../lib/ai/errors.js";
import type { AIProvider } from "../lib/ai/types.js";
import { jobEvents, genericFailureMessage } from "../lib/socket/job-events.js";
import { createChildLogger } from "../lib/logger.js";
import { randomUUID } from "node:crypto";

const log = createChildLogger("spec-kit");

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

/**
 * Epic #406 (#423) — pull the human-readable completion line out of a Spec Kit
 * command result so it can be surfaced as the TERMINAL `job:lifecycle` message.
 *
 * CRITICAL: the grounded-completion string (e.g. "Generated spec.md (v3) in 1.2k
 * tokens — grounded on 8 retrieved chunks.") is computed at the END of each
 * command and returned on `result.message`. Both the legacy
 * {@link DispatchedCommandResult} and the namespaced (`speckit.*`) results carry
 * a `message` field; we read it generically so the grounded-completion line is
 * preserved verbatim and is NOT regressed by the async refactor. When a result
 * has no message (defensive — should not happen for the LLM commands), fall back
 * to a generic completion label so the terminal toast still reads sensibly.
 */
export function extractCompletionMessage(result: unknown, fallback: string): string {
  if (
    result &&
    typeof result === "object" &&
    "message" in result &&
    typeof (result as { message: unknown }).message === "string" &&
    (result as { message: string }).message.length > 0
  ) {
    return (result as { message: string }).message;
  }
  return fallback;
}

/**
 * Epic #406 (#423) — run a Spec Kit command under the unified `job:lifecycle`
 * bus so the UI streams live progress instead of freezing on a static
 * "Running…" label, and a terminal toast fires on success/failure.
 *
 * Streams lifecycle on the `spec-kit` JobKind keyed by `jobId`, scoped to
 * `project:{projectId}`: `started` → `progress` → `completed` / `failed`. The
 * grounded-completion line is threaded VERBATIM into `completed` via
 * {@link extractCompletionMessage} (the #423 invariant — "Generated spec.md (v3)
 * … grounded on 8 retrieved chunks." reaches the client as the terminal message
 * and is NOT regressed by this change).
 *
 * Error handling — TWO destinations, no information loss:
 *   1. A GENERIC, user-safe `failed` lifecycle event (#254) so the global
 *      active-jobs indicator clears and a non-revealing terminal toast shows.
 *      Raw error detail (which can carry provider/credential hints) stays in the
 *      server log only.
 *   2. The original error is RE-THROWN so the route's existing `rethrow()` mapper
 *      still surfaces the PRECISE 4xx/5xx (budget 402-style, safety 403, provider
 *      502, gate/validation 4xx) synchronously to the caller — the spec-kit
 *      command errors are actionable and must not be flattened into a generic
 *      202-then-toast. The grounded HAPPY-path message is what #423 must
 *      preserve; the rich error contract is preserved here too.
 *
 * Awaited by the route (not fire-and-forget): the command is a single LLM call,
 * not a corpus-scale op, so holding the request for its duration carries no
 * gateway risk (that risk is the embeddings reindex, which IS fully async). The
 * response still returns the `jobId` so the client can subscribe for progress.
 *
 * Exported for direct unit testing without a socket.
 */
export async function runSpecKitCommandJob(
  jobId: string,
  projectId: string,
  label: string,
  dispatch: () => Promise<unknown>,
): Promise<unknown> {
  jobEvents.started("spec-kit", jobId, projectId, `Running ${label}`);
  // A single coarse progress tick: the LLM command is one opaque step, so we
  // mark it in-progress immediately (the UI shows an indeterminate bar) and the
  // grounded-completion line lands as the terminal message.
  jobEvents.progress("spec-kit", jobId, projectId, 50, `${label} in progress`);
  try {
    const result = await dispatch();
    jobEvents.completed(
      "spec-kit",
      jobId,
      projectId,
      extractCompletionMessage(result, `${label} completed.`),
    );
    return result;
  } catch (err) {
    log.error("Spec Kit command failed", { projectId, jobId, label, error: String(err) });
    jobEvents.failed("spec-kit", jobId, projectId, genericFailureMessage("spec-kit"));
    // Re-throw so the route maps the precise error (budget / safety / provider /
    // gate) to its proper status code — never a generic 500/202.
    throw err;
  }
}

function actorId(req: Request): string {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return req.user.userId;
}

function projectIdFrom(req: Request): string {
  const params = req.params as { projectId?: string };
  if (!params.projectId) {
    throw new AppError(400, "PROJECT_REQUIRED", "projectId param missing");
  }
  return params.projectId;
}

/**
 * Express 5 wildcard params (`*key`) arrive as `string | string[]` — joined
 * back into the original path here.
 */
function wildcardKey(value: unknown): string {
  if (Array.isArray(value)) return value.join("/");
  return String(value ?? "");
}

function rethrow(err: unknown): never {
  if (err instanceof SpecKitArtifactError) {
    throw new AppError(err.status, err.code, err.message);
  }
  if (err instanceof SpecKitFeatureLifecycleError) {
    throw new AppError(err.status, err.code, err.message);
  }
  if (err instanceof GateUnmetError) {
    throw new AppError(err.status, err.code, err.message, { required: err.required });
  }
  if (err instanceof BudgetExceededError) {
    throw new AppError(err.status, err.code, err.message, {
      usedTokens: err.usedTokens,
      budget: err.budget,
    });
  }
  if (err instanceof SafetyDeniedError) {
    throw new AppError(err.status, err.code, err.message, { findings: err.findings });
  }
  // #381 — provider construction/credential failures from resolveProjectProvider
  // surface as 502 AI_PROVIDER_KEY_UNAVAILABLE, mirroring the chat route's
  // semantics, rather than silently degrading to the offline stub or throwing
  // an opaque 500. The message carries no key/secret material.
  if (err instanceof AIProviderError) {
    throw new AppError(502, "AI_PROVIDER_KEY_UNAVAILABLE", err.message);
  }
  throw err;
}

const enabledSchema = z.object({ enabled: z.boolean() });
const constitutionSchema = z.object({
  projectOverrides: z.string().max(50_000).optional(),
});

async function ensureEnabled(projectId: string): Promise<void> {
  const enabled = await isSpecKitEnabled(projectId);
  if (!enabled) {
    throw new AppError(
      409,
      "SPEC_KIT_DISABLED",
      "Spec Kit Mode is disabled for this project — enable it via PUT /spec-kit/enabled",
    );
  }
}

export function specKitRouter(): Router {
  const r = Router({ mergeParams: true });

  r.get("/enabled", requireAuth, requirePermission("project.read"), async (req, res) => {
    try {
      const enabled = await isSpecKitEnabled(projectIdFrom(req));
      res.json(ok({ enabled }));
    } catch (err) {
      rethrow(err);
    }
  });

  r.put("/enabled", requireAuth, requirePermission("project.update"), async (req, res) => {
    const parsed = enabledSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    try {
      const enabled = await setSpecKitEnabled(
        projectIdFrom(req),
        parsed.data.enabled,
        actorId(req),
      );
      res.json(ok({ enabled }));
    } catch (err) {
      rethrow(err);
    }
  });

  r.get("/files", requireAuth, requirePermission("project.read"), async (req, res) => {
    try {
      const projectId = projectIdFrom(req);
      const enabled = await isSpecKitEnabled(projectId);
      const artifacts = enabled ? await listArtifacts(projectId) : [];
      res.json(ok({ enabled, artifacts }));
    } catch (err) {
      rethrow(err);
    }
  });

  r.get("/files/:name", requireAuth, requirePermission("project.read"), async (req, res) => {
    try {
      const projectId = projectIdFrom(req);
      await ensureEnabled(projectId);
      const name = String(req.params.name ?? "");
      if (!isSpecKitArtifactName(name)) {
        throw new AppError(400, "SPEC_KIT_INVALID_NAME", `Unknown Spec Kit artifact: ${name}`);
      }
      const artifact = await getArtifact(projectId, name);
      if (!artifact) {
        throw new AppError(
          404,
          "SPEC_KIT_NOT_FOUND",
          `Artifact ${name} has not been generated yet`,
        );
      }
      res.json(ok({ artifact }));
    } catch (err) {
      rethrow(err);
    }
  });

  r.put("/files/:name", requireAuth, requirePermission("project.update"), async (req, res) => {
    const parsed = specKitWriteRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    try {
      const projectId = projectIdFrom(req);
      await ensureEnabled(projectId);
      const name = String(req.params.name ?? "");
      const artifact = await writeArtifact({
        projectId,
        name,
        content: parsed.data.content,
        actorId: actorId(req),
      });
      res.json(ok({ artifact }));
    } catch (err) {
      rethrow(err);
    }
  });

  r.delete("/files/:name", requireAuth, requirePermission("project.update"), async (req, res) => {
    try {
      const projectId = projectIdFrom(req);
      await ensureEnabled(projectId);
      await deleteArtifact(projectId, String(req.params.name ?? ""), actorId(req));
      res.status(204).end();
    } catch (err) {
      rethrow(err);
    }
  });

  r.post("/constitution", requireAuth, requirePermission("project.update"), async (req, res) => {
    const parsed = constitutionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    try {
      const projectId = projectIdFrom(req);
      await ensureEnabled(projectId);
      const content = await generateConstitution({
        projectId,
        ...(parsed.data.projectOverrides !== undefined
          ? { projectOverrides: parsed.data.projectOverrides }
          : {}),
        actorId: actorId(req),
      });
      const artifact = await getArtifact(projectId, "constitution.md");
      res.json(ok({ artifact, contentLength: content.length }));
    } catch (err) {
      rethrow(err);
    }
  });

  // Epic #406 (#423) — Spec Kit commands are LLM-backed and froze the UI on a
  // static "Running…" label with no progress or terminal toast. They now run
  // under the unified `job:lifecycle` bus (kind `spec-kit`): a `jobId` is minted,
  // `started` → `progress` stream while the command runs, and the
  // GROUNDED-COMPLETION line ("Generated spec.md (v3) … grounded on N retrieved
  // chunks.") is surfaced VERBATIM as the terminal `completed` message (#423
  // invariant). The HTTP response still carries the full command result + the
  // `jobId` so existing callers keep their precise success payload AND error
  // contract: budget/safety/provider/gate failures still map to their proper 4xx
  // via `rethrow()` (the bus additionally gets a generic, user-safe `failed`
  // event). A single LLM call is not corpus-scale, so awaiting it carries no
  // gateway risk — the corpus-scale op (embeddings reindex) is the one made fully
  // async (202 + jobId) elsewhere.
  r.post("/commands/:cmd", requireAuth, requirePermission("project.update"), async (req, res) => {
    const parsed = specKitCommandRequestSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      throw new AppError(400, "BAD_REQUEST", parsed.error.message);
    }
    const cmdRaw = String(req.params.cmd ?? "");
    const input = parsed.data.input;
    const body = (req.body ?? {}) as Record<string, unknown>;
    // MVP-1: accept both `speckit.*` namespaced form and the v1.2 legacy
    // short names. Set a `Deprecation` header on legacy invocations.
    const normalized = normalizeSpecKitCommand(cmdRaw);
    if (normalized) {
      if (normalized.legacy) {
        res.setHeader("Deprecation", "true");
        res.setHeader(
          "Link",
          `</api/projects/${projectIdFrom(req)}/spec-kit/commands/${normalized.canonical}>; rel="successor-version"`,
        );
        // Legacy aliases preserve v1.2 behavior — dispatch through the
        // original handler so the streamed result shape does not change.
        try {
          const projectId = projectIdFrom(req);
          await ensureEnabled(projectId);
          const legacyCmd = normalized.canonical.replace(/^speckit\./, "") as SpecKitCommand;
          if (!isSpecKitCommand(legacyCmd)) {
            throw new AppError(
              400,
              "SPEC_KIT_UNKNOWN_COMMAND",
              `Legacy alias has no v1.2 dispatcher: ${cmdRaw}`,
            );
          }
          const actor = actorId(req);
          const jobId = randomUUID();
          const result = await runSpecKitCommandJob(jobId, projectId, `/${legacyCmd}`, () =>
            dispatchCommand(
              legacyCmd,
              projectId,
              input,
              actor,
              memoizeProviderResolver(() => resolveProjectProvider(projectId)),
            ),
          );
          // Preserve the v1.2 response shape (command, artifactName, message, …)
          // and add the `jobId` so the client can correlate the live progress it
          // already received over the `job:lifecycle` bus.
          res.json(ok({ ...(result as Record<string, unknown>), jobId }));
        } catch (err) {
          rethrow(err);
        }
        return;
      }
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        // S-3 — the per-command `speckit.constitution.write` RBAC gate must run
        // SYNCHRONOUSLY so a forbidden caller gets a 403 instead of a 202. It is
        // re-checked inside dispatchNamespaced (defence in depth) but the route
        // pre-check preserves the synchronous-403 contract under async dispatch.
        if (normalized.canonical === "speckit.constitution") {
          if (!req.user || !hasPermission(req.user.role, "speckit.constitution.write")) {
            throw new AppError(403, "FORBIDDEN", "Requires permission speckit.constitution.write");
          }
        }
        const actor = actorId(req);
        const jobId = randomUUID();
        const result = await runSpecKitCommandJob(
          jobId,
          projectId,
          `/${normalized.canonical}`,
          () =>
            dispatchNamespaced(
              normalized.canonical,
              projectId,
              input,
              actor,
              body,
              req,
              memoizeProviderResolver(() => resolveProjectProvider(projectId)),
            ),
        );
        // Namespaced results vary in shape; spread them and add the `jobId` so
        // the client can correlate the streamed progress with this response.
        res.json(ok({ ...(result as Record<string, unknown>), jobId }));
      } catch (err) {
        rethrow(err);
      }
      return;
    }
    if (!isSpecKitCommand(cmdRaw)) {
      throw new AppError(400, "SPEC_KIT_UNKNOWN_COMMAND", `Unknown Spec Kit command: ${cmdRaw}`);
    }
    try {
      const projectId = projectIdFrom(req);
      await ensureEnabled(projectId);
      const actor = actorId(req);
      const jobId = randomUUID();
      const result = await runSpecKitCommandJob(jobId, projectId, `/${cmdRaw}`, () =>
        dispatchCommand(
          cmdRaw,
          projectId,
          input,
          actor,
          memoizeProviderResolver(() => resolveProjectProvider(projectId)),
        ),
      );
      // Preserve the v1.2 DispatchedCommandResult shape (command, artifactName,
      // artifact, message — incl. the grounded-completion line — tokensUsed) and
      // add the `jobId` so the client can correlate the streamed progress.
      res.json(ok({ ...(result as Record<string, unknown>), jobId }));
    } catch (err) {
      rethrow(err);
    }
  });

  // ---- MVP-5: per-feature routes ------------------------------------------
  r.get("/features", requireAuth, requirePermission("project.read"), async (req, res) => {
    try {
      const projectId = projectIdFrom(req);
      await ensureEnabled(projectId);
      const includeArchived =
        req.query.includeArchived === "1" || req.query.includeArchived === "true";
      const features = await listFeatures(projectId, { includeArchived });
      res.json(ok({ features }));
    } catch (err) {
      rethrow(err);
    }
  });

  r.get(
    "/features/:slug/artifacts",
    requireAuth,
    requirePermission("project.read"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        const feature = await resolveFeatureBySlug(projectId, String(req.params.slug ?? ""));
        if (!feature) throw new AppError(404, "SPECKIT_FEATURE_NOT_FOUND", "Feature not found");
        const artifacts = await listFeatureArtifacts(feature.id);
        res.json(ok({ feature, artifacts }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.get(
    "/features/:slug/artifacts/*key",
    requireAuth,
    requirePermission("project.read"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        const feature = await resolveFeatureBySlug(projectId, String(req.params.slug ?? ""));
        if (!feature) throw new AppError(404, "SPECKIT_FEATURE_NOT_FOUND", "Feature not found");
        const key = wildcardKey(req.params.key);
        const artifact = await getFeatureArtifact(feature.id, key);
        if (!artifact) throw new AppError(404, "SPECKIT_NOT_FOUND", `Artifact ${key} not found`);
        res.json(ok({ artifact }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.put(
    "/features/:slug/artifacts/*key",
    requireAuth,
    requirePermission("project.update"),
    async (req, res) => {
      const parsed = z.object({ content: z.string().max(200_000) }).safeParse(req.body ?? {});
      if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        const feature = await resolveFeatureBySlug(projectId, String(req.params.slug ?? ""));
        if (!feature) throw new AppError(404, "SPECKIT_FEATURE_NOT_FOUND", "Feature not found");
        const artifact = await writeFeatureArtifact({
          featureId: feature.id,
          key: wildcardKey(req.params.key),
          content: parsed.data.content,
          actorId: actorId(req),
        });
        res.json(ok({ artifact }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ---- MVP-8: status endpoint --------------------------------------------
  r.get(
    "/features/:slug/status",
    requireAuth,
    requirePermission("project.read"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        const feature = await resolveFeatureBySlug(projectId, String(req.params.slug ?? ""));
        if (!feature) throw new AppError(404, "SPECKIT_FEATURE_NOT_FOUND", "Feature not found");
        const status = await computeStatus(feature.id);
        res.json(ok({ slug: feature.slug, ...status }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ---- Issue #434: archive / restore -------------------------------------
  r.post(
    "/features/:slug/archive",
    requireAuth,
    requirePermission("project.update"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        const feature = await archiveFeature({
          projectId,
          slug: String(req.params.slug ?? ""),
          actorId: actorId(req),
        });
        res.json(ok({ feature }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.post(
    "/features/:slug/restore",
    requireAuth,
    requirePermission("project.update"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        const parsed = z
          .object({ restoreTo: z.string().min(1).max(40).optional() })
          .safeParse(req.body ?? {});
        if (!parsed.success) throw new AppError(400, "BAD_REQUEST", parsed.error.message);
        const feature = await restoreFeature({
          projectId,
          slug: String(req.params.slug ?? ""),
          actorId: actorId(req),
          ...(parsed.data.restoreTo ? { restoreTo: parsed.data.restoreTo } : {}),
        });
        res.json(ok({ feature }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ---- MVP-7: filesystem installer ---------------------------------------
  r.post("/install", requireAuth, requirePermission("project.update"), async (req, res) => {
    // S-2 — the AttachedWorkspace concept does not yet exist as a
    // first-class model. Until it does, every `/install` call is
    // rejected so we cannot accept a caller-supplied workspaceRoot we
    // have no way to validate against the project's true attached path.
    // Tracked: follow-up issue for AttachedWorkspace model.
    void req;
    void res;
    throw new AppError(
      501,
      "SPECKIT_ATTACHED_WORKSPACE_NOT_IMPLEMENTED",
      "/spec-kit/install is disabled until the AttachedWorkspace model lands. The installer library is reachable for trusted in-process callers (tests + future server-internal code) but the public route refuses caller-supplied workspaceRoot values to prevent path-not-attached bypass (Epic #396 follow-up).",
    );
  });

  return r;
}

export interface DispatchedCommandResult {
  command: SpecKitCommand;
  artifactName: string | null;
  artifact: unknown;
  message: string;
  tokensUsed: number;
}

/**
 * Lazily resolves the project's AI provider on first use. Passing a thunk
 * (rather than an eagerly-built provider) keeps provider construction OUT of
 * code paths that never reach the LLM — notably the `speckit.constitution`
 * RBAC pre-check, so a forbidden caller still gets a 403 rather than a 502
 * from an unrelated provider-credential failure. Resolution is memoized so a
 * single dispatch builds the provider at most once (#381).
 */
export type ProviderResolver = () => Promise<AIProvider>;

/** Memoize a provider resolver so it builds at most once per dispatch. */
export function memoizeProviderResolver(resolve: ProviderResolver): ProviderResolver {
  let cached: Promise<AIProvider> | null = null;
  return () => {
    if (!cached) cached = resolve();
    return cached;
  };
}

async function dispatchCommand(
  cmd: SpecKitCommand,
  projectId: string,
  input: string,
  actor: string,
  resolveProvider: ProviderResolver,
): Promise<DispatchedCommandResult> {
  // #381 — every LLM-backed command receives the project's real provider via
  // the existing `deps.provider` seam. The offline-stub is no longer the
  // production default; it remains reachable ONLY when a test injects it.
  // `implement` never calls the LLM, so it is handled below WITHOUT resolving
  // a provider.
  switch (cmd) {
    case "specify": {
      const deps = { provider: await resolveProvider() };
      const r = await runSpecify({ projectId, prompt: input, actorId: actor, deps });
      return {
        command: "specify",
        artifactName: "spec.md",
        artifact: r.artifact,
        message: r.message,
        tokensUsed: r.tokensUsed,
      };
    }
    case "plan": {
      const deps = { provider: await resolveProvider() };
      const r = await runPlan({ projectId, actorId: actor, deps });
      return {
        command: "plan",
        artifactName: "plan.md",
        artifact: r.artifact,
        message: r.message,
        tokensUsed: r.tokensUsed,
      };
    }
    case "tasks": {
      const deps = { provider: await resolveProvider() };
      const r = await runTasks({ projectId, actorId: actor, deps });
      return {
        command: "tasks",
        artifactName: "tasks.md",
        artifact: r.artifact,
        message: r.message,
        tokensUsed: r.tokensUsed,
      };
    }
    case "clarify": {
      const deps = { provider: await resolveProvider() };
      const r = await runClarify({ projectId, input, actorId: actor, deps });
      return {
        command: "clarify",
        artifactName: "clarify.md",
        artifact: r.artifact,
        message: r.message,
        tokensUsed: r.tokensUsed,
      };
    }
    case "analyze": {
      const deps = { provider: await resolveProvider() };
      const r = await runAnalyze({ projectId, actorId: actor, deps });
      return {
        command: "analyze",
        artifactName: "analysis.md",
        artifact: r.artifact,
        message: r.message,
        tokensUsed: r.tokensUsed,
      };
    }
    case "implement": {
      const r = await runImplement({ projectId, actorId: actor });
      return {
        command: "implement",
        artifactName: null,
        artifact: { context: r.context, orchestratorRoute: r.orchestratorRoute },
        message: r.message,
        tokensUsed: 0,
      };
    }
  }
}

/**
 * Epic #396 — namespaced (`speckit.*`) command dispatcher. Includes the
 * MVP-2/3/4/5/6 commands that have no v1.2 legacy form.
 */
async function dispatchNamespaced(
  cmd: string,
  projectId: string,
  input: string,
  actor: string,
  body: Record<string, unknown>,
  req: Request,
  resolveProvider: ProviderResolver,
): Promise<unknown> {
  // Per-feature commands accept a `featureSlug` body field.
  const featureSlug = typeof body.featureSlug === "string" ? body.featureSlug : undefined;
  const force = req.header("x-speckit-force") === "1" || req.header("x-speckit-force") === "true";
  // S-3 — per-command RBAC: the constitution write requires its own
  // `speckit.constitution.write` permission on top of the route-level
  // `project.update` gate.
  if (cmd === "speckit.constitution") {
    if (!req.user || !hasPermission(req.user.role, "speckit.constitution.write")) {
      throw new AppError(403, "FORBIDDEN", "Requires permission speckit.constitution.write");
    }
  }
  switch (cmd) {
    case "speckit.constitution": {
      const r = await runConstitution({ projectId, content: input, actorId: actor });
      return r;
    }
    case "speckit.specify": {
      const r = await runSpecifyFeature({
        projectId,
        prompt: input,
        ...(typeof body.featureSlug === "string" ? { featureSlugOverride: body.featureSlug } : {}),
        actorId: actor,
        deps: { provider: await resolveProvider() },
      });
      return r;
    }
    case "speckit.plan": {
      if (!featureSlug)
        throw new AppError(
          400,
          "SPECKIT_FEATURE_REQUIRED",
          "featureSlug required for /speckit.plan",
        );
      return runPlanExpanded({
        projectId,
        featureSlug,
        force,
        actorId: actor,
        deps: { provider: await resolveProvider() },
      });
    }
    case "speckit.checklist": {
      if (!featureSlug)
        throw new AppError(
          400,
          "SPECKIT_FEATURE_REQUIRED",
          "featureSlug required for /speckit.checklist",
        );
      const mode = body.mode === "merge" || body.mode === "overwrite" ? body.mode : undefined;
      return runChecklist({
        projectId,
        featureSlug,
        force,
        ...(mode !== undefined ? { mode } : {}),
        ...(Array.isArray(body.domains) ? { domains: body.domains as string[] } : {}),
        actorId: actor,
      });
    }
    case "speckit.taskstoissues": {
      if (!featureSlug)
        throw new AppError(
          400,
          "SPECKIT_FEATURE_REQUIRED",
          "featureSlug required for /speckit.taskstoissues",
        );
      return runTasksToIssues({
        projectId,
        featureSlug,
        force,
        ...(typeof body.repo === "object" && body.repo !== null
          ? { repo: body.repo as { owner: string; name: string } }
          : {}),
        ...(typeof body.parentEpicNumber === "number"
          ? { parentEpicNumber: body.parentEpicNumber }
          : {}),
        ...(typeof body.dryRun === "boolean" ? { dryRun: body.dryRun } : {}),
        actorId: actor,
      });
    }
    case "speckit.tasks":
      return dispatchCommand("tasks", projectId, input, actor, resolveProvider);
    case "speckit.clarify":
      return dispatchCommand("clarify", projectId, input, actor, resolveProvider);
    case "speckit.analyze":
      return dispatchCommand("analyze", projectId, input, actor, resolveProvider);
    case "speckit.implement":
      return dispatchCommand("implement", projectId, input, actor, resolveProvider);
    default:
      throw new AppError(400, "SPEC_KIT_UNKNOWN_COMMAND", `Unknown speckit.* command: ${cmd}`);
  }
}
