/**
 * Epic #609 / Issue #620 — baseline contents: each pinned requirement rendered
 * AS OF its pinned version (server-side reconstruction over the
 * RequirementVersion substrate — never the current state).
 */
import { Card } from "@/components/ui/card";
import type { BaselineItem } from "@/lib/baselines-api";

/**
 * Drift note for a pin: how the requirement has moved since the baseline was
 * taken. Exported for unit testing.
 */
export function describeDrift(item: BaselineItem): string | null {
  if (!item.current) return "requirement no longer exists";
  if (item.current.deleted) return `deleted since (was v${item.version})`;
  if (item.current.version !== item.version) {
    return `now at v${item.current.version}`;
  }
  return null;
}

/** Compact metadata line from the pinned snapshot. Exported for unit testing. */
export function snapshotMeta(item: BaselineItem): string {
  const s = item.snapshot;
  if (!s) return "";
  const parts: string[] = [];
  if (s.type) parts.push(String(s.type));
  if (s.priority) parts.push(`priority ${s.priority}`);
  if (s.storyPoints !== null && s.storyPoints !== undefined) {
    parts.push(`${s.storyPoints} pts`);
  }
  return parts.join(" · ");
}

export function BaselineItemsTable({ items }: { items: BaselineItem[] }) {
  if (items.length === 0) {
    return <p className="text-sm text-muted-foreground">This baseline pins no requirements.</p>;
  }
  return (
    <ul className="space-y-2" data-testid="baseline-items">
      {items.map((item) => {
        const drift = describeDrift(item);
        const meta = snapshotMeta(item);
        return (
          <li key={item.requirementId}>
            <Card className="space-y-1 p-4" data-testid={`baseline-item-${item.requirementId}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm font-semibold">
                  {item.snapshot?.title ?? item.requirementId}
                </span>
                <span className="rounded bg-muted px-1.5 py-0.5 text-xs font-medium">
                  v{item.version}
                </span>
                {drift ? (
                  <span className="text-xs text-amber-700 dark:text-amber-400">{drift}</span>
                ) : null}
              </div>
              {meta ? <p className="text-xs text-muted-foreground">{meta}</p> : null}
              {item.snapshot?.body ? (
                <p className="whitespace-pre-wrap break-words text-xs text-foreground/80">
                  {item.snapshot.body}
                </p>
              ) : null}
            </Card>
          </li>
        );
      })}
    </ul>
  );
}
