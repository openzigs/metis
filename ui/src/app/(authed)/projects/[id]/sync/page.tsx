/**
 * Epic #739 / Issue #746 — `/projects/:id/sync` drift dashboard.
 *
 * Paginated table grouped by Requirement, side-by-side diff modal with
 * action buttons (Adopt external / Push METIS / Mark divergent).
 */
"use client";

import { useEffect, useState, useCallback } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { fetchDriftEvents, resolveDrift } from "@/lib/sync-api";
import type { DriftEventRow, DriftResolutionAction, FieldDiff } from "@metis/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

export default function SyncDashboardPage() {
  const params = useParams();
  const searchParams = useSearchParams();
  const projectId = params.id as string;
  const requirementId = searchParams.get("requirementId") ?? undefined;

  const [items, setItems] = useState<DriftEventRow[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selectedDrift, setSelectedDrift] = useState<DriftEventRow | null>(null);
  const [resolving, setResolving] = useState(false);

  const perPage = 20;

  const loadDrifts = useCallback(async () => {
    setLoading(true);
    try {
      const result = await fetchDriftEvents(projectId, {
        status: "pending",
        requirementId,
        page,
        perPage,
      });
      setItems(result.items);
      setTotal(result.total);
    } catch {
      // Fail silently — empty state will show
    } finally {
      setLoading(false);
    }
  }, [projectId, requirementId, page]);

  useEffect(() => {
    void loadDrifts();
  }, [loadDrifts]);

  const handleResolve = async (driftId: string, action: DriftResolutionAction) => {
    setResolving(true);
    try {
      await resolveDrift(driftId, action);
      setSelectedDrift(null);
      await loadDrifts();
    } finally {
      setResolving(false);
    }
  };

  const totalPages = Math.ceil(total / perPage);

  if (loading && items.length === 0) {
    return (
      <div className="p-6">
        <h1 className="text-2xl font-bold mb-4">Issue Sync</h1>
        <p className="text-muted-foreground">Loading drift events...</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Issue Sync</h1>
        <Badge variant="secondary">{total} pending</Badge>
      </div>

      {items.length === 0 ? (
        <EmptyState />
      ) : (
        <>
          <div className="space-y-3">
            {items.map((drift) => (
              <DriftRow key={drift.id} drift={drift} onSelect={() => setSelectedDrift(drift)} />
            ))}
          </div>

          {totalPages > 1 && (
            <div className="flex items-center justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => setPage((p) => p - 1)}
              >
                Previous
              </Button>
              <span className="text-sm text-muted-foreground">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => setPage((p) => p + 1)}
              >
                Next
              </Button>
            </div>
          )}
        </>
      )}

      {/* Side-by-side diff modal */}
      {selectedDrift && (
        <DiffModal
          drift={selectedDrift}
          onClose={() => setSelectedDrift(null)}
          onResolve={handleResolve}
          resolving={resolving}
        />
      )}
    </div>
  );
}

// ---- Sub-components --------------------------------------------------------

function EmptyState() {
  return (
    <Card className="p-12 text-center">
      <div className="text-4xl mb-4">🎉</div>
      <h2 className="text-lg font-semibold mb-2">All synced up!</h2>
      <p className="text-muted-foreground">
        No drift detected between your published issues and external trackers. Changes will appear
        here automatically when they&apos;re detected.
      </p>
    </Card>
  );
}

function DriftRow({ drift, onSelect }: { drift: DriftEventRow; onSelect: () => void }) {
  return (
    <Card className="p-4 cursor-pointer hover:bg-muted/50 transition-colors" onClick={onSelect}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Badge variant={drift.source === "github" ? "default" : "secondary"}>
            {drift.source}
          </Badge>
          <div>
            <p className="font-medium text-sm">
              {drift.fieldDiffs.map((d: FieldDiff) => d.field).join(", ")} changed
            </p>
            <p className="text-xs text-muted-foreground">
              {drift.action} · {new Date(drift.createdAt).toLocaleString()}
            </p>
          </div>
        </div>
        <Badge variant="outline">{drift.fieldDiffs.length} field(s)</Badge>
      </div>
    </Card>
  );
}

function DiffModal({
  drift,
  onClose,
  onResolve,
  resolving,
}: {
  drift: DriftEventRow;
  onClose: () => void;
  onResolve: (id: string, action: DriftResolutionAction) => void;
  resolving: boolean;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-background rounded-lg shadow-xl w-full max-w-4xl max-h-[80vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-lg font-semibold">Drift Details</h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            ✕
          </Button>
        </div>

        <div className="space-y-4">
          {drift.fieldDiffs.map((diff: FieldDiff, i: number) => (
            <div key={i} className="border rounded-lg overflow-hidden">
              <div className="bg-muted px-4 py-2 font-medium text-sm capitalize">{diff.field}</div>
              <div className="grid grid-cols-2 divide-x">
                <div className="p-4">
                  <p className="text-xs text-muted-foreground mb-1">Local (METIS)</p>
                  <pre className="text-sm whitespace-pre-wrap break-words bg-red-50 dark:bg-red-950/20 p-2 rounded">
                    {formatFieldValue(diff.local)}
                  </pre>
                </div>
                <div className="p-4">
                  <p className="text-xs text-muted-foreground mb-1">External</p>
                  <pre className="text-sm whitespace-pre-wrap break-words bg-green-50 dark:bg-green-950/20 p-2 rounded">
                    {formatFieldValue(diff.external)}
                  </pre>
                </div>
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-end gap-3 mt-6 pt-4 border-t">
          <Button
            variant="outline"
            onClick={() => onResolve(drift.id, "divergent")}
            disabled={resolving}
          >
            Mark Divergent
          </Button>
          <Button
            variant="secondary"
            onClick={() => onResolve(drift.id, "push")}
            disabled={resolving}
          >
            Push METIS →
          </Button>
          <Button onClick={() => onResolve(drift.id, "adopt")} disabled={resolving}>
            ← Adopt External
          </Button>
        </div>
      </div>
    </div>
  );
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(", ");
  if (typeof value === "string") return value || "(empty)";
  return JSON.stringify(value, null, 2);
}
