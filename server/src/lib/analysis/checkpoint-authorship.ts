/**
 * Issue #2436 — maker-checker on the approval checkpoint.
 *
 * Editing a requirement's wording in the checkpoint (#1580) makes the editor
 * one of its authors, just as an edit on the Requirements page does. Without a
 * record of that, someone could reword a requirement in the checkpoint, sign
 * the checkpoint off, and have their own wording promoted as `approved`.
 *
 * Three pieces, all read from the analysis's metadata:
 *
 * - {@link CHECKPOINT_EDITORS_KEY}: who edited each structured requirement of
 *   the extraction run under review. Written by the checkpoint edit in the same
 *   transaction as the edit; scoped to the run (`runId`), because every run
 *   numbers its list from `REQ-001` (#909).
 * - {@link CHECKPOINT_HELD_KEY}: the structured ids a promotion wrote as
 *   awaiting review (`draft`) instead of `approved` because the sign-off came
 *   from one of their authors. A later re-save or append of the same run keeps
 *   them held, so a re-save can never widen what the promotion decided.
 * - {@link isCheckpointEditor}: whether an actor edited a promoted row's
 *   structured requirement — the direct-approval maker-checker counts that as
 *   authorship, so the editor cannot approve the held row on the list either.
 *
 * Pure: no database access.
 */

/** Analysis metadata key: `{ runId, editors: { [structuredId]: userId[] } }`. */
export const CHECKPOINT_EDITORS_KEY = "checkpointRequirementEditors";

/** Analysis metadata key: `{ runId, ids: structuredId[] }`. */
export const CHECKPOINT_HELD_KEY = "checkpointHeldForReview";

/** What a promotion's response says about requirements it held for review. */
export const CHECKPOINT_HELD_REASON =
  "Requirements edited in the checkpoint by the person who approved them were promoted as awaiting review, not approved: someone else must approve them. A coordinator or admin can allow self-approval in the project's Publishing settings.";

type Metadata = Record<string, unknown>;

function sameRun(recorded: unknown, runId: string | null | undefined): boolean {
  const rec = typeof recorded === "string" ? recorded : null;
  return rec === (runId ?? null);
}

/** Structured id → the users who edited it in the checkpoint of run `runId`. */
export function readCheckpointEditors(
  metadata: Metadata,
  runId: string | null | undefined,
): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const raw = metadata[CHECKPOINT_EDITORS_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  const record = raw as { runId?: unknown; editors?: unknown };
  if (!sameRun(record.runId, runId)) return out;
  if (!record.editors || typeof record.editors !== "object") return out;
  for (const [id, users] of Object.entries(record.editors as Record<string, unknown>)) {
    if (!Array.isArray(users)) continue;
    out.set(id, new Set(users.filter((u): u is string => typeof u === "string")));
  }
  return out;
}

/**
 * `metadata` with `actorId` recorded as an editor of `structuredId` in run
 * `runId`. A record for another run is replaced, not merged.
 */
export function withCheckpointEditor(
  metadata: Metadata,
  runId: string | null | undefined,
  structuredId: string,
  actorId: string,
): Metadata {
  const current = readCheckpointEditors(metadata, runId);
  const users = current.get(structuredId) ?? new Set<string>();
  users.add(actorId);
  current.set(structuredId, users);
  return {
    ...metadata,
    [CHECKPOINT_EDITORS_KEY]: {
      runId: runId ?? null,
      editors: Object.fromEntries([...current].map(([id, set]) => [id, [...set]])),
    },
  };
}

/** Whether `actorId` edited `structuredId` in the checkpoint of run `runId`. */
export function isCheckpointEditor(
  metadata: Metadata,
  runId: string | null | undefined,
  structuredId: string | null | undefined,
  actorId: string,
): boolean {
  if (!structuredId) return false;
  return readCheckpointEditors(metadata, runId).get(structuredId)?.has(actorId) ?? false;
}

/** The structured ids of run `runId` an earlier promotion held for review. */
export function readHeldForReview(metadata: Metadata, runId: string | null | undefined): string[] {
  const raw = metadata[CHECKPOINT_HELD_KEY];
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const record = raw as { runId?: unknown; ids?: unknown };
  if (!sameRun(record.runId, runId) || !Array.isArray(record.ids)) return [];
  return record.ids.filter((x): x is string => typeof x === "string");
}

/** The metadata value recording `ids` as held for review in run `runId`. */
export function heldForReviewRecord(
  runId: string | null | undefined,
  ids: Iterable<string>,
): { runId: string | null; ids: string[] } {
  return { runId: runId ?? null, ids: [...new Set(ids)] };
}

/**
 * The structured requirements a checkpoint promotion must hold for review:
 * those an author of theirs signed off. An author is someone who edited it in
 * the checkpoint; the sign-off is the promoter's (#1588), and the item's own
 * checkpoint approval is its reviewer's, so either being an editor holds it.
 * Nothing is held when the project allows self-approval.
 */
export function selfAuthoredCheckpointIds(input: {
  editors: ReadonlyMap<string, ReadonlySet<string>>;
  ids: Iterable<string>;
  signerId: string | null | undefined;
  reviewerByItem: ReadonlyMap<string, string | null | undefined>;
  allowSelfApproval: boolean;
}): Set<string> {
  const held = new Set<string>();
  if (input.allowSelfApproval) return held;
  for (const id of input.ids) {
    const editors = input.editors.get(id);
    if (!editors || editors.size === 0) continue;
    const reviewer = input.reviewerByItem.get(id);
    if ((input.signerId && editors.has(input.signerId)) || (reviewer && editors.has(reviewer))) {
      held.add(id);
    }
  }
  return held;
}
