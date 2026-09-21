/**
 * Clamp + validate `SandboxOptions` against `SANDBOX_HARD_LIMITS` and the
 * per-`Project` configuration (Epic #395 #412).
 *
 * Behaviour:
 *   - `vCpus` and `memMiB` use a *throw* policy — exceeding the absolute
 *     maximum is a programmer error worth surfacing loudly.
 *   - `timeoutMs` uses a *clamp* policy — out-of-range values are coerced
 *     and a structured WARN log entry is emitted with the original value
 *     (callers commonly pass user-supplied numbers; throwing would surface
 *     unrelated 500s for end users).
 *   - The effective timeout is `min(callerRequested, projectCap, hardCap)`.
 */
import { createChildLogger } from "../logger.js";
import { SANDBOX_HARD_LIMITS } from "./limits.js";
import type { SandboxOptions, SandboxProjectConfig } from "./types.js";
import { SandboxLimitExceededError } from "./types.js";

const log = createChildLogger("sandbox.clamp");

/** Result of `clampSandboxOptions` — fully resolved, ready for the SDK. */
export interface ClampedSandboxOptions {
  projectId: string;
  userId: string | null;
  runId: string | null;
  vCpus: number;
  memMiB: number;
  timeoutMs: number;
  templateId: string | undefined;
  egressAllowlist: readonly string[];
}

const DEFAULT_VCPUS = 2;
const DEFAULT_MEM_MIB = 2 * 1024; // 2 GiB
const DEFAULT_TIMEOUT_MS = 60_000; // 1 minute

export function clampSandboxOptions(
  requested: SandboxOptions,
  project?: SandboxProjectConfig,
): ClampedSandboxOptions {
  const vCpus = requested.vCpus ?? DEFAULT_VCPUS;
  const memMiB = requested.memMiB ?? DEFAULT_MEM_MIB;

  if (vCpus > SANDBOX_HARD_LIMITS.maxVCpus) {
    throw new SandboxLimitExceededError("vCpus", vCpus, SANDBOX_HARD_LIMITS.maxVCpus);
  }
  if (memMiB > SANDBOX_HARD_LIMITS.maxMemMiB) {
    throw new SandboxLimitExceededError("memMiB", memMiB, SANDBOX_HARD_LIMITS.maxMemMiB);
  }
  if (vCpus < 1) {
    throw new SandboxLimitExceededError("vCpus", vCpus, 1);
  }
  if (memMiB < 128) {
    throw new SandboxLimitExceededError("memMiB", memMiB, 128);
  }

  const requestedTimeout = requested.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let effectiveTimeout = requestedTimeout;
  if (effectiveTimeout > SANDBOX_HARD_LIMITS.maxWallClockMs) {
    log.warn("Sandbox timeoutMs clamped to hard cap", {
      requested: requestedTimeout,
      clamped: SANDBOX_HARD_LIMITS.maxWallClockMs,
      reason: "exceeds_hard_cap",
    });
    effectiveTimeout = SANDBOX_HARD_LIMITS.maxWallClockMs;
  }
  if (effectiveTimeout < SANDBOX_HARD_LIMITS.minWallClockMs) {
    log.warn("Sandbox timeoutMs clamped to minimum", {
      requested: requestedTimeout,
      clamped: SANDBOX_HARD_LIMITS.minWallClockMs,
      reason: "below_min",
    });
    effectiveTimeout = SANDBOX_HARD_LIMITS.minWallClockMs;
  }

  const projectCap = project?.sandboxTimeoutMs;
  if (typeof projectCap === "number" && Number.isFinite(projectCap) && projectCap > 0) {
    const tightened = Math.min(effectiveTimeout, projectCap);
    if (tightened < effectiveTimeout) {
      log.info("Sandbox timeoutMs tightened by project cap", {
        beforeProject: effectiveTimeout,
        projectCap,
        effective: tightened,
        projectId: requested.projectId,
      });
    }
    effectiveTimeout = tightened;
  }

  // Project allowlist + per-call allowlist are merged with the system
  // defaults later in `egress-defaults.ts`. Here we simply de-duplicate.
  const merged = new Set<string>();
  for (const host of project?.sandboxEgressAllowlist ?? []) merged.add(host);
  for (const host of requested.egressAllowlist ?? []) merged.add(host);

  return {
    projectId: requested.projectId,
    userId: requested.userId ?? null,
    runId: requested.runId ?? null,
    vCpus,
    memMiB,
    timeoutMs: effectiveTimeout,
    templateId: requested.templateId,
    egressAllowlist: Array.from(merged),
  };
}
