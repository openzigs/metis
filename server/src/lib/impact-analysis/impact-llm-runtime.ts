/**
 * Issues #1021 + #1024 — the one place every impact-analysis LLM stage passes
 * through on its way to a provider.
 *
 * Both issues exist because the six LLM stages talk to `AIProvider.chat()`
 * directly and nothing sat between them and the wire:
 *
 *   - **#1021 (metering).** Nothing in the impact pipeline ever called
 *     `TokenTracker.record()`, so its provider calls wrote **zero** rows to
 *     `ai_token_usages`. That is not under-counting, it is absence: the most
 *     LLM-intensive feature in the product was invisible to cost attribution.
 *     Providers do not self-meter — every other metered caller
 *     (`discussions/ai-responder.ts`, `testcoverage/judge.ts`) records at the
 *     call site — and the impact stages simply never did.
 *
 *   - **#1024 (degradation).** Every stage already degrades to the
 *     deterministic result on a provider error, but nothing bounded the call.
 *     A provider that accepts the connection and then hangs would hang
 *     `executeImpactAnalysis`, leaving the run stuck in `running` forever, and
 *     nothing told the analyst that the AI enrichment they were expecting had
 *     silently not happened.
 *
 * The decorator returned by {@link ImpactLlmRuntime.instrument} therefore does
 * three things and nothing else:
 *
 *   1. **Meters** every completed call into `AITokenUsage` with `projectId`
 *      (from the {@link runInImpactProjectScope} scope the engine publishes)
 *      and a per-stage `agentStep`, so spend is attributable per project AND
 *      per stage.
 *   2. **Bounds** every call with a hard deadline (`IMPACT_LLM_TIMEOUT_MS`,
 *      default 60s). The deadline both aborts the underlying request and races
 *      it, so even a provider that ignores `AbortSignal` cannot hang the run.
 *   3. **Records** what degraded, so the run can tell the analyst honestly
 *      (`degradationNotice`) and the operator loudly (a WARN per failure).
 *
 * Nothing here changes a stage's output. A metering or session-creation fault
 * is swallowed with a warning: accounting must never sink an analysis. A
 * timeout, by contrast, is deliberately propagated as a rejection — the stage's
 * own `catch` turns it into the deterministic passthrough, which is exactly the
 * #1024 contract.
 */
import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";
import { getTokenTracker } from "../ai/token-tracker.js";
import type { AIProvider, ChatMessage, ChatOptions, ChatResponse } from "../ai/types.js";
import { currentImpactProjectId } from "./impact-llm-scope.js";

const log = createChildLogger("impact-llm-runtime");

/** The LLM stages of an impact run. One `agentStep` label each. */
export type ImpactLlmStage =
  | "seeding"
  | "entity-seeds"
  | "table-filter"
  | "additive-ddl"
  | "table-judge"
  | "clause-reconcile"
  | "summary-item"
  | "summary-run";

/** Every stage, in pipeline order. Used to keep the notice's wording stable. */
export const IMPACT_LLM_STAGES: readonly ImpactLlmStage[] = [
  "seeding",
  "entity-seeds",
  "table-filter",
  "additive-ddl",
  "table-judge",
  "clause-reconcile",
  "summary-item",
  "summary-run",
] as const;

/**
 * `AITokenUsage.agentStep` value per stage. Prefixed `impact.` so a spend query
 * can isolate the whole feature (`agentStep LIKE 'impact.%'`) or one stage.
 */
export const IMPACT_LLM_AGENT_STEP: Record<ImpactLlmStage, string> = {
  seeding: "impact.seeding",
  "entity-seeds": "impact.entity-seeds",
  "table-filter": "impact.table-filter",
  "additive-ddl": "impact.additive-ddl",
  "table-judge": "impact.table-judge",
  "clause-reconcile": "impact.clause-reconcile",
  "summary-item": "impact.summary-item",
  "summary-run": "impact.summary-run",
};

