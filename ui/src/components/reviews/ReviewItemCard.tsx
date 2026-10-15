"use client";

/**
 * Epic #609 / Issue #618 — one scoped artifact inside a review.
 *
 * Requirement items render their content AT THE PINNED VERSION (reconstructed
 * snapshot from the requirement-history API, epic #770) plus the field-level
 * diff that version introduced. Spec-document items render title + pin only —
 * document version diffs are out of scope for this issue.
 */
import { useQuery } from "@tanstack/react-query";
import { parseAcceptanceCriteria } from "@metis/shared";
import { RequirementBody } from "@/components/analysis/RequirementBody";
import { Card } from "@/components/ui/card";
import { historyApi } from "@/lib/history-api";
import { queryKeys } from "@/lib/query-keys";
import type { ReviewItem } from "@/lib/reviews-api";
import { VersionDiff } from "./VersionDiff";

/** Snapshot fields rendered as metadata under the body. */
const META_FIELDS = ["priority", "type", "storyPoints", "reviewStatus"] as const;

export function ReviewItemCard({ item }: { item: ReviewItem }) {
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

      {history.isLoading ? (
        <p className="text-xs text-muted-foreground">Loading version history…</p>
      ) : history.isError ? (
        <p className="text-xs text-destructive" role="alert">
          Failed to load version history for this requirement.
        </p>
      ) : snapshot ? (
        <>
          <PinnedContent snapshot={snapshot} />
          {entry ? (
            <div className="space-y-1">
              <h4 className="text-xs font-semibold text-muted-foreground">
                Changes introduced by v{item.pinnedVersion}
              </h4>
              <VersionDiff changedFields={entry.changedFields} />
            </div>
          ) : (
            <p className="text-xs text-muted-foreground" data-testid="review-item-unedited">
              v{item.pinnedVersion} is the requirement as it was created: no edits were recorded
              before it.
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
function PinnedContent({ snapshot }: { snapshot: Record<string, unknown> }) {
  const criteria = parseAcceptanceCriteria(
    typeof snapshot.acceptanceCriteria === "string" ? snapshot.acceptanceCriteria : null,
  );
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
              <li key={i}>{c}</li>
            ))}
          </ul>
        </div>
      ) : null}
      <SnapshotMeta snapshot={snapshot} />
    </>
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
