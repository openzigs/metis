/**
 * #2335 — request an incremental refresh of a repository connector without
 * holding the caller: the push webhook (and the signed CI / git-hook call to
 * the same receiver) answers at once, and the work runs off the request.
 *
 * - Idle connector: the refresh starts now, in the background (`started`).
 * - Busy connector (a Sync, Deep Ingest, scheduled refresh or an earlier push
 *   holds its ingest lease): the request folds into the connector's single
 *   "re-run when done" marker (`queued`), however many arrive during the run;
 *   `ingest-guard.ts` hands the one follow-up its lease when the run ends.
 *
 * Every follow-up runs through {@link installRepoRefreshRerunRunner}'s runner.
 * A follow-up a manual Sync asked for (`manual`) runs the Sync route's own body
 * (`repo-sync.ts`: discovery and its notification, and a metadata failure is
 * not fatal); a push or scheduled one runs the shared unattended refresh in
 * `repo-refresh.ts`, the work the scheduled task always did.
 *
 * Runs started here are tracked and tied to one shutdown signal
 * ({@link stopRepoConnectorRefreshes}, called from the server's shutdown).
 *
 * A requested commit SHA is recorded on the run and in its logs; it is never
 * handed to git. The refresh pulls the connector's own configured branch, whose
 * head is at or after the newest requested commit.
 *
 * Also here: the request limiter the push receiver checks right after the
 * signature verifies and before any claim write or connector lookup, so a push
 * storm on one repository cannot fill the receiver with lookups and claims
 * (OWASP A04). The queue already bounds the work itself to one run plus one
 * follow-up.
 */
import { createChildLogger } from "../../logger.js";
import {
  acquireOrQueueConnectorIngest,
  setIngestRerunRunner,
  type ConnectorIngestLease,
  type IngestTrigger,
  type QueuedIngestRerun,
} from "../ingest-guard.js";
import { runRepoConnectorRefresh } from "./repo-refresh.js";
import { runQueuedRepoConnectorSync } from "./repo-sync.js";

const log = createChildLogger("repo-refresh-trigger");

export interface RepoRefreshRequest {
  trigger: IngestTrigger;
  /** A validated 40- or 64-hex commit SHA, or null. */
  commitSha?: string | null;
}

export type RepoRefreshOutcome =
  | { status: "started"; trigger: IngestTrigger; commitSha: string | null }
  | {
      status: "queued";
      trigger: IngestTrigger;
      commitSha: string | null;
      /** Requests folded into the one queued re-run so far. */
      requests: number;
    };

/** Aborted once, when the server shuts down; every background run watches it. */
let shutdown = new AbortController();
/** Background runs in flight, so shutdown can wait for them to stop. */
const inFlight = new Set<Promise<void>>();

/** Run one refresh holding `lease` (released by the refresh), off the caller's tick. */
function startRefresh(lease: ConnectorIngestLease, run: QueuedIngestRerun): void {
  const connectorId = lease.connectorId;
  log.info("connector.refresh.start", {
    connectorId,
    trigger: run.trigger,
    requestedCommitSha: run.commitSha,
    requests: run.requests,
  });
  const work: Promise<{ headSha?: unknown; filesChanged?: unknown }> =
    run.trigger === "manual"
      ? runQueuedRepoConnectorSync(connectorId, lease, shutdown.signal)
      : runRepoConnectorRefresh(connectorId, lease, shutdown.signal);
  const tracked: Promise<void> = work
    .then((result) => {
      log.info("connector.refresh.done", {
        connectorId,
        trigger: run.trigger,
        requestedCommitSha: run.commitSha,
        headSha: result.headSha ?? null,
        filesChanged: result.filesChanged ?? null,
      });
    })
    .catch((err: unknown) => {
      // A failed run queues nothing of its own: only a request made while it
      // ran is followed up, so a failure never loops.
      log.warn("connector.refresh.failed", {
        connectorId,
        trigger: run.trigger,
        requestedCommitSha: run.commitSha,
        error: err instanceof Error ? err.message : String(err),
      });
    })
    .finally(() => {
      inFlight.delete(tracked);
    });
  inFlight.add(tracked);
}

