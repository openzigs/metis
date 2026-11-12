/**
 * Issue #217 — one repository ingest per connector at a time.
 *
 * A connector's source ingest can be started from the sync routes
 * (`/deep-ingest`, `/refresh-ingest`, create-with-autoIngest), the scheduled
 * `refresh-repo-connector` task and the docs-gen eval runner. Two runs on one
 * connector interleave their `repo_connections.sourceIngestState` writes (the
 * last writer wins with counts from a different run) and race each other over
 * the same clone. Every entry point shares this registry:
 *
 *   - an entry point that does work before the source ingest (clone, pull,
 *     code graph) takes a lease up front and passes it to
 *     `ingestSourceAsKnowledge`, so a busy connector is refused before any of it;
 *   - `ingestSourceAsKnowledge` takes the lease itself when it is not handed
 *     one, so a caller that forgets is still guarded (the eval runner relies on
 *     this).
 *
 * The registry is per process. METIS runs one API process against its
 * database; a multi-replica deployment would need a database-level claim.
 *
 * #2335 — a sync requested while one runs is not refused but QUEUED: one
 * "re-run when done" marker per connector ({@link acquireOrQueueConnectorIngest}).
 * Any number of requests during one run fold into it (the newest named commit
 * wins). When the running lease is released the marker is consumed and exactly
 * one follow-up run is handed a fresh lease, in the same tick, so nothing can
 * start a parallel run in between. The marker lives where the lease does and
 * follows its rules: per process, gone on restart (the next push, manual sync
 * or schedule recovers), and consumed by the FIRST release only, so a second
 * release of an old lease never fires a second follow-up. A follow-up that
 * fails sets no marker of its own, so a failure never loops: only a request
 * made while the follow-up runs queues another.
 */
import { createChildLogger } from "../logger.js";
import { ConnectorError } from "./types.js";

const log = createChildLogger("ingest-guard");

export const INGEST_IN_PROGRESS = "INGEST_IN_PROGRESS";

export interface ConnectorIngestLease {
  readonly connectorId: string;
  /** Which entry point holds it — for logs only. */
  readonly holder: string;
  /** False once released. */
  readonly held: boolean;
  /** Idempotent: never frees a claim taken after this lease was released. */
  release(): void;
}

const active = new Map<string, ConnectorIngestLease>();

/** #2335 — what asked for a sync: a push (webhook or the signed CI call), a person, the schedule. */
export type IngestTrigger = "push" | "manual" | "scheduled";

/** #2335 — the single "re-run when done" marker of a busy connector. */
export interface QueuedIngestRerun {
  /** The trigger of the most recent request folded into the marker. */
  trigger: IngestTrigger;
  /**
   * The newest commit any folded request named (a request naming none keeps
   * the previous one). Validated by the caller; recorded, never passed to git.
   */
  commitSha: string | null;
  /** How many requests the marker stands for. */
  requests: number;
  /** Epoch ms of the most recent request. */
  requestedAt: number;
}

/** Runs a follow-up holding `lease`, and must release it when done. */
export type IngestRerunRunner = (lease: ConnectorIngestLease, rerun: QueuedIngestRerun) => void;

const queued = new Map<string, QueuedIngestRerun>();
let rerunRunner: IngestRerunRunner | null = null;

/** #2335 — installed once at boot (`installRepoRefreshRerunRunner`); `null` uninstalls (tests). */
export function setIngestRerunRunner(runner: IngestRerunRunner | null): void {
  rerunRunner = runner;
}

/** The connector's queued follow-up, or `null` when none is waiting. */
export function queuedConnectorIngest(connectorId: string): QueuedIngestRerun | null {
  return queued.get(connectorId) ?? null;
}

/**
 * Consume the marker on release: hand exactly one follow-up a fresh lease. The
 * lease is taken in this tick, so no request can slip a second run in.
 */
function dispatchQueuedRerun(connectorId: string): void {
  const rerun = queued.get(connectorId);
  if (!rerun) return;
  queued.delete(connectorId);
  const runner = rerunRunner;
  if (!runner) {
    log.warn("connector.ingest.rerun_dropped", { connectorId, reason: "NO_RERUN_RUNNER" });
    return;
  }
  const lease = tryAcquireConnectorIngest(connectorId, `rerun:${rerun.trigger}`);
  if (!lease) return; // unreachable: the release just freed it, in this tick
  try {
    runner(lease, rerun);
  } catch (err) {
    lease.release();
    log.warn("connector.ingest.rerun_failed_to_start", {
      connectorId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Claim the connector, or `null` when another run holds it. */
export function tryAcquireConnectorIngest(
  connectorId: string,
  holder: string,
): ConnectorIngestLease | null {
  if (active.has(connectorId)) return null;
  let held = true;
  const lease: ConnectorIngestLease = {
    connectorId,
    holder,
    get held() {
      return held;
    },
    release() {
      // A released lease is inert, so a second release never frees a newer holder's claim.
      if (!held) return;
      held = false;
      active.delete(connectorId);
      dispatchQueuedRerun(connectorId);
    },
  };
  active.set(connectorId, lease);
  return lease;
}

/**
 * #2335 — claim the connector, or, when a run holds it, fold this request into
 * its single "re-run when done" marker and return `queued` (never a refusal).
 */
export function acquireOrQueueConnectorIngest(
  connectorId: string,
  holder: string,
  request: { trigger: IngestTrigger; commitSha?: string | null },
): { lease: ConnectorIngestLease } | { queued: QueuedIngestRerun } {
  const lease = tryAcquireConnectorIngest(connectorId, holder);
  if (lease) return { lease };
  const prior = queued.get(connectorId);
  const rerun: QueuedIngestRerun = {
    trigger: request.trigger,
    commitSha: request.commitSha ?? prior?.commitSha ?? null,
    requests: (prior?.requests ?? 0) + 1,
    requestedAt: Date.now(),
  };
  queued.set(connectorId, rerun);
  return { queued: { ...rerun } };
}

/** Claim the connector or throw a 409 `INGEST_IN_PROGRESS` {@link ConnectorError}. */
export function acquireConnectorIngest(connectorId: string, holder: string): ConnectorIngestLease {
  const lease = tryAcquireConnectorIngest(connectorId, holder);
  if (!lease) {
    throw new ConnectorError(
      409,
      INGEST_IN_PROGRESS,
      "An ingest is already running for this connector",
    );
  }
  return lease;
}

export function isConnectorIngestActive(connectorId: string): boolean {
  return active.has(connectorId);
}

/** Which entry point holds the connector's lease, or `null` when it is free. */
export function connectorIngestHolder(connectorId: string): string | null {
  return active.get(connectorId)?.holder ?? null;
}

/** Run `fn` holding the connector's lease; refuse with a 409 when it is busy. */
export async function withConnectorIngest<T>(
  connectorId: string,
  holder: string,
  fn: (lease: ConnectorIngestLease) => Promise<T>,
): Promise<T> {
  const lease = acquireConnectorIngest(connectorId, holder);
  try {
    return await fn(lease);
  } finally {
    lease.release();
  }
}

/** A lease handed in by a caller must be live and for this connector — a programming error otherwise. */
export function assertConnectorIngestLease(lease: ConnectorIngestLease, connectorId: string): void {
  if (!lease.held || lease.connectorId !== connectorId) {
    throw new ConnectorError(
      500,
      "INGEST_LEASE_INVALID",
      "The ingest lease is not held for this connector",
    );
  }
}
