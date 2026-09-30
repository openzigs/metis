/**
 * Shared connector types — Phase 8.
 */
import type { ConnectorStatus } from "@metis/shared";

export class ConnectorError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "ConnectorError";
    this.status = status;
    this.code = code;
  }
}

/**
 * #479 — the row changed between the binding check and the write, so the
 * write was not made. The caller re-reads and retries.
 */
export const CONCURRENT_UPDATE = "CONCURRENT_UPDATE";
export const CONCURRENT_UPDATE_MESSAGE =
  "this resource changed while the request was being checked; reload it and retry";
export const concurrentUpdateError = (): ConnectorError =>
  new ConnectorError(409, CONCURRENT_UPDATE, CONCURRENT_UPDATE_MESSAGE);

export interface ConnectorEmitter {
  status(event: {
    connectorId: string;
    kind: "repo" | "db";
    status: ConnectorStatus;
    message?: string;
    errorMessage?: string | null;
  }): void;
  progress(event: {
    connectorId: string;
    projectId?: string;
    kind: "repo" | "db";
    phase: "test" | "metadata" | "introspect" | "ingest" | "deep-ingest";
    step: string;
    current?: number;
    total?: number;
    status?: "running" | "error";
    errorMessage?: string;
  }): void;
  discovery(event: {
    projectId: string;
    connectorId: string;
    repoLabel: string;
    connectionsFound: number;
  }): void;
}

/** A no-op emitter used in tests / when Socket.IO isn't wired. */
export const NOOP_EMITTER: ConnectorEmitter = {
  status: () => undefined,
  progress: () => undefined,
  discovery: () => undefined,
};
