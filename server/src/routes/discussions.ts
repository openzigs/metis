/**
 * Epic #475 (Phase 1, #478) — collaborative discussions REST surface.
 *
 * Routes (all gated by `requireAuth`, mounted at `/api/discussions`):
 *   POST /threads                      — create a project-scoped thread
 *   GET  /threads/:id/messages         — paginated message history (attribution)
 *   POST /threads/:id/messages         — post a HUMAN message
 *
 * Cost-control guarantee: posting a human message never calls `buildProvider()`
 * and never writes an `AITokenUsage` row — human↔human messages are free by
 * construction (the whole reason for the `authorKind` discriminator, see #476).
 *
 * Authorization: thread access uses `canAccessThread` (#477) — the single source
 * of truth shared with the socket layer — which maps to 404 (missing/soft-
 * deleted) vs 403 (non-member). Thread creation checks project membership
 * directly via `actorCanAccessProject` since no thread exists yet.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { prisma } from "../lib/prisma.js";
import { actorCanAccessProject } from "../lib/scheduler/project-access.js";
import { canAccessThread } from "../lib/discussions/access.js";
import { emitMessageNew, emitMessageStream } from "../lib/discussions/socket-emitter.js";
import { scheduleMirrorToTeams } from "../lib/teams/outbound-sync.js";
import { createHumanDiscussionMessage } from "../lib/discussions/create-message.js";
import { promoteMessageToRequirement, PromoteError } from "../lib/discussions/promote.js";
import { AI_RESPONSE_MODES, shouldAIRespond } from "../lib/discussions/ai-gate.js";
import { streamAIReply, type ResponderChunk } from "../lib/discussions/ai-responder.js";
import {
  checkThreadAIRateLimit,
  loadThreadAIRateLimitConfig,
} from "../lib/discussions/ai-rate-limit.js";
import { audit } from "../lib/audit/audit-service.js";
import { buildProvider, loadAIConfig, type AIProvider } from "../lib/ai/index.js";
import type { RoleKey } from "@metis/shared";

// ---- AI provider seam (#484) ------------------------------------------------
// Mirrors the ai.ts pattern: construct from config by default; tests inject a
// deterministic stub so the SSE trigger path runs without a real model.
let providerOverride: AIProvider | null = null;
function discussionProvider(): AIProvider {
  return providerOverride ?? buildProvider({ config: loadAIConfig() });
}
/** Test seam — inject a stub provider for the AI-respond SSE route. */
export function setDiscussionProviderForTests(p: AIProvider | null): void {
  providerOverride = p;
}

// ---- Constants --------------------------------------------------------------

const MAX_BODY_LEN = 10_000;
const DEFAULT_PAGE_SIZE = 50;
const MAX_PAGE_SIZE = 100;

// ---- Schemas ----------------------------------------------------------------

const anchorSchema = z
  .object({
    requirementId: z.string().min(1).optional(),
    analysisId: z.string().min(1).optional(),
    specKitFeatureId: z.string().min(1).optional(),
  })
  .optional();

const createThreadSchema = z.object({
  projectId: z.string().min(1),
  title: z.string().min(1).max(255).optional(),
  anchor: anchorSchema,
});

const postMessageSchema = z.object({
  body: z.string().min(1).max(MAX_BODY_LEN),
});

// POST /threads/:id/ai-respond — trigger an AI reply for a given human message.
const aiRespondSchema = z.object({
  messageId: z.string().min(1),
});

// PATCH /threads/:id — thread settings: the AI participation mode (#483) and,
// for #488, an optional anchor (Requirement / Analysis / Spec Kit feature). At
// least one updatable field must be supplied.
const patchThreadSchema = z
  .object({
    aiResponseMode: z.enum(AI_RESPONSE_MODES).optional(),
    anchor: anchorSchema,
  })
  .refine((v) => v.aiResponseMode !== undefined || v.anchor !== undefined, {
    message: "no updatable fields supplied",
  });

const promoteSchema = z.object({
  title: z.string().min(1).max(255),
  type: z.enum(["feature", "bug", "chore", "epic", "task"]).optional(),
  priority: z.enum(["low", "medium", "high", "critical"]).optional(),
});

