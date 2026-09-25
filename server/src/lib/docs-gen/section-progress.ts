/**
 * The document-level progress percentage broadcast while a document generates.
 *
 * Progress used to advance only when a section group changed: a group was
 * counted as done the moment it STARTED (`index / total`), so a batched section
 * (#157) of fifty ~10-minute calls sat on one number for hours (onyourleft's
 * Business Rules: 43% for ~9 hours). A section that is generating now counts as
 * `index - 1` finished groups plus the fraction of its batches written, so the
 * bar moves once per batch and never runs ahead of the work.
 */

/** The fields of a section progress update this computation reads. */
export interface SectionProgressLike {
  status: "queued" | "generating" | "done" | "degraded" | "failed";
  /** 1-based index of the section group. */
  index: number;
  /** Number of section groups. */
  total: number;
  /** For a batched section while it generates: batches finished of batches planned. */
  batch?: { done: number; total: number };
}

/** 0-100, monotonic across a document's updates. */
export function sectionProgressPercent(u: SectionProgressLike): number {
  const total = Math.max(u.total, 1);
  if (u.status !== "generating" && u.status !== "queued") {
    return Math.round((Math.min(u.index, total) / total) * 100);
  }
  const fraction =
    u.batch && u.batch.total > 0 ? Math.min(Math.max(u.batch.done / u.batch.total, 0), 1) : 0;
  return Math.round(((Math.max(u.index - 1, 0) + fraction) / total) * 100);
}

/** The lifecycle message for an update, naming the batch when there is one. */
export function sectionProgressMessage(u: SectionProgressLike & { section: string }): string {
  const base = `Section ${u.index}/${u.total}: ${u.section}`;
  return u.batch && u.status === "generating"
    ? `${base} (batch ${u.batch.done}/${u.batch.total})`
    : base;
}

/**
 * Share of the document's progress bar given to Phase 1 (fact extraction);
 * Phase 2 (section synthesis) fills the rest. 60%: with full coverage Phase 1
 * is most of a cold run's wall time — on onyourleft ~32 h of estimated Phase-1
 * output at 20 tok/s (554 chunks) against roughly 12–20 h for Phase 2 (72+
 * Rules batches of ~10 min plus the other sections) — and a warm run's cached
 * Phase 1 simply jumps to 60%. A fixed share keeps the bar monotonic without
 * predicting either phase's duration.
 */
export const PHASE1_PROGRESS_SHARE = 60;

/** 0..{@link PHASE1_PROGRESS_SHARE}: Phase-1 chunks completed of chunks planned. Monotonic. */
export function phase1ProgressPercent(done: number, total: number): number {
  if (total <= 0) return 0;
  return Math.floor((Math.min(Math.max(done, 0), total) / total) * PHASE1_PROGRESS_SHARE);
}

/** The lifecycle message for Phase-1 progress. */
export function phase1ProgressMessage(done: number, total: number): string {
  return `Extracting facts: ${Math.min(done, total)}/${total} chunks`;
}

/**
 * The document-level percentage for a section update: Phase 2 fills the bar
 * from {@link PHASE1_PROGRESS_SHARE} to 100, so it never drops below where
 * Phase 1 left it.
 */
export function documentProgressPercent(u: SectionProgressLike): number {
  return (
    PHASE1_PROGRESS_SHARE +
    Math.round((sectionProgressPercent(u) * (100 - PHASE1_PROGRESS_SHARE)) / 100)
  );
}
