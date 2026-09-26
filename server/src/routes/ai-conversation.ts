/**
 * Epic #127 — the server-owned conversation of a chat session.
 *
 *   GET  /api/ai/sessions/:id/messages   — the transcript (#136), compacted rows
 *                                          included and marked; paged by
 *                                          `afterOrdinal` / `limit` (#212)
 *   POST /api/ai/sessions/:id/resume     — transcript + model/agent/skills/plan
 *                                          state, from server data only (#139)
 *   POST /api/ai/sessions/:id/fork       — new session from an earlier reply (#139)
 *   POST /api/ai/sessions/:id/compact    — summarise older turns now (#138)
 *
 * Every route authorises through `loadAuthorizedSession`: the caller must own
 * the session AND still reach its project. Anything else is a 404.
 */
import { Router, type Request, type Response } from "express";
import { z } from "zod";
import { TRANSCRIPT_PAGE_MAX, type TranscriptResponse } from "@metis/shared";
import { requireAuth } from "../middleware/auth.js";
import { AppError } from "../middleware/error-handler.js";
import { conversationRateLimiter } from "../middleware/conversation-rate-limit.js";
import {
  compactSessionOnDemand,
  forkSession,
  readTranscriptPage,
  resumeSession,
} from "../lib/ai/conversation/conversation-service.js";
import { CompactionError } from "../lib/async/compaction.js";
import { AIError } from "../lib/ai/errors.js";
import { BudgetExceededError } from "../lib/finops/budget-enforcer.js";
import { chatProviderForSession } from "./ai.js";

function ok<T>(data: T): { success: true; data: T } {
  return { success: true, data };
}

// #212 — a page past the server maximum is clamped to it, and `hasMore` says
// the reader has not got everything; nothing is dropped silently.
const pageQuerySchema = z.object({
  afterOrdinal: z.coerce.number().int().min(0).default(0),
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .default(TRANSCRIPT_PAGE_MAX)
    .transform((n) => Math.min(n, TRANSCRIPT_PAGE_MAX)),
});

const forkSchema = z.object({
  fromOrdinal: z.number().int().min(1),
});

export function aiConversationRouter(): Router {
  const r = Router();

  r.get(
    "/sessions/:id/messages",
    requireAuth,
    conversationRateLimiter,
    async (req: Request, res: Response) => {
      const parsed = pageQuerySchema.safeParse(req.query ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid transcript page", {
          issues: parsed.error.flatten(),
        });
      }
      res.json(
        ok<TranscriptResponse>(
          await readTranscriptPage(req.user, String(req.params.id), parsed.data),
        ),
      );
    },
  );

  r.post(
    "/sessions/:id/resume",
    requireAuth,
    conversationRateLimiter,
    async (req: Request, res: Response) => {
      res.json(ok(await resumeSession(req.user, String(req.params.id))));
    },
  );

  r.post(
    "/sessions/:id/fork",
    requireAuth,
    conversationRateLimiter,
    async (req: Request, res: Response) => {
      const parsed = forkSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new AppError(400, "VALIDATION_ERROR", "Invalid fork payload", {
          issues: parsed.error.flatten(),
        });
      }
      const result = await forkSession(req.user, String(req.params.id), parsed.data.fromOrdinal);
      res.status(201).json(ok(result));
    },
  );

  // Epic #156 (#150) — on-demand compaction for the chat `/compact` command,
  // now over the transcript (#138).
  r.post(
    "/sessions/:id/compact",
    requireAuth,
    conversationRateLimiter,
    async (req: Request, res: Response) => {
      const ac = new AbortController();
      res.on("close", () => {
        if (!res.writableEnded) ac.abort();
      });
      try {
        const result = await compactSessionOnDemand(
          req.user,
          String(req.params.id),
          chatProviderForSession,
          ac.signal,
        );
        res.json(ok(result));
      } catch (err) {
        if (err instanceof AppError) throw err;
        if (err instanceof BudgetExceededError) {
          throw new AppError(err.status, err.code, err.message, {
            usedTokens: err.usedTokens,
            budget: err.budget,
          });
        }
        if (err instanceof CompactionError) throw new AppError(502, "COMPACT_FAILED", err.message);
        if (err instanceof AIError) throw new AppError(err.status, err.code, err.message);
        throw new AppError(500, "COMPACT_FAILED", (err as Error).message);
      }
    },
  );

  return r;
}
