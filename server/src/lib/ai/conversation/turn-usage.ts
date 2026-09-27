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

const log = createChildLogger("chat-turn-usage");

/** `agentStep` on the per-user row of a turn that failed after spending tokens. */
export const FAILED_TURN_AGENT_STEP = "chat-failed";

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
