/**
 * #399 / #432 — scheduling automatic document regeneration after an ingest, told
 * apart from a failure of the ingest itself.
 *
 * Every ingest entry point (Deep Ingest, the refresh-ingest route and the
 * scheduled repo refresh) schedules regeneration only once the ingest has landed.
 * If that scheduling then fails, reporting "ingestion failed" is wrong: the data
 * is in, and only the regeneration still has to be retried (#1356).
 */
import { checkIncrementalRegeneration } from "./incremental.js";

/**
 * The only text a scheduling failure may carry to a client or a task record. The
 * underlying exception stays on `cause`, for the server log (#114, #254).
 */
export const REGENERATION_SCHEDULING_FAILED_MESSAGE =
  "The repository was ingested, but scheduling automatic document regeneration failed. " +
  "The details are in the server log; the next ingest of this repository retries it.";

/** Marks a failure to schedule regeneration apart from a failure of the ingest. */
export class RegenerationSchedulingError extends Error {
  constructor(cause: unknown) {
    super(REGENERATION_SCHEDULING_FAILED_MESSAGE, { cause });
    this.name = "RegenerationSchedulingError";
  }
}

/**
 * Schedule regeneration for a connector whose ingest has landed. Any failure is
 * rethrown as a {@link RegenerationSchedulingError}, so it still propagates (a
 * replay retries the scheduling) but can no longer be mistaken for the ingest's.
 */
export async function scheduleIncrementalRegeneration(
  projectId: string,
  repoConnectorId: string,
): Promise<void> {
  try {
    await checkIncrementalRegeneration(projectId, repoConnectorId);
  } catch (err) {
    throw new RegenerationSchedulingError(err);
  }
}
