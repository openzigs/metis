/**
 * Epic #271 — Container provisioner abstraction.
 *
 * A provisioner takes a registered MCP server's `MCPServerConfig` plus its
 * resolved env map (vault references already expanded) and returns the
 * concrete spawn target (`command`, `args`, `env`) that the lifecycle
 * manager hands to `child_process.spawn` via `MCPStdioTransport`.
 *
 * Native runtime: pass-through.
 * Docker runtime: wrap into `docker run -i --rm <image> <args>` with
 * memory/CPU limits, dedicated network, and `-e KEY` (no `=VALUE`) env
 * propagation so secrets never appear in `ps aux` output.
 *
 * Future Phase B (#272) introduces a `K8sSseProvisioner` that returns an
 * HTTP endpoint instead of a spawn target — the lifecycle manager handles
 * that branch by inspecting `runtime` directly.
 */
import type { MCPServerConfig } from "../types.js";

export interface ProvisionedProcess {
  command: string;
  args: string[];
  env: Record<string, string>;
  /**
   * Optional cleanup hook invoked after the lifecycle manager kills the
   * spawned process. Provisioners that allocate out-of-band resources
   * (e.g. docker container by name) use this to ensure they tidy up even
   * when the child process has already crashed.
   */
  cleanup?: () => Promise<void>;
}

/**
 * Phase B (#272) — provisioner result for runtimes that produce a network
 * endpoint instead of a child process. The lifecycle manager dispatches on
 * `'url' in result` to pick between spawning a child (stdio) and connecting
 * to an HTTP/SSE endpoint.
 */
export interface ProvisionedEndpoint {
  transport: "sse" | "http";
  url: string;
  headers?: Record<string, string>;
  /**
   * Cleanup hook invoked when the lifecycle manager stops the server.
   * Implementations MUST tear down all out-of-band resources (k8s
   * Deployment + Service + NetworkPolicy + ServiceAccount) on a best-effort
   * basis — failures are logged, not thrown.
   */
  cleanup: () => Promise<void>;
}

export type ProvisionResult = ProvisionedProcess | ProvisionedEndpoint;

/** Type guard — distinguishes endpoint (k8s-sse) results from process results. */
export function isEndpoint(result: ProvisionResult): result is ProvisionedEndpoint {
  return "url" in result;
}

export interface ContainerProvisioner {
  /**
   * Given the persisted server config and the resolved env map, return the
   * spawn target (process) OR the network endpoint (endpoint). Implementations
   * MUST be deterministic for a given input and MUST NOT mutate `config` or
   * `resolvedEnv`.
   */
  provision(config: MCPServerConfig, resolvedEnv: Record<string, string>): Promise<ProvisionResult>;
}