/** BA-readable stage names used in the user-visible degradation notice. */
const STAGE_LABEL: Record<ImpactLlmStage, string> = {
  seeding: "requirement-to-code seeding",
  "entity-seeds": "entity seed recall",
  "table-filter": "table relevance filtering",
  "additive-ddl": "additive-column proposals",
  "table-judge": "column-informed table recovery",
  "clause-reconcile": "clause coverage advisories",
  "summary-item": "narrative summaries",
  "summary-run": "narrative summaries",
};

/** Why a stage never got to make a call. */
export type ImpactStageUnavailableReason =
  | "no-provider"
  | "provider-offline"
  | "provider-build-failed";

export interface ImpactLlmStageSnapshot {
  stage: ImpactLlmStage;
  /** Calls that returned a response. */
  calls: number;
  /** Calls that rejected for a non-timeout reason. */
  failures: number;
  /** Calls killed by the {@link impactLlmTimeoutMs} deadline. */
  timeouts: number;
  /** Set when the stage was requested but no usable provider existed. */
  unavailableReason: ImpactStageUnavailableReason | null;
}

export interface ImpactLlmRuntime {
  /** Wrap `provider` so `stage`'s calls are metered, bounded and observed. */
  instrument(provider: AIProvider, stage: ImpactLlmStage): AIProvider;
  /** Record that `stage` was enabled but could not be wired to a live provider. */
  markUnavailable(stage: ImpactLlmStage, reason: ImpactStageUnavailableReason): void;
  /** Per-stage counters — for logging and tests. */
  snapshot(): ImpactLlmStageSnapshot[];
  /**
   * A single honest sentence for the analyst when AI enrichment was requested
   * but did not produce anything, or `null` when there is nothing to disclose.
   */
  degradationNotice(): string | null;
  /** Await every in-flight metering write. Test/shutdown helper. */
  flush(): Promise<void>;
}

/** Default hard deadline for ONE impact LLM call. */
export const DEFAULT_IMPACT_LLM_TIMEOUT_MS = 60_000;

/**
 * Per-call deadline, from `IMPACT_LLM_TIMEOUT_MS`. A non-numeric or
 * non-positive value falls back to the default rather than disabling the
 * bound — an unbounded impact LLM call is the #1024 stuck-in-`running` bug, so
 * there is deliberately no "off" setting.
 */
export function impactLlmTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = Number(env.IMPACT_LLM_TIMEOUT_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_IMPACT_LLM_TIMEOUT_MS;
}

/** Thrown when a stage's call blows the deadline. Stages catch it and degrade. */
export class ImpactLlmTimeoutError extends Error {
  constructor(
    readonly stage: ImpactLlmStage,
    readonly timeoutMs: number,
  ) {
    super(`impact LLM stage "${stage}" exceeded ${timeoutMs}ms and was abandoned`);
    this.name = "ImpactLlmTimeoutError";
  }
}

type TokenRecorder = Pick<ReturnType<typeof getTokenTracker>, "record">;

export interface ImpactLlmRuntimeOptions {
  /** The user the run is billed to (`AITokenUsage.userId`, a real `User` id). */
  actorId: string;
  /** Projects in the run. The first scopes the backing `AISession`. */
  projectIds: readonly string[];
  /** Per-call deadline override (tests). */
  timeoutMs?: number;
  /** Token recorder seam (tests). */
  tracker?: TokenRecorder;
  /**
   * Backing-session factory seam. Returns the `AISession` id to hang usage rows
   * off, or `null` when one cannot be created (usage is then skipped, loudly).
   */
  createSession?: (input: {
    actorId: string;
    projectId: string | null;
    provider: string;
    model: string;
  }) => Promise<string | null>;
}

function defaultCreateSession(input: {
  actorId: string;
  projectId: string | null;
  provider: string;
  model: string;
}): Promise<string | null> {
  return defaultPrisma.aISession
    .create({
      data: {
        userId: input.actorId,
        projectId: input.projectId,
        title: "Impact analysis",
        provider: input.provider,
        model: input.model,
      },
    })
    .then((s: { id: string }) => s.id);
}

/**
 * Build the per-run LLM runtime. One instance per impact-analysis run: it owns
 * exactly one lazily-created backing `AISession` (no LLM call ⇒ no session row)
 * and the run's degradation ledger.
 */
