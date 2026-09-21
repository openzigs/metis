/**
 * Epic #271 — Native provisioner.
 *
 * The legacy spawn() path. Returns the configured `command`/`args`/`env`
 * verbatim so the lifecycle manager preserves pre-#271 behaviour for any
 * row whose `runtime === 'native'`.
 */
import type { MCPServerConfig } from "../types.js";
import type { ContainerProvisioner, ProvisionedProcess } from "./types.js";

export class NativeProvisioner implements ContainerProvisioner {
  async provision(
    config: MCPServerConfig,
    resolvedEnv: Record<string, string>,
  ): Promise<ProvisionedProcess> {
    if (!config.command) {
      throw new Error("native runtime requires command");
    }
    return {
      command: config.command,
      args: (config.args ?? []).slice(),
      env: { ...resolvedEnv },
    };
  }
}
