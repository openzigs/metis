/**
 * #2593 — what an impact result leads with: the requirements it covers and the
 * files to edit, never the raw symbol reach.
 *
 * "1 project(s) · 3305 impacted symbol(s)" headed a two-requirement result whose
 * files to edit were short and correct. The symbol count is the whole reach —
 * every caller, importer and related symbol the graph walk touched — and read
 * as the size of the change. It stays, as secondary detail that says what it is.
 *
 * One definition of "a file to edit" serves the page header, each requirement's
 * own headline and the markdown export, so the three counts cannot drift.
 */
import {
  impactFileKey,
  impactSymbolRole,
  type ImpactAffectedSymbolView,
  type ImpactDatabaseNotCheckedReason,
  type ImpactSeedEvidence,
} from "./impact.js";

/** What {@link impactEditFileKeys} reads from an impact item. */
export interface ImpactEditFileSource {
  affectedSymbols: ReadonlyArray<Pick<ImpactAffectedSymbolView, "filePath" | "depth" | "repo">>;
  seedEvidence?: ImpactSeedEvidence;
}

/**
 * The files to edit of one impact item, keyed by {@link impactFileKey}, in
 * first-seen order. A file whose seed evidence carries a `doubtful` verdict
 * (#1820) is listed on the page for review and is not a file to edit, so it is
 * left out here. The evidence entry is matched as the page matches it
 * (`orderEditFiles`): the first entry with the file's path whose repository is
 * unknown on either side or the same.
 */
export function impactEditFileKeys(item: ImpactEditFileSource): string[] {
  const files = new Map<string, { filePath: string; repoId: string | null }>();
  for (const s of item.affectedSymbols) {
    if (impactSymbolRole(s) !== "edit-candidate") continue;
    const key = impactFileKey(s);
    if (!files.has(key)) files.set(key, { filePath: s.filePath, repoId: s.repo?.id ?? null });
  }
  const evidence = item.seedEvidence;
  if (!evidence) return [...files.keys()];
  return [...files].flatMap(([key, f]) => {
    const entry = evidence.editCandidates.find(
      (e) =>
        e.filePath === f.filePath &&
        (e.repoConnectionId === undefined || f.repoId === null || e.repoConnectionId === f.repoId),
    );
    return entry?.verdict?.kind === "doubtful" ? [] : [key];
  });
}

/**
 * #2593 — what makes two impact items the same requirement, for counting: its
 * tracked id; else, for a change read from a document or pasted text (no
 * `Requirement` row), its snapshotted title, so one change reaching two
 * projects counts once; else the item itself.
 */
export function impactRequirementKey(item: {
  id: string;
  requirementId?: string | null;
  requirementTitle?: string | null;
}): string {
  if (item.requirementId) return `r:${item.requirementId}`;
  const title = item.requirementTitle?.trim();
  return title ? `t:${title}` : `i:${item.id}`;
}

/** #2593 — the run-level headline of an impact result. */
export interface ImpactRunHeadline {
  /** Distinct requirements with an impact item, as {@link impactRequirementKey} tells them apart. */
  requirementCount: number;
  /** Distinct files to edit across every item, a file being (project, repository, path). */
  editFileCount: number;
}

/** #2593 — the requirements and files to edit across a run's items. */
export function impactRunHeadline(
  items: ReadonlyArray<
    ImpactEditFileSource & {
      id: string;
      projectId: string;
      requirementId: string | null;
      requirementTitle?: string | null;
    }
  >,
): ImpactRunHeadline {
  const requirements = new Set<string>();
  const files = new Set<string>();
  for (const item of items) {
    requirements.add(impactRequirementKey(item));
    for (const key of impactEditFileKeys(item)) files.add(`${item.projectId}\u0000${key}`);
  }
  return { requirementCount: requirements.size, editFileCount: files.size };
}

/** `1 file`, `2 files` — the counts this module's callers print. */
export function impactCountLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`;
}

/**
 * #2593 — the one sentence for the raw symbol reach, wherever it is shown: it
 * is review material, not the size of the change.
 */
export function impactReachLabel(totalImpactedSymbols: number): string {
  return `Reach: ${impactCountLabel(totalImpactedSymbols, "code symbol")} — the callers and related code to review; not each one changes.`;
}

/**
 * #2593 — said where a requirement lists no affected table and the run did not
 * read the project's database (no database connector, or it could not be read).
 * Without it, "no tables" read as "no database change", and the summary said
 * the impact was "confined to code" beside findings that need a migration.
 */
export const IMPACT_DATABASE_NOT_CHECKED = "Database impact not checked (no database connection)";

/** #2593 — as {@link IMPACT_DATABASE_NOT_CHECKED}, for a run started with schema analysis off. */
export const IMPACT_DATABASE_NOT_CHECKED_SCHEMA_OFF =
  "Database impact not checked (schema analysis was off for this run)";

/**
 * #2593 — the "database not checked" sentence for a reason. A missing reason
 * reads as no connection, the case the sentence was first written for.
 */
export function impactDatabaseNotCheckedLabel(
  reason: ImpactDatabaseNotCheckedReason | null | undefined,
): string {
  return reason === "schema-off"
    ? IMPACT_DATABASE_NOT_CHECKED_SCHEMA_OFF
    : IMPACT_DATABASE_NOT_CHECKED;
}
