/**
 * Translate METIS egress allowlist into the E2B per-template firewall
 * payload (Epic #395 #414).
 *
 * E2B Pro+ accepts a per-template firewall config. The exact field name
 * has evolved across SDK versions:
 *   - `firewall: { defaultPolicy, allow: { hosts: [...] } }` — current
 *     2.4.x preview.
 *   - `network:  { defaultPolicy, allow: [...] }`            — older.
 *
 * Rather than emit BOTH and pray (silent default-allow if both shapes
 * are silently ignored by a future SDK), we probe at runtime: the
 * provider tries shape A, on `Sandbox.create` rejection retries with
 * shape B, and if BOTH fail it throws. The chosen shape is logged once
 * per process at INFO level so operators can detect drift.
 *
 * `buildE2BFirewallShapes` returns BOTH candidate payloads for the
 * provider's probe loop to try. Pure — never reaches the network.
 */
import { buildEffectiveEgressAllowlist, validateEgressAllowlist } from "../egress-defaults.js";

export type E2BFirewallShapeName = "firewall" | "network";

export interface E2BFirewallShape {
  /** Human-readable identifier for logs. */
  name: E2BFirewallShapeName;
  /**
   * Partial `Sandbox.create` options to merge into the SDK call. The
   * provider spreads this object directly into the create payload.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: Record<string, any>;
}

export interface E2BFirewallShapes {
  /** Effective allowlist (system defaults + caller hosts, deduped + sorted). */
  hosts: readonly string[];
  /** Ordered list of candidate SDK payload shapes to try in turn. */
  shapes: readonly E2BFirewallShape[];
}

export function buildE2BFirewallShapes(callerHosts: readonly string[]): E2BFirewallShapes {
  validateEgressAllowlist(callerHosts);
  const hosts = buildEffectiveEgressAllowlist(callerHosts);
  return {
    hosts,
    shapes: [
      {
        name: "firewall",
        payload: {
          firewall: { defaultPolicy: "deny" as const, allow: { hosts } },
        },
      },
      {
        name: "network",
        payload: {
          network: { defaultPolicy: "deny" as const, allow: hosts },
        },
      },
    ],
  };
}
