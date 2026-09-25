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
