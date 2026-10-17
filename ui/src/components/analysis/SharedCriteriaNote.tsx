/**
 * Issue #1203 — say on a requirement when its acceptance criteria were written
 * for it and other requirements together, and link to those requirements.
 *
 * Synthesis can group several reviewed requirements under one item, and every
 * approved requirement the item names receives all of its criteria (#1187), so
 * some of them were written for a sibling. Promotion records that
 * (`metadata.promotionMatching.shared`); the caller decides with
 * `sharedCriteriaToMark` whether the criteria are still the promoted ones, and
 * renders nothing once the analyst has edited them.
 *
 * Used by the requirement card and the review card, so both say the same thing.
 */
import Link from "next/link";
import {
  SHARED_CRITERIA_ANALYST_HINT,
  sharedCriteriaMarks,
  sharedCriteriaToMark,
  type SharedCriteriaRecord,
  type SharedCriteriaSibling,
} from "@metis/shared";
import { AcceptanceCriteriaList } from "@/components/analysis/AcceptanceCriteriaList";

/** The deep link that opens a requirement's card on the analysis page (#424). */
export function requirementCardHref(
  projectId: string,
  analysisId: string,
  requirementId: string,
): string {
  const enc = encodeURIComponent;
  return `/projects/${enc(projectId)}/analysis?analysisId=${enc(analysisId)}&requirementId=${enc(requirementId)}`;
}

/**
 * The criteria to mark "shared" in a list: only when not all of it is shared.
 * The one rule in `@metis/shared` that the published issue uses too.
 */
export { sharedCriteriaMarks };

export function SharedCriteriaNote({
  record,
  criteria,
  hrefFor,
  titleOf = () => undefined,
}: {
  /** The record to show, or `null` (renders nothing). */
  record: SharedCriteriaRecord | null;
  /** The criteria as shown, to tell "all of these" from "the ones marked". */
  criteria: readonly string[];
  /**
   * The link to a sibling's card, or `undefined` when there is nowhere to go —
   * the caller returns `undefined` for a row it does not know to be live, so a
   * deleted sibling is named but never linked to a card that does not exist.
   */
  hrefFor: (requirementId: string) => string | undefined;
  /** A sibling's current title, when the caller knows the row. */
  titleOf?: (requirementId: string) => string | undefined;
}): React.ReactElement | null {
  if (!record) return null;
  const partial = sharedCriteriaMarks(record, criteria).size > 0;
  return (
    <p
      role="note"
      data-testid={`shared-criteria-${record.requirementId}`}
      className="mt-2 rounded border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground"
    >
      {partial ? "The criteria marked “shared” are shared with " : "Shared with "}
      {record.sharedWith.map((s, i) => (
        <span key={s.structuredId}>
          {i > 0 ? (i === record.sharedWith.length - 1 ? " and " : ", ") : null}
          <SiblingName sibling={s} hrefFor={hrefFor} titleOf={titleOf} />
        </span>
      ))}
      {" — "}
      {SHARED_CRITERIA_ANALYST_HINT}
    </p>
  );
}

function SiblingName({
  sibling,
  hrefFor,
  titleOf,
}: {
  sibling: SharedCriteriaSibling;
  hrefFor: (requirementId: string) => string | undefined;
  titleOf: (requirementId: string) => string | undefined;
}): React.ReactElement {
  const id = sibling.requirementId;
  const title = (id && titleOf(id)) || sibling.title;
  const href = id ? hrefFor(id) : undefined;
  return (
    <>
      {href ? (
        <Link href={href} className="font-medium text-foreground underline underline-offset-2">
          {title}
        </Link>
      ) : (
        <span className="font-medium text-foreground">{title}</span>
      )}
      {!id && !sibling.approved ? " (not approved)" : null}
    </>
  );
}

/**
 * A requirement card's acceptance criteria, with the shared ones marked and
 * the note under them while the criteria are still the promoted ones.
 */
export function RequirementCriteria({
  metadata,
  requirementId,
  criteria,
  projectId,
  analysisId,
  titleOf,
}: {
  metadata: Record<string, unknown> | null | undefined;
  requirementId: string;
  criteria: string[];
  projectId: string;
  analysisId: string;
  /**
   * A sibling's current title from the page's own requirement list, or
   * `undefined` when the page does not list that row (a deleted sibling): it is
   * then named by its promoted title and not linked, since the page has no
   * card for the link to open.
   */
  titleOf: (requirementId: string) => string | undefined;
}): React.ReactElement {
  const record = sharedCriteriaToMark(metadata, requirementId, criteria);
  return (
    <>
      <AcceptanceCriteriaList criteria={criteria} shared={sharedCriteriaMarks(record, criteria)} />
      <SharedCriteriaNote
        record={record}
        criteria={criteria}
        hrefFor={(id) =>
          titleOf(id) !== undefined ? requirementCardHref(projectId, analysisId, id) : undefined
        }
        titleOf={titleOf}
      />
    </>
  );
}
