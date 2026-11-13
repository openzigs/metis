/**
 * Issue #430 (epic #407) — human-readable Change-Analysis run labels.
 *
 * The Change-Analysis history list previously used a bare truncated id as the
 * *primary* label (e.g. "cmqpu6zn") with the date relegated to a muted
 * sub-line. A truncated cuid is opaque: two runs from the same day read as
 * near-identical noise and a human cannot tell which is which or which is newer.
 *
 * This helper derives an unambiguous, scannable label from the run's own data:
 *
 *   primary:   "Run #3 — Jun 22, 2026, 2:14 PM"   (sequence + date-time)
 *   secondary: "cmqpu6zn"                          (short id, for disambiguation
 *                                                    / copy / deep-link only)
 *
 * The sequence number is a stable 1-based ordinal assigned oldest→newest, so it
 * never changes for a given run as new runs are added (older runs keep their
 * number). The short id is preserved (never dropped) so it stays available in a
 * tooltip/secondary line, but it is no longer the sole label.
 *
 * Pure and side-effect-free → trivially unit-testable and shareable.
 */

/** Number of leading id chars kept as the short, secondary id token. */
const SHORT_ID_LEN = 8;

export interface ChangeRunLike {
  id: string;
  startedAt: string | Date;
  /**
   * #2341 — the change request's title. When present it is the primary label
   * and "Run #N — <date-time>" moves to `detail`; a run with none (a Change
   * Analysis comparison run) keeps the sequence-and-date label.
   */
  title?: string | null;
}

export interface ChangeRunLabel {
  /**
   * Human-facing primary label: the change request's title (#2341), else
   * `"Run #<seq> — <date-time>"`. Never a bare id, never a bare timestamp.
   */
  primary: string;
  /** #2341 — `"Run #<seq> — <date-time>"`: secondary detail beside a title. */
  detail: string;
  /** #2341 — true when `primary` is the change request's title. */
  titled: boolean;
  /** Short id for disambiguation / copy / tooltip — secondary, never primary. */
  shortId: string;
  /** The stable 1-based sequence ordinal (oldest run = 1). */
  sequence: number;
  /** The full id, unchanged — for deep-links / copy / `title`. */
  rawId: string;
}

/** Format an ISO/Date timestamp as a locale date-time, degrading gracefully. */
export function formatRunTimestamp(startedAt: string | Date): string {
  const d = startedAt instanceof Date ? startedAt : new Date(startedAt);
  if (Number.isNaN(d.getTime())) return "Unknown date";
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Short, stable id token (leading {@link SHORT_ID_LEN} chars). */
export function shortRunId(id: string): string {
  return (id ?? "").trim().slice(0, SHORT_ID_LEN);
}

/**
 * Build a label for a single run given its stable 1-based `sequence`. Use
 * {@link formatChangeRunLabels} to assign sequences across a list; this is the
 * single-run primitive it delegates to.
 */
export function formatChangeRunLabel(run: ChangeRunLike, sequence: number): ChangeRunLabel {
  const detail = `Run #${sequence} — ${formatRunTimestamp(run.startedAt)}`;
  const title = run.title?.trim();
  return {
    primary: title || detail,
    detail,
    titled: Boolean(title),
    shortId: shortRunId(run.id),
    sequence,
    rawId: (run.id ?? "").trim(),
  };
}

/**
 * Assign stable sequence ordinals across a list of runs and return a label per
 * run, keyed by id for O(1) lookup at render time.
 *
 * The list is typically sorted newest-first for display; sequence ordinals are
 * assigned oldest→newest (so the oldest run is "Run #1") and remain stable as
 * new runs arrive. The input order is otherwise preserved in `ordered`.
 */
export function formatChangeRunLabels(runs: ChangeRunLike[]): {
  /** Map of run id → label, for O(1) lookup keyed by `run.id`. */
  byId: Map<string, ChangeRunLabel>;
  /** Labels in the same order as the input `runs`. */
  ordered: ChangeRunLabel[];
} {
  // Determine oldest→newest order to assign stable ordinals without mutating
  // the caller's array. Ties (or unparseable dates) fall back to input order.
  const indexed = runs.map((run, i) => ({ run, i }));
  const oldestFirst = [...indexed].sort((a, b) => {
    const ta = new Date(a.run.startedAt).getTime();
    const tb = new Date(b.run.startedAt).getTime();
    const va = Number.isNaN(ta) ? Number.POSITIVE_INFINITY : ta;
    const vb = Number.isNaN(tb) ? Number.POSITIVE_INFINITY : tb;
    if (va !== vb) return va - vb;
    return a.i - b.i;
  });

  const seqByIndex = new Map<number, number>();
  oldestFirst.forEach(({ i }, ordinal) => seqByIndex.set(i, ordinal + 1));

  const byId = new Map<string, ChangeRunLabel>();
  const ordered = runs.map((run, i) => {
    const label = formatChangeRunLabel(run, seqByIndex.get(i) ?? i + 1);
    byId.set(run.id, label);
    return label;
  });

  return { byId, ordered };
}

/**
 * #2341 — one line for a run in a dropdown: the title with the sequence and date
 * after it, or the sequence and date alone for a run with no title. The date is
 * always there, never the only label of a titled run.
 */
export function formatRunOptionLabel(label: ChangeRunLabel): string {
  return label.titled ? `${label.primary} · ${label.detail}` : label.primary;
}
