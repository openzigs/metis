/**
 * Durable clarification dialog state store (Epic #201 / Issue #210).
 *
 * Replaces the prior module-level in-memory `Map` so in-flight clarification
 * survives a server restart. State is checkpointed to the
 * `ClarificationDialogState` Prisma table keyed by `analysisId`; reads
 * rehydrate the JSON blob (interrupt/resume pattern, native Prisma — no
 * external orchestrator).
 *
 * Security: `analysisId` is only ever used as a Prisma `where` value (bound
 * parameter), never string-interpolated into SQL, so it cannot be used for
 * injection. The serialized payload is JSON and is parsed defensively.
 */
import type { Prisma } from "@prisma/client";
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { isUniqueViolation } from "../db/prisma-errors.js";
import type { ClarificationState } from "./types/requirements.js";

const log = createChildLogger("clarification-dialog-store");

/**
 * #2270 — what a dialog is about when it is not a requirements analysis: an
 * Impact Analysis run or a portfolio check started on a document. Its state
 * lives in `SubjectClarificationDialog`, keyed on the subject, because neither
 * has an `Analysis` row for `ClarificationDialogState` to key on.
 */
export type DialogSubjectKind = "impact" | "portfolio";

/**
 * #2270 — which dialog: an analysis id (the requirements analysis's dialog,
 * as before), or a subject. Every store function takes either.
 */
export type DialogKey = string | { kind: DialogSubjectKind; id: string };

type SubjectWhere = { impactAnalysisId: string } | { portfolioAssessmentId: string };

/** The subject's unique column, as a Prisma `where`. */
export function subjectWhere(key: { kind: DialogSubjectKind; id: string }): SubjectWhere {
  return key.kind === "impact" ? { impactAnalysisId: key.id } : { portfolioAssessmentId: key.id };
}

/** One string per dialog, for logs and process-local maps: distinct across kinds. */
export function dialogKeyString(key: DialogKey): string {
  return typeof key === "string" ? key : `${key.kind}:${key.id}`;
}

/**
 * Read the durable dialog state for an analysis, or `undefined` when none has
 * been checkpointed (or the stored blob is unparseable).
 */
export async function readDialogState(key: DialogKey): Promise<ClarificationState | undefined> {
  return (await readDialogStateRevision(key))?.state;
}

/**
 * Upsert the durable dialog state for an analysis. Idempotent: repeated writes
 * with the same `analysisId` overwrite the prior checkpoint.
 */
export async function writeDialogState(key: DialogKey, state: ClarificationState): Promise<void> {
  const serialized = JSON.stringify(state);
  if (typeof key !== "string") {
    // #2270 — the run created the row with its requirements; there is no
    // dialog to write without one.
    await prisma.subjectClarificationDialog.update({
      where: subjectWhere(key),
      data: { state: serialized },
    });
    return;
  }
  const analysisId = key;
  await prisma.clarificationDialogState.upsert({
    where: { analysisId },
    create: { analysisId, state: serialized },
    update: { state: serialized },
  });
}

/**
 * #2101 — the stored state as read, with the exact serialized row it came
 * from: the revision a later {@link replaceDialogState} compares against.
 */
export interface DialogStateRevision {
  state: ClarificationState;
  revision: string;
}

/**
 * #2101 — read the state together with its revision, for a caller that will
 * write it back with {@link replaceDialogState}. `undefined` as
 * {@link readDialogState} is.
 */
export async function readDialogStateRevision(
  key: DialogKey,
): Promise<DialogStateRevision | undefined> {
  const row =
    typeof key === "string"
      ? await prisma.clarificationDialogState.findUnique({
          where: { analysisId: key },
          select: { state: true },
        })
      : await prisma.subjectClarificationDialog.findUnique({
          where: subjectWhere(key) as Prisma.SubjectClarificationDialogWhereUniqueInput,
          select: { state: true },
        });
  // #2270 — a subject's row exists before its dialog starts, with no state.
  if (!row || row.state === null) return undefined;
  try {
    return { state: JSON.parse(row.state) as ClarificationState, revision: row.state };
  } catch {
    log.warn("Corrupt clarification dialog state — ignoring", { dialog: dialogKeyString(key) });
    return undefined;
  }
}

/**
 * #2101 — compare-and-set: write `state` only while the row still holds
 * `revision`, in one conditional UPDATE, so two writers that read the same
 * revision cannot both succeed. Returns the new revision, or `null` when the
 * row changed (or is gone) since it was read, and nothing was written.
 *
 * #2142 — `revision` `undefined` is a writer that read no row: the state is
 * created only while there is still none, and `null` when another writer
 * created it first. `client` is the transaction to write in, if any.
 */
