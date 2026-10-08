"use client";

/**
 * #789 — the Spec Kit page's feature selector.
 *
 * Lists the project's features (`GET /features`, archived ones on request),
 * selects one (or the project-level `.specify/` set), shows the selected
 * feature's phase gates (`GET /features/:slug/status`) and archives or
 * restores it. A new feature is created by `/speckit.specify` with no feature
 * selected, which the hint says.
 */
import { useState } from "react";
import { toast } from "sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { specKitApi, type SpecKitFeatureStatus } from "@/lib/spec-kit-api";
import { queryKeys } from "@/lib/query-keys";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";

const GATES: Array<{
  key: keyof Omit<SpecKitFeatureStatus, "slug" | "lastUpdated">;
  label: string;
}> = [
  { key: "specGate", label: "spec.md" },
  { key: "planGate", label: "plan.md" },
  { key: "tasksGate", label: "tasks.md" },
  { key: "implementGate", label: "ready to implement" },
];

interface Props {
  projectId: string;
  enabled: boolean;
  /** Whether the viewer holds `project.update`, which archive/restore requires. */
  canWrite: boolean;
  selectedSlug: string | null;
  onSelect: (slug: string | null) => void;
}

export function FeaturePanel({ projectId, enabled, canWrite, selectedSlug, onSelect }: Props) {
  const queryClient = useQueryClient();
  const [showArchived, setShowArchived] = useState(false);

  const featuresQuery = useQuery({
    queryKey: queryKeys.projects.specKitFeatures(projectId, showArchived),
    queryFn: () => specKitApi.listFeatures(projectId, showArchived),
    enabled: enabled && Boolean(projectId),
  });
  const statusQuery = useQuery({
    queryKey: queryKeys.projects.specKitFeatureStatus(projectId, selectedSlug ?? ""),
    queryFn: () => specKitApi.featureStatus(projectId, selectedSlug ?? ""),
    enabled: enabled && selectedSlug !== null,
  });

  const features = featuresQuery.data?.features ?? [];
  const selected = features.find((f) => f.slug === selectedSlug) ?? null;
  const archived = selected?.status === "archived";

  const lifecycle = useMutation({
    mutationFn: (input: { slug: string; action: "archive" | "restore" }) =>
      input.action === "archive"
        ? specKitApi.archiveFeature(projectId, input.slug)
        : specKitApi.restoreFeature(projectId, input.slug),
    onSuccess: (_result, input) => {
      toast.success(
        input.action === "archive" ? `Archived ${input.slug}.` : `Restored ${input.slug}.`,
      );
      // An archived feature leaves the list unless archived ones are shown.
      if (input.action === "archive" && !showArchived) onSelect(null);
      void queryClient.invalidateQueries({
        queryKey: queryKeys.projects.specKitFeaturesAll(projectId),
      });
    },
    onError: () => {
      toast.error("The Spec Kit operation failed. Please try again.");
    },
  });

  return (
    <Card className="space-y-2 p-3" data-testid="spec-kit-features">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        Features
      </h2>
      <select
        aria-label="Feature"
        className="w-full rounded border bg-background px-2 py-1 text-sm"
        value={selectedSlug ?? ""}
        onChange={(e) => onSelect(e.target.value === "" ? null : e.target.value)}
        disabled={!enabled}
        data-testid="spec-kit-feature-select"
      >
        <option value="">Project (.specify/)</option>
        {features.map((f) => (
          <option key={f.slug} value={f.slug}>
            {f.slug} — {f.title}
            {f.status === "archived" ? " (archived)" : ""}
          </option>
        ))}
      </select>
      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
          disabled={!enabled}
          data-testid="spec-kit-show-archived"
        />
        Show archived
      </label>
      <p className="text-xs text-muted-foreground" data-testid="spec-kit-new-feature-hint">
        New feature: select Project and run{" "}
        <span className="font-mono">/speckit.specify &lt;brief&gt;</span>.
      </p>

      {selectedSlug !== null ? (
        <div className="space-y-2 border-t pt-2">
          <ul className="space-y-0.5 text-xs" data-testid="spec-kit-feature-gates">
            {GATES.map((g) => {
              const met = statusQuery.data?.[g.key] === true;
              return (
                <li
                  key={g.key}
                  data-testid={`spec-kit-gate-${g.key}`}
                  data-met={met}
                  className={met ? "text-foreground" : "text-muted-foreground"}
                >
                  <span aria-hidden>{met ? "✓" : "○"}</span> {g.label}
                  <span className="sr-only">{met ? " (met)" : " (not met)"}</span>
                </li>
              );
            })}
          </ul>
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            disabled={!canWrite || lifecycle.isPending}
            title={canWrite ? undefined : "Requires project.update"}
            onClick={() =>
              lifecycle.mutate({ slug: selectedSlug, action: archived ? "restore" : "archive" })
            }
            data-testid={archived ? "spec-kit-feature-restore" : "spec-kit-feature-archive"}
          >
            {archived ? "Restore feature" : "Archive feature"}
          </Button>
        </div>
      ) : null}
    </Card>
  );
}
