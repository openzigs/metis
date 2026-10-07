/**
 * #243 — the usage a chat turn has already spent, metered even when the turn
 * fails.
 *
 * Both chat routes used to record a turn's usage only on their success path. A
 * turn that failed after one or more paid model calls — a code-tool loop whose
 * second call errored, a stream stopped by the hard ceiling or the client after
 * its usage arrived, an output safety refusal — metered NOTHING, so the project
 * budget (#164) under-counted exactly the turns that went wrong.
 *
 * The meter accumulates each model call's reported usage as it returns. The
 * success path still records the turn as before and marks each store it wrote;
 * on failure {@link TurnUsageMeter.recordFailedTurn} writes what was spent to
 * each store NOT yet written — so a turn is metered once per store, never
 * twice, and a turn that spent nothing writes no (zero) row.
 *
 * Sub-agent calls and compaction summaries meter themselves per call
 * (`bindSubAgents`, `providerSummarizer`) and are deliberately not counted here.
 */
import { createChildLogger } from "../../logger.js";
import { recordUsage as recordProjectUsage } from "../../finops/token-tracker.js";
import { getTokenTracker } from "../token-tracker.js";
import type { ProviderKey, TokenUsage } from "../types.js";
import { estimateTextTokens, type TokenRatio } from "./token-estimator.js";

const log = createChildLogger("chat-turn-usage");

/** #792 — `agentStep` on the project-ledger row of a chat turn. */
export const CHAT_TURN_AGENT_STEP = "chat";

/** `agentStep` on the per-user row of a turn that failed after spending tokens. */
export const FAILED_TURN_AGENT_STEP = "chat-failed";

/**
 * #137 — `agentStep` on the per-user row of a turn whose provider reported NO
 * usage, so the row holds {@link billableTurnUsage}'s estimate, not a count.
 */
export const ESTIMATED_TURN_AGENT_STEP = "chat-estimated";

/** True when a provider reported any usage at all for a call or turn. */
export function isReportedUsage(u: TokenUsage | null | undefined): u is TokenUsage {
  return (
    !!u &&
    (u.promptTokens > 0 ||
      u.completionTokens > 0 ||
      u.totalTokens > 0 ||
      (u.cacheReadTokens ?? 0) > 0 ||
      (u.cacheWriteTokens ?? 0) > 0)
  );
}

/**
 * #137 — the usage a successful turn is metered on.
 *
 * Provider-reported usage, exactly as reported (cache reads/writes included),
 * whenever there is any. Only when the provider reported NOTHING — an
 * OpenAI-compatible runtime that ignores `stream_options.include_usage`, a
 * response without a `usage` block — is the turn metered on an ESTIMATE:
 *
 *   • input  = the pre-send prompt estimate `prepareTurn` already made
 *              (calibrated → catalog → default chars-per-token, #137);
 *   • output = the reply's characters at the same ratio;
 *   • no cache tokens (nothing is known about them).
 *
 * Without this such a turn metered zero in both usage stores, so the project
 * budget never saw it. The per-user row is marked
 * {@link ESTIMATED_TURN_AGENT_STEP} (the usage page groups by it); the
 * transcript row keeps its usage columns empty — they hold only what a
 * provider reported, and calibration must never learn from an estimate.
 */
export function billableTurnUsage(
  reported: TokenUsage | null | undefined,
  basis: { promptTokens: number; answerText: string; ratio: TokenRatio },
): { usage: TokenUsage; estimated: boolean } {
  if (isReportedUsage(reported)) return { usage: reported, estimated: false };
  const promptTokens = Math.max(0, Math.round(basis.promptTokens));
  const completionTokens = estimateTextTokens(basis.answerText, basis.ratio);
  return {
    usage: {
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    },
    estimated: true,
  };
}

export interface TurnUsageScope {
  sessionId: string;
  userId: string;
  projectId: string | null;
  provider: ProviderKey;
  /** The requested model — what the transcript and calibration key on. */
  model: string;
}

export class TurnUsageMeter {
  private spent: TokenUsage | null = null;
  private perUserRecorded = false;
  private projectRecorded = false;

  constructor(private readonly scope: TurnUsageScope) {}

  /** What this turn has spent so far (`null` until a model call reported usage). */
  get usage(): TokenUsage | null {
    return this.spent;
  }

  /** One more model call of this turn returned and reported `u`. */
  add(u: TokenUsage): void {
    const s = this.spent ?? { promptTokens: 0, completionTokens: 0, totalTokens: 0 };
    this.spent = {
      promptTokens: s.promptTokens + (u.promptTokens ?? 0),
      completionTokens: s.completionTokens + (u.completionTokens ?? 0),
      totalTokens: s.totalTokens + (u.totalTokens ?? 0),
      cacheReadTokens: (s.cacheReadTokens ?? 0) + (u.cacheReadTokens ?? 0),
      cacheWriteTokens: (s.cacheWriteTokens ?? 0) + (u.cacheWriteTokens ?? 0),
    };
  }

  /** A single-call turn's provider reported its (whole) usage. */
  set(u: TokenUsage): void {
    this.spent = { ...u };
  }

  /** The success path wrote the per-user `AITokenUsage` row. */
  markPerUserRecorded(): void {
    this.perUserRecorded = true;
  }

  /** The success path wrote the per-project `TokenUsage` row. */
  markProjectRecorded(): void {
    this.projectRecorded = true;
  }

  /**
   * The turn failed: meter what it already spent in every store the success
   * path did not reach. Never throws — the caller is already reporting the
   * original failure.
   */
  recordFailedTurn(): void {
    const u = this.spent;
    // Nothing reported, nothing metered. (Both stores also drop an all-zero row.)
    if (!u) return;
    const { sessionId, userId, projectId, provider, model } = this.scope;
    if (!this.perUserRecorded) {
      this.perUserRecorded = true;
      try {
        getTokenTracker().record({
          sessionId,
          userId,
          provider,
          model,
          usage: {
            ...u,
            cacheReadTokens: u.cacheReadTokens ?? 0,
            cacheWriteTokens: u.cacheWriteTokens ?? 0,
          },
          agentStep: FAILED_TURN_AGENT_STEP,
          ...(projectId ? { projectId } : {}),
        });
      } catch (err) {
        log.error("Failed to meter a failed chat turn (per-user usage)", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (projectId && !this.projectRecorded) {
      this.projectRecorded = true;
      try {
        recordProjectUsage({
          projectId,
          sessionId,
          userId,
          agentStep: FAILED_TURN_AGENT_STEP,
          provider,
          model,
          inputTokens: u.promptTokens,
          outputTokens: u.completionTokens,
          cacheReadTokens: u.cacheReadTokens,
          cacheWriteTokens: u.cacheWriteTokens,
        });
      } catch (err) {
        log.error("Failed to meter a failed chat turn (project usage)", {
          sessionId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
}
