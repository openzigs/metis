/**
 * ProjectImpactSection — Epic #159 (#165).
 *
 * Groups all impacted requirements for a single project. The detail page
 * renders one section per project included in the analysis.
 */
"use client";

import type {
  CrossProjectImpactResult,
  ImpactItemView,
  ImpactTableFeedbackVerdict,
  ProjectObjectUsage,
  SchemaUsageClassificationView,
} from "@metis/shared";
import { ChangedRequirementGroup } from "./changed-requirement-group";
import { UsageClassificationSection } from "./usage-classification-section";
import { CrossProjectImpactSection } from "./cross-project-impact-section";
import { useCrossProjectImpact, useProjectUsageClassification } from "@/lib/impact-analysis-hooks";
import { crossProjectUsageByObject } from "@/lib/cross-project-api";

export interface ProjectImpactSectionProps {
  projectId: string;
  projectName?: string;
  items: ImpactItemView[];
  /**
   * Epic #292 (#298) — pre-fetched usage classification. When provided, it is
   * rendered directly and no fetch is performed (keeps the component
   * presentational + testable without a QueryClient). When omitted, the wrapper
   * {@link ProjectImpactSectionWithUsage} fetches it.
   */
  usageClassification?: SchemaUsageClassificationView[];
  /**
   * Epic #295 Phase 4 (#310) — pre-fetched aggregated cross-project impact for
   * THIS project. When provided, the aggregated {@link CrossProjectImpactSection}
   * is rendered AND each affected table gets a "used by N projects" badge built
   * from it. Presentational: the wrapper fetches it.
   */
  crossProjectImpact?: CrossProjectImpactResult | null;
  /**
   * Epic #295 Phase 4 (#310) — `loading`/`error` drive the cross-project block's
   * non-empty states (the presentational cross-project component only handles
   * the empty case). Both default false → render whatever data is present.
   */
  crossProjectLoading?: boolean;
  crossProjectError?: boolean;
  /** Issue #966 — the signed-in caller's user id, forwarded to each requirement group. */
  currentUserId?: string | null;
  /** Issue #966 — mark (or re-mark) a table relevant/not-relevant on the given item. */
  onMarkFeedback?: (
    itemId: string,
    input: { tableName: string; verdict: ImpactTableFeedbackVerdict },
  ) => void;
  /** Issue #966 — remove a feedback mark on the given item. */
  onDeleteFeedback?: (itemId: string, feedbackId: string) => void;
}

export function ProjectImpactSection({
  projectId,
  projectName,
  items,
  usageClassification,
  crossProjectImpact,
  crossProjectLoading = false,
  crossProjectError = false,
  currentUserId,
  onMarkFeedback,
  onDeleteFeedback,
}: ProjectImpactSectionProps) {
  const totalSymbols = items.reduce((sum, item) => sum + item.affectedSymbolCount, 0);
  const crossProjectUsage: Record<string, ProjectObjectUsage[]> =
    crossProjectUsageByObject(crossProjectImpact);

  return (
    <section className="space-y-3" data-testid="project-impact-section" data-project-id={projectId}>
      <div className="flex items-center justify-between border-b pb-1">
        <h2 className="text-base font-semibold">{projectName ?? projectId}</h2>
        <span className="text-xs text-muted-foreground" data-testid="project-impact-total">
          {items.length} requirement(s) · {totalSymbols} symbol(s)
        </span>
      </div>

      {usageClassification && usageClassification.length > 0 ? (
        <UsageClassificationSection objects={usageClassification} />
      ) : null}

      <CrossProjectImpactBlock
        result={crossProjectImpact}
        loading={crossProjectLoading}
        error={crossProjectError}
      />

      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground" data-testid="project-impact-empty">
          No code impact detected for this project.
        </p>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <ChangedRequirementGroup
              key={item.id}
              item={item}
              crossProjectUsage={crossProjectUsage}
              currentUserId={currentUserId}
              onMarkFeedback={onMarkFeedback}
              onDeleteFeedback={onDeleteFeedback}
            />
          ))}
        </div>
      )}
    </section>
  );
}

/**
 * Loading/error/empty wrapper around the presentational
 * {@link CrossProjectImpactSection} — Epic #295 Phase 4 (#310). The
 * presentational component only renders data + an empty state; this adds the two
 * states it cannot know about (the fetch is owned by the smart wrapper). All
 * states are read-only — no drop/alter affordance.
 */
function CrossProjectImpactBlock({
  result,
  loading,
  error,
}: {
  result: CrossProjectImpactResult | null | undefined;
  loading: boolean;
  error: boolean;
}) {
  if (loading) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="cross-project-impact-loading">
        Checking other projects in this workspace…
      </p>
    );
  }
  if (error) {
    return (
      <p className="text-[11px] text-muted-foreground" data-testid="cross-project-impact-error">
        Cross-project impact is unavailable right now.
      </p>
    );
  }
  if (!result) return null;
  return <CrossProjectImpactSection result={result} />;
}

/**
 * Epic #292 (#298) + #295 Phase 4 (#310) — fetches the project's usage
 * classification AND its aggregated cross-project impact (both read-only) and
 * renders {@link ProjectImpactSection}. Absence of either (no DB connector / not
 * yet computed / no shared workspace) degrades to the empty state rather than an
 * error. Used by the impact-analysis detail page (wrapped in a
 * QueryClientProvider); tests render the presentational component directly.
 */
export function ProjectImpactSectionWithUsage(
  props: Omit<
    ProjectImpactSectionProps,
    "usageClassification" | "crossProjectImpact" | "crossProjectLoading" | "crossProjectError"
  >,
) {
  const usage = useProjectUsageClassification(props.projectId);
  const crossProject = useCrossProjectImpact(props.projectId);
  return (
    <ProjectImpactSection
      {...props}
      usageClassification={usage.data ?? undefined}
      crossProjectImpact={crossProject.data ?? null}
      crossProjectLoading={crossProject.isLoading}
      crossProjectError={crossProject.isError}
    />
  );
}
