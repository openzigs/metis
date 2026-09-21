/**
 * Epic #272 / Sub-issue #288 — NetworkPolicy template builder.
 *
 * Generates a per-MCP `V1NetworkPolicy` that:
 *   - Selects only the MCP's own pods via the managed labels
 *   - Restricts egress to (a) the configured allowlist + (b) DNS to kube-dns
 *   - Restricts ingress to METIS server pods (`metis.io/component=server`)
 *     on port 8080 — the SSE listening port. Blocks pod-to-pod lateral
 *     movement within `metis-mcp` so a compromised MCP cannot reach its
 *     neighbours.
 *
 * Allowlist entries are CSV strings:
 *   - `cidr:10.0.0.0/8`           → ipBlock egress rule
 *   - `host:api.github.com`       → host-based egress rule (resolved by k8s
 *                                    DNS at runtime; we emit a podSelector
 *                                    that matches everything and rely on the
 *                                    namespaceSelector to scope traffic by
 *                                    layer-4 ports — see note below)
 *   - `host:*.atlassian.com`      → wildcard host (same handling as above)
 *
 * NOTE on host-based rules: native NetworkPolicy is L3/L4 (IP + port) only,
 * so a hostname allowlist is necessarily approximate. This module emits
 * `to: []` (no peer constraint) + ports 80/443 for each `host:` entry,
 * meaning every L7 destination over HTTP/HTTPS is allowed when even one
 * `host:` entry is present. Operators wanting strict hostname enforcement
 * must layer Cilium FQDN policies on top — documented in OPERATIONS.md.
 *
 * Requires a CNI that enforces NetworkPolicy (Calico, Cilium). With the
 * default in-tree CNI the policy is silently ignored — also documented.
 */
import type {
  V1NetworkPolicy,
  V1NetworkPolicyEgressRule,
  V1NetworkPolicyIngressRule,
} from "@kubernetes/client-node";

export interface BuildNetworkPolicyInput {
  serverId: string;
  resourceName: string;
  namespace: string;
  /** Trimmed allowlist entries (already-validated `cidr:` / `host:` prefix). */
  allowlist: readonly string[];
}

/** Parsed allowlist entry — discriminated by `kind`. */
export type AllowlistEntry = { kind: "cidr"; cidr: string } | { kind: "host"; host: string };

/** Parse a single CSV entry. Throws on unrecognised prefix. */
export function parseAllowlistEntry(raw: string): AllowlistEntry {
  const trimmed = raw.trim();
  if (trimmed.startsWith("cidr:")) {
    const cidr = trimmed.slice("cidr:".length).trim();
    if (!cidr) throw new Error(`Empty CIDR in allowlist entry: ${raw}`);
    return { kind: "cidr", cidr };
  }
  if (trimmed.startsWith("host:")) {
    const host = trimmed.slice("host:".length).trim();
    if (!host) throw new Error(`Empty host in allowlist entry: ${raw}`);
    return { kind: "host", host };
  }
  throw new Error(`Unrecognised egress allowlist entry '${raw}' — expected 'cidr:' or 'host:'`);
}

/** Parse a CSV (or array) into validated entries. */
export function parseAllowlist(
  raw: string | readonly string[] | null | undefined,
): AllowlistEntry[] {
  if (!raw) return [];
  const items: string[] = Array.isArray(raw)
    ? (raw as readonly string[]).map((s) => s.trim()).filter((s) => s.length > 0)
    : (raw as string)
        .split(",")
        .map((s: string) => s.trim())
        .filter((s: string) => s.length > 0);
  return items.map((s) => parseAllowlistEntry(s));
}

/**
 * Build the DNS-to-kube-dns egress rule (UDP+TCP/53). Always included so
 * containers can resolve service names.
 */
function dnsEgressRule(): V1NetworkPolicyEgressRule {
  return {
    to: [
      {
        namespaceSelector: { matchLabels: { "kubernetes.io/metadata.name": "kube-system" } },
        podSelector: { matchLabels: { "k8s-app": "kube-dns" } },
      },
    ],
    ports: [
      { protocol: "UDP", port: 53 },
      { protocol: "TCP", port: 53 },
    ],
  };
}

/** Build egress rules for an array of parsed entries. */
function entryEgressRules(entries: readonly AllowlistEntry[]): V1NetworkPolicyEgressRule[] {
  const rules: V1NetworkPolicyEgressRule[] = [];
  let hasHost = false;
  for (const e of entries) {
    if (e.kind === "cidr") {
      rules.push({
        to: [{ ipBlock: { cidr: e.cidr } }],
      });
    } else {
      hasHost = true;
    }
  }
  // Collapse all host: entries into a single permissive HTTP/HTTPS rule. See
  // module docstring for why hostname enforcement requires L7 (FQDN) policy.
  if (hasHost) {
    rules.push({
      ports: [
        { protocol: "TCP", port: 80 },
        { protocol: "TCP", port: 443 },
      ],
    });
  }
  return rules;
}

/**
 * Build the ingress rule allowing METIS server pods to reach the MCP on
 * port 8080. Selecting on the `metis.io/component=server` pod label means
 * a sibling MCP pod cannot connect even if it discovers the Service IP.
 *
 * Note: the @kubernetes/client-node TypeScript model renames the wire
 * field `from` → `_from` (because `from` is a reserved-ish identifier).
 * The serializer maps it back to `from` over the wire.
 */
function metisIngressRule(): V1NetworkPolicyIngressRule {
  return {
    _from: [
      {
        podSelector: { matchLabels: { "metis.io/component": "server" } },
      },
    ],
    ports: [{ protocol: "TCP", port: 8080 }],
  };
}

/** Build the per-MCP NetworkPolicy manifest. */
export function buildNetworkPolicy(input: BuildNetworkPolicyInput): V1NetworkPolicy {
  const entries = parseAllowlist(input.allowlist);
  const egress: V1NetworkPolicyEgressRule[] = [dnsEgressRule(), ...entryEgressRules(entries)];
  const ingress: V1NetworkPolicyIngressRule[] = [metisIngressRule()];
  return {
    apiVersion: "networking.k8s.io/v1",
    kind: "NetworkPolicy",
    metadata: {
      name: input.resourceName,
      namespace: input.namespace,
      labels: {
        "metis.io/managed-by": "mcp-provisioner",
        "metis.io/server-id": input.serverId,
      },
    },
    spec: {
      podSelector: {
        matchLabels: {
          "metis.io/managed-by": "mcp-provisioner",
          "metis.io/server-id": input.serverId,
        },
      },
      policyTypes: ["Ingress", "Egress"],
      ingress,
      egress,
    },
  };
}
