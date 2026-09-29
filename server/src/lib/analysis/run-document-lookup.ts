/**
 * #384 — the per-run document lookups the citation-id repair (#298/#303) uses,
 * memoized so a normal grounded answer costs no query once its ids are known.
 *
 * `loadKnownDocuments` loads the project's document list at most once per run.
 * The promise is memoized, so a failed load is memoized too: every later
 * repair in the run sees the same rejection and degrades to "no known
 * documents" (unchanged from #303).
 *
 * `findKnownDocumentIds` answers without a query when every id was already
 * confirmed earlier in the run, or when the full list has been loaded. Only
 * successful answers are remembered, and only positively: an id that was not
 * found is asked about again (or answered by the full list, which the repair
 * loads in that case anyway). The `in` list is capped at
 * {@link MAX_DOCUMENT_ID_LOOKUP}; ids past the cap are reported as not found,
 * which makes the repair load the (project-scoped) list and answer from it —
 * so the bound does not depend on the provider's output limit.
 *
 * Pure: the caller supplies both queries, already scoped to the project.
 */
import type { FindKnownDocumentIds, KnownDocument } from "./findings-repair.js";

/**
 * The most ids one id check sends to the database. The schema allows 50
 * findings × 20 citations, but the check runs on the model's answer BEFORE the
 * schema does, so without a cap the list is bounded only by the output limit.
 */
export const MAX_DOCUMENT_ID_LOOKUP = 100;

export interface RunDocumentLookupQueries {
  /** Every live document of the project. */
  listDocuments: () => Promise<readonly KnownDocument[]>;
  /** Of `ids`, the ones that are live documents of the project. */
  findDocumentIds: (ids: readonly string[]) => Promise<readonly string[]>;
}

export interface RunDocumentLookup {
  loadKnownDocuments: () => Promise<readonly KnownDocument[]>;
  findKnownDocumentIds: FindKnownDocumentIds;
}

export function createRunDocumentLookup(queries: RunDocumentLookupQueries): RunDocumentLookup {
  let knownDocuments: Promise<readonly KnownDocument[]> | undefined;
  /** Every id of the loaded list, once (and only if) the load succeeded. */
  let loadedIds: ReadonlySet<string> | undefined;
  const confirmed = new Set<string>();

  const loadKnownDocuments = (): Promise<readonly KnownDocument[]> =>
    (knownDocuments ??= queries.listDocuments().then((docs) => {
      loadedIds = new Set(docs.map((d) => d.id));
      return docs;
    }));

  const findKnownDocumentIds: FindKnownDocumentIds = async (ids) => {
    const known = loadedIds;
    if (known) return ids.filter((id) => known.has(id));
    const unconfirmed = [...new Set(ids)].filter((id) => !confirmed.has(id));
    if (unconfirmed.length > 0) {
      const found = await queries.findDocumentIds(unconfirmed.slice(0, MAX_DOCUMENT_ID_LOOKUP));
      for (const id of found) confirmed.add(id);
    }
    return ids.filter((id) => confirmed.has(id));
  };

  return { loadKnownDocuments, findKnownDocumentIds };
}
