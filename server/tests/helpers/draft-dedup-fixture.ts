/**
 * Issue #402 — one data set for the issue_drafts dedup migrations (#369 retires
 * live duplicates, #402 repoints what referenced them), seeded identically into
 * a real SQLite (`issue-draft-dedup-repoint-402.sqlite.test.ts`) and a real
 * Postgres (`issue-draft-dedup-postgres.integration.test.ts`), so both dialects'
 * SQL is held to the same expected outcome.
 *
 * Rows are listed parent-first, so inserting them in order satisfies the
 * `parentDraftId` foreign key.
 */
export const MIGRATION_369 = "20261001000000_issue369_issue_draft_dedup_unique";
export const MIGRATION_402 = "20261002000000_issue402_repoint_retired_dedup_drafts";

const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-02T00:00:00.000Z";

export interface DraftSeed {
  id: string;
  projectId: string;
  dedupHash: string | null;
  status: string;
  createdAt: string;
  deletedAt: string | null;
  parentDraftId: string | null;
}

const d = (
  id: string,
  projectId: string,
  dedupHash: string | null,
  status: string,
  createdAt: string,
  extra: { deletedAt?: string; parentDraftId?: string } = {},
): DraftSeed => ({
  id,
  projectId,
  dedupHash,
  status,
  createdAt,
  deletedAt: extra.deletedAt ?? null,
  parentDraftId: extra.parentDraftId ?? null,
});

export const DRAFTS: DraftSeed[] = [
  // h1/p1: the published row survives even though it is the newest.
  d("d_a", "p1", "h1", "draft", T0),
  d("d_b", "p1", "h1", "approved", T0),
  d("d_c", "p1", "h1", "published", T1),
  d("d_gone", "p1", "h1", "draft", T0, { deletedAt: T0 }),
  // h2/p1: nothing published, so the oldest (then the lowest id) survives.
  d("d_e", "p1", "h2", "draft", T1),
  d("d_d", "p1", "h2", "draft", T0),
  d("d_f", "p1", "h2", "draft", T0),
  // The same hash in another project is not a duplicate.
  d("d_other", "p2", "h1", "draft", T0),
  // h3/p1: TWO published drafts. The oldest is kept and the newer one retired
  // although it has a GitHub issue — documented in #402's migration, not fixed.
  d("d_p1", "p1", "h3", "published", T0),
  d("d_p2", "p1", "h3", "published", T1),
  // h4/p1: the survivor is itself a child of the row retired beside it.
  d("d_s1", "p1", "h4", "draft", T0),
  d("d_s2", "p1", "h4", "published", T1, { parentDraftId: "d_s1" }),
  // Children of a retired epic (d_e), of a survivor (d_c), and a retired child.
  d("c_live", "p1", "hc1", "draft", T0, { parentDraftId: "d_e" }),
  d("c_kept", "p1", "hc2", "draft", T0, { parentDraftId: "d_c" }),
  d("c_dead", "p1", "hc3", "draft", T0, { parentDraftId: "d_e", deletedAt: T0 }),
];

/** Live after #369: one row per (projectId, dedupHash), plus the children. */
export const LIVE_AFTER_369 = ["c_kept", "c_live", "d_c", "d_d", "d_other", "d_p1", "d_s2"].sort();

/** parentDraftId after #402, for every row that has one. */
export const PARENTS_AFTER_402: Record<string, string> = {
  // Retired parent -> its survivor.
  c_live: "d_d",
  // Already pointing at a survivor: untouched.
  c_kept: "d_c",
  // A retired child is left alone.
  c_dead: "d_e",
  // Repointing would make the row its own parent, so it keeps the old id.
  d_s2: "d_s1",
};

export interface BatchSeed {
  id: string;
  projectId: string;
  status: string;
  archived: boolean;
  metadata: string | null;
}

const meta = (draftIds: string[]) =>
  JSON.stringify({ draftIds, additionalLabels: ["x"], secretRef: "${vault:gh}" });

export const BATCHES: BatchSeed[] = [
  // Retired ids map to survivors, order is first-seen, the duplicate is
  // dropped, and an id that names no draft passes through.
  {
    id: "b_pending",
    projectId: "p1",
    status: "pending",
    archived: false,
    metadata: meta(["d_e", "c_kept", "d_a", "d_d", "nope"]),
  },
  { id: "b_running", projectId: "p1", status: "running", archived: false, metadata: meta(["d_b"]) },
  // PR #414 panel — runBatch refuses only archived and cancelled batches, and the
  // scheduler's publish-batch task can re-run a completed or failed one, so
  // those are repointed too; cancelled and archived keep the ids they ran with.
  {
    id: "b_completed",
    projectId: "p1",
    status: "completed",
    archived: false,
    metadata: meta(["d_a"]),
  },
  { id: "b_failed", projectId: "p1", status: "failed", archived: false, metadata: meta(["d_b"]) },
  {
    id: "b_cancelled",
    projectId: "p1",
    status: "cancelled",
    archived: false,
    metadata: meta(["d_a"]),
  },
  { id: "b_archived", projectId: "p1", status: "pending", archived: true, metadata: meta(["d_a"]) },
  // Another project's retired draft is not this batch's to repoint.
  { id: "b_foreign", projectId: "p2", status: "pending", archived: false, metadata: meta(["d_a"]) },
  { id: "b_null", projectId: "p1", status: "pending", archived: false, metadata: null },
  { id: "b_clean", projectId: "p1", status: "pending", archived: false, metadata: meta(["d_c"]) },
];

/** draftIds after #402, per batch; batches not listed keep their metadata byte-for-byte. */
export const DRAFT_IDS_AFTER_402: Record<string, string[]> = {
  b_pending: ["d_d", "c_kept", "d_c", "nope"],
  b_running: ["d_c"],
  b_completed: ["d_c"],
  b_failed: ["d_c"],
};

export const USER_ID = "u1";
export const PROJECT_IDS = ["p1", "p2"];
export const SEED_TIME = T0;
