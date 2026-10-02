/**
 * Issue #724 — analysis-family LLM spend is recorded as PROJECT usage.
 *
 * Project usage (`token_usages`, read by `summarizeUsage` → `usage-summary`,
 * the monthly budget and Settings → Usage & cost) is written only through
 * finops `recordUsage`. Nothing under `lib/analysis/` called it, so a 207k-token
 * analysis left the project's usage, budget and cost at zero. The analysis kept
 * its own `Analysis.totalTokens`, which only the cost-cap widget reads.
 *
 * The analysis family makes its model calls from dozens of call sites (agents,
 * synthesis, verification, faithfulness, clarify, regenerate, deep dive, the
 * custom-agent phase and playground invoke), and most of them never see a
 * `projectId`. Metering each one would leave the next call site unmetered by
 * default — the same class as #180, #243 and #718. So, as impact analysis does
 * for #1021 (`impact-llm-scope.ts`), the meter sits on the PROVIDER:
 *
 *   - {@link meterAnalysisProvider} decorates an `AIProvider` so every
 *     completed `chat()` and every `stream()` usage chunk is recorded; and
 *   - {@link runInAnalysisUsageScope} publishes which project (and which
 *     session — the analysis id, which is also the replay `AgentRun.sessionId`
 *     the /runs cost reads) a call belongs to, in an `AsyncLocalStorage` scope
 *     that is correct across `await` and under concurrent runs.
 *
 * A metered provider called OUTSIDE a scope records nothing: the orchestrator's
 * provider is reachable from places that are not analysis spend, and an
 * unattributable call has no project to bill.
 *
 * Accounting must never sink a run: `recordUsage` persists on a microtask and
 * swallows its own write errors, and anything it throws synchronously is
 * logged here and dropped.
 *
 * Because that write is asynchronous, a run that reads its own spend back
 * (`computeRunCost` over `token_usages`) must first await
 * {@link flushAnalysisUsage} — otherwise the last calls' rows may not have
 * landed yet and the run's cost comes out low.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { recordUsage } from "../finops/token-tracker.js";
import { createChildLogger } from "../logger.js";
import type { AIProvider, ChatChunk, ChatMessage, ChatOptions, TokenUsage } from "../ai/types.js";

const log = createChildLogger("analysis-usage");

/** Who an analysis-family model call is billed to. */
export interface AnalysisUsageScope {
  readonly projectId: string;
  /** The analysis id for run-scoped calls; `playground:<agentId>:<projectId>` for a playground invoke. */
  readonly sessionId: string;
}

const storage = new AsyncLocalStorage<AnalysisUsageScope>();

/** Run `fn` with every metered model call it makes billed to `scope`. */
export function runInAnalysisUsageScope<T>(scope: AnalysisUsageScope, fn: () => T): T {
  return storage.run(scope, fn);
}

/** The scope the current async flow bills to, or `null` outside one. */
export function currentAnalysisUsageScope(): AnalysisUsageScope | null {
  return storage.getStore() ?? null;
}

const METERED = Symbol.for("metis.analysisUsageMetered");

/** In-flight `token_usages` writes, keyed by the scope's session id. */
const inFlight = new Map<string, Set<Promise<void>>>();

function track(sessionId: string, persisted: Promise<void>): void {
  let writes = inFlight.get(sessionId);
  if (!writes) {
    writes = new Set();
    inFlight.set(sessionId, writes);
  }
  const settled = persisted
    .catch((err: unknown) => {
      log.warn("analysis usage write failed", { sessionId, error: (err as Error).message });
    })
    .finally(() => {
      writes.delete(settled);
      if (writes.size === 0 && inFlight.get(sessionId) === writes) inFlight.delete(sessionId);
    });
  writes.add(settled);
}

/**
 * Wait until every usage write recorded so far has settled — for `sessionId`
 * only, or for every session when omitted. Never rejects: a failed write was
 * already logged, and accounting must not fail the caller.
 */
export async function flushAnalysisUsage(sessionId?: string): Promise<void> {
  for (;;) {
    const writes =
      sessionId === undefined
        ? [...inFlight.values()].flatMap((set) => [...set])
        : [...(inFlight.get(sessionId) ?? [])];
    if (writes.length === 0) return;
    await Promise.all(writes);
  }
}

function record(provider: string, model: string, usage: TokenUsage | undefined): void {
  const scope = storage.getStore();
  if (!scope || !usage) return;
  try {
    const result = recordUsage({
      projectId: scope.projectId,
      sessionId: scope.sessionId,
      provider,
      model,
      inputTokens: usage.promptTokens,
      outputTokens: usage.completionTokens,
      cacheReadTokens: usage.cacheReadTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
    });
    // `persisted` is absent only where `recordUsage` is test-mocked.
    if (result?.persisted) track(scope.sessionId, result.persisted);
  } catch (err) {
    log.warn("analysis usage could not be recorded", {
      projectId: scope.projectId,
      error: (err as Error).message,
    });
  }
}

/**
 * Decorate `provider` so its model calls are recorded against the active
 * {@link runInAnalysisUsageScope} scope. Idempotent: an already-metered
 * provider is returned as-is, so a call is never recorded twice.
 *
 * A `Proxy`, not a hand-built object: every other member — `capabilities`,
 * `capabilitiesFor`, `servesRouterModel`, `embed`, `instanceof` — must reach
 * the wrapped adapter unchanged, or capability resolution silently degrades
 * to "supports nothing" for the whole analysis.
 */
export function meterAnalysisProvider(provider: AIProvider): AIProvider {
  if ((provider as unknown as Record<symbol, unknown>)[METERED]) return provider;

  const chat = async (messages: ChatMessage[], opts?: ChatOptions) => {
    const res = await provider.chat(messages, opts);
    record(res.provider ?? provider.key, res.model ?? opts?.model ?? provider.model, res.usage);
    return res;
  };

  async function* stream(messages: ChatMessage[], opts?: ChatOptions): AsyncGenerator<ChatChunk> {
    for await (const chunk of provider.stream(messages, opts)) {
      // The model the stream reports it ran, as `chat()` prices `res.model`;
      // the requested model only when the adapter does not say.
      if (chunk.type === "usage") {
        record(provider.key, chunk.model ?? opts?.model ?? provider.model, chunk.usage);
      }
      yield chunk;
    }
  }

  return new Proxy(provider, {
    get(target, prop) {
      if (prop === METERED) return true;
      if (prop === "chat") return chat;
      if (prop === "stream") return stream;
      const value: unknown = Reflect.get(target, prop, target);
      // Bind to the adapter so an internal `this.chat()` is not metered twice.
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
