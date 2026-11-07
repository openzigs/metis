/**
 * Issue #1918 — rebuild the governing-document vector tables from the text the
 * database already holds (`GoverningDocumentRevision.extractedText`).
 *
 * Two things leave a live revision unsearchable while its row says nothing is
 * wrong, and this sweep repairs both:
 *
 *   - an embedding-model change. A search filters on the active model's
 *     identity, so after a change every governing row is ignored and search
 *     returns `[]`. A workspace whose table holds any row on another identity is
 *     rebuilt whole: a new model can also change the vector width, which a
 *     Lance table cannot mix. On pgvector the destructive column migration
 *     (`embeddings:migrate prepare`) deletes every governing row, which reads
 *     here as revisions with no rows at all.
 *   - a failed embed at upload, which leaves the revision `pending` with no rows.
 *
 * #1947 — a rebuild is written into a shadow table and swapped in when it is
 * complete (`GoverningIndex.beginShadow` / `swapInShadow`, the store's reindex
 * swap), so search keeps reading the live table until then. An admin may upload
 * a revision while the sweep runs: its rows land in the live table the swap
 * replaces, and it is not in the sweep's snapshot. So after the swap the sweep
 * reads the workspace's revisions again and embeds any with no row on the
 * active model. A revision row is written before its upload embeds it, so one
 * the re-read misses was embedded after the swap, into the new live table.
 *
 * A revision with no row on the active identity is embedded again and marked
 * `indexed`; one that fails is marked `pending` and reported, and the sweep goes
 * on. `embeddings:migrate reindex --all` runs it after the projects
 * (`reindexAll`, `lib/rag/embed-migration.ts`), and `embeddings:migrate status`
 * reports what it would do ({@link governingCoverage}). Behind
 * `GOVERNING_DOCS_ENABLED`, like every governing job: with the flag off it
 * touches nothing.
 */
import { createChildLogger } from "../logger.js";
import { isGoverningDocsEnabled } from "./flag.js";
import { getGoverningIndex, type GoverningIndex } from "./governing-index.js";
import {
  listReindexTargets,
  revisionText,
  setRevisionIndexState,
  type GoverningReindexTarget,
} from "./governing-store.js";

const log = createChildLogger("governing-reindex");

export interface GoverningReindexResult {
  /** `true` when the flag is off and nothing was read or written. */
  skipped: boolean;
  /** Live revisions examined. */
  revisions: number;
  /** Workspaces whose table was rebuilt because it held another model's rows. */
  rebuiltWorkspaces: string[];
  /** Revisions embedded again, with their chunk counts. */
  reindexed: Array<{ workspaceId: string; revisionId: string; chunkCount: number }>;
  failures: Array<{ workspaceId: string; revisionId: string; error: string }>;
}

type Revision = GoverningReindexTarget["revisions"][number];

export async function reindexGoverningRevisions(
  deps: { index?: GoverningIndex } = {},
): Promise<GoverningReindexResult> {
  const result: GoverningReindexResult = {
    skipped: !isGoverningDocsEnabled(),
    revisions: 0,
    rebuiltWorkspaces: [],
    reindexed: [],
    failures: [],
  };
  if (result.skipped) return result;

  const targets = await listReindexTargets();
  if (targets.length === 0) return result;
  const index = deps.index ?? getGoverningIndex();
  const active = await index.activeEmbeddingIdentity();

  /** Embed one revision into the live table or the shadow; `false` on a failure, recorded. */
  async function embed(workspaceId: string, rev: Revision, shadow: boolean): Promise<boolean> {
    try {
      const text = await revisionText(workspaceId, rev.revisionId);
      // The upload's filename is not stored; the row's `filename` is metadata only.
      const chunkCount = await index.indexRevision(
        { workspaceId, revisionId: rev.revisionId, filename: rev.title, text: text ?? "" },
        { shadow },
      );
      result.reindexed.push({ workspaceId, revisionId: rev.revisionId, chunkCount });
      return true;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log.warn("governing revision reindex failed", {
        workspaceId,
        revisionId: rev.revisionId,
        error,
      });
      result.failures.push({ workspaceId, revisionId: rev.revisionId, error });
      return false;
    }
  }

  for (const target of targets) {
    const { workspaceId } = target;
    result.revisions += target.revisions.length;
    let revisions = target.revisions;
    let stored = await index.storedIdentities(workspaceId);
    const failed = new Set<string>();
    if (hasForeignRows(stored, active)) {
      await index.beginShadow(workspaceId);
      for (const rev of revisions) {
        if (!(await embed(workspaceId, rev, true))) failed.add(rev.revisionId);
      }
      await index.swapInShadow(workspaceId);
      result.rebuiltWorkspaces.push(workspaceId);
      // The re-read: a revision uploaded since the snapshot is not in the shadow.
      const snapshot = new Set(revisions.map((r) => r.revisionId));
      revisions = (await listReindexTargets(workspaceId))[0]?.revisions ?? [];
      // Revisions that arrived after the snapshot are swept too, so they count.
      result.revisions += revisions.filter((r) => !snapshot.has(r.revisionId)).length;
      stored = await index.storedIdentities(workspaceId);
    }
    for (const rev of revisions) {
      if (stored.get(rev.revisionId)?.has(active)) {
        if (rev.indexState !== "indexed") {
          await setRevisionIndexState(workspaceId, rev.revisionId, "indexed");
        }
        continue;
      }
      // A revision the shadow pass already failed is not tried a second time.
      const ok = !failed.has(rev.revisionId) && (await embed(workspaceId, rev, false));
      await setRevisionIndexState(workspaceId, rev.revisionId, ok ? "indexed" : "pending");
    }
  }
  return result;
}

function hasForeignRows(stored: Map<string, Set<string>>, active: string): boolean {
  return [...stored.values()].some((ids) => [...ids].some((id) => id !== active));
}

/**
 * #1947 — what {@link reindexGoverningRevisions} would do, for
 * `embeddings:migrate status`: per workspace, the live revisions with no row
 * on the active embedding model (dark to search: an un-swept model change, a
 * pgvector `prepare`, or a failed upload embed), and whether its table holds
 * another model's rows. Only workspaces with something to do are listed.
 */
export interface GoverningCoverage {
  /** `true` when the flag is off: nothing was read, and the sweep would skip too. */
  skipped: boolean;
  /** Live revisions examined. */
  revisions: number;
  workspaces: Array<{ workspaceId: string; darkRevisions: string[]; foreignRows: boolean }>;
}

export async function governingCoverage(
  deps: { index?: GoverningIndex } = {},
): Promise<GoverningCoverage> {
  const coverage: GoverningCoverage = {
    skipped: !isGoverningDocsEnabled(),
    revisions: 0,
    workspaces: [],
  };
  if (coverage.skipped) return coverage;
  const targets = await listReindexTargets();
  if (targets.length === 0) return coverage;
  const index = deps.index ?? getGoverningIndex();
  const active = await index.activeEmbeddingIdentity();
  for (const { workspaceId, revisions } of targets) {
    coverage.revisions += revisions.length;
    const stored = await index.storedIdentities(workspaceId);
    const darkRevisions = revisions
      .filter((rev) => !stored.get(rev.revisionId)?.has(active))
      .map((rev) => rev.revisionId);
    const foreignRows = hasForeignRows(stored, active);
    if (darkRevisions.length > 0 || foreignRows) {
      coverage.workspaces.push({ workspaceId, darkRevisions, foreignRows });
    }
  }
  return coverage;
}
