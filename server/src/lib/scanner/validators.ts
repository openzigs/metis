/**
 * Epic #708 — fingerprint + validators.
 *
 * `computeFingerprint` is the dedup key that gates both per-scan
 * uniqueness (`scanner_scan_findings.scanId+fingerprint` UNIQUE) and
 * cross-scan idempotency at publish time (matched against `IssueLink.fingerprint`).
 *
 * `validateEvidenceLines` enforces the contract from Issue #712 that an
 * LLM-reported `evidence_lines` array is a subset of the symbol's actual
 * source-line range. Hallucinated line numbers are silently dropped; a
 * finding with zero surviving evidence lines is treated as unverifiable
 * and discarded by the caller.
 */
import crypto from "node:crypto";

export interface FingerprintInput {
  projectId: string;
  repoConnectionId: string;
  qualifiedName: string;
  /** Rule id when rule-driven; null for heuristic scans. */
  ruleId: string | null;
  title: string;
}

export function computeFingerprint(input: FingerprintInput): string {
  const normalisedTitle = input.title.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
  const seed = [
    input.projectId,
    input.repoConnectionId,
    input.qualifiedName,
    input.ruleId ?? "__heuristic__",
    normalisedTitle,
  ].join("\u0000");
  return crypto.createHash("sha256").update(seed).digest("hex");
}

/**
 * Return the subset of `reported` that falls inside `[startLine, endLine]`
 * (inclusive, 1-indexed). Out-of-range / negative / non-integer values are
 * silently dropped. The result is sorted and deduplicated.
 */
export function validateEvidenceLines(
  reported: readonly number[],
  startLine: number,
  endLine: number,
): number[] {
  const lo = Math.min(startLine, endLine);
  const hi = Math.max(startLine, endLine);
  const seen = new Set<number>();
  for (const raw of reported) {
    if (!Number.isFinite(raw)) continue;
    const n = Math.trunc(raw);
    if (n < lo || n > hi) continue;
    seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}
