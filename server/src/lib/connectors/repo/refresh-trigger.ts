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
 * Every follow-up, whoever queued it (a push, a manual Sync, the schedule),
 * runs through {@link installRepoRefreshRerunRunner}'s runner: the shared
 * unattended refresh in `repo-refresh.ts`.
 *
 * A requested commit SHA is recorded on the run and in its logs; it is never
 * handed to git. The refresh pulls the connector's own configured branch, whose
 * head is at or after the newest requested commit.
 *
 * Also here: the per-connector request limiter, so a push storm on one
 * repository cannot fill the receiver with lookups and claims (OWASP A04). The
 * queue already bounds the work itself to one run plus one follow-up.
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

/** Run one refresh holding `lease` (released by the refresh), off the caller's tick. */
function startRefresh(lease: ConnectorIngestLease, run: QueuedIngestRerun): void {
  const connectorId = lease.connectorId;
  log.info("connector.refresh.start", {
    connectorId,
    trigger: run.trigger,
    requestedCommitSha: run.commitSha,
    requests: run.requests,
  });
  void runRepoConnectorRefresh(connectorId, lease, new AbortController().signal)
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
    });
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
      trigger: request.trigger,
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

// ── Per-connector request limit ─────────────────────────────────────────────

const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX = 20;
/** Sweep expired windows once the map holds this many connectors. */
const SWEEP_AT = 1000;

const windows = new Map<string, { start: number; count: number }>();

function positiveEnv(name: string, fallback: number): number {
  const raw = Number(process.env[name] ?? fallback);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

/**
 * True when `connectorId` may make another refresh request in the current
 * window: `REPO_REFRESH_REQUEST_LIMIT_MAX` (default 20) per
 * `REPO_REFRESH_REQUEST_LIMIT_WINDOW_MS` (default 60 s). Keyed on a connector
 * id read from the database after the signature verified, never on a raw
 * path or payload value, so the map is bounded by the connector count.
 */
export function allowRepoRefreshRequest(connectorId: string, now: number = Date.now()): boolean {
  const windowMs = positiveEnv("REPO_REFRESH_REQUEST_LIMIT_WINDOW_MS", DEFAULT_WINDOW_MS);
  const max = positiveEnv("REPO_REFRESH_REQUEST_LIMIT_MAX", DEFAULT_MAX);
  if (windows.size >= SWEEP_AT) {
    for (const [id, w] of windows) if (now - w.start >= windowMs) windows.delete(id);
  }
  const w = windows.get(connectorId);
  if (!w || now - w.start >= windowMs) {
    windows.set(connectorId, { start: now, count: 1 });
    return true;
  }
  if (w.count >= max) return false;
  w.count += 1;
  return true;
}

/** Test-only: forget every window. */
export function __resetRepoRefreshRateLimit(): void {
  windows.clear();
}
