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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PageHeader } from "@/components/ui/page-header";
import { EmptyState } from "@/components/ui/empty-state";

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
        <PageHeader className="mb-4" title="Issue Sync" />
        <p className="text-muted-foreground">Loading drift events...</p>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader
        title="Issue Sync"
        titleExtra={<Badge variant="secondary">{total} pending</Badge>}
      />

      {items.length === 0 ? (
        <SyncedEmptyState />
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
      {/* #268 — Radix Dialog: focus trap, Escape, focus return. */}
      <Dialog
        open={selectedDrift !== null}
        onOpenChange={(open) => {
          if (!open) setSelectedDrift(null);
        }}
      >
        {selectedDrift && (
          <DiffModal drift={selectedDrift} onResolve={handleResolve} resolving={resolving} />
        )}
      </Dialog>
    </div>
  );
}

// ---- Sub-components --------------------------------------------------------

function SyncedEmptyState() {
  return (
    <EmptyState
      className="p-12"
      titleAs="h2"
      title="All synced up!"
      description="No drift detected between your published issues and external trackers. Changes will appear here automatically when they're detected."
    />
  );
}

function DriftRow({ drift, onSelect }: { drift: DriftEventRow; onSelect: () => void }) {
  return (
    // #268 — a real button, so the drift (and its dialog) is keyboard-reachable;
    // the clickable Card used to be mouse-only (WCAG 2.1.1).
    <button type="button" className="block w-full rounded-lg text-left" onClick={onSelect}>
      <Card className="p-4 cursor-pointer hover:bg-muted/50 transition-colors">
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
    </button>
  );
}

function DiffModal({
  drift,
  onResolve,
  resolving,
}: {
  drift: DriftEventRow;
  onResolve: (id: string, action: DriftResolutionAction) => void;
  resolving: boolean;
}) {
  return (
    <DialogContent className="max-h-[80vh] max-w-4xl">
      <DialogHeader>
        <DialogTitle>Drift Details</DialogTitle>
        <DialogDescription>
          Compare the METIS copy with the external issue, then choose how to resolve the drift.
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-4">
        {drift.fieldDiffs.map((diff: FieldDiff, i: number) => (
          <div key={i} className="border rounded-lg overflow-hidden">
            <div className="bg-muted px-4 py-2 font-medium text-sm capitalize">{diff.field}</div>
            <div className="grid grid-cols-2 divide-x">
              <div className="p-4">
                <p className="text-xs text-muted-foreground mb-1">Local (METIS)</p>
                <pre className="text-sm whitespace-pre-wrap break-words bg-destructive/10 p-2 rounded">
                  {formatFieldValue(diff.local)}
                </pre>
              </div>
              <div className="p-4">
                <p className="text-xs text-muted-foreground mb-1">External</p>
                <pre className="text-sm whitespace-pre-wrap break-words bg-success-muted p-2 rounded">
                  {formatFieldValue(diff.external)}
                </pre>
              </div>
            </div>
          </div>
        ))}
      </div>

      <DialogFooter className="gap-3 border-t pt-4">
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
      </DialogFooter>
    </DialogContent>
  );
}

function formatFieldValue(value: unknown): string {
  if (value === null || value === undefined) return "(empty)";
  if (Array.isArray(value)) return value.length === 0 ? "(none)" : value.join(", ");
  if (typeof value === "string") return value || "(empty)";
  return JSON.stringify(value, null, 2);
}
