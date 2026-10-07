/**
 * #762 — pure helpers for `connector:progress` rows, kept out of the hook
 * module so pages can use them while tests mock the hook.
 */

/** The fields of a `connector:progress` event these helpers read. */
export interface ProgressLike {
  phase: string;
  step: string;
  total?: number | null;
}

/** Readable wording for the count-less phases, whose `step` is an internal id. */
const PHASE_LABELS: Record<string, string> = {
  test: "Testing connection",
  metadata: "Reading repository metadata",
  introspect: "Reading database schema",
};

/** Whether an event carries a step count (`current` of `total`). */
export function isDeterminate(p: Pick<ProgressLike, "total">): boolean {
  return typeof p.total === "number" && p.total > 0;
}

/**
 * #762 — the text a progress row shows: a stepped run's own step name, or a
 * phase label for a count-less event (`repo.get` is not for people).
 */
export function progressLabel(p: ProgressLike): string {
  if (isDeterminate(p)) return p.step;
  return PHASE_LABELS[p.phase] ?? p.step;
}
