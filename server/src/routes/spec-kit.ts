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
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import {
  SPECKIT_LEGACY_ALIAS,
  SPEC_KIT_JOB_NOT_FOUND_CODE,
  SPEC_KIT_JOB_RUNNING_CODE,
  SPEC_KIT_JOB_SAVING_CODE,
  SPEC_KIT_NOT_A_JOB_CODE,
  SPEC_KIT_START_TOKEN_HEADER,
  isSpecKitArtifactName,
  isSpecKitJobCommand,
  type SpecKitCommand,
  type SpecKitJobDto,
  type SpecKitJobError,
  type SpecKitNamespacedCommand,
  normalizeSpecKitCommand,
  specKitCommandRequestSchema,
  specKitWriteRequestSchema,
} from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { requirePermission } from "../middleware/require-permission.js";
import { requireProjectAccess } from "../middleware/require-project-access.js";
import { specKitDeleteRateLimiter } from "../middleware/spec-kit-delete-rate-limit.js";
import {
  specKitExportLiveRateLimiter,
  specKitExportPreAuthRateLimiter,
} from "../middleware/spec-kit-export-rate-limit.js";
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
import { draftConstitution } from "../lib/spec-kit/commands/constitution-draft.js";
import { runSpecify } from "../lib/spec-kit/commands/specify.js";
import { runPlan } from "../lib/spec-kit/commands/plan.js";
import { runTasks } from "../lib/spec-kit/commands/tasks.js";
import { runClarify } from "../lib/spec-kit/commands/clarify.js";
import { runAnalyze } from "../lib/spec-kit/commands/analyze.js";
import { runImplement } from "../lib/spec-kit/commands/implement.js";
import { findStaleArtifacts } from "../lib/spec-kit/plan-provenance.js";
import { runConstitution } from "../lib/spec-kit/commands/constitution.js";
import { runChecklist } from "../lib/spec-kit/commands/checklist.js";
import { runPlanExpanded } from "../lib/spec-kit/commands/plan-expanded.js";
import {
  runSpecifyFeature,
  specifyFeatureTitle,
} from "../lib/spec-kit/commands/specify-feature.js";
import {
  clearStuckTasksExport,
  exportTasksToGitHub,
  previewTasksExport,
  tasksExportBodySchema,
} from "../lib/spec-kit/commands/taskstoissues-github.js";
import { PublishError } from "../lib/publishing/types.js";
import {
  CrossProjectRepoError,
  crossProjectDryRunNotice,
  describeCrossProjectRefusal,
} from "../lib/publishing/cross-project-guard.js";
import {
  createFeature,
  discardEmptyDraftFeature,
  listFeatures,
  resolveFeatureBySlug,
  archiveFeature,
  restoreFeature,
  SpecKitFeatureLifecycleError,
} from "../lib/spec-kit/features.js";
import {
  deleteFeatureArtifact,
  getFeatureArtifact,
  listFeatureArtifacts,
  writeFeatureArtifact,
} from "../lib/spec-kit/feature-artifacts.js";
import {
  computeStatus,
  GateUnmetError,
  requireGate,
  type GateName,
} from "../lib/spec-kit/gates.js";
import { featureArtifactScope, type ArtifactScope } from "../lib/spec-kit/artifact-scope.js";
import { BudgetExceededError, assertWithinBudget } from "../lib/finops/budget-enforcer.js";
import { audit } from "../lib/audit/audit-service.js";
import { SafetyDeniedError } from "../lib/safety/safety-hook.js";
import { resolveProjectProvider } from "../lib/ai/project-provider.js";
import { AIProviderError, describeProviderErrorSafely } from "../lib/ai/errors.js";
import { isRetiredProviderError } from "../lib/ai/retired-providers.js";
import type { AIProvider } from "../lib/ai/types.js";
import { jobEvents, genericFailureMessage } from "../lib/socket/job-events.js";
import { recordJobScope } from "../lib/socket/job-scope-store.js";
import { createChildLogger } from "../lib/logger.js";
import { randomUUID } from "node:crypto";
import { ZodError } from "zod";
import { zodErrorToFriendly } from "../middleware/error-handler.js";
import { mapStatusCarryingError } from "../middleware/http-status-errors.js";
import {
  specKitJobPreAuthRateLimiter,
  specKitJobUserReadRateLimiter,
  specKitJobUserWriteRateLimiter,
} from "../middleware/spec-kit-job-rate-limit.js";
import { SPECKIT_FEATURE_SLUG_RE } from "../lib/spec-kit/features.js";
import {
  SPEC_KIT_JOB_CANCELLED_MESSAGE,
  SPEC_KIT_JOB_INTERNAL_ERROR,
  SPEC_KIT_JOB_START_TOKEN_RE,
  SpecKitJobAlreadyStartedError,
  SpecKitJobConflictError,
  SpecKitJobSavingError,
  cancelSpecKitJob,
  extractCompletionMessage,
  getSpecKitJob,
  listActiveSpecKitJobs,
  specKitJobHolding,
  specKitJobIdForStart,
  startSpecKitJob,
  type StartedSpecKitJob,
} from "../lib/spec-kit/jobs.js";

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
 *
 * #1059 — it lives with the job runner now, which emits the same terminal line.
 */
