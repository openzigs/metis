/**
 * Sandbox cost calculator (Epic #395 #418).
 *
 * Pure-function math, no IO. Given a destroyed session's resource
 * footprint and the rate-sheet entry that applied at creation time,
 * compute the integer micro-USD value persisted to
 * `SandboxSession.costMicroUsd`. Callers (E2B / Daytona destroy hooks)
 * round-trip through `lookupSandboxRate` first.
 */
import type { SandboxProviderKind } from "../types.js";
import { lookupSandboxRate } from "./rates.js";

export interface SandboxCostInput {
  provider: SandboxProviderKind;
  /** Wall-clock duration in milliseconds. */
  wallClockMs: number;
  /** Logical CPU count the sandbox was provisioned with. */
  vCpus: number;
  /** Memory cap in MiB the sandbox was provisioned with. */
  memMiB: number;
  /** Session creation timestamp — anchors the rate-sheet lookup. */
  createdAt: Date;
}

export interface SandboxCostResult {
  /** Integer micro-USD persisted to `SandboxSession.costMicroUsd`. */
  costMicroUsd: number;
  /** Floating USD value (informational; never persisted as-is). */
  costUsd: number;
  /** The rate-sheet entry that resolved (null when no rate). */
  rate: ReturnType<typeof lookupSandboxRate>;
}

const MIB_PER_GIB = 1024;
const MS_PER_SECOND = 1000;
const MICRO_PER_USD = 1_000_000;

/**
 * Compute the cost for a destroyed sandbox session. Returns `0` cost +
 * a non-null `rate` for free providers (`noop`, `local_dev`,
 * `self_hosted`). Returns `0` cost + `null` rate ONLY when no rate
 * sheet entry applies — caller should leave `costMicroUsd` null in
 * that case rather than write a misleading zero.
 */
export function calculateSandboxCost(input: SandboxCostInput): SandboxCostResult {
  const rate = lookupSandboxRate(input.provider, input.createdAt);
  if (!rate) return { costMicroUsd: 0, costUsd: 0, rate: null };

  const seconds = Math.max(0, input.wallClockMs) / MS_PER_SECOND;
  const memGiB = input.memMiB / MIB_PER_GIB;
  const costUsd =
    rate.vCpuPerSecondUsd * input.vCpus * seconds + rate.gibPerSecondUsd * memGiB * seconds;
  // Round to nearest micro-USD; bias to zero for negative drift.
  const costMicroUsd = Math.max(0, Math.round(costUsd * MICRO_PER_USD));
  return { costMicroUsd, costUsd, rate };
}
