/**
 * Epic #609 / Issue #620 — baseline compare view: added / removed / changed
 * (field-level, reusing VersionDiff) / unchanged requirement sets between two
 * baselines. Read-only — baselines are immutable.
 */
import { Card } from "@/components/ui/card";
import { VersionDiff } from "@/components/reviews/VersionDiff";
import type { BaselineCompareResult } from "@/lib/baselines-api";

/** One-line compare summary, e.g. "1 added · 2 removed · 3 changed · 4 unchanged". */
export function compareSummary(result: BaselineCompareResult): string {
  return [
    `${result.added.length} added`,
    `${result.removed.length} removed`,
    `${result.changed.length} changed`,
    `${result.unchanged.length} unchanged`,
  ].join(" · ");
}

function PinList({
  heading,
  entries,
  tone,
  testId,
}: {
  heading: string;
  entries: { requirementId: string; version: number; title: string }[];
  tone: "added" | "removed" | "unchanged";
  testId: string;
}) {
  if (entries.length === 0) return null;
  const toneClass =
    tone === "added"
      ? "text-emerald-700 dark:text-emerald-400"
      : tone === "removed"
        ? "text-red-700 dark:text-red-400"
        : "text-muted-foreground";
  return (
    <section className="space-y-1" data-testid={testId}>
      <h3 className={`text-sm font-semibold ${toneClass}`}>
        {heading} ({entries.length})
      </h3>
      <ul className="space-y-1">
        {entries.map((entry) => (
          <li key={entry.requirementId} className="text-sm">
            {entry.title || entry.requirementId}{" "}
            <span className="text-xs text-muted-foreground">v{entry.version}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function BaselineCompareView({ result }: { result: BaselineCompareResult }) {
  return (
    <Card className="space-y-4 p-4" data-testid="baseline-compare">
      <header className="space-y-1">
        <h2 className="text-sm font-semibold">
          {result.baselineA.name} → {result.baselineB.name}
        </h2>
        <p className="text-xs text-muted-foreground">{compareSummary(result)}</p>
      </header>

      <PinList heading="Added" entries={result.added} tone="added" testId="compare-added" />
      <PinList heading="Removed" entries={result.removed} tone="removed" testId="compare-removed" />

      {result.changed.length > 0 ? (
        <section className="space-y-2" data-testid="compare-changed">
          <h3 className="text-sm font-semibold">Changed ({result.changed.length})</h3>
          {result.changed.map((entry) => (
            <div
              key={entry.requirementId}
              className="space-y-1 rounded border p-3"
              data-testid={`compare-changed-${entry.requirementId}`}
            >
              <p className="text-sm">
                {entry.title || entry.requirementId}{" "}
                <span className="text-xs text-muted-foreground">
                  v{entry.fromVersion} → v{entry.toVersion}
                </span>
              </p>
              <VersionDiff changedFields={entry.changedFields} />
            </div>
          ))}
        </section>
      ) : null}

      <PinList
        heading="Unchanged"
        entries={result.unchanged}
        tone="unchanged"
        testId="compare-unchanged"
      />
    </Card>
  );
}
