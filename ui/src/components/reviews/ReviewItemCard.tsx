"use client";

/**
 * Epic #609 / Issue #618 — one scoped artifact inside a review.
 *
 * Requirement items render their content AT THE PINNED VERSION (reconstructed
 * snapshot from the requirement-history API, epic #770) plus the field-level
 * diff that version introduced. Spec-document items render title + pin only —
 * document version diffs are out of scope for this issue.
 *
 * #2219 — when the requirement has been edited since the pin, an approved or
 * in-review card says so ("v2 differs from the approved v1") with the diff from
 * the pinned version to the current one: an approval is of a wording, and the
 * wording on the card is no longer the requirement's.
 */
import { useQuery } from "@tanstack/react-query";
import { criteriaAsPromoted, parseAcceptanceCriteria } from "@metis/shared";
import { RequirementBody } from "@/components/analysis/RequirementBody";
import {
  requirementCardHref,
  SharedCriteriaNote,
  sharedCriteriaMarks,
} from "@/components/analysis/SharedCriteriaNote";
import { Card } from "@/components/ui/card";
import { historyApi, type ChangedFields } from "@/lib/history-api";
import { queryKeys } from "@/lib/query-keys";
import type { ReviewItem, ReviewRequest, ReviewStatus } from "@/lib/reviews-api";
import { VersionDiff } from "./VersionDiff";

/**
 * Snapshot fields rendered as metadata under the body. #1162 — no
 * `reviewStatus`: a snapshot no longer carries it (it is not versioned).
 */
const META_FIELDS = ["priority", "type", "storyPoints"] as const;

/** Review statuses whose pinned versions an edit puts out of date (#2219). */
const PINNING_STATUSES: ReadonlySet<ReviewStatus> = new Set(["approved", "in_review"]);

/**
 * #2219 — the requirement's current version when it was edited after `item`
 * was pinned and the review still stands on the pin (approved or in review);
 * otherwise null. Exported for testing.
 */
export function outOfDateVersion(item: ReviewItem, status: ReviewStatus): number | null {
  if (!PINNING_STATUSES.has(status)) return null;
  const current = item.requirement?.version;
  return current !== undefined && current !== item.pinnedVersion ? current : null;
}

/** #2219 — whether any requirement in `review` was edited after its pin. */
export function reviewOutOfDate(review: Pick<ReviewRequest, "items" | "status">): boolean {
  return review.items.some((item) => outOfDateVersion(item, review.status) !== null);
}

/**
 * #2219 — the field changes from one snapshot to another, in the history
 * diff's shape. Exported for testing.
 */
export function snapshotDiff(
  from: Record<string, unknown>,
  to: Record<string, unknown>,
): ChangedFields {
  const diff: ChangedFields = {};
  for (const field of new Set([...Object.keys(from), ...Object.keys(to)])) {
    const a = from[field] ?? null;
    const b = to[field] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) diff[field] = { from: a, to: b };
  }
  return diff;
}

