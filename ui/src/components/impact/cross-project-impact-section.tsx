/**
 * CrossProjectImpactSection + ProjectUsageList — Epic #295 Phase 4 (#310).
 *
 * Surfaces the cross-project dimension of impact:
 *   - {@link ProjectUsageList} — for a canonical object, the OTHER projects in
 *     the workspace that use it ("used by N projects" + the list), each with its
 *     per-project usage class and evidence count.
 *   - {@link CrossProjectImpactSection} — the aggregated cross-project impact for
 *     a source project: each affected canonical object plus the sibling projects
 *     that also use it.
 *
 * Safety contract (mirrors #292/#302): READ-ONLY. There is NO "drop"/"remove"
 * affordance anywhere; `uncertain` is rendered visually distinct and clearly
 * labelled. METIS never recommends a schema change here.
 *
 * Accessibility: each block is a labelled `region`; project lists are real
 * `<ul>`s; the usage class is conveyed by a text badge (not colour alone) with
 * an evidence count exposed via `title`.
 */
"use client";

import type {
  CrossProjectAffectedObject,
  CrossProjectImpactResult,
  CrossProjectObjectUsage,
  ProjectObjectUsage,
  UsageClass,
} from "@metis/shared";
import { Badge } from "@/components/ui/badge";

const CLASS_LABEL: Record<UsageClass, string> = {
  used: "Used",
  unreferenced: "Unreferenced",
  uncertain: "Uncertain",
};

const CLASS_VARIANT: Record<UsageClass, "default" | "secondary" | "destructive" | "outline"> = {
  used: "default",
  unreferenced: "outline",
  // `uncertain` is deliberately distinct from both used and unreferenced.
  uncertain: "destructive",
};

/** A per-project usage badge — class as text (never colour-only) + evidence. */
function ProjectUsageBadge({ usageClass }: { usageClass: UsageClass }) {
  return (
    <Badge
      variant={CLASS_VARIANT[usageClass]}
      data-testid="cross-project-usage-badge"
      data-usage-class={usageClass}
      data-distinct={usageClass === "uncertain" ? "true" : "false"}
    >
      {CLASS_LABEL[usageClass]}
    </Badge>
  );
}

function canonicalName(schemaName: string | null, objectName: string): string {
  return schemaName ? `${schemaName}.${objectName}` : objectName;
}

function ProjectRow({ project }: { project: ProjectObjectUsage }) {
  return (
    <li
      className="flex flex-wrap items-center gap-2 rounded border px-2 py-1"
      data-testid="cross-project-row"
      data-project-id={project.projectId}
    >
      <span className="text-xs font-medium" title={project.projectId}>
        {project.projectName}
      </span>
      <ProjectUsageBadge usageClass={project.usageClass} />
      <span
        className="text-[11px] text-muted-foreground"
        data-testid="cross-project-evidence-count"
        title={`${project.evidenceCount} inbound reference(s)`}
      >
        {project.evidenceCount} ref{project.evidenceCount === 1 ? "" : "s"}
      </span>
    </li>
  );
}

export interface ProjectUsageListProps {
  usage: CrossProjectObjectUsage;
}

/**
 * "Used by N projects" — the list of OTHER projects (within the authorized
 * workspace) that reference a canonical object, with each project's usage class
 * and evidence count, plus the cross-project rollup. Read-only.
 */
export function ProjectUsageList({ usage }: ProjectUsageListProps) {
  const { identity, projects, rollupUsageClass } = usage;
  const name = canonicalName(identity.schemaName, identity.objectName);
  return (
    <section
      aria-label={`Projects using ${name}`}
      data-testid="project-usage-list"
      className="space-y-2"
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold" title={name}>
          {name}
        </span>
        <span className="text-[10px] uppercase text-muted-foreground">{identity.objectType}</span>
        <span className="text-xs text-muted-foreground" data-testid="used-by-count">
          used by {projects.length} project{projects.length === 1 ? "" : "s"}
        </span>
        <span className="text-[11px] text-muted-foreground">overall:</span>
        <ProjectUsageBadge usageClass={rollupUsageClass} />
      </div>
      {projects.length === 0 ? (
        <p className="text-[11px] text-muted-foreground" data-testid="cross-project-empty">
          No other project in this workspace references this object.
        </p>
      ) : (
        <ul className="space-y-1">
          {projects.map((p) => (
            <ProjectRow key={p.projectId} project={p} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AffectedObjectRow({ object }: { object: CrossProjectAffectedObject }) {
  const name = canonicalName(object.schemaName, object.objectName);
  return (
    <li
      className="space-y-1 rounded border px-3 py-2"
      data-testid="cross-project-affected-object"
      data-object-name={name}
    >
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-xs font-semibold" title={name}>
          {name}
        </span>
        <span className="text-[10px] uppercase text-muted-foreground">{object.objectType}</span>
        <span className="text-xs text-muted-foreground">
          used by {object.alsoUsedByProjects.length} other project
          {object.alsoUsedByProjects.length === 1 ? "" : "s"}
        </span>
      </div>
      <ul className="space-y-1 border-l pl-3">
        {object.alsoUsedByProjects.map((p) => (
          <ProjectRow key={p.projectId} project={p} />
        ))}
      </ul>
    </li>
  );
}

export interface CrossProjectImpactSectionProps {
  result: CrossProjectImpactResult;
}

/**
 * Aggregated cross-project impact for a source project: each affected canonical
 * object and the sibling projects in the same workspace that also use it. Read
 * only — no drop/alter affordance; nothing is executed.
 */
export function CrossProjectImpactSection({ result }: CrossProjectImpactSectionProps) {
  // No workspace, or no shared objects → nothing to show.
  if (!result.workspaceId || result.affectedObjects.length === 0) {
    return (
      <section
        aria-label="Cross-project impact"
        data-testid="cross-project-impact-section"
        className="space-y-1"
      >
        <p className="text-xs font-medium text-muted-foreground">Cross-project impact</p>
        <p className="text-[11px] text-muted-foreground" data-testid="cross-project-impact-empty">
          No other projects in this workspace are affected by this change.
        </p>
      </section>
    );
  }

  return (
    <section
      aria-label="Cross-project impact"
      data-testid="cross-project-impact-section"
      className="space-y-2"
    >
      <p className="text-xs font-medium text-muted-foreground">Cross-project impact</p>
      <p className="text-[11px] text-muted-foreground">
        These objects are also used by other projects in this workspace. Review is informational —
        METIS does not recommend any schema change; uncertain usage must be investigated manually.
      </p>
      <ul className="space-y-2">
        {result.affectedObjects.map((obj) => (
          <AffectedObjectRow key={canonicalName(obj.schemaName, obj.objectName)} object={obj} />
        ))}
      </ul>
    </section>
  );
}
