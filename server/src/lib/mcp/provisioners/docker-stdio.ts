/**
 * Epic #271 — Docker stdio provisioner.
 *
 * Wraps an arbitrary MCP server into `docker run -i --rm <image> <args>`.
 *
 * Data-model contract — when `config.runtime === 'docker-stdio'`:
 *   - `config.command` is interpreted as the wrapper image reference
 *     (e.g. `ghcr.io/metis-mcps/uvx-runner:1.0`). It is NOT a host binary.
 *   - `config.args`    are the arguments passed to the image's entrypoint
 *     (e.g. `["awslabs.aws-api-mcp-server@latest"]` for the uvx wrapper).
 *   - `config.env`     env vars to forward into the container; values come
 *     from the resolved env map (vault refs already expanded by the caller).
 *
 * Security posture:
 *   - Env values flow via spawn's `env` map and are referenced inside
 *     `docker run` with `-e KEY` (NO `=VALUE`). This prevents secrets from
 *     appearing in `ps aux` / argv listings on the host.
 *   - The image is re-validated against `MCP_IMAGE_ALLOWLIST` (#275) at
 *     provision time so a tunable change between registration and start
 *     cannot smuggle a previously-allowed image past the new policy.
 *   - Container is run with explicit memory + CPU caps from runtime config
 *     and attached to a user-defined bridge network so platform-managed
 *     network policy applies.
 *   - `--rm` ensures the container is reaped on exit, but we additionally
 *     issue `docker rm -f <name>` in the cleanup hook to recover from any
 *     edge case where the daemon left a corpse behind.
 */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createChildLogger } from "../../logger.js";
import { getConfigService } from "../../config/config-service.js";
import { imageMatchesAllowlist, parseAllowlistCsv } from "../image-allowlist.js";
import { assertRawImageNotDenied } from "../validation.js";
import type { MCPServerConfig } from "../types.js";
import type { ContainerProvisioner, ProvisionedProcess } from "./types.js";

const log = createChildLogger("mcp-docker-provisioner");

const DEFAULT_MEMORY = "512m";
const DEFAULT_CPUS = "1.0";
const DEFAULT_NETWORK = "metis-mcp";
const DEFAULT_WORKSPACE_TMPFS = "/workspace:rw,nosuid,nodev,size=64m";

/** docker container names: lowercase alphanumerics + `_`, `-`. */
const CONTAINER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]+$/;

export interface DockerStdioProvisionerOptions {
  /** Override `docker` binary path/name. Defaults to `"docker"`. */
  dockerBinary?: string;
  /**
   * Override the cleanup invoker for tests so we don't shell out to a real
   * docker daemon. Receives the canonical container name; resolves on best
   * effort (failures are logged, not thrown).
   */
  cleanupRunner?: (containerName: string) => Promise<void>;
}

export class DockerStdioProvisioner implements ContainerProvisioner {
  constructor(private readonly opts: DockerStdioProvisionerOptions = {}) {}

  async provision(
    config: MCPServerConfig,
    resolvedEnv: Record<string, string>,
  ): Promise<ProvisionedProcess> {
    if (!config.command) {
      throw new Error("docker-stdio runtime requires `command` (interpreted as image reference)");
    }
    const image = config.command;

    // Defence-in-depth: re-check the image against the current allowlist.
    const cfg = getConfigService();
    const allowlistCsv = cfg.get("MCP_IMAGE_ALLOWLIST");
    const patterns = parseAllowlistCsv(allowlistCsv ?? null);
    if (!imageMatchesAllowlist(image, patterns)) {
      throw new Error(
        `IMAGE_NOT_ALLOWED: '${image}' does not match any allowlisted pattern (${patterns.length} configured)`,
      );
    }
    // Issue #392 — denylist pre-flight: blocks rows that were registered
    // before the denylist update. Throws MCPRegistryError(422) on deny;
    // emits a WARN audit event when override admits a vulnerable image.
    assertRawImageNotDenied(image, {
      actorId: null,
      source: "provision",
      serverId: config.id,
      serverLabel: config.label ?? null,
    });

    const dockerBinary = this.opts.dockerBinary ?? "docker";
    const memory = sanitiseTunable(cfg.get("MCP_DOCKER_MEMORY_LIMIT"), DEFAULT_MEMORY);
    const cpus = sanitiseTunable(cfg.get("MCP_DOCKER_CPU_LIMIT"), DEFAULT_CPUS);
    const network = sanitiseTunable(cfg.get("MCP_DOCKER_NETWORK"), DEFAULT_NETWORK);

    const containerName = buildContainerName(config.id);
    const envKeys = Object.keys(resolvedEnv).filter((k) => isValidEnvKey(k));
    const args: string[] = [
      "run",
      "-i",
      "--rm",
      "--name",
      containerName,
      "--network",
      network,
      "--memory",
      memory,
      "--cpus",
      cpus,
      "--tmpfs",
      DEFAULT_WORKSPACE_TMPFS,
    ];
    for (const k of envKeys) {
      // `-e KEY` (no value): docker reads the value from our spawn env map,
      // never the host argv listing. This is the explicit security goal.
      args.push("-e", k);
    }
    args.push(image);
    args.push(...(config.args ?? []));

    log.debug("Provisioning docker-stdio MCP", {
      serverId: config.id,
      image,
      containerName,
      memory,
      cpus,
      network,
      workspace: "/workspace",
      envKeyCount: envKeys.length,
    });

    return {
      command: dockerBinary,
      args,
      // Spawn env carries the actual values — picked up by `-e KEY`.
      env: { ...resolvedEnv },
      cleanup: async () => {
        const runner = this.opts.cleanupRunner ?? defaultCleanupRunner(dockerBinary);
        try {
          await runner(containerName);
        } catch (err) {
          log.warn("docker-stdio cleanup hook failed", {
            serverId: config.id,
            containerName,
            error: (err as Error).message,
          });
        }
      },
    };
  }
}

/**
 * Build the canonical `metis-mcp-<id>-<short-uuid>` container name. The
 * short UUID disambiguates restarts so we never collide with a lingering
 * `--rm`-but-not-yet-reaped container from a prior run.
 */
export function buildContainerName(serverId: string): string {
  const safeId = serverId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "anon";
  const short = randomUUID().split("-")[0];
  const name = `metis-mcp-${safeId}-${short}`;
  if (!CONTAINER_NAME_RE.test(name)) {
    // Should be unreachable given how we build it, but throwing here makes
    // the failure mode explicit rather than letting docker reject it later.
    throw new Error(`Computed container name violates docker rules: ${name}`);
  }
  return name;
}

function sanitiseTunable(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : fallback;
}

function isValidEnvKey(key: string): boolean {
  // POSIX-ish — letters, digits, underscore; first char not a digit.
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key.length <= 256;
}

/**
 * Default cleanup: best-effort `docker rm -f <name>`. We never await
 * `docker kill` first because `--rm` already wires up reap-on-exit; the
 * `rm -f` is the belt-and-braces second guarantee.
 */
function defaultCleanupRunner(dockerBinary: string): (containerName: string) => Promise<void> {
  return (containerName: string) =>
    new Promise<void>((resolve) => {
      const child = spawn(dockerBinary, ["rm", "-f", containerName], {
        stdio: ["ignore", "ignore", "ignore"],
      });
      child.on("exit", () => resolve());
      child.on("error", () => resolve());
    });
}
