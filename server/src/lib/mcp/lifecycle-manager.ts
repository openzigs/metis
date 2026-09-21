/**
 * MCP lifecycle manager — owns the connected `MCPClient` for each enabled
 * server in the registry. Status transitions fan out via the supplied
 * emitter (Socket.IO room `mcp:status`) and are persisted to the database
 * by the caller (see `mcp-service.ts`).
 *
 * Auto-restart uses capped exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s
 * (then steady) with a hard cap on retries (default 5) before the server is
 * marked `error` and left for human intervention.
 */
import type { MCPStatus } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import { MCPClient } from "./client.js";
import { MCPHttpTransport } from "./http-transport.js";
import { MCPStdioTransport, validateCommand } from "./stdio-transport.js";
import {
  defaultProvisionerRegistry,
  isEndpoint,
  type ProvisionResult,
  type ProvisionerRegistry,
} from "./provisioners/index.js";
import type {
  MCPRuntimeState,
  MCPServerConfig,
  MCPStatusEvent,
  MCPStatusListener,
  MCPTransportClient,
} from "./types.js";

const log = createChildLogger("mcp-lifecycle");

const BACKOFF_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const DEFAULT_MAX_RESTARTS = 5;

/**
 * SEC-10: high-entropy substrings inside transport / handshake error messages
 * occasionally embed bearer tokens (e.g. an HTTP server's `Unauthorized: ...`
 * leak). Mask them before persistence + Socket.IO broadcast.
 */
const HIGH_ENTROPY_TOKEN = /[A-Za-z0-9_\-+/=]{40,}/g;
const BEARER_INLINE = /\b(Bearer|Basic|Token|JWT)\s+\S{8,}/gi;
const KEY_VALUE_LEAK = /([A-Za-z_][A-Za-z0-9_]*[Tt]oken|password|secret|apikey)[=:]\s*\S+/gi;
const JWT_INLINE = /eyJ[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}\.[A-Za-z0-9_\-]{8,}/g;

export function redactErrorMessage(input: string | null | undefined): string | null {
  if (input == null) return null;
  if (typeof input !== "string") return null;
  return input
    .replace(BEARER_INLINE, (m) => `${m.split(/\s+/)[0]} ***`)
    .replace(JWT_INLINE, "***")
    .replace(KEY_VALUE_LEAK, (_m, key) => `${key}=***`)
    .replace(HIGH_ENTROPY_TOKEN, "***");
}

export interface LifecycleOptions {
  /**
   * Resolves vault refs (`${vault:...}`) inside env values. Provided by the
   * caller so tests can inject a fake vault.
   */
  resolveEnv: (env: Record<string, string>) => Promise<Record<string, string>>;
  /**
   * Override the transport factory — tests inject mock transports here.
   * Receives the provisioner result (process OR endpoint) so docker-runtime
   * paths see the actual `docker run …` argv and k8s-sse paths see the URL.
   */
  transportFactory?: (config: MCPServerConfig, provisioned: ProvisionResult) => MCPTransportClient;
  /**
   * Provisioner registry — maps runtime to its spawn-target builder.
   * Defaults to `{ native: NativeProvisioner, 'docker-stdio': DockerStdioProvisioner }`.
   */
  provisioners?: ProvisionerRegistry;
  /** Default 5. */
  maxRestarts?: number;
  /** Status fan-out (Socket.IO emitter, audit, etc.). */
  emitStatus?: MCPStatusListener;
  /** Optional clock override for tests. */
  now?: () => number;
}

interface RuntimeEntry {
  config: MCPServerConfig;
  state: MCPRuntimeState;
  client: MCPClient | null;
  transport: MCPTransportClient | null;
  /** Cleanup hook returned by the active provisioner; runs after stop(). */
  cleanup: (() => Promise<void>) | null;
  restartTimer: NodeJS.Timeout | null;
  restartAttempt: number;
  closing: boolean;
}

export class MCPLifecycleManager {
  private readonly entries = new Map<string, RuntimeEntry>();
  private readonly maxRestarts: number;
  private readonly listeners = new Set<MCPStatusListener>();
  private readonly provisioners: ProvisionerRegistry;

  constructor(private readonly opts: LifecycleOptions) {
    this.maxRestarts = opts.maxRestarts ?? DEFAULT_MAX_RESTARTS;
    this.provisioners = opts.provisioners ?? defaultProvisionerRegistry();
    if (opts.emitStatus) this.listeners.add(opts.emitStatus);
  }