export { extractCompletionMessage };

/**
 * #1059 — the error a client is shown for whatever a command threw, as this
 * route maps it.
 *
 * One class is NOT stored with its own message: a provider failure. Its message
 * can carry the upstream service's free text (`anthropic chat failed (…): <what
 * the provider said>`), and a job's error is kept for a day and readable by
 * every member who can read the project — not, as on a request that is simply
 * answered, by the caller alone. It is stored as the provider, the operation,
 * the error class and the HTTP status; the job runner logs the full error.
 */
export function toSpecKitJobError(err: unknown): SpecKitJobError {
  if (err instanceof AIProviderError) {
    return {
      status: 502,
      code: "AI_PROVIDER_KEY_UNAVAILABLE",
      message: describeProviderErrorSafely(err),
    };
  }
  try {
    rethrow(err);
  } catch (mapped) {
    if (mapped instanceof AppError) {
      return {
        status: mapped.statusCode,
        code: mapped.code,
        message: mapped.message,
        ...(mapped.details ? { details: mapped.details } : {}),
      };
    }
    if (mapped instanceof ZodError) {
      const friendly = zodErrorToFriendly(mapped);
      return {
        status: 400,
        code: "VALIDATION_ERROR",
        message: friendly.message,
        details: { fields: friendly.fields },
      };
    }
    // Status and code only: the message of any other error class is never
    // forwarded (see http-status-errors.ts).
    const carried = mapStatusCarryingError(mapped);
    if (carried) {
      return { status: carried.statusCode, code: carried.code, message: carried.message };
    }
  }
  return SPEC_KIT_JOB_INTERNAL_ERROR;
}

/** #1059 — a terminal job's result, or the error the synchronous route answers with. */
function jobResultOrThrow(job: SpecKitJobDto): unknown {
  if (job.status === "succeeded") return job.result;
  if (job.status === "cancelled") {
    throw new AppError(409, "SPEC_KIT_JOB_CANCELLED", SPEC_KIT_JOB_CANCELLED_MESSAGE);
  }
  const error = job.error ?? SPEC_KIT_JOB_INTERNAL_ERROR;
  throw new AppError(error.status, error.code, error.message, error.details);
}

