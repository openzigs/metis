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