  onStatus(listener: MCPStatusListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  list(): Array<{ config: MCPServerConfig; state: MCPRuntimeState }> {
    return [...this.entries.values()].map((e) => ({
      config: e.config,
      state: { ...e.state, tools: [...e.state.tools] },
    }));
  }

  get(serverId: string): { config: MCPServerConfig; state: MCPRuntimeState } | null {
    const entry = this.entries.get(serverId);
    if (!entry) return null;
    return {
      config: entry.config,
      state: { ...entry.state, tools: [...entry.state.tools] },
    };
  }

  async start(config: MCPServerConfig): Promise<MCPRuntimeState> {
    if (!config.enabled) {
      const state = this.upsertEntry(config, { status: "disabled", lastError: null });
      this.emit(config, state);
      return state;
    }
    let entry = this.entries.get(config.id);
    if (entry) {
      entry.config = config;
      entry.restartAttempt = 0;
    } else {
      entry = this.upsertEntryRaw(config);
    }
    entry.closing = false;
    return this.connect(config.id);
  }

  async stop(serverId: string, reason = "stop"): Promise<void> {
    const entry = this.entries.get(serverId);
    if (!entry) return;
    entry.closing = true;
    if (entry.restartTimer) {
      clearTimeout(entry.restartTimer);
      entry.restartTimer = null;
    }
    if (entry.client) {
      try {
        await entry.client.close(reason);
      } catch (err) {
        log.warn("Error stopping MCP client", { serverId, error: (err as Error).message });
      }
    }
    if (entry.cleanup) {
      try {
        await entry.cleanup();
      } catch (err) {
        log.warn("MCP provisioner cleanup hook threw", {
          serverId,
          error: (err as Error).message,
        });
      }
    }
    entry.cleanup = null;
    entry.client = null;
    entry.transport = null;
    entry.state.status = "idle";
    entry.state.tools = [];
    this.emit(entry.config, entry.state);
  }

  async restart(serverId: string): Promise<MCPRuntimeState> {
    const entry = this.entries.get(serverId);
    if (!entry) throw new Error(`MCP server ${serverId} is not registered with lifecycle`);
    await this.stop(serverId, "restart");
    entry.closing = false;
    entry.restartAttempt = 0;
    return this.connect(serverId);
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.stop(id, "shutdown")));
    this.entries.clear();
  }

  /** Invoke a tool against the live MCP client for `serverId`. */
  async invokeTool(
    serverId: string,
    toolName: string,
    args: unknown,
  ): Promise<{ content: unknown; isError: boolean }> {
    const entry = this.entries.get(serverId);
    if (!entry || !entry.client || entry.state.status !== "ready") {
      throw new Error(`MCP server ${serverId} is not ready`);
    }
    return entry.client.callTool(toolName, args);
  }

  /** Probe a server cheaply for the health check loop. */
  async probe(serverId: string): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const entry = this.entries.get(serverId);
    if (!entry || !entry.client) {
      return { ok: false, latencyMs: 0, error: "not_connected" };
    }
    const start = this.now();
    try {
      await entry.client.ping();
      const latency = this.now() - start;
      entry.state.latencyMs = latency;
      entry.state.lastHealthCheckAt = new Date(this.now());
      entry.state.failureCount = 0;
      entry.state.lastError = null;
      return { ok: true, latencyMs: latency };
    } catch (err) {
      const message = redactErrorMessage((err as Error).message) ?? "error";
      entry.state.failureCount += 1;
      entry.state.lastError = message;
      entry.state.lastHealthCheckAt = new Date(this.now());
      if (entry.state.failureCount >= 3) {
        entry.state.status = "error";
        this.emit(entry.config, entry.state);
      }
      return { ok: false, latencyMs: this.now() - start, error: message };
    }
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private async connect(serverId: string): Promise<MCPRuntimeState> {
    const entry = this.entries.get(serverId);
    if (!entry) throw new Error(`MCP server ${serverId} not registered`);
    if (entry.closing) return entry.state;
    entry.state.status = "starting";
    entry.state.lastError = null;
    this.emit(entry.config, entry.state);

    let env: Record<string, string> = {};
    try {
      const raw = entry.config.env ?? {};
      env = await this.opts.resolveEnv(raw);
    } catch (err) {
      const message = redactErrorMessage(`env resolution failed: ${(err as Error).message}`);
      entry.state.status = "error";
      entry.state.lastError = message;
      entry.state.failureCount += 1;
      this.emit(entry.config, entry.state);
      return entry.state;
    }

    // Resolve runtime → provisioner. Default to native for back-compat.
    const runtime = entry.config.runtime ?? "native";
    const provisioner = this.provisioners[runtime];
    if (!provisioner) {
      const message = `unsupported MCP runtime: ${runtime}`;
      entry.state.status = "error";
      entry.state.lastError = message;
      entry.state.failureCount += 1;
      this.emit(entry.config, entry.state);
      return entry.state;
    }

    let provisioned: ProvisionResult;
    try {
      provisioned = await provisioner.provision(entry.config, env);
    } catch (err) {
      const message = redactErrorMessage((err as Error).message);
      entry.state.status = "error";
      entry.state.lastError = message;
      entry.state.failureCount += 1;
      this.emit(entry.config, entry.state);
      this.scheduleRestart(serverId);
      return entry.state;
    }
    entry.cleanup = provisioned.cleanup ?? null;

    const transport = (this.opts.transportFactory ?? defaultTransportFactory)(
      entry.config,
      provisioned,
    );
    const client = new MCPClient(transport, entry.config.defaultToolRisk);
    entry.transport = transport;
    entry.client = client;

    try {
      await transport.start();
      const handshake = await client.handshake();
      entry.state.tools = handshake.tools;
      entry.state.status = "ready";
      entry.state.lastError = null;
      entry.state.failureCount = 0;
      entry.state.latencyMs = 0;
      entry.restartAttempt = 0;
      this.emit(entry.config, entry.state);
      // Async wait on transport close so we can auto-restart on crash.
      void transport
        .closed()
        .then((info) => this.handleUnexpectedClose(serverId, info.reason))
        .catch(() => undefined);
    } catch (err) {
      const message = redactErrorMessage((err as Error).message);
      entry.state.status = "error";
      entry.state.lastError = message;
      entry.state.failureCount += 1;
      // Provisioner may have allocated docker resources we now need to drop.
      if (entry.cleanup) {
        try {
          await entry.cleanup();
        } catch (cleanupErr) {
          log.warn("MCP provisioner cleanup hook threw on connect failure", {
            serverId,
            error: (cleanupErr as Error).message,
          });
        }
        entry.cleanup = null;
      }
      this.emit(entry.config, entry.state);
      this.scheduleRestart(serverId);
    }
    return entry.state;
  }

  private handleUnexpectedClose(serverId: string, reason: string): void {
    const entry = this.entries.get(serverId);
    if (!entry || entry.closing) return;
    log.warn("MCP server transport closed unexpectedly", { serverId, reason });
    entry.state.status = "error";
    entry.state.lastError = redactErrorMessage(`transport_closed:${reason}`);
    entry.state.failureCount += 1;
    entry.client = null;
    entry.transport = null;
    this.emit(entry.config, entry.state);
    this.scheduleRestart(serverId);
  }

  private scheduleRestart(serverId: string): void {
    const entry = this.entries.get(serverId);
    if (!entry || entry.closing) return;
    if (entry.restartAttempt >= this.maxRestarts) {
      log.error("MCP server reached max restart attempts — leaving in error", {
        serverId,
        attempts: entry.restartAttempt,
      });
      return;
    }
    const delayMs = BACKOFF_MS[Math.min(entry.restartAttempt, BACKOFF_MS.length - 1)];
    entry.restartAttempt += 1;
    if (entry.restartTimer) clearTimeout(entry.restartTimer);
    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      void this.connect(serverId);
    }, delayMs);
    entry.restartTimer.unref?.();
  }

  private upsertEntry(config: MCPServerConfig, seed: Partial<MCPRuntimeState>): MCPRuntimeState {
    const entry = this.entries.get(config.id) ?? this.upsertEntryRaw(config);
    entry.config = config;
    Object.assign(entry.state, seed);
    return entry.state;
  }

  private upsertEntryRaw(config: MCPServerConfig): RuntimeEntry {
    const entry: RuntimeEntry = {
      config,
      state: {
        status: "idle",
        lastError: null,
        latencyMs: null,
        failureCount: 0,
        lastHealthCheckAt: null,
        tools: [],
      },
      client: null,
      transport: null,
      cleanup: null,
      restartTimer: null,
      restartAttempt: 0,
      closing: false,
    };
    this.entries.set(config.id, entry);
    return entry;
  }

  private emit(config: MCPServerConfig, state: MCPRuntimeState): void {
    const event: MCPStatusEvent = {
      serverId: config.id,
      label: config.label,
      scope: config.scope,
      projectId: config.projectId,
      status: state.status as MCPStatus,
      latencyMs: state.latencyMs,
      failureCount: state.failureCount,
      lastError: state.lastError,
      ts: this.now(),
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn("MCP status listener threw", { error: (err as Error).message });
      }
    }
  }
}