/**
 * Server shutdown: abort every background refresh (each stops at its next
 * step boundary and releases its lease; a follow-up that then starts sees the
 * aborted signal and stops at once) and wait up to `timeoutMs` for them.
 */
export async function stopRepoConnectorRefreshes(timeoutMs = 5_000): Promise<void> {
  shutdown.abort();
  if (inFlight.size === 0) return;
  let timer: NodeJS.Timeout | undefined;
  await Promise.race([
    Promise.allSettled([...inFlight]),
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
    }),
  ]);
  if (timer) clearTimeout(timer);
}

/** Test-only: background runs in flight, and a fresh shutdown signal. */
export function __repoRefreshesInFlight(): number {
  return inFlight.size;
}
export function __resetRepoRefreshShutdown(): void {
  shutdown = new AbortController();
}

/** Start the connector's refresh now, or queue its one follow-up when a run holds it. */
export function requestRepoConnectorRefresh(
  connectorId: string,
  request: RepoRefreshRequest,
): RepoRefreshOutcome {
  const commitSha = request.commitSha ?? null;
  const claim = acquireOrQueueConnectorIngest(connectorId, `refresh:${request.trigger}`, {
    trigger: request.trigger,
    commitSha,
  });
  if ("queued" in claim) {
    log.info("connector.refresh.queued", {
      connectorId,
      trigger: request.trigger,
      requestedCommitSha: commitSha,
      requests: claim.queued.requests,
    });
    return {
      status: "queued",
      // The follow-up's trigger: a folded-in manual Sync keeps it `manual`.
      trigger: claim.queued.trigger,
      commitSha: claim.queued.commitSha,
      requests: claim.queued.requests,
    };
  }
  startRefresh(claim.lease, {
    trigger: request.trigger,
    commitSha,
    requests: 1,
    requestedAt: Date.now(),
  });
  return { status: "started", trigger: request.trigger, commitSha };
}

/** Called once at boot: every queued follow-up runs the shared unattended refresh. */
export function installRepoRefreshRerunRunner(): void {
  setIngestRerunRunner(startRefresh);
}

// ── Request limit ────────────────────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 20;
/** Sweep expired windows once the map holds this many keys; never hold more. */
const SWEEP_AT = 1000;

const windows = new Map<string, { start: number; count: number }>();

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * True when `key` may make another refresh request in the current window:
 * `REPO_REFRESH_REQUEST_LIMIT_MAX` (default 20) per
 * `REPO_REFRESH_REQUEST_LIMIT_WINDOW_MS` (default 60 s).
 *
 * The push receiver checks it as soon as the signature has verified and the
 * signed body parsed, before any claim write or connector lookup. Its key is
 * the connector id for a connector-signed delivery (the id the HMAC verified
 * against) and the delivery's host and `owner/name` for a deployment-signed
 * one: a connector has one repository, so either way one connector's requests
 * share one budget. Keys come only from verified deliveries, and the map is
 * capped at {@link SWEEP_AT} keys: expired windows are swept first, then the
 * oldest window goes.
 */
export function allowRepoRefreshRequest(key: string, now: number = Date.now()): boolean {
  const windowMs = positiveEnv("REPO_REFRESH_REQUEST_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS);
  const max = positiveEnv("REPO_REFRESH_REQUEST_LIMIT_MAX", DEFAULT_MAX);
  const w = windows.get(key);
  if (w && now - w.start < windowMs) {
    if (w.count >= max) return false;
    w.count += 1;
    return true;
  }
  if (!w && windows.size >= SWEEP_AT) {
    for (const [k, old] of windows) if (now - old.start >= windowMs) windows.delete(k);
    // Still full of live windows: drop the oldest (Map keeps insertion order).
    if (windows.size >= SWEEP_AT) {
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
  }
  windows.delete(key);
  windows.set(key, { start: now, count: 1 });
  return true;
}

/** Test-only: forget every window. */
export function __resetRepoRefreshRateLimit(): void {
  windows.clear();
}

/** Test-only: how many windows the limiter holds. */
export function __repoRefreshRateLimitSize(): number {
  return windows.size;
}
