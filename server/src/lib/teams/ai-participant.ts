/**
 * Epic #547 (Phase 3, #552) — AI participant via Teams.
 *
 * When a message ingested from a linked Teams channel (#551) mentions `@AI` (and
 * the thread's `aiResponseMode` permits), trigger the SAME discussion AI
 * participant the in-app REST `ai-respond` path uses — so the AI replies in the
 * thread, and the reply rides #550's outbound mirror back into the Teams channel.
 *
 * This module DOES NOT reimplement any AI logic. It reuses, verbatim:
 *   - `ai-gate.ts`        — `shouldAIRespond` (off / on_mention / auto, @AI detect)
 *   - `ai-rate-limit.ts`  — per-(thread,user) sliding-window cap (#485)
 *   - `ai-responder.ts`   — `streamAIReply` (provider call + `AITokenUsage` row)
 *
 * KEY DESIGN POINTS
 *
 * 1. CANONICAL MENTION. A Teams `@AI` arrives as a mention ENTITY whose `text` is
 *    an `<at>…</at>` tag (e.g. `<at>AI</at>`) rather than the literal `@AI` the
 *    in-app gate matches. #551 already strips the BOT's own recipient mention
 *    from the body; here we additionally normalise any AI-directed mention entity
 *    into a canonical `@AI` token so the SAME `detectAIMention` the REST path uses
 *    recognises it. Plain-text `@AI` typed by a user already canonicalises to
 *    itself. `auto` mode still fires on a detected question/request with no
 *    explicit mention, exactly as in-app.
 *
 * 2. ONE TEAMS SEND (no double-post). `streamAIReply` persists the reply as
 *    `authorKind="ai"` and DOES NOT itself mirror to Teams. We schedule EXACTLY
 *    ONE outbound mirror (#550) with `origin="metis"` — the same single mirror
 *    the REST route schedules. Because the inbound human message was created with
 *    `origin="teams"` (#551), #550's loop guard skips it; the AI reply is the only
 *    `metis`-origin row, so it is mirrored once. There is no second send path.
 *
 * 3. NO TOKEN STREAMING IN TEAMS. Teams has no SSE surface. We pass NO `onChunk`
 *    to `streamAIReply`, so only the FINAL persisted reply is mirrored (a single
 *    activity). The in-app thread still streams independently via the REST route;
 *    here we additionally emit the persisted `message:new` to the in-app room so
 *    connected web clients see the Teams-triggered AI reply live too.
 *
 * 4. COST CONTROL. `shouldAIRespond` gates BEFORE any provider call; the
 *    rate-limit check gates BEFORE the provider call too — a chatty channel can
 *    never blow the AI budget beyond the existing per-(thread,user) cap.
 *
 * SECURITY: the triggering body is UNTRUSTED Teams content. It flows only into
 * the responder's injection-isolated message array (a fixed system prompt + the
 * body as a USER turn); we never execute it. Member/tenant scoping from #549/#551
 * already gated ingestion — only a mapped, authorized user's `@AI` reaches here.
 */
import type { Activity, TurnContext } from "botbuilder";

import { createChildLogger } from "../logger.js";
import { shouldAIRespond } from "../discussions/ai-gate.js";
import {
  checkThreadAIRateLimit,
  loadThreadAIRateLimitConfig,
} from "../discussions/ai-rate-limit.js";
import { streamAIReply } from "../discussions/ai-responder.js";
import { emitMessageNew } from "../discussions/socket-emitter.js";
import { scheduleMirrorToTeams } from "./outbound-sync.js";
import { buildProvider, loadAIConfig, type AIProvider } from "../ai/index.js";

const log = createChildLogger("teams-ai-participant");

/** Why the AI participant did (or did not) reply — for tests + structured logs. */
export type AIParticipantOutcome =
  | "responded" // provider invoked, AI reply persisted + mirrored
  | "gate-declined" // mode/content did not call for a reply (no provider call)
  | "rate-limited" // per-(thread,user) cap reached (no provider call)
  | "error"; // provider/stream failure (nothing persisted, never thrown)

