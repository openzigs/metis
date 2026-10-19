/**
 * #1209 — stop retrying dropped connections once they keep dropping.
 *
 * A section draft whose stream drops part-way through the reply is retried
 * (#1174, up to `MID_STREAM_DROP_ATTEMPTS` tries at full prompt cost). A proxy
 * that always cuts long streams — a maximum duration or body size — makes EVERY
 * section drop on every try, so the run paid three times per section before
 * failing each one. The run's cost ceiling bounded the total; nothing stopped
 * it early.
 *
 * One breaker per document run: once {@link DropRetryBreaker.limit} section
 * drafts have used up their retries on drops, every later draft in that run is
 * tried once, and the run's provenance records why
 * (`generation.dropRetries`).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getConfigService, type ConfigService } from "../config/config-service.js";

/** Registry key: how many sections may use up their drop retries before a run stops retrying drops. */
export const DROP_RETRY_SECTION_LIMIT_KEY = "DOCS_GEN_DROP_RETRY_SECTION_LIMIT";
/** Two: one exhausted section is bad luck; two in one run is the proxy. */
export const DEFAULT_DROP_RETRY_SECTION_LIMIT = 2;

/** The configured limit. A missing, non-numeric or negative value is the default; `0` never stops retrying. */
export function resolveDropRetrySectionLimit(config: ConfigService = getConfigService()): number {
  const raw = config.getNumber(DROP_RETRY_SECTION_LIMIT_KEY, DEFAULT_DROP_RETRY_SECTION_LIMIT);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : DEFAULT_DROP_RETRY_SECTION_LIMIT;
}

/** What the run's provenance records once its breaker has tripped. */
export interface DropRetriesRecord {
  reason: "repeated-connection-drops";
  /** The configured limit it tripped at. */
  limit: number;
  /** Section drafts that used up every retry on a dropped connection in this run. */
  exhaustedSections: number;
}

/** One run's count of sections that used up their drop retries. */
export class DropRetryBreaker {
  // Counted by SECTION: a batched section drafts each batch separately (and in
  // parallel), so two dropped batches of one section are one section, not two.
  private readonly exhausted = new Set<string>();

  constructor(readonly limit: number = DEFAULT_DROP_RETRY_SECTION_LIMIT) {}

  /** True once later drafts in this run should be tried only once. */
  get tripped(): boolean {
    return this.limit > 0 && this.exhausted.size >= this.limit;
  }

  /** A draft of section `sectionId` used up every retry on a dropped connection. */
  noteExhausted(sectionId: string): void {
    this.exhausted.add(sectionId);
  }

  /** The provenance record, once tripped; `undefined` while retries continue. */
  record(): DropRetriesRecord | undefined {
    return this.tripped
      ? {
          reason: "repeated-connection-drops",
          limit: this.limit,
          exhaustedSections: this.exhausted.size,
        }
      : undefined;
  }
}

const store = new AsyncLocalStorage<DropRetryBreaker>();

/** Run `fn` (one document's section synthesis) with `breaker` as its run's breaker. */
export function withDropRetryBreaker<T>(breaker: DropRetryBreaker, fn: () => T): T {
  return store.run(breaker, fn);
}

/** The current run's breaker, if any. */
export function currentDropRetryBreaker(): DropRetryBreaker | undefined {
  return store.getStore();
}
