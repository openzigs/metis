/**
 * Epic #272 / Sub-issue #291 — Per-MCP ServiceAccount + IRSA helper.
 *
 * When `MCP_K8S_IRSA_ROLE_ARN_PREFIX` is configured, each MCP gets a
 * dedicated ServiceAccount annotated with its IRSA role ARN. The actual IAM
 * role with the IRSA trust relationship MUST be pre-provisioned by ops /
 * Terraform — METIS does NOT touch AWS IAM directly. The naming convention
 * `<prefix>-<server-id>` lets ops pre-create roles per server.
 *
 * When the prefix is empty (local dev / non-EKS), the provisioner falls
 * back to the namespace's `default` SA with `automountServiceAccountToken:
 * false` so the MCP never gets a usable K8s API token.
 */
import type { V1ServiceAccount } from "@kubernetes/client-node";

export interface BuildServiceAccountInput {
  serverId: string;
  resourceName: string;
  namespace: string;
  /** Validated IRSA role ARN (full, not prefix). Caller is responsible for composition. */
  roleArn: string;
}

/** Compose the per-server IRSA role ARN from the configured prefix. */
export function composeRoleArn(prefix: string, serverId: string): string {
  // Strip a single trailing dash so `arn:…:role/metis-mcp-` + `srv-id` reads
  // cleanly while a prefix without dash also works.
  const cleanPrefix = prefix.replace(/-$/, "");
  // Server ids are cuids (alphanumeric); IAM allows up to 64 chars in the
  // role name. We slice defensively to keep the composed ARN under the limit.
  const safeId = serverId.replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32);
  return `${cleanPrefix}-${safeId}`;
}

/** Build the per-MCP ServiceAccount manifest with IRSA annotation. */
export function buildServiceAccount(input: BuildServiceAccountInput): V1ServiceAccount {
  return {
    apiVersion: "v1",
    kind: "ServiceAccount",
    metadata: {
      name: input.resourceName,
      namespace: input.namespace,
      labels: {
        "metis.io/managed-by": "mcp-provisioner",
        "metis.io/server-id": input.serverId,
      },
      annotations: {
        "eks.amazonaws.com/role-arn": input.roleArn,
      },
    },
    automountServiceAccountToken: true,
  };
}