export async function replaceDialogState(
  key: DialogKey,
  revision: string | undefined,
  state: ClarificationState,
  client: Prisma.TransactionClient = prisma,
): Promise<string | null> {
  const serialized = JSON.stringify(state);
  if (typeof key !== "string") return replaceSubjectState(key, revision, serialized, client);
  const analysisId = key;
  if (revision === undefined) {
    // A writer that read no state may have read a row that will not parse
    // (readDialogStateRevision ignores it). Creating would then collide with
    // that row forever, so compare-and-set over its raw text instead: the
    // corrupt row is replaced, as the old unconditional upsert replaced it.
    // Read first rather than catching the create's unique violation, which
    // would abort an enclosing Postgres transaction.
    const existing = await client.clarificationDialogState.findUnique({
      where: { analysisId },
      select: { state: true },
    });
    if (existing) {
      if (parses(existing.state)) return null;
      const { count } = await client.clarificationDialogState.updateMany({
        where: { analysisId, state: existing.state },
        data: { state: serialized },
      });
      return count === 1 ? serialized : null;
    }
    try {
      await client.clarificationDialogState.create({ data: { analysisId, state: serialized } });
      return serialized;
    } catch (err) {
      if (isUniqueViolation(err)) return null;
      throw err;
    }
  }
  const { count } = await client.clarificationDialogState.updateMany({
    where: { analysisId, state: revision },
    data: { state: serialized },
  });
  return count === 1 ? serialized : null;
}

/**
 * #2142 — {@link replaceDialogState} and the writes that belong with it, in one
 * transaction: `alongside` runs only once the compare-and-set has landed, and
 * when it throws, the state write is rolled back with it and the error
 * rethrown. So a submit's round and its refined requirements are committed
 * together or not at all — a refused or crashed submit never consumes the
 * round, and no restore write is needed (#2101's could itself be overwritten).
 * Returns the new revision, or `null` when the compare-and-set found the row
 * changed, and neither it nor `alongside` wrote anything.
 *
 * #2156 — lock order, on Postgres: the compare-and-set locks the dialog row
 * first, and the submit's `alongside` (the metadata merge) then locks the
 * `analyses` row. A hard delete of an analysis takes them the other way
 * round — the `analyses` row, then this row through `onDelete: Cascade` (so
 * does a hard delete of its project). No app path does that: `deleteProject`
 * is a soft delete and `server/src` deletes no analysis, so only an
 * out-of-band delete (the dev and eval scripts in `server/scripts`) can race a
 * submit into a deadlock. Postgres then aborts one of the two transactions,
 * which rolls back whole and fails (nothing half-written). Harmless, but not
 * deadlock-free: do not cite this order as one nothing reverses.
 */
export async function commitDialogState(
  key: DialogKey,
  revision: string,
  state: ClarificationState,
  alongside: (tx: Prisma.TransactionClient) => Promise<void>,
): Promise<string | null> {
  return prisma.$transaction(async (tx) => {
    const committed = await replaceDialogState(key, revision, state, tx);
    if (committed !== null) await alongside(tx);
    return committed;
  });
}

/**
 * #2270 — {@link replaceDialogState} for a subject's dialog. Its row is
 * created by the run, with the requirements and no state, so a first write is
 * a compare-and-set on `state` being null (or, as for an analysis, on the raw
 * text of a state that will not parse). No row: nothing to write, `null`.
 */
async function replaceSubjectState(
  key: { kind: DialogSubjectKind; id: string },
  revision: string | undefined,
  serialized: string,
  client: Prisma.TransactionClient,
): Promise<string | null> {
  const where = subjectWhere(key);
  let expected: string | null;
  if (revision === undefined) {
    const existing = await client.subjectClarificationDialog.findUnique({
      where: where as Prisma.SubjectClarificationDialogWhereUniqueInput,
      select: { state: true },
    });
    if (!existing) return null;
    if (existing.state !== null && parses(existing.state)) return null;
    expected = existing.state;
  } else {
    expected = revision;
  }
  const { count } = await client.subjectClarificationDialog.updateMany({
    where: { ...where, state: expected },
    data: { state: serialized },
  });
  return count === 1 ? serialized : null;
}

function parses(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/**
 * Delete the durable dialog state for an analysis (no-op when absent). #2270 —
 * a subject's dialog keeps its row (it holds the run's requirements): only its
 * state is cleared, so the questions can be asked again.
 */
export async function deleteDialogState(key: DialogKey): Promise<void> {
  if (typeof key !== "string") {
    await prisma.subjectClarificationDialog.updateMany({
      where: subjectWhere(key),
      data: { state: null },
    });
    return;
  }
  await prisma.clarificationDialogState.deleteMany({ where: { analysisId: key } });
}
