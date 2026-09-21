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
  const snapshot = entry?.snapshot;
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
      ) : entry ? (
        <>
          {typeof snapshot?.body === "string" && snapshot.body !== "" ? (
            <p className="whitespace-pre-wrap break-words text-sm text-foreground/90">
              {snapshot.body}
            </p>
          ) : null}
          <SnapshotMeta snapshot={snapshot ?? {}} />
          <div className="space-y-1">
            <h4 className="text-xs font-semibold text-muted-foreground">
              Changes introduced by v{item.pinnedVersion}
            </h4>
            <VersionDiff changedFields={entry.changedFields} />
          </div>
        </>
      ) : (
        <p className="text-xs text-muted-foreground">
          No version history for v{item.pinnedVersion} — showing the requirement reference only.
        </p>
      )}
    </Card>
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
