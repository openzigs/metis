/**
 * Issue #317 (OWASP A07) — per-MCP `Secret` builder for the K8s SSE provisioner.
 *
 * Why this exists: the legacy K8s provisioner inlined env values directly
 * into the Deployment spec (`env: [{name, value}]`). Anyone with
 * `kubectl get deployment -n metis-mcp -o yaml` could read every resolved
 * secret in cleartext. The fix is the standard k8s pattern — push values
 * into a `Secret` and reference them from the container via
 * `env: [{name, valueFrom: {secretKeyRef: {name, key}}}]`.
 *
 * The Secret is named after the same `resourceName` as the Deployment +
 * Service + NetworkPolicy + ServiceAccount, so cleanup tears them all down
 * with a single label selector or four parallel deletes.
 */
import type { V1Secret } from "@kubernetes/client-node";

export interface BuildSecretInput {
  serverId: string;
  resourceName: string;
  namespace: string;
  /** Resolved env values to be stored in the Secret's `stringData`. */
  env: Record<string, string>;
}

/** RFC-1123 env-var key allowlist — same regex as k8s-sse used inline. */
function isValidEnvKey(key: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(key) && key.length <= 256;
}

/**
 * Build a `V1Secret` for the given MCP. Returns `null` when no env entries
 * survive the key validator — there's no point creating an empty Secret,
 * and the K8s API rejects Secrets with neither `data` nor `stringData`.
 */
export function buildSecret(input: BuildSecretInput): V1Secret | null {
  const stringData: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.env)) {
    if (!isValidEnvKey(k)) continue;
    stringData[k] = v;
  }
  if (Object.keys(stringData).length === 0) return null;
  return {
    apiVersion: "v1",
    kind: "Secret",
    type: "Opaque",
    metadata: {
      name: input.resourceName,
      namespace: input.namespace,
      labels: {
        "metis.io/managed-by": "mcp-provisioner",
        "metis.io/server-id": input.serverId,
      },
    },
    stringData,
  };
}

/**
 * Build the Deployment env entries that reference the Secret. Returns the
 * same key order as the input map (sorted for determinism — easier to diff
 * across reconciliations).
 */
export function buildSecretEnvRefs(
  resourceName: string,
  env: Record<string, string>,
): Array<{ name: string; valueFrom: { secretKeyRef: { name: string; key: string } } }> {
  return Object.keys(env)
    .filter((k) => isValidEnvKey(k))
    .sort()
    .map((name) => ({
      name,
      valueFrom: { secretKeyRef: { name: resourceName, key: name } },
    }));
}