export interface AIParticipantResult {
  outcome: AIParticipantOutcome;
  messageId?: string;
}

/** The triggering (just-ingested) Teams human message. */
export interface TeamsAITrigger {
  /** Thread the message was ingested into. */
  threadId: string;
  /** Project of the thread (already resolved + authorized by #551). */
  projectId: string;
  /** The thread's persisted `aiResponseMode` (off | on_mention | auto). */
  aiResponseMode: string;
  /** The persisted human `DiscussionMessage` id (the trigger). */
  messageId: string;
  /** The resolved METIS user who sent it (rate-limit + session attribution). */
  authorUserId: string;
}

/** Injectable collaborators (defaults wire the real singletons/factories). */
export interface AIParticipantDeps {
  /** Provider to stream from. Defaults to the configured discussion provider. */
  provider: AIProvider;
  shouldRespond: typeof shouldAIRespond;
  checkRateLimit: typeof checkThreadAIRateLimit;
  loadRateLimitConfig: typeof loadThreadAIRateLimitConfig;
  streamReply: typeof streamAIReply;
  emit: typeof emitMessageNew;
  scheduleMirror: typeof scheduleMirrorToTeams;
}

export type AIParticipantOptions = Partial<AIParticipantDeps>;

function resolveDeps(opts: AIParticipantOptions): AIParticipantDeps {
  return {
    provider: opts.provider ?? buildProvider({ config: loadAIConfig() }),
    shouldRespond: opts.shouldRespond ?? shouldAIRespond,
    checkRateLimit: opts.checkRateLimit ?? checkThreadAIRateLimit,
    loadRateLimitConfig: opts.loadRateLimitConfig ?? loadThreadAIRateLimitConfig,
    streamReply: opts.streamReply ?? streamAIReply,
    emit: opts.emit ?? emitMessageNew,
    scheduleMirror: opts.scheduleMirror ?? scheduleMirrorToTeams,
  };
}

/**
 * Normalise a Teams `@AI` mention ENTITY in the (already bot-mention-stripped)
 * body into the canonical `@AI` literal the in-app gate (`detectAIMention`)
 * matches.
 *
 * Teams renders a user-typed `@AI` as a mention entity whose `text` is an
 * `<at>…</at>` tag that appears verbatim in `activity.text`. We replace the tag
 * of any AI-directed mention with ` @AI ` so the gate sees a canonical token —
 * other users' mentions are left untouched. A mention is "AI-directed" when its
 * mentioned display name (or the inner text of its `<at>` tag) is exactly `AI`
 * (case-insensitive). A plain-text `@AI` the user typed already canonicalises to
 * itself and needs no rewrite.
 *
 * Deterministic + dependency-free (no SDK internals), so behaviour is identical
 * in tests and production.
 */
export function canonicalizeAIMention(activity: Partial<Activity>, body: string): string {
  let text = body;
  const entities = (activity.entities ?? []) as Array<{
    type?: string;
    text?: string;
    mentioned?: { id?: string; name?: string };
  }>;

  for (const ent of entities) {
    if (ent.type !== "mention" || !ent.text) continue;
    const innerName = ent.text.replace(/<\/?at[^>]*>/gi, "").trim();
    const mentionedName = (ent.mentioned?.name ?? "").trim();
    const isAi = /^ai$/i.test(innerName) || /^ai$/i.test(mentionedName);
    if (isAi) {
      // Replace the literal mention tag occurrences with a canonical token.
      text = text.split(ent.text).join(" @AI ");
    }
  }

  return text.replace(/\s+/g, " ").trim();
}

/**
 * Decide + (when warranted) run the AI reply for a just-ingested Teams message.
 *
 * NON-THROWING: an expected "no reply" returns an outcome; a provider/stream
 * failure is logged and returned as `{ outcome: "error" }` (never thrown into
 * the inbound turn — a failed AI reply must not break message ingestion).
 *
 * @param context  the inbound TurnContext (for the raw mention entities)
 * @param trigger  the persisted human message + thread facts (from #551)
 */