function jobNotFound(): AppError {
  return new AppError(404, SPEC_KIT_JOB_NOT_FOUND_CODE, "No such Spec Kit job in this project");
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
  // #674 — durably, before the response carries the id, so `subscribe:job`
  // is authorized on any replica.
  await recordJobScope(jobId, "spec-kit", projectId);
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
  // #953 — the live issue export's publishing-layer refusals (target guard,
  // credential, GitHub failure) carry fixed, client-safe messages.
  if (err instanceof PublishError) {
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
  // #149 — a project override naming a removed provider: the same 409 the chat
  // route returns for it, not a credentials 502.
  if (isRetiredProviderError(err)) {
    throw new AppError(409, "AI_PROVIDER_RETIRED", err.message);
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

/** A `/commands/:cmd` request, checked as far as it can be before the command runs. */
interface PreparedCommand {
  projectId: string;
  canonical: SpecKitNamespacedCommand;
  /** The command as the caller named it (`/plan` for the legacy alias), for progress text. */
  label: string;
  /** The feature whose artifacts the command writes; `null` for the project-level set. */
  featureSlug: string | null;
  actor: string;
  run: () => Promise<unknown>;
  /**
   * Set for a command that creates a NEW feature (`speckit.specify` without a
   * `featureSlug`). It writes nothing another such command writes, so it must
   * not hold the project-level key: `reserve` creates the feature — the store
   * gives two concurrent creators different numbers — and the job is started
   * under that feature's own slug, running `run(slug)`.
   *
   * `preflight` is everything that can refuse the command without a model
   * call and that used to be decided before a feature existed (the provider,
   * the budget). It runs BEFORE `reserve`, so a project whose provider cannot
   * be built answers its 502 / 409 and creates nothing, on every attempt.
   */
  newFeature?: {
    preflight: () => Promise<void>;
    reserve: () => Promise<ReservedFeature>;
    run: (featureSlug: string) => Promise<unknown>;
  };
}

/** A feature a command created for itself, before its job started. */
interface ReservedFeature {
  id: string;
  slug: string;
}

/**
 * The budget gate `runSpecKitAgent` applies before its model call, applied
 * before a feature is created for the command. Same error, same audit event.
 */
async function assertSpecifyWithinBudget(projectId: string, actor: string): Promise<void> {
  try {
    await assertWithinBudget(projectId);
  } catch (err) {
    if (err instanceof BudgetExceededError) {
      audit({
        actor: { id: actor },
        action: "spec_kit.command.specify.denied",
        target: { type: "project", id: projectId },
        metadata: { reason: "budget_exceeded" },
      });
    }
    throw err;
  }
}

/**
 * Remove the feature a job reserved for itself when that job saved nothing.
 * Never throws. Three things keep it from removing anything else:
 *
 *   - it waits for the job's own command to have ENDED (`work`), so nothing of
 *     that job can still create or write the feature afterwards;
 *   - it leaves a feature that a live job holds (somebody started a command on
 *     the draft in the meantime);
 *   - the delete itself is conditional on the feature still being an empty
 *     draft (`discardEmptyDraftFeature`), and names the feature by the id this
 *     job was given at the reservation, never by slug.
 */
async function discardReservedFeature(
  projectId: string,
  feature: ReservedFeature,
  actor: string,
  work?: Promise<unknown>,
): Promise<void> {
  try {
    await work?.catch(() => undefined);
    if (await specKitJobHolding(projectId, feature.slug)) return;
    await discardEmptyDraftFeature(feature.id, actor);
  } catch (err) {
    log.warn("could not remove the empty feature a failed /speckit.specify created", {
      projectId,
      feature: feature.slug,
      error: String(err),
    });
  }
}

/**
 * Validate a command request and bind the command to run. Everything the
 * command needs of the request is read here, because a job outlives it.
 *
 * MVP-1: both the `speckit.*` namespaced form and the v1.2 legacy short names
 * are accepted. A legacy name sets a `Deprecation` header and dispatches the
 * original v1.2 handler, so its result shape (and its project-level `.specify/`
 * scope) does not change.
 */
async function prepareCommand(req: Request, res: Response): Promise<PreparedCommand> {
  const parsed = specKitCommandRequestSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    throw new AppError(400, "BAD_REQUEST", parsed.error.message);
  }
  const cmdRaw = String(req.params.cmd ?? "");
  const input = parsed.data.input;
  const body = (req.body ?? {}) as Record<string, unknown>;
  const normalized = normalizeSpecKitCommand(cmdRaw);
  if (!normalized) {
    throw new AppError(400, "SPEC_KIT_UNKNOWN_COMMAND", `Unknown Spec Kit command: ${cmdRaw}`);
  }
  const projectId = projectIdFrom(req);
  const { canonical } = normalized;
  const legacyCmd = normalized.legacy ? SPECKIT_LEGACY_ALIAS[canonical] : null;
  if (legacyCmd) {
    res.setHeader("Deprecation", "true");
    res.setHeader(
      "Link",
      `</api/projects/${projectId}/spec-kit/commands/${canonical}>; rel="successor-version"`,
    );
  }
  try {
    await ensureEnabled(projectId);
    const actor = actorId(req);
    const resolveProvider = memoizeProviderResolver(() => resolveProjectProvider(projectId));
    if (legacyCmd) {
      return {
        projectId,
        canonical,
        label: `/${legacyCmd}`,
        featureSlug: null,
        actor,
        run: () => dispatchCommand(legacyCmd, projectId, input, actor, resolveProvider),
      };
    }
    // Object-level scope (BOLA) is not checked here: `requireProjectAccess()`
    // runs on both routes that call this (#960), ahead of the role check, so a
    // refused caller reaches no command, records no job scope and emits no
    // `started` event.
    const ctx = {
      force: req.header("x-speckit-force") === "1" || req.header("x-speckit-force") === "true",
      user: req.user,
    };
    const featureSlug = typeof body.featureSlug === "string" ? body.featureSlug : null;
    const dispatch = (commandBody: Record<string, unknown>) => (): Promise<unknown> =>
      dispatchNamespaced(canonical, projectId, input, actor, commandBody, ctx, resolveProvider);
    if (canonical === "speckit.specify" && featureSlug === null) {
      // Refused here, before a feature is created for it (400 SPECKIT_EMPTY_INPUT).
      const title = specifyFeatureTitle(input);
      return {
        projectId,
        canonical,
        label: `/${canonical}`,
        featureSlug: null,
        actor,
        run: dispatch(body),
        newFeature: {
          preflight: async () => {
            await resolveProvider();
            await assertSpecifyWithinBudget(projectId, actor);
          },
          reserve: async () => {
            const feature = await createFeature({ projectId, title, actorId: actor });
            return { id: feature.id, slug: feature.slug };
          },
          run: (slug) => dispatch({ ...body, featureSlug: slug })(),
        },
      };
    }
    return {
      projectId,
      canonical,
      label: `/${canonical}`,
      featureSlug,
      actor,
      run: dispatch(body),
    };
  } catch (err) {
    rethrow(err);
  }
}

/**
 * #1059 — start a prepared command as a job. A second start on the same feature
 * (or on the project-level set) is refused with 409 `SPEC_KIT_JOB_RUNNING`,
 * naming the job that holds it: there is never a second job writing it.
 *
 * The key is exactly as wide as what the command writes. A command that creates
 * a new feature has that feature created first and is locked under its slug,
 * so any number of members can each create a feature at the same time, and a
 * project-level command does not block them. That feature is removed again if
 * the job ends without having saved anything into it.
 *
 * `jobId` is set when the caller sent a start token: the start then creates
 * that job or throws `SpecKitJobAlreadyStartedError` (nothing new is left).
 */
async function startCommandJob(
  prepared: PreparedCommand,
  jobId?: string,
): Promise<StartedSpecKitJob> {
  let cmd = prepared;
  let reserved: ReservedFeature | null = null;
  /** The reserved feature's own command, once the job has started running it. */
  let work: Promise<unknown> | undefined;
  if (prepared.newFeature) {
    const { preflight, reserve, run } = prepared.newFeature;
    try {
      await preflight();
    } catch (err) {
      // Answered as the job would have stored it (a provider failure without
      // the provider's own words), on this route and on the synchronous one.
      const refused = toSpecKitJobError(err);
      throw new AppError(refused.status, refused.code, refused.message, refused.details);
    }
    const feature = await reserve();
    reserved = feature;
    cmd = {
      ...prepared,
      featureSlug: feature.slug,
      run: () => {
        work = run(feature.slug);
        return work;
      },
    };
  }
  // The slug is part of the lock key, so it is checked here rather than
  // minutes into the command (which refuses it with the same code).
  if (cmd.featureSlug !== null && !SPECKIT_FEATURE_SLUG_RE.test(cmd.featureSlug)) {
    throw new AppError(
      400,
      "SPECKIT_INVALID_SLUG",
      `Slug must match ^\\d{3}-[a-z0-9-]{1,80}$ (got: ${cmd.featureSlug.slice(0, 120)})`,
    );
  }
  try {
    const started = await startSpecKitJob({
      ...(jobId !== undefined ? { id: jobId } : {}),
      projectId: cmd.projectId,
      command: cmd.canonical,
      featureSlug: cmd.featureSlug,
      actorId: cmd.actor,
      label: cmd.label,
      run: cmd.run,
      mapError: toSpecKitJobError,
    });
    if (reserved) {
      const feature = reserved;
      // `done` never rejects, and neither does the removal.
      void started.done.then((job) =>
        job.status === "succeeded"
          ? undefined
          : discardReservedFeature(cmd.projectId, feature, cmd.actor, work),
      );
    }
    return started;
  } catch (err) {
    // The job never ran (its scope could not be recorded, or this very start
    // had already been made): the feature reserved for it is nobody's.
    if (reserved) await discardReservedFeature(cmd.projectId, reserved, cmd.actor);
    if (err instanceof SpecKitJobConflictError) {
      throw new AppError(409, SPEC_KIT_JOB_RUNNING_CODE, err.message, {
        ...(err.holder
          ? {
              jobId: err.holder.id,
              command: err.holder.command,
              featureSlug: err.holder.featureSlug,
            }
          : {}),
      });
    }
    throw err;
  }
}

/**
 * The id of the job the request's start token names for THIS caller in THIS
 * project, or `undefined` when the request carries none. 400 for a token that
 * is not 16 to 128 characters of `A-Z a-z 0-9 _ -`.
 */
function startTokenJobId(req: Request, projectId: string): string | undefined {
  const token = req.header(SPEC_KIT_START_TOKEN_HEADER);
  if (token === undefined) return undefined;
  if (!SPEC_KIT_JOB_START_TOKEN_RE.test(token)) {
    throw new AppError(
      400,
      "SPECKIT_INVALID_START_TOKEN",
      "X-SpecKit-Start-Token must be 16 to 128 characters of A-Z, a-z, 0-9, _ or -",
    );
  }
  return specKitJobIdForStart(projectId, actorId(req), token);
}

/** The job a repeated start names, provided it is a start of the same command. */
function sameStart(job: SpecKitJobDto, cmd: PreparedCommand): SpecKitJobDto {
  if (job.command !== cmd.canonical) {
    throw new AppError(
      409,
      "SPECKIT_START_TOKEN_REUSED",
      `This start token already started /${job.command}. Use a new token for each command you start.`,
    );
  }
  return job;
}

export function specKitRouter(): Router {
  const r = Router({ mergeParams: true });
  // #960 — object-level project scope (OWASP A01 / BOLA) on EVERY route here:
  // `requireProjectAccess()` straight after `requireAuth` (and after the
  // per-user limiter where a route has one), ahead of the role check, so a
  // caller outside the project's workspace gets 404 whatever their role.
  //
  // Per route, not one router-level `r.use(requireAuth, requireProjectAccess())`:
  // the guard needs `req.user`, and a router-level `requireAuth` would run ahead
  // of the routes' pre-auth limiters, which #953 and #1059 put in front of
  // authentication on purpose (their tests assert that order).
  // `project-access-guard.test.ts` fails if a route is added without it.

  r.get(
    "/enabled",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.read"),
    async (req, res) => {
      try {
        const enabled = await isSpecKitEnabled(projectIdFrom(req));
        res.json(ok({ enabled }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.put(
    "/enabled",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.update"),
    async (req, res) => {
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
    },
  );

  r.get(
    "/files",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.read"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        const enabled = await isSpecKitEnabled(projectId);
        const artifacts = enabled ? await listArtifacts(projectId) : [];
        res.json(ok({ enabled, artifacts }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.get(
    "/files/:name",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.read"),
    async (req, res) => {
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
    },
  );

  r.put(
    "/files/:name",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.update"),
    async (req, res) => {
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
    },
  );

  r.delete(
    "/files/:name",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.update"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        await deleteArtifact(projectId, String(req.params.name ?? ""), actorId(req));
        res.status(204).end();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.post(
    "/constitution",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.update"),
    async (req, res) => {
      const parsed = constitutionSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "BAD_REQUEST", parsed.error.message);
      }
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        // #788 — derive the constitution from the project's knowledge; the
        // skeleton only when there is nothing to ground on (and `message` says so).
        const result = await draftConstitution({
          projectId,
          ...(parsed.data.projectOverrides !== undefined
            ? { projectOverrides: parsed.data.projectOverrides }
            : {}),
          actorId: actorId(req),
          resolveProvider: memoizeProviderResolver(() => resolveProjectProvider(projectId)),
        });
        const artifact = await getArtifact(projectId, "constitution.md");
        res.json(
          ok({
            artifact,
            contentLength: result.content.length,
            grounded: result.grounded,
            meta: result.meta,
            message: result.message,
          }),
        );
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // Epic #406 (#423) — Spec Kit commands stream `job:lifecycle` (kind
  // `spec-kit`) and their GROUNDED-COMPLETION line ("Generated spec.md (v3) …
  // grounded on N retrieved chunks.") is the terminal `completed` message.
  //
  // #1059 — this route still ANSWERS WITH THE RESULT, for API clients (the MCP
  // transport, scripts, the walkthrough's API-only checks): same payload, same
  // statuses and codes. But a command that makes a model call now runs as a job
  // (`startSpecKitJob`) that this request merely waits on, so it holds the same
  // per-feature lock as a job started with `POST /commands/:cmd/jobs`, and a
  // caller whose connection drops can still read the outcome from
  // `GET /jobs/:jobId`. A long command should be started as a job instead: a
  // request held for minutes is at the mercy of every proxy in between.
  // #953 — `speckit.taskstoissues` files real GitHub issues, so it is rate
  // limited ahead of auth (by address) and after it (live runs, by user). Both
  // limiters skip every other command.
  r.post(
    "/commands/:cmd",
    specKitExportPreAuthRateLimiter,
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.update"),
    specKitExportLiveRateLimiter,
    async (req, res) => {
      const cmd = await prepareCommand(req, res);
      try {
        if (!isSpecKitJobCommand(cmd.canonical)) {
          const jobId = randomUUID();
          const result = await runSpecKitCommandJob(jobId, cmd.projectId, cmd.label, cmd.run);
          // Results vary in shape; spread them and add the `jobId` so the client
          // can correlate the streamed progress with this response.
          res.json(ok({ ...(result as Record<string, unknown>), jobId }));
          return;
        }
        const started = await startCommandJob(cmd);
        const job = await started.done;
        res.json(
          ok({
            ...(jobResultOrThrow(job) as Record<string, unknown>),
            jobId: job.id,
          }),
        );
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ---- #1059: Spec Kit commands as background jobs -------------------------
  // Every job endpoint checks the caller against the PROJECT (object-level
  // scope first, so another tenant's caller gets a 404 whatever their role),
  // then the role, and reads a job only through `(projectId, jobId)`: a job id
  // from another project is indistinguishable from one that never existed.
  //
  // Rate limits, the same arrangement on all four (`spec-kit-job-rate-limit.ts`):
  // a coarse limiter in front of `requireAuth` (CodeQL js/missing-rate-limiting)
  // whose key no caller can aim at another, then — straight after `requireAuth`
  // — the budget that matters, per signed-in user: one for reads, one for
  // starts and cancels. Never the client address, which the client can choose.
  //
  // `X-SpecKit-Start-Token` makes a start repeatable: a second start carrying
  // the same token, from the same user in the same project, is answered with
  // the job the first one started — no second feature, no second run — so a
  // client whose 202 was lost can find its job instead of guessing.
  r.post(
    "/commands/:cmd/jobs",
    specKitJobPreAuthRateLimiter,
    requireAuth,
    specKitJobUserWriteRateLimiter,
    requireProjectAccess(),
    requirePermission("project.update"),
    async (req, res) => {
      const cmd = await prepareCommand(req, res);
      if (!isSpecKitJobCommand(cmd.canonical)) {
        throw new AppError(
          400,
          SPEC_KIT_NOT_A_JOB_CODE,
          `/${cmd.canonical} does not run as a job — send it to POST /spec-kit/commands/${cmd.canonical}.`,
        );
      }
      const jobId = startTokenJobId(req, cmd.projectId);
      const answer = (job: SpecKitJobDto): void => {
        res
          .status(202)
          .location(`/api/projects/${cmd.projectId}/spec-kit/jobs/${job.id}`)
          .json(ok({ jobId: job.id, job }));
      };
      try {
        // Looked up first, so a repeat does not even reserve a feature; the
        // primary key settles the two that arrive together (caught below).
        const already = jobId ? await getSpecKitJob(cmd.projectId, jobId) : null;
        answer(already ? sameStart(already, cmd) : (await startCommandJob(cmd, jobId)).job);
      } catch (err) {
        if (err instanceof SpecKitJobAlreadyStartedError) {
          answer(sameStart(err.job, cmd));
          return;
        }
        rethrow(err);
      }
    },
  );

  r.get(
    "/jobs",
    specKitJobPreAuthRateLimiter,
    requireAuth,
    specKitJobUserReadRateLimiter,
    requireProjectAccess(),
    requirePermission("project.read"),
    async (req, res) => {
      const projectId = projectIdFrom(req);
      // With a start token: also the job that token started for this caller,
      // running or finished — how a client recovers a start whose 202 was lost.
      const startedId = startTokenJobId(req, projectId);
      res.json(
        ok({
          jobs: await listActiveSpecKitJobs(projectId),
          ...(startedId !== undefined
            ? { started: await getSpecKitJob(projectId, startedId) }
            : {}),
        }),
      );
    },
  );

  r.get(
    "/jobs/:jobId",
    specKitJobPreAuthRateLimiter,
    requireAuth,
    specKitJobUserReadRateLimiter,
    requireProjectAccess(),
    requirePermission("project.read"),
    async (req, res) => {
      const job = await getSpecKitJob(projectIdFrom(req), String(req.params.jobId ?? ""));
      if (!job) throw jobNotFound();
      res.json(ok({ job }));
    },
  );

  r.post(
    "/jobs/:jobId/cancel",
    specKitJobPreAuthRateLimiter,
    requireAuth,
    specKitJobUserWriteRateLimiter,
    requireProjectAccess(),
    requirePermission("project.update"),
    async (req, res) => {
      try {
        const job = await cancelSpecKitJob(
          projectIdFrom(req),
          String(req.params.jobId ?? ""),
          actorId(req),
        );
        if (!job) throw jobNotFound();
        res.json(ok({ job }));
      } catch (err) {
        if (err instanceof SpecKitJobSavingError) {
          throw new AppError(409, SPEC_KIT_JOB_SAVING_CODE, err.message);
        }
        throw err;
      }
    },
  );

  // ---- MVP-5: per-feature routes ------------------------------------------
  r.get(
    "/features",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.read"),
    async (req, res) => {
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
    },
  );

  r.get(
    "/features/:slug/artifacts",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.read"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        const feature = await resolveFeatureBySlug(projectId, String(req.params.slug ?? ""));
        if (!feature) throw new AppError(404, "SPECKIT_FEATURE_NOT_FOUND", "Feature not found");
        const artifacts = await listFeatureArtifacts(feature.id);
        // #1134 — the plan-derived artifacts generated from an earlier plan.md.
        res.json(ok({ feature, artifacts, stale: findStaleArtifacts(artifacts) }));
      } catch (err) {
        rethrow(err);
      }
    },
  );

  r.get(
    "/features/:slug/artifacts/*key",
    requireAuth,
    requireProjectAccess(),
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
    requireProjectAccess(),
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

  // #789 — the Spec Kit page deletes a feature artifact as it does a
  // project-level file (`DELETE /files/:name`).
  r.delete(
    "/features/:slug/artifacts/*key",
    // In front of every auth check (CodeQL js/missing-rate-limiting).
    specKitDeleteRateLimiter,
    requireAuth,
    // Object-level scope (BOLA): role alone would let a `project.update`
    // holder in workspace A delete artifacts in workspace B's project.
    requireProjectAccess(),
    requirePermission("project.update"),
    async (req, res) => {
      try {
        const projectId = projectIdFrom(req);
        await ensureEnabled(projectId);
        const feature = await resolveFeatureBySlug(projectId, String(req.params.slug ?? ""));
        if (!feature) throw new AppError(404, "SPECKIT_FEATURE_NOT_FOUND", "Feature not found");
        await deleteFeatureArtifact(feature.id, wildcardKey(req.params.key), actorId(req));
        res.status(204).end();
      } catch (err) {
        rethrow(err);
      }
    },
  );

  // ---- MVP-8: status endpoint --------------------------------------------
  r.get(
    "/features/:slug/status",
    requireAuth,
    requireProjectAccess(),
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
    requireProjectAccess(),
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
    requireProjectAccess(),
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
  r.post(
    "/install",
    requireAuth,
    requireProjectAccess(),
    requirePermission("project.update"),
    async (req, res) => {
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
    },
  );

  return r;
}

export interface DispatchedCommandResult {
  command: SpecKitCommand;
  artifactName: string | null;
  artifact: unknown;
  message: string;
  tokensUsed: number;
  /** #1057 — a cut-off reply kept out of the store because a complete version exists. */
  partialContent?: string;
}

/**
 * Lazily resolves the project's AI provider on first use. Passing a thunk
 * (rather than an eagerly-built provider) keeps provider construction OUT of
 * code paths that never reach the LLM — notably `speckit.constitution` and a
 * constitution generation with nothing retrieved, which then never fail with a
 * 502 from an unrelated provider-credential problem. Resolution is memoized so a
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

/** #786 — the `speckit.*` commands that run in a feature scope when given a slug. */
const FEATURE_SCOPED_COMMANDS: Record<string, "tasks" | "clarify" | "analyze" | "implement"> = {
  "speckit.tasks": "tasks",
  "speckit.clarify": "clarify",
  "speckit.analyze": "analyze",
  "speckit.implement": "implement",
};

/** #786 — the feature phase gate each of them needs (bypassable with x-speckit-force). */
const FEATURE_COMMAND_GATES: Record<"tasks" | "clarify" | "analyze" | "implement", GateName> = {
  clarify: "specGate",
  tasks: "planGate",
  analyze: "tasksGate",
  implement: "implementGate",
};

async function dispatchCommand(
  cmd: SpecKitCommand,
  projectId: string,
  input: string,
  actor: string,
  resolveProvider: ProviderResolver,
  /** #786 — tasks/clarify/analyze/implement only; the project's `.specify/` when absent. */
  scope?: ArtifactScope,
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
        ...(r.partialContent !== undefined ? { partialContent: r.partialContent } : {}),
      };
    }
    case "tasks": {
      const deps = { provider: await resolveProvider() };
      const r = await runTasks({ projectId, actorId: actor, deps, scope });
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
      const r = await runClarify({ projectId, input, actorId: actor, deps, scope });
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
      const r = await runAnalyze({ projectId, actorId: actor, deps, scope });
      return {
        command: "analyze",
        artifactName: "analysis.md",
        artifact: r.artifact,
        message: r.message,
        tokensUsed: r.tokensUsed,
      };
    }
    case "implement": {
      const r = await runImplement({ projectId, actorId: actor, scope });
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
  /**
   * #1059 — what the command needs of the request, read before it runs: a job
   * outlives the request that started it.
   */
  ctx: { force: boolean; user: Request["user"] },
  resolveProvider: ProviderResolver,
): Promise<unknown> {
  // Per-feature commands accept a `featureSlug` body field.
  const featureSlug = typeof body.featureSlug === "string" ? body.featureSlug : undefined;
  const { force } = ctx;
  // #788 — `speckit.constitution` is gated by the route's `project.update`, like
  // every other Spec Kit write. A second `speckit.constitution.write` check here
  // never decided anything: every role holding `project.update` also held it.
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
        // #787 — derive the items from the feature's spec.md + plan.md. Resolved
        // lazily inside runChecklist, after its 404/412 checks; a provider that
        // cannot be built falls back to the labelled template.
        resolveProvider,
      });
    }
    case "speckit.taskstoissues": {
      if (!featureSlug)
        throw new AppError(
          400,
          "SPECKIT_FEATURE_REQUIRED",
          "featureSlug required for /speckit.taskstoissues",
        );
      // #953 — a dry run plans and checks the credential; anything else is a
      // live export through the vault-bound, target-guarded GitHub client.
      const extra = tasksExportBodySchema.safeParse(body);
      if (!extra.success) throw new AppError(400, "BAD_REQUEST", extra.error.message);
      if (!ctx.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
      // BOLA: requireProjectAccess() already ran on the route, before the job wrapper.
      const exportInput = {
        projectId,
        featureSlug,
        force,
        actorId: actor,
        actorRole: ctx.user.role,
        ...(typeof body.repo === "object" && body.repo !== null
          ? { repo: body.repo as { owner: string; name: string } }
          : {}),
        ...(typeof body.parentEpicNumber === "number"
          ? { parentEpicNumber: body.parentEpicNumber }
          : {}),
        ...(extra.data.secretRef !== undefined ? { secretRef: extra.data.secretRef } : {}),
        ...(extra.data.expectedPlan !== undefined ? { expectedPlan: extra.data.expectedPlan } : {}),
        ...(extra.data.taskIds !== undefined ? { taskIds: extra.data.taskIds } : {}),
        confirmCrossProject: extra.data.confirmCrossProject === true,
      };
      // #962 — "Clear stuck export" writes (deletes or records claims) after
      // reading GitHub, so it is never a dry run and counts as a live export
      // for the rate limit.
      if (extra.data.clearStuckClaims) {
        if (body.dryRun === true) {
          throw new AppError(
            400,
            "BAD_REQUEST",
            "Clearing a stuck export is not a dry run; send it without dryRun.",
          );
        }
        return clearStuckTasksExport(exportInput);
      }
      if (body.dryRun === true) {
        const preview = await previewTasksExport(exportInput);
        // #1211 — the dry run is not refused; like a batch dry run (#1171) it
        // says the live export will ask. Only for the configured target, the
        // one a live export uses, and never persisted: this command answers on
        // the request, so the names reach this caller alone.
        const notice =
          exportInput.repo || exportInput.confirmCrossProject
            ? null
            : await crossProjectDryRunNotice(
                {
                  projectId,
                  targetOwner: preview.repo.owner,
                  targetRepo: preview.repo.name,
                },
                ctx.user,
              );
        return notice ? { ...preview, crossProject: notice } : preview;
      }
      try {
        return await exportTasksToGitHub(exportInput);
      } catch (err) {
        // #1211 — name the other project only if this caller may open it.
        if (err instanceof CrossProjectRepoError) {
          throw await describeCrossProjectRefusal(err, ctx.user);
        }
        throw err;
      }
    }
    // #786 — with a `featureSlug` these read and write that feature's
    // `specs/<slug>/` artifacts behind the feature's phase gate; without one
    // they are the project-level `.specify/` commands (documented).
    case "speckit.tasks":
    case "speckit.clarify":
    case "speckit.analyze":
    case "speckit.implement": {
      const legacy = FEATURE_SCOPED_COMMANDS[cmd];
      if (!featureSlug) return dispatchCommand(legacy, projectId, input, actor, resolveProvider);
      const feature = await resolveFeatureBySlug(projectId, featureSlug);
      if (!feature) {
        throw new AppError(404, "SPECKIT_FEATURE_NOT_FOUND", `Feature not found: ${featureSlug}`);
      }
      await requireGate({
        featureId: feature.id,
        gate: FEATURE_COMMAND_GATES[legacy],
        force,
        actorId: actor,
        command: cmd,
      });
      return {
        ...(await dispatchCommand(
          legacy,
          projectId,
          input,
          actor,
          resolveProvider,
          featureArtifactScope(feature),
        )),
        featureSlug: feature.slug,
      };
    }
    default:
      throw new AppError(400, "SPEC_KIT_UNKNOWN_COMMAND", `Unknown speckit.* command: ${cmd}`);
  }
}
