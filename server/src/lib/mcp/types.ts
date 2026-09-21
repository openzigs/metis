/**
 * Phase 6 — MCP Server Registry types.
 *
 * The lifecycle manager owns one connected MCP client per server id. Status
 * transitions are pushed to the `mcp:status` Socket.IO room so the admin UI
 * can react in real time.
 */
import type {
  MCPRuntime,
  MCPStatus,
  MCPToolDescriptor,
  MCPToolRisk,
  MCPTransport,
  MCPTrustLevel,
} from "@metis/shared";

export interface MCPServerConfig {
  id: string;
  scope: "global" | "project" | "user";
  projectId: string | null;
  label: string;
  transport: MCPTransport;
  /** Epic #271 — execution runtime. `native` keeps the legacy spawn() path. */
  runtime: MCPRuntime;
  command: string | null;
  args: string[] | null;
  url: string | null;
  headers: Record<string, string> | null;
  /** Plain env map; values may be `${vault:...}` references. */
  env: Record<string, string> | null;
  /** Optional explicit map of envKey -> secret label written by the importer. */
  envSecretRefs: Record<string, string> | null;
  trustLevel: MCPTrustLevel;
  defaultToolRisk: MCPToolRisk;
  version: string | null;
  sha256: string | null;
  healthCheckIntervalSec: number;
  enabled: boolean;
  /** Epic #272 — per-server k8s-sse overrides (null → use global tunable). */
  egressAllowlist?: string | null;
  k8sMemoryLimit?: string | null;
  k8sCpuLimit?: string | null;
  /** Epic #272 — when true and runtime='k8s-sse', wake on demand / scale to zero on idle. */
  coldStart?: boolean;
}

export interface MCPRuntimeState {
  status: MCPStatus;
  lastError: string | null;
  latencyMs: number | null;
  failureCount: number;
  lastHealthCheckAt: Date | null;
  /** Capability cache — last `tools/list` response. */
  tools: MCPToolDescriptor[];
}

export type MCPStatusListener = (event: MCPStatusEvent) => void;
export interface MCPStatusEvent {
  serverId: string;
  label: string;
  scope: "global" | "project" | "user";
  projectId: string | null;
  status: MCPStatus;
  latencyMs: number | null;
  failureCount: number;
  lastError: string | null;
  ts: number;
}

/** Wire-level transport used by the MCP client. */
export interface MCPTransportClient {
  start(): Promise<void>;
  stop(reason?: string): Promise<void>;
  /** Send a JSON-RPC request and wait for the matching response. */
  request<TResult>(method: string, params?: unknown, timeoutMs?: number): Promise<TResult>;
  /** Send a JSON-RPC notification (no response expected). */
  notify(method: string, params?: unknown): Promise<void>;
  /** Resolves once the transport disconnects (crash or graceful close). */
  closed(): Promise<{ code: number | null; reason: string }>;
}