export function createImpactLlmRuntime(opts: ImpactLlmRuntimeOptions): ImpactLlmRuntime {
  const timeoutMs = opts.timeoutMs ?? impactLlmTimeoutMs();
  const tracker = opts.tracker ?? getTokenTracker();
  const createSession = opts.createSession ?? defaultCreateSession;
  const fallbackProjectId = opts.projectIds[0] ?? null;

  const stats = new Map<ImpactLlmStage, ImpactLlmStageSnapshot>();
  const statsFor = (stage: ImpactLlmStage): ImpactLlmStageSnapshot => {
    let s = stats.get(stage);
    if (!s) {
      s = { stage, calls: 0, failures: 0, timeouts: 0, unavailableReason: null };
      stats.set(stage, s);
    }
    return s;
  };

  const inflight = new Set<Promise<void>>();
  let sessionPromise: Promise<string | null> | null = null;

  const ensureSession = (provider: string, model: string): Promise<string | null> => {
    if (!sessionPromise) {
      sessionPromise = createSession({
        actorId: opts.actorId,
        projectId: fallbackProjectId,
        provider,
        model,
      }).catch((err: unknown) => {
        // No session ⇒ no FK target ⇒ no usage rows. Say so once, loudly: an
        // operator reading "unmetered" needs the reason, not silence.
        log.error("impact LLM usage session could not be created; calls stay unmetered", {
          error: String(err),
        });
        return null;
      });
    }
    return sessionPromise;
  };

  const meter = (stage: ImpactLlmStage, fallback: AIProvider, res: ChatResponse): void => {
    const usage = res.usage;
    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const total = usage?.totalTokens ?? promptTokens + completionTokens;
    // A provider that reports nothing (offline stub, fixture replay) has no
    // spend to attribute; `record()` would drop it anyway.
    if (total <= 0) return;

    const providerKey = res.provider ?? fallback.key;
    const model = res.model || fallback.model;
    const projectId = currentImpactProjectId() ?? fallbackProjectId;

    const task = (async () => {
      const sessionId = await ensureSession(providerKey, model);
      if (!sessionId) return;
      tracker.record({
        sessionId,
        userId: opts.actorId,
        provider: providerKey,
        model,
        usage,
        ...(projectId ? { projectId } : {}),
        agentStep: IMPACT_LLM_AGENT_STEP[stage],
      });
    })().catch((err: unknown) => {
      log.warn("impact LLM usage recording failed", { stage, error: String(err) });
    });
    inflight.add(task);
    void task.finally(() => inflight.delete(task));
  };

  /**
   * Run `call` under a hard deadline. The deadline BOTH aborts (for providers
   * that honour `AbortSignal`) AND races (for providers that do not), because
   * "the analysis never completes" is a worse failure than "one abandoned
   * request keeps a socket open until the process reclaims it".
   */
  const withDeadline = async <T>(
    stage: ImpactLlmStage,
    callerSignal: AbortSignal | undefined,
    call: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> => {
    const controller = new AbortController();
    let timedOut = false;
    const onCallerAbort = () => controller.abort();
    callerSignal?.addEventListener("abort", onCallerAbort, { once: true });

    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
        reject(new ImpactLlmTimeoutError(stage, timeoutMs));
      }, timeoutMs);
      timer.unref?.();
    });

    try {
      return await Promise.race([call(controller.signal), deadline]);
    } catch (err) {
      const s = statsFor(stage);
      if (timedOut) {
        s.timeouts += 1;
        log.warn("impact LLM stage timed out; degrading to the deterministic result", {
          stage,
          timeoutMs,
        });
        throw new ImpactLlmTimeoutError(stage, timeoutMs);
      }
      s.failures += 1;
      log.warn("impact LLM stage call failed; degrading to the deterministic result", {
        stage,
        error: String(err),
      });
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
      callerSignal?.removeEventListener("abort", onCallerAbort);
    }
  };

  const instrument = (provider: AIProvider, stage: ImpactLlmStage): AIProvider => {
    const wrapped: AIProvider = {
      key: provider.key,
      model: provider.model,
      offline: provider.offline,
      async chat(messages: ChatMessage[], chatOpts?: ChatOptions): Promise<ChatResponse> {
        const res = await withDeadline(stage, chatOpts?.signal, (signal) =>
          provider.chat(messages, { ...chatOpts, signal }),
        );
        statsFor(stage).calls += 1;
        meter(stage, provider, res);
        return res;
      },
      // Metered too: no stage streams today, but an unmetered `stream()` is the
      // exact hole #1021 asks us to close for whatever is added next. The #1024
      // deadline is NOT applied here — a stream's total duration is legitimately
      // unbounded, and a per-token bound is a different mechanism. Any stage that
      // starts streaming must bring its own idle timeout.
      async *stream(messages: ChatMessage[], chatOpts?: ChatOptions) {
        let sawUsage = false;
        for await (const chunk of provider.stream(messages, chatOpts)) {
          if (chunk.type === "usage") {
            sawUsage = true;
            statsFor(stage).calls += 1;
            meter(stage, provider, {
              content: "",
              usage: chunk.usage,
              model: provider.model,
              provider: provider.key,
            });
          }
          yield chunk;
        }
        if (!sawUsage) {
          log.debug("impact LLM stream produced no usage chunk; nothing metered", { stage });
        }
      },
      embed: (texts: string[]) => provider.embed(texts),
      models: () => provider.models(),
      ping: () => provider.ping(),
    };
    return wrapped;
  };

  return {
    instrument,
    markUnavailable(stage, reason) {
      statsFor(stage).unavailableReason = reason;
      log.warn("impact LLM stage enabled but no usable provider; skipping", { stage, reason });
    },
    snapshot: () => IMPACT_LLM_STAGES.filter((s) => stats.has(s)).map((s) => ({ ...statsFor(s) })),
    degradationNotice: () => buildDegradationNotice(stats),
    async flush() {
      while (inflight.size > 0) {
        await Promise.allSettled([...inflight]);
      }
    },
  };
}

