/**
 * Epic #194 (C.1) — SWE-bench-Pro per-task scorer.
 *
 * Pure-function scorer kept separate from the runner so it can be unit
 * tested in isolation. A task is considered passed when:
 *   1. The sandbox `testCommand` exited 0, AND
 *   2. The produced patch overlaps the expected patch above
 *      `OVERLAP_THRESHOLD` (Jaccard similarity over non-trivial lines).
 *
 * The numeric `score` returned in [0,1] is the Jaccard similarity itself —
 * useful when ranking partial solutions during best-of-N.
 */

export interface SandboxOutcome {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface ScoreInput {
  expectedPatch: string;
  actualPatch: string;
  sandbox: SandboxOutcome;
}

export interface ScoreResult {
  passed: boolean;
  score: number;
  reason: string;
}

/** Minimum Jaccard similarity over patch lines required to count as passed. */
export const OVERLAP_THRESHOLD = 0.4;

export function scoreTask(input: ScoreInput): ScoreResult {
  if (input.sandbox.exitCode !== 0) {
    return {
      passed: false,
      score: 0,
      reason: `sandbox exit ${input.sandbox.exitCode}`,
    };
  }
  const sim = jaccardLines(input.expectedPatch, input.actualPatch);
  if (sim < OVERLAP_THRESHOLD) {
    return {
      passed: false,
      score: sim,
      reason: `patch overlap ${sim.toFixed(2)} < ${OVERLAP_THRESHOLD}`,
    };
  }
  return { passed: true, score: sim, reason: "ok" };
}

/**
 * Jaccard similarity over the set of meaningful patch lines (drops blank
 * lines and unified-diff metadata so two patches that touch the same hunks
 * but with different file headers still match).
 */
export function jaccardLines(a: string, b: string): number {
  const setA = patchLineSet(a);
  const setB = patchLineSet(b);
  if (setA.size === 0 && setB.size === 0) return 1;
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersect = 0;
  for (const line of setA) {
    if (setB.has(line)) intersect += 1;
  }
  const union = setA.size + setB.size - intersect;
  return union === 0 ? 0 : intersect / union;
}

function patchLineSet(patch: string): Set<string> {
  const out = new Set<string>();
  for (const raw of patch.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("diff ")) continue;
    if (line.startsWith("index ")) continue;
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) continue;
    if (line.startsWith("@@")) continue;
    out.add(line);
  }
  return out;
}
