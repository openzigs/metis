/**
 * Versioned sandbox vendor rate sheet (Epic #395 #418).
 *
 * Rates are per-second compute cost, expressed in USD. Storage cost is
 * out of scope for v1.2 — sandboxes are short-lived and persistent disk
 * (E2B persistence, Daytona snapshots) is not yet exposed via the port.
 *
 * **Why versioned?** Vendors change pricing. Once a `SandboxSession` is
 * destroyed and `costMicroUsd` is persisted, the row must remain stable
 * even if a future deploy ships an updated rate. The lookup function
 * picks the most recent entry whose `effectiveAt` is `<=` the session
 * creation time.
 *
 * Per research §2.5: E2B + Daytona both bill `$0.000014 / vCPU-second
 * + $0.0000045 / GiB-second`. `noop` and `local_dev` providers run on
 * the host so vendor billing is `$0`. Modal pricing is deferred (no
 * adapter ships in v1.2).
 */
import type { SandboxProviderKind } from "../types.js";

/** Per-provider per-second compute rate in USD. Storage is out of scope. */
export interface SandboxRate {
  /** Vendor — exactly one of the `SandboxProviderKind` values. */
  readonly provider: SandboxProviderKind;
  /** ISO timestamp this rate became effective. */
  readonly effectiveAt: string;
  /** USD per vCPU per wall-clock second. */
  readonly vCpuPerSecondUsd: number;
  /** USD per GiB of memory per wall-clock second. */
  readonly gibPerSecondUsd: number;
  /** Free-form note for audit (e.g. URL to vendor pricing page). */
  readonly note?: string;
}

/**
 * Append-only rate table. New entries MUST go at the BOTTOM with a
 * newer `effectiveAt` — never edit existing rows in place. Old sessions
 * resolve their rate by `effectiveAt <= session.createdAt`.
 */
export const SANDBOX_RATES: readonly SandboxRate[] = [
  {
    provider: "e2b",
    effectiveAt: "2024-01-01T00:00:00.000Z",
    vCpuPerSecondUsd: 0.000014,
    gibPerSecondUsd: 0.0000045,
    note: "https://e2b.dev/pricing — research §2.5",
  },
  {
    provider: "daytona",
    effectiveAt: "2024-01-01T00:00:00.000Z",
    vCpuPerSecondUsd: 0.000014,
    gibPerSecondUsd: 0.0000045,
    note: "https://daytona.io/pricing — research §2.5",
  },
  {
    provider: "noop",
    effectiveAt: "2024-01-01T00:00:00.000Z",
    vCpuPerSecondUsd: 0,
    gibPerSecondUsd: 0,
    note: "host-process only — no vendor billing",
  },
  {
    provider: "local_dev",
    effectiveAt: "2024-01-01T00:00:00.000Z",
    vCpuPerSecondUsd: 0,
    gibPerSecondUsd: 0,
    note: "host-process only — no vendor billing",
  },
  {
    provider: "self_hosted",
    effectiveAt: "2024-01-01T00:00:00.000Z",
    vCpuPerSecondUsd: 0,
    gibPerSecondUsd: 0,
    note: "self-hosted — operator absorbs cost",
  },
];

/**
 * Find the rate that applies to a session created at `createdAt`.
 *
 * Returns the entry with the latest `effectiveAt` that is `<=` the
 * session creation timestamp. Returns `null` when no rate exists for
 * the provider yet — callers MUST treat that as "do not write a cost"
 * rather than fall back to zero (zero is a meaningful value reserved
 * for noop/local_dev/self_hosted).
 */
export function lookupSandboxRate(
  provider: SandboxProviderKind,
  createdAt: Date,
): SandboxRate | null {
  const candidates = SANDBOX_RATES.filter(
    (r) => r.provider === provider && new Date(r.effectiveAt).getTime() <= createdAt.getTime(),
  );
  if (candidates.length === 0) return null;
  // Most recent applicable rate wins.
  candidates.sort((a, b) => new Date(b.effectiveAt).getTime() - new Date(a.effectiveAt).getTime());
  return candidates[0];
}