export function ReviewItemCard({
  item,
  reviewStatus,
}: {
  item: ReviewItem;
  /** The review's status: an out-of-date pin is flagged only while it stands (#2219). */
  reviewStatus?: ReviewStatus;
}) {
  const requirementId = item.requirementId;
  const history = useQuery({
    queryKey: queryKeys.reviews.requirementHistory(requirementId ?? "none"),
    // Server MAX_PAGE_SIZE is 100 — enough to locate any realistic pin.
    queryFn: () => historyApi.list(requirementId as string, { pageSize: 100 }),
    enabled: requirementId !== null,
  });

  if (requirementId === null) {
    return (
      <Card className="space-y-1 p-4" data-testid={`review-item-${item.id}`}>
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold">
            {item.generatedDocument?.title ?? "Spec document"}
          </h3>
          <PinBadge version={item.pinnedVersion} />
        </div>
        <p className="text-xs text-muted-foreground">
          Spec document — field-level diffs are available for requirement items only.
        </p>
      </Card>
    );
  }

  const entry = history.data?.versions.find((v) => v.version === item.pinnedVersion);
  // #1130 — a never-edited requirement has no version row; its pinned text is
  // the state before the first recorded change, which the server returns.
  const original =
    !entry && history.data?.original?.version === item.pinnedVersion
      ? history.data.original
      : undefined;
  const snapshot = entry?.snapshot ?? original?.snapshot;
  const currentVersion = reviewStatus ? outOfDateVersion(item, reviewStatus) : null;
  const currentSnapshot =
    currentVersion === null
      ? undefined
      : history.data?.versions.find((v) => v.version === currentVersion)?.snapshot;
  const title =
    typeof snapshot?.title === "string" && snapshot.title !== ""
      ? snapshot.title
      : (item.requirement?.title ?? "Requirement");

  return (
    <Card className="space-y-3 p-4" data-testid={`review-item-${item.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold">{title}</h3>
        <PinBadge version={item.pinnedVersion} />
      </div>

      {currentVersion !== null ? (
        <OutOfDateNotice
          pinnedVersion={item.pinnedVersion}
          currentVersion={currentVersion}
          approved={reviewStatus === "approved"}
          diff={snapshot && currentSnapshot ? snapshotDiff(snapshot, currentSnapshot) : null}
        />
      ) : null}

      {history.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading version history…</p>
      ) : history.isError ? (
        <p className="text-xs text-destructive" role="alert">
          Failed to load version history for this requirement.
        </p>
      ) : snapshot ? (
        <>
          <PinnedContent snapshot={snapshot} shared={item.sharedCriteria ?? null} />
          {entry ? (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground">
                Changes introduced by v{item.pinnedVersion}
              </h4>
              <VersionDiff changedFields={entry.changedFields} />
            </div>
          ) : original?.source === "reversed" ? (
            <p className="text-xs text-muted-foreground" data-testid="review-item-unedited">
              v{item.pinnedVersion} is rebuilt by reversing the edits recorded after it.
            </p>
          ) : (
            // #1130 AC2 — with no recorded edits the server returns the CURRENT
            // row, which is not guaranteed to be the pinned text: say so.
            <p className="text-xs text-muted-foreground" data-testid="review-item-unedited">
              No edits were recorded for this requirement; this is its current text.
            </p>
          )}
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No version history for v{item.pinnedVersion} — showing the requirement reference only.
        </p>
      )}
    </Card>
  );
}

/** The pinned body, acceptance criteria and metadata of a requirement snapshot. */
function PinnedContent({
  snapshot,
  shared,
}: {
  snapshot: Record<string, unknown>;
  /** #1203 — the item's shared-criteria record, if promotion wrote one. */
  shared: NonNullable<ReviewItem["sharedCriteria"]> | null;
}) {
  const criteria = parseAcceptanceCriteria(
    typeof snapshot.acceptanceCriteria === "string" ? snapshot.acceptanceCriteria : null,
  );
  // #1203 — marked only while the PINNED criteria are still the promoted ones.
  const record = shared && criteriaAsPromoted(shared.record, criteria) ? shared.record : null;
  const marks = sharedCriteriaMarks(record, criteria);
  return (
    <>
      {/* #998 — the pinned body is Markdown and carries METIS block markers; its
          headings sit under this card's h3 title. */}
      {typeof snapshot.body === "string" ? (
        <RequirementBody body={snapshot.body} minHeadingLevel={4} />
      ) : null}
      {criteria.length > 0 ? (
        <div className="space-y-1" data-testid="review-item-criteria">
          <h4 className="text-xs font-semibold text-muted-foreground">Acceptance criteria</h4>
          <ul className="list-disc space-y-0.5 pl-5 text-sm">
            {criteria.map((c, i) => (
              <li key={i}>
                {c}
                {marks.has(c.trim()) ? (
                  <span className="ml-1 text-xs text-muted-foreground">(shared)</span>
                ) : null}
              </li>
            ))}
          </ul>
          <SharedCriteriaNote
            record={record}
            criteria={criteria}
            hrefFor={(id) =>
              shared ? requirementCardHref(shared.projectId, shared.analysisId, id) : undefined
            }
          />
        </div>
      ) : null}
      <SnapshotMeta snapshot={snapshot} />
    </>
  );
}

/** #2219 — the requirement changed after the pin: say so, and show what changed. */
function OutOfDateNotice({
  pinnedVersion,
  currentVersion,
  approved,
  diff,
}: {
  pinnedVersion: number;
  currentVersion: number;
  approved: boolean;
  /** Pinned → current changes; null while either snapshot is unavailable. */
  diff: ChangedFields | null;
}) {
  return (
    <div
      role="status"
      className="space-y-2 rounded-md border border-warning/40 bg-warning-muted p-3"
      data-testid="review-item-out-of-date"
    >
      <p className="text-sm font-medium">
        v{currentVersion} differs from the {approved ? "approved" : "pinned"} v{pinnedVersion}
      </p>
      <p className="text-xs text-muted-foreground">
        {approved
          ? `The requirement was edited after this review approved it, so the approval is of v${pinnedVersion}. Request a re-review to approve the current wording.`
          : `The requirement was edited while this review is open. Reviewers are deciding on v${pinnedVersion}, shown below.`}
      </p>
      {diff && Object.keys(diff).length > 0 ? (
        <div className="space-y-1">
          <h4 className="text-xs font-semibold text-muted-foreground">
            Changes from v{pinnedVersion} to v{currentVersion}
          </h4>
          <VersionDiff changedFields={diff} />
        </div>
      ) : diff ? (
        <p className="text-xs text-muted-foreground">
          v{currentVersion} has the same wording as v{pinnedVersion}.
        </p>
      ) : null}
    </div>
  );
}

function PinBadge({ version }: { version: number }) {
  return (
    <span className="inline-flex items-center rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">
      pinned v{version}
    </span>
  );
}

function SnapshotMeta({ snapshot }: { snapshot: Record<string, unknown> }) {
  const parts = META_FIELDS.filter(
    (f) => snapshot[f] !== null && snapshot[f] !== undefined && snapshot[f] !== "",
  ).map((f) => `${f}: ${String(snapshot[f])}`);
  if (parts.length === 0) return null;
  return <p className="text-xs text-muted-foreground">{parts.join(" · ")}</p>;
}