// ---- Helpers ----------------------------------------------------------------

function actorFromReq(req: Request): { id: string; role: RoleKey } {
  if (!req.user) throw new AppError(401, "AUTH_REQUIRED", "Authentication required");
  return { id: req.user.userId, role: req.user.role as RoleKey };
}

/** Map a `canAccessThread` denial to the right HTTP error. */
function denyToError(reason: "not_found" | "forbidden"): AppError {
  return reason === "not_found"
    ? new AppError(404, "THREAD_NOT_FOUND", "Discussion thread not found")
    : new AppError(403, "FORBIDDEN", "No access to this discussion thread");
}

/**
 * Validate each provided anchor id exists AND belongs to `projectId` (a thread
 * can only anchor to artifacts in its own project). Soft-deleted anchors are
 * rejected. Returns the validated anchor columns to spread into the create.
 */
async function validateAnchor(
  projectId: string,
  anchor: { requirementId?: string; analysisId?: string; specKitFeatureId?: string } | undefined,
): Promise<{ requirementId?: string; analysisId?: string; specKitFeatureId?: string }> {
  if (!anchor) return {};
  const out: { requirementId?: string; analysisId?: string; specKitFeatureId?: string } = {};

  if (anchor.requirementId) {
    const row = await prisma.requirement.findFirst({
      where: { id: anchor.requirementId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new AppError(400, "INVALID_ANCHOR", "requirement anchor not found in project");
    out.requirementId = anchor.requirementId;
  }
  if (anchor.analysisId) {
    const row = await prisma.analysis.findFirst({
      where: { id: anchor.analysisId, projectId, deletedAt: null },
      select: { id: true },
    });
    if (!row) throw new AppError(400, "INVALID_ANCHOR", "analysis anchor not found in project");
    out.analysisId = anchor.analysisId;
  }
  if (anchor.specKitFeatureId) {
    const row = await prisma.specKitFeature.findFirst({
      where: { id: anchor.specKitFeatureId, projectId },
      select: { id: true },
    });
    if (!row)
      throw new AppError(400, "INVALID_ANCHOR", "spec-kit feature anchor not found in project");
    out.specKitFeatureId = anchor.specKitFeatureId;
  }
  return out;
}

// ---- Router -----------------------------------------------------------------

export function discussionsRouter(): Router {
  const r = Router();

  // GET /api/discussions/threads?projectId=… — list a project's threads (#486).
  // Member-gated like creation; soft-deleted threads excluded; newest first.
  r.get("/threads", requireAuth, async (req: Request, res: Response) => {
    const actor = actorFromReq(req);
    const projectId = typeof req.query.projectId === "string" ? req.query.projectId : "";
    if (!projectId) {
      throw new AppError(400, "VALIDATION_ERROR", "projectId query param is required");
    }

    const allowed = await actorCanAccessProject(actor, projectId, {
      resource: "discussion_thread",
      resourceId: projectId,
      action: "discussion.thread.list",
    });
    if (!allowed) throw new AppError(403, "FORBIDDEN", "No access to this project");

    const threads = await prisma.discussionThread.findMany({
      where: { projectId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        projectId: true,
        title: true,
        aiResponseMode: true,
        requirementId: true,
        analysisId: true,
        specKitFeatureId: true,
        createdById: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    res.json({ success: true, data: threads });
  });

  // POST /api/discussions/threads — create a project-scoped thread.
  r.post("/threads", requireAuth, async (req: Request, res: Response) => {
    const actor = actorFromReq(req);
    const parsed = createThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid thread payload", {
        issues: parsed.error.flatten(),
      });
    }
    const { projectId, title, anchor } = parsed.data;

    const allowed = await actorCanAccessProject(actor, projectId, {
      resource: "discussion_thread",
      resourceId: projectId,
      action: "discussion.thread.create",
    });
    if (!allowed) throw new AppError(403, "FORBIDDEN", "No access to this project");

    const anchorCols = await validateAnchor(projectId, anchor);

    const thread = await prisma.discussionThread.create({
      data: {
        projectId,
        createdById: actor.id,
        ...(title ? { title } : {}),
        ...anchorCols,
      },
    });

    // #489 — audit thread creation (provenance: who created which thread, where).
    audit({
      actor: { id: actor.id },
      action: "discussion.thread.created",
      target: { type: "discussion_thread", id: thread.id },
      metadata: { projectId, ...anchorCols },
    });

    res.status(201).json({ success: true, data: thread });
  });

  // PATCH /api/discussions/threads/:id — update thread settings (#483, #488).
  // Member-only. Updatable: `aiResponseMode` (off|on_mention|auto, enum-
  // validated) and an optional `anchor` (Requirement / Analysis / Spec Kit
  // feature, validated to belong to the thread's own project — same rule as
  // create-time anchoring).
  r.patch("/threads/:id", requireAuth, async (req: Request, res: Response) => {
    const actor = actorFromReq(req);
    const threadId = String(req.params.id);

    const parsed = patchThreadSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid thread update payload", {
        issues: parsed.error.flatten(),
      });
    }

    const access = await canAccessThread(actor, threadId);
    if (!access.ok) throw denyToError(access.reason);

    // Anchor ids must belong to this thread's project (access carries projectId).
    const anchorCols = parsed.data.anchor
      ? await validateAnchor(access.projectId, parsed.data.anchor)
      : {};

    const thread = await prisma.discussionThread.update({
      where: { id: threadId },
      data: {
        ...(parsed.data.aiResponseMode ? { aiResponseMode: parsed.data.aiResponseMode } : {}),
        ...anchorCols,
      },
    });
    res.json({ success: true, data: thread });
  });

  // GET /api/discussions/threads/:id/messages — paginated history.
  r.get("/threads/:id/messages", requireAuth, async (req: Request, res: Response) => {
    const actor = actorFromReq(req);
    const threadId = String(req.params.id);

    const access = await canAccessThread(actor, threadId);
    if (!access.ok) throw denyToError(access.reason);

    const rawLimit = Number.parseInt(String(req.query.limit ?? ""), 10);
    const limit = Number.isFinite(rawLimit)
      ? Math.min(Math.max(rawLimit, 1), MAX_PAGE_SIZE)
      : DEFAULT_PAGE_SIZE;
    const cursor =
      typeof req.query.cursor === "string" && req.query.cursor ? req.query.cursor : null;

    const messages = await prisma.discussionMessage.findMany({
      where: { threadId, deletedAt: null },
      orderBy: { createdAt: "asc" },
      take: limit,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      select: {
        id: true,
        threadId: true,
        authorKind: true,
        authorUserId: true,
        aiProvider: true,
        aiModel: true,
        aiSessionId: true,
        body: true,
        createdAt: true,
        editedAt: true,
      },
    });

    const nextCursor = messages.length === limit ? messages[messages.length - 1]?.id : null;
    res.json({ success: true, data: messages, nextCursor });
  });

  // POST /api/discussions/threads/:id/messages — post a HUMAN message.
  r.post("/threads/:id/messages", requireAuth, async (req: Request, res: Response) => {
    const actor = actorFromReq(req);
    const threadId = String(req.params.id);

    const parsed = postMessageSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid message payload", {
        issues: parsed.error.flatten(),
      });
    }

    const access = await canAccessThread(actor, threadId);
    if (!access.ok) throw denyToError(access.reason);

    // Human message: NO provider call, NO AITokenUsage row. The SHARED creation
    // path (#551) builds via `buildHumanMessageData` (nulls AI columns + asserts
    // the author invariant), persists with `origin="metis"`, fans out @mention
    // notifications to project members (#489, fire-and-forget), emits the
    // realtime `message:new` (#481), and schedules the outbound Teams mirror
    // (#550 — a no-op for an unlinked thread, a real mirror when bridged). The
    // Teams INBOUND bridge (#551) calls this same function with `origin="teams"`
    // so the two entry points can never drift apart.
    const message = await createHumanDiscussionMessage({
      threadId,
      authorUserId: actor.id,
      projectId: access.projectId,
      body: parsed.data.body,
      origin: "metis",
    });

    res.status(201).json({ success: true, data: message });
  });

  // POST /api/discussions/threads/:id/ai-respond — triggered AI reply (#484).
  //
  // Given a triggering human `messageId`, the gate (`shouldAIRespond`, #483)
  // decides whether to invoke the provider. When it does, the reply is streamed
  // over SSE and, on completion, persisted as an `authorKind=ai` message with
  // attribution + a single `AITokenUsage` row (see `streamAIReply`). When the
  // gate says no (e.g. `off`, or a plain statement in `on_mention`), we make NO
  // provider call and return a JSON `{ responded: false }` — the cost-control
  // guarantee. Member-only via `canAccessThread`.
  r.post("/threads/:id/ai-respond", requireAuth, async (req: Request, res: Response) => {
    const actor = actorFromReq(req);
    const threadId = String(req.params.id);

    const parsed = aiRespondSchema.safeParse(req.body);
    if (!parsed.success) {
      throw new AppError(400, "VALIDATION_ERROR", "Invalid ai-respond payload", {
        issues: parsed.error.flatten(),
      });
    }

    const access = await canAccessThread(actor, threadId);
    if (!access.ok) throw denyToError(access.reason);

    const thread = await prisma.discussionThread.findFirst({
      where: { id: threadId, deletedAt: null },
      select: { id: true, projectId: true, aiResponseMode: true },
    });
    if (!thread) throw denyToError("not_found");

    const trigger = await prisma.discussionMessage.findFirst({
      where: { id: parsed.data.messageId, threadId, deletedAt: null },
      select: { id: true, body: true, authorKind: true },
    });
    if (!trigger) throw new AppError(404, "MESSAGE_NOT_FOUND", "Trigger message not found");

    // The gate decides — no provider call when it returns false (cost control).
    if (!shouldAIRespond(thread, trigger)) {
      res.json({ success: true, data: { responded: false } });
      return;
    }

    // Per-(thread,user) AI-invocation rate limit (#485). Enforced BEFORE the
    // provider call so an over-limit request never incurs LLM cost. Surfaced as
    // a 429 with a clear retry hint + audited; the client renders it as a system
    // notice in the thread. Human↔human messages never reach this path.
    const rl = await checkThreadAIRateLimit(
      { threadId, userId: actor.id },
      loadThreadAIRateLimitConfig(),
    );
    if (!rl.allowed) {
      audit({
        actor: { id: actor.id },
        action: "discussion.ai.rate_limited",
        target: { type: "discussion_thread", id: threadId },
        metadata: { limit: rl.limit, retryAfterMs: rl.retryAfterMs },
      });
      res.setHeader("Retry-After", String(Math.ceil(rl.retryAfterMs / 1000)));
      throw new AppError(
        429,
        "DISCUSSION_AI_RATE_LIMITED",
        "AI reply rate limit reached for this thread — please wait before asking again",
        { limit: rl.limit, retryAfterMs: rl.retryAfterMs },
      );
    }

    // SSE stream the reply. Headers mirror the /api/ai/stream route.
    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const ac = new AbortController();
    req.on("aborted", () => ac.abort());
    res.on("close", () => ac.abort());

    const send = (chunk: ResponderChunk): void => {
      res.write(`event: ${chunk.type}\n`);
      res.write(`data: ${JSON.stringify(chunk)}\n\n`);
      // Integration seam (#486): fan the AI reply out to the `thread:{id}` room
      // so OTHER connected members (who are not the SSE requester) see the reply
      // stream live, exactly like a human `message:new`. We mirror token deltas
      // as `message:stream` chunks; the persisted `message:new` is emitted after
      // `streamAIReply` resolves (below). Best-effort + no-op without IO.
      if (chunk.type === "delta") {
        emitMessageStream(threadId, { delta: chunk.content });
      }
    };

    // Prior history (excluding the trigger) for conversational context.
    const history = await prisma.discussionMessage.findMany({
      where: { threadId, deletedAt: null, id: { not: trigger.id } },
      orderBy: { createdAt: "asc" },
      take: 20,
      select: { authorKind: true, body: true, authorUserId: true, aiModel: true },
    });

    try {
      const result = await streamAIReply({
        thread,
        triggerMessage: trigger,
        actor: { id: actor.id },
        provider: discussionProvider(),
        history,
        onChunk: send,
        signal: ac.signal,
      });
      // Integration seam (#486 — Phase 4): now that the discussion socket emitter
      // is merged (Phase 2 #481), fan the PERSISTED AI message out to the
      // `thread:{id}` room so multi-user clients receive the AI reply live, just
      // like a human `message:new`. The SSE frames remain the delivery mechanism
      // for the requester who triggered the reply; this emit reaches the OTHER
      // members. Mark the stream done over the room first (so a streaming UI can
      // finalize its placeholder), then publish the authoritative message row.
      emitMessageStream(threadId, {
        delta: "",
        messageId: result.message.id,
        done: true,
      });
      emitMessageNew(threadId, {
        id: result.message.id,
        threadId,
        authorKind: "ai",
        authorUserId: null,
        aiProvider: result.message.aiProvider,
        aiModel: result.message.aiModel,
        aiSessionId: result.message.aiSessionId,
        body: result.message.body,
        createdAt: new Date(),
        editedAt: null,
      });

      // #550 — mirror the AI reply into the linked Teams channel (if bridged),
      // rendered with the AI marker + model. Best-effort + fire-and-forget; an
      // in-app AI reply is always `metis`-origin so the loop guard never skips
      // it. A Teams send failure can never break the SSE/AI-respond path.
      scheduleMirrorToTeams(threadId, {
        id: result.message.id,
        threadId,
        authorKind: "ai",
        authorUserId: null,
        aiModel: result.message.aiModel,
        body: result.message.body,
        origin: "metis",
      });

      // #489 — audit the AI invocation: who triggered it, in which thread, the
      // model that answered, and the token-usage reference (the backing
      // AISession id, which the AITokenUsage row links to). No prompt/response
      // bodies are persisted — only provenance.
      audit({
        actor: { id: actor.id },
        action: "discussion.ai.invoked",
        target: { type: "discussion_thread", id: threadId },
        metadata: {
          messageId: result.message.id,
          triggerMessageId: trigger.id,
          aiProvider: result.message.aiProvider,
          aiModel: result.message.aiModel,
          aiSessionId: result.message.aiSessionId,
          totalTokens: result.usage.totalTokens,
        },
      });

      send({ type: "done" });
    } catch {
      // streamAIReply already emitted an `error` chunk to the client.
    } finally {
      try {
        res.end();
      } catch {
        /* socket already gone */
      }
    }
  });

  // POST /api/discussions/threads/:id/messages/:messageId/promote
  // Promote an AI- or human-authored message into a tracked Requirement, with
  // AuditLog provenance back to the source message (#479).
  r.post(
    "/threads/:id/messages/:messageId/promote",
    requireAuth,
    async (req: Request, res: Response) => {
      const actor = actorFromReq(req);
      const threadId = String(req.params.id);
      const messageId = String(req.params.messageId);

      const parsed = promoteSchema.safeParse(req.body);
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid promote payload", {
          issues: parsed.error.flatten(),
        });
      }

      // Member-only: promoting in a thread the caller can't access → 403/404.
      const access = await canAccessThread(actor, threadId);
      if (!access.ok) throw denyToError(access.reason);

      try {
        const result = await promoteMessageToRequirement({
          actor,
          threadId,
          messageId,
          title: parsed.data.title,
          type: parsed.data.type,
          priority: parsed.data.priority,
        });
        res.status(201).json({ success: true, data: result });
      } catch (err) {
        if (err instanceof PromoteError) {
          const status =
            err.code === "MESSAGE_NOT_FOUND" || err.code === "THREAD_NOT_FOUND" ? 404 : 400;
          throw new AppError(status, err.code, err.message);
        }
        throw err;
      }
    },
  );

  return r;
}
