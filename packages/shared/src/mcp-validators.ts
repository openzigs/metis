/**
 * Epic #272 — Shared validators for k8s-sse runtime fields.
 *
 * Extracted so the per-server platform schemas (`createMCPServerSchema`
 * etc.) and the global config registry (`MCP_K8S_*` keys) enforce identical
 * bounds. A single source of truth for "what counts as a valid memory
 * limit / CPU limit / egress allowlist entry" — drift between the two has
 * already bitten us (CHANGELOG vs key-registry) and there's no excuse for
 * letting it happen again.
 */
import { z } from "zod";

/** Hard upper bound: 16 GiB per pod. */
export const MCP_K8S_MEMORY_LIMIT_MAX_MI = 16 * 1024;
/** Hard upper bound: 8 vCPU per pod. */
export const MCP_K8S_CPU_LIMIT_MAX_MILLI = 8 * 1000;

/** Convert a `^\d+(Mi|Gi)$` quantity string to MiB. */
export function parseMemoryQuantityToMi(raw: string): number {
  const m = /^(\d+)(Mi|Gi)$/.exec(raw);
  if (!m) throw new Error(`Invalid k8s memory spec: ${raw}`);
  const n = Number.parseInt(m[1]!, 10);
  return m[2] === "Gi" ? n * 1024 : n;
}

/** Convert a `^\d+m?$` cpu string to millicores. */
export function parseCpuQuantityToMilli(raw: string): number {
  const m = /^(\d+)(m?)$/.exec(raw);
  if (!m) throw new Error(`Invalid k8s CPU spec: ${raw}`);
  const n = Number.parseInt(m[1]!, 10);
  return m[2] === "m" ? n : n * 1000;
}

/** Per-server memory limit (`512Mi`, `1Gi`, …) capped at 16 Gi. */
export const k8sMemoryLimitSchema = z
  .string()
  .regex(/^\d+(Mi|Gi)$/, "Invalid k8s memory spec (e.g. 512Mi, 1Gi)")
  .refine(
    (s) => {
      // Skip if the regex already failed — don't double-report and don't
      // throw out of the refine (zod doesn't catch refine throws).
      if (!/^\d+(Mi|Gi)$/.test(s)) return true;
      return parseMemoryQuantityToMi(s) <= MCP_K8S_MEMORY_LIMIT_MAX_MI;
    },
    { message: `k8s memory limit must be ≤ ${MCP_K8S_MEMORY_LIMIT_MAX_MI}Mi (16Gi)` },
  );

/** Per-server CPU limit (`500m`, `2`, …) capped at 8 cores. */
export const k8sCpuLimitSchema = z
  .string()
  .regex(/^\d+m?$/, "Invalid k8s CPU spec (e.g. 1000m, 2)")
  .refine(
    (s) => {
      if (!/^\d+m?$/.test(s)) return true;
      return parseCpuQuantityToMilli(s) <= MCP_K8S_CPU_LIMIT_MAX_MILLI;
    },
    { message: `k8s CPU limit must be ≤ ${MCP_K8S_CPU_LIMIT_MAX_MILLI}m (8 cores)` },
  );

/** Validate a single egress allowlist entry — `cidr:<cidr>` or `host:<host>`. */
export function validateEgressAllowlistEntry(raw: string): void {
  const t = raw.trim();
  if (!t) throw new Error("Empty egress allowlist entry");
  if (!/^(cidr:|host:)/.test(t)) {
    throw new Error(
      `Invalid egress allowlist entry '${raw}' — expected 'cidr:<cidr>' or 'host:<host>'`,
    );
  }
  if (t.startsWith("cidr:") && t.length === "cidr:".length) {
    throw new Error(`Empty CIDR in allowlist entry: ${raw}`);
  }
  if (t.startsWith("host:") && t.length === "host:".length) {
    throw new Error(`Empty host in allowlist entry: ${raw}`);
  }
}

/**
 * Per-server `egressAllowlist` — CSV string of `cidr:` / `host:` entries
 * mirroring the global `MCP_K8S_EGRESS_ALLOWLIST` validator. Empty string
 * is treated as "no overrides" (DNS-only egress beyond global defaults).
 */
export const egressAllowlistCsvSchema = z
  .string()
  .max(4096)
  .superRefine((raw, ctx) => {
    const parts = raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
    for (const p of parts) {
      try {
        validateEgressAllowlistEntry(p);
      } catch (err) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: (err as Error).message,
        });
        return;
      }
    }
  });
