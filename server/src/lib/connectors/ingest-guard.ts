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
 */
import { ConnectorError } from "./types.js";

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
    },
  };
  active.set(connectorId, lease);
  return lease;
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
