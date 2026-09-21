"use client";

/**
 * Epic #770 / Issues #773 + #775 — Requirement history tab.
 *
 *  • Renders the version timeline (newest first), each entry a keyboard-focusable
 *    button. Selecting any two versions reveals a side-by-side diff of their
 *    reconstructed snapshots.
 *  • Coordinators/admins get a per-version Restore action (confirmation dialog).
 *  • An Export dropdown downloads the FULL history as CSV or JSON.
 */
import * as React from "react";
import ReactDiffViewer from "react-diff-viewer-continued";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useAuth } from "@/lib/auth-context";
import { hasMinRole } from "@metis/shared";
import { historyApi, type RequirementHistoryEntry, type ExportFormat } from "@/lib/history-api";
import { ApiError } from "@/lib/api-client";
import { RestoreVersionDialog } from "./RestoreVersionDialog";

/** Stable field order for rendering snapshots in the diff view. */
const FIELD_ORDER = [
  "title",
  "body",
  "priority",
  "type",
  "labels",
  "storyPoints",
  "reviewStatus",
] as const;

export interface RequirementHistoryTabProps {
  requirementId: string;
  /** Notified after a successful restore so the parent can refetch. */
  onRestored?: () => void;
}

function snapshotToText(snapshot: Record<string, unknown>): string {
  return FIELD_ORDER.map((field) => {
    const value = snapshot[field];
    const rendered = value === null || value === undefined ? "" : String(value);
    return `${field}: ${rendered}`;
  }).join("\n");
}

function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString();
}

export function RequirementHistoryTab({
  requirementId,
  onRestored,
}: RequirementHistoryTabProps): React.ReactElement {
  const { user } = useAuth();
  const canRestore = user ? hasMinRole(user.role, "coordinator") : false;

  const [entries, setEntries] = React.useState<RequirementHistoryEntry[]>([]);
  const [total, setTotal] = React.useState(0);
  const [page, setPage] = React.useState(1);
  const [pageSize] = React.useState(20);
  const [currentVersion, setCurrentVersion] = React.useState<number | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [selected, setSelected] = React.useState<number[]>([]);
  const [restoreTarget, setRestoreTarget] = React.useState<number | null>(null);
  const [exporting, setExporting] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await historyApi.list(requirementId, { page, pageSize });
      setEntries(data.versions);
      setTotal(data.total);
      setCurrentVersion(data.currentVersion);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Failed to load history");
    } finally {
      setLoading(false);
    }
  }, [requirementId, page, pageSize]);

  React.useEffect(() => {
    void load();
  }, [load]);

  function toggleSelect(version: number): void {
    setSelected((prev) => {
      if (prev.includes(version)) return prev.filter((v) => v !== version);
      // Keep at most two; drop the oldest selection when a third is chosen.
      const next = [...prev, version];
      return next.length > 2 ? next.slice(next.length - 2) : next;
    });
  }

  const byVersion = React.useMemo(() => {
    const map = new Map<number, RequirementHistoryEntry>();
    for (const e of entries) map.set(e.version, e);
    return map;
  }, [entries]);

  const diffPair = React.useMemo(() => {
    if (selected.length !== 2) return null;
    const [a, b] = [...selected].sort((x, y) => x - y);
    const older = byVersion.get(a);
    const newer = byVersion.get(b);
    if (!older || !newer) return null;
    return { older, newer };
  }, [selected, byVersion]);

  async function handleExport(format: ExportFormat): Promise<void> {
    setExporting(true);
    setError(null);
    try {
      await historyApi.export(requirementId, format);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Export failed");
    } finally {
      setExporting(false);
    }
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return (
    <div className="space-y-4" data-testid="requirement-history-tab">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">
          Version history{currentVersion !== null ? ` · current v${currentVersion}` : ""}
        </h3>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="sm" variant="outline" disabled={exporting || total === 0}>
              {exporting ? "Exporting…" : "Export"}
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => void handleExport("csv")}>
              Export as CSV
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={() => void handleExport("json")}>
              Export as JSON
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {error ? (
        <p className="text-sm text-red-500" role="alert">
          {error}
        </p>
      ) : null}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading history…</p>
      ) : entries.length === 0 ? (
        <p className="text-sm text-zinc-500">No version history yet.</p>
      ) : (
        <ul className="space-y-2" role="list" aria-label="Version timeline">
          {entries.map((entry) => {
            const isSelected = selected.includes(entry.version);
            const changedNames = Object.keys(entry.changedFields);
            return (
              <li key={entry.version}>
                <div
                  className={`rounded border px-3 py-2 ${
                    isSelected ? "border-blue-500 bg-blue-500/10" : "border-zinc-700"
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <button
                      type="button"
                      onClick={() => toggleSelect(entry.version)}
                      aria-pressed={isSelected}
                      className="flex-1 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500"
                    >
                      <span className="text-sm font-medium">Version {entry.version}</span>
                      <span className="ml-2 text-xs text-zinc-500">
                        {formatDate(entry.createdAt)}
                        {entry.actorId ? ` · ${entry.actorId}` : ""}
                      </span>
                      {entry.reason ? (
                        <span className="ml-2 text-xs italic text-zinc-400">{entry.reason}</span>
                      ) : null}
                      {changedNames.length > 0 ? (
                        <span className="mt-1 block text-xs text-zinc-400">
                          Changed: {changedNames.join(", ")}
                        </span>
                      ) : null}
                    </button>
                    {canRestore ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => setRestoreTarget(entry.version)}
                      >
                        Restore
                      </Button>
                    ) : null}
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {totalPages > 1 ? (
        <div className="flex items-center justify-between text-xs">
          <Button
            size="sm"
            variant="outline"
            disabled={page <= 1 || loading}
            onClick={() => setPage((p) => Math.max(1, p - 1))}
          >
            Previous
          </Button>
          <span className="text-zinc-500">
            Page {page} of {totalPages}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={page >= totalPages || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      ) : null}

      {diffPair ? (
        <div className="space-y-2" data-testid="version-diff">
          <h4 className="text-xs font-semibold text-zinc-400">
            Comparing v{diffPair.older.version} → v{diffPair.newer.version}
          </h4>
          <div className="overflow-x-auto rounded border border-zinc-700 text-xs">
            <ReactDiffViewer
              oldValue={snapshotToText(diffPair.older.snapshot)}
              newValue={snapshotToText(diffPair.newer.snapshot)}
              splitView
              leftTitle={`Version ${diffPair.older.version}`}
              rightTitle={`Version ${diffPair.newer.version}`}
            />
          </div>
        </div>
      ) : selected.length === 1 ? (
        <p className="text-xs text-zinc-500">Select a second version to compare.</p>
      ) : null}

      <RestoreVersionDialog
        requirementId={requirementId}
        version={restoreTarget}
        onClose={() => setRestoreTarget(null)}
        onRestored={() => {
          setRestoreTarget(null);
          setSelected([]);
          void load();
          onRestored?.();
        }}
      />
    </div>
  );
}