/**
 * The analyst-facing disclosure. #1024 requires that a BA is never shown a
 * filtered-looking result that was never filtered, so the notice names the
 * stages that produced nothing and states plainly that what they are reading is
 * the deterministic baseline.
 *
 * A stage that made at least one successful call is NOT named, even if a later
 * call failed: it contributed real output and the result is not wholly
 * un-enriched. A stage that was simply switched off is never named either —
 * that is a configured choice, not a degradation.
 */
function buildDegradationNotice(stats: Map<ImpactLlmStage, ImpactLlmStageSnapshot>): string | null {
  const degraded = IMPACT_LLM_STAGES.map((s) => stats.get(s)).filter(
    (s): s is ImpactLlmStageSnapshot =>
      !!s && s.calls === 0 && (s.unavailableReason !== null || s.failures + s.timeouts > 0),
  );
  if (degraded.length === 0) return null;

  const anyUnavailable = degraded.some((s) => s.unavailableReason !== null);
  const anyTimeout = degraded.some((s) => s.timeouts > 0);
  const anyFailure = degraded.some((s) => s.failures > 0);

  let reason: string;
  if (anyUnavailable && !anyTimeout && !anyFailure) {
    reason = "no AI provider is configured";
  } else if (anyTimeout && !anyFailure && !anyUnavailable) {
    reason = "the AI provider timed out";
  } else if (anyFailure && !anyTimeout && !anyUnavailable) {
    reason = "the AI provider returned an error";
  } else {
    reason = "the AI provider was unavailable";
  }

  // #1033 — `summary-item` and `summary-run` share the "narrative summaries" BA
  // label; dedupe so a run that degraded both never lists it twice.
  const labels = [...new Set(degraded.map((s) => STAGE_LABEL[s.stage]))].join(", ");
  return (
    `AI enrichment did not run for this analysis (${reason}). ` +
    `These results are the deterministic code-graph and schema baseline. ` +
    `Not applied: ${labels}.`
  );
}