export async function maybeRespondAsAI(
  context: TurnContext,
  trigger: TeamsAITrigger,
  opts: AIParticipantOptions = {},
): Promise<AIParticipantResult> {
  const deps = resolveDeps(opts);

  // Canonicalise the body so the SAME gate the REST path uses sees `@AI`.
  const canonicalBody = canonicalizeAIMention(context.activity, context.activity.text ?? "");

  // 1. The gate decides — no provider call when it returns false (cost control).
  //    Honors aiResponseMode end-to-end: off → never; on_mention → @AI only;
  //    auto → @AI or detected question/request.
  if (!deps.shouldRespond({ aiResponseMode: trigger.aiResponseMode }, { body: canonicalBody })) {
    return { outcome: "gate-declined" };
  }

  // 2. Per-(thread,user) AI-invocation rate limit (#485). Enforced BEFORE the
  //    provider call so an over-limit Teams message incurs NO LLM cost. A chatty
  //    channel cannot blow the budget beyond the existing shared cap.
  const rl = await deps.checkRateLimit(
    { threadId: trigger.threadId, userId: trigger.authorUserId },
    deps.loadRateLimitConfig(),
  );
  if (!rl.allowed) {
    log.info("Teams @AI reply rate-limited", {
      threadId: trigger.threadId,
      limit: rl.limit,
      retryAfterMs: rl.retryAfterMs,
    });
    return { outcome: "rate-limited" };
  }

  // 3. Invoke the SHARED responder. No `onChunk` — Teams has no SSE surface, so
  //    we stream nothing to Teams; only the FINAL persisted reply is mirrored.
  //    `streamAIReply` persists the reply (authorKind=ai) + records ONE
  //    AITokenUsage row, exactly as the REST path.
  try {
    const result = await deps.streamReply({
      thread: {
        id: trigger.threadId,
        projectId: trigger.projectId,
        aiResponseMode: trigger.aiResponseMode,
      },
      triggerMessage: { id: trigger.messageId, body: canonicalBody },
      actor: { id: trigger.authorUserId },
      provider: deps.provider,
    });

    // 4a. Fan the persisted AI reply out to the in-app `thread:{id}` room so
    //     connected web clients see the Teams-triggered reply live (same as the
    //     REST route's post-stream emit). Best-effort + no-op without IO.
    deps.emit(trigger.threadId, {
      id: result.message.id,
      threadId: trigger.threadId,
      authorKind: "ai",
      authorUserId: null,
      aiProvider: result.message.aiProvider,
      aiModel: result.message.aiModel,
      aiSessionId: result.message.aiSessionId,
      body: result.message.body,
      createdAt: new Date(),
      editedAt: null,
    });

    // 4b. EXACTLY ONE outbound Teams mirror (#550) for the AI reply. The reply is
    //     `origin="metis"`, so the loop guard mirrors it; the trigger was
    //     `origin="teams"`, so it is NOT mirrored — no double-post. This is the
    //     SAME single mirror the REST route schedules; there is no second send.
    deps.scheduleMirror(trigger.threadId, {
      id: result.message.id,
      threadId: trigger.threadId,
      authorKind: "ai",
      authorUserId: null,
      aiModel: result.message.aiModel,
      body: result.message.body,
      origin: "metis",
    });

    log.info("Teams @AI reply persisted + mirrored", {
      threadId: trigger.threadId,
      messageId: result.message.id,
      totalTokens: result.usage.totalTokens,
    });
    return { outcome: "responded", messageId: result.message.id };
  } catch (err) {
    // streamAIReply rethrows on stream error WITHOUT persisting/charging. We
    // swallow it here — a failed AI reply must never break inbound ingestion.
    log.error("Teams @AI reply failed", {
      threadId: trigger.threadId,
      error: (err as Error).message,
    });
    return { outcome: "error" };
  }
}