function defaultTransportFactory(
  config: MCPServerConfig,
  provisioned: ProvisionResult,
): MCPTransportClient {
  // Endpoint provisioner (k8s-sse): bypass `config.url` / `config.transport`
  // and connect via the in-cluster URL the provisioner just constructed.
  if (isEndpoint(provisioned)) {
    return new MCPHttpTransport({
      url: provisioned.url,
      headers: provisioned.headers,
      sseUpgrade: provisioned.transport === "sse",
      // In-cluster service URLs (e.g. *.svc.cluster.local) resolve to private
      // ClusterIPs which the SSRF guard would otherwise reject. Skip the host
      // check — the URL was constructed by us, not user-supplied.
      skipHostCheck: true,
    });
  }
  // Process provisioner (native, docker-stdio).
  if (config.transport === "stdio") {
    if (!provisioned.command) throw new Error("stdio transport requires command");
    validateCommand(provisioned.command);
    return new MCPStdioTransport({
      command: provisioned.command,
      args: provisioned.args,
      env: provisioned.env,
    });
  }
  if (config.transport === "http" || config.transport === "sse") {
    if (!config.url) throw new Error(`${config.transport} transport requires url`);
    return new MCPHttpTransport({
      url: config.url,
      headers: config.headers ?? undefined,
      sseUpgrade: config.transport === "sse",
    });
  }
  throw new Error(`unsupported MCP transport: ${config.transport}`);
}
