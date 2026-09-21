/**
 * Provisioner registry — Epic #271 (Phase A) + Epic #272 (Phase B).
 *
 * Maps an `MCPRuntime` to the provisioner that owns the spawn-target /
 * endpoint shape. Tests inject overrides via `MCPLifecycleManager`'s
 * constructor.
 */
import type { MCPRuntime } from "@metis/shared";
import { DockerStdioProvisioner } from "./docker-stdio.js";
import { K8sSseProvisioner } from "./k8s-sse.js";
import { NativeProvisioner } from "./native.js";
import type { ContainerProvisioner } from "./types.js";

export type ProvisionerRegistry = Partial<Record<MCPRuntime, ContainerProvisioner>>;

export function defaultProvisionerRegistry(): ProvisionerRegistry {
  return {
    native: new NativeProvisioner(),
    "docker-stdio": new DockerStdioProvisioner(),
    "k8s-sse": new K8sSseProvisioner(),
  };
}

export { NativeProvisioner } from "./native.js";
export { DockerStdioProvisioner } from "./docker-stdio.js";
export { K8sSseProvisioner } from "./k8s-sse.js";
export type {
  ContainerProvisioner,
  ProvisionedProcess,
  ProvisionedEndpoint,
  ProvisionResult,
} from "./types.js";
export { isEndpoint } from "./types.js";
