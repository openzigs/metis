"use client";

/**
 * Workspace-level traceability rollup view — Epic #610 (#626).
 *
 * Read-only surface for a workspace's traceability posture: a per-project
 * coverage table (requirements, cross-project linkage, spec/code coverage) and a
 * Mermaid visualization of the cross-project `RequirementLink` map. The server
 * scopes everything to the caller's accessible projects, so this component just
 * renders whatever the summary endpoint returns.
 */
import * as React from "react";
import { useQuery } from "@tanstack/react-query";
import mermaid from "mermaid";
import DOMPurify from "dompurify";
import type { WorkspaceProjectTraceability, WorkspaceTraceabilitySummary } from "@metis/shared";
import { ApiError } from "@/lib/api-client";
import { traceabilityApi } from "@/lib/traceability-api";
import { Badge } from "@/components/ui/badge";

export interface WorkspaceTraceabilityRollupProps {
  workspaceId: string;
}

export function workspaceTraceabilityKey(workspaceId: string) {
  return ["workspace-traceability-summary", workspaceId] as const;
}

/** Render a 0–1 coverage fraction as a whole-percent string. */
export function formatCoveragePct(fraction: number): string {
  const safe = Number.isFinite(fraction) ? Math.max(0, Math.min(1, fraction)) : 0;
  return `${Math.round(safe * 100)}%`;
}

/** Sanitize an arbitrary id into a Mermaid-safe node identifier. */
function mermaidNodeId(prefix: string, raw: string): string {
  return `${prefix}${raw.replace(/[^a-zA-Z0-9_]/g, "_")}`;
}

/** Escape a label for use inside a Mermaid `"..."` label. */
function mermaidLabel(raw: string): string {
  return raw.replace(/"/g, "'");
}

/**
 * Build a Mermaid `graph LR` definition for the cross-project link map: each
 * project becomes a subgraph, each participating requirement a node, and each
 * cross-project link a typed edge. Returns null when there are no cross-project
 * links (nothing to visualize).
 */
export function buildCrossProjectLinkMermaid(summary: WorkspaceTraceabilitySummary): string | null {
  const links = summary.crossProjectLinks;
  if (links.length === 0) return null;

  const nameByProject = new Map(summary.projects.map((p) => [p.projectId, p.name] as const));
  // project id -> set of requirement ids appearing in cross-project links
  const reqsByProject = new Map<string, Set<string>>();
  const add = (projectId: string, reqId: string) => {
    const set = reqsByProject.get(projectId) ?? new Set<string>();
    set.add(reqId);
    reqsByProject.set(projectId, set);
  };
  for (const edge of links) {
    add(edge.source.projectId, edge.source.requirementId);
    add(edge.target.projectId, edge.target.requirementId);
  }

  const lines: string[] = ["graph LR"];
  for (const [projectId, reqs] of reqsByProject) {
    const label = mermaidLabel(nameByProject.get(projectId) ?? projectId);
    lines.push(`  subgraph ${mermaidNodeId("P_", projectId)}["${label}"]`);
    for (const reqId of reqs) {
      lines.push(`    ${mermaidNodeId("R_", reqId)}["${mermaidLabel(reqId)}"]`);
    }
    lines.push("  end");
  }
  for (const edge of links) {
    const from = mermaidNodeId("R_", edge.source.requirementId);
    const to = mermaidNodeId("R_", edge.target.requirementId);
    lines.push(`  ${from} -->|${mermaidLabel(edge.type)}| ${to}`);
  }
  return lines.join("\n");
}

function CoverageBadge({ fraction }: { fraction: number }): React.ReactElement {
  const low = fraction < 0.4;
  return <Badge variant={low ? "outline" : "secondary"}>{formatCoveragePct(fraction)}</Badge>;
}

function SummaryTable({
  projects,
}: {
  projects: WorkspaceProjectTraceability[];
}): React.ReactElement {
  return (
    <table className="w-full text-sm" data-testid="rollup-summary-table">
      <thead>
        <tr className="border-b text-left text-xs text-muted-foreground">
          <th className="py-2 pr-4 font-medium">Project</th>
          <th className="py-2 pr-4 font-medium">Requirements</th>
          <th className="py-2 pr-4 font-medium">Cross-project links</th>
          <th className="py-2 pr-4 font-medium">Spec coverage</th>
          <th className="py-2 font-medium">Code coverage</th>
        </tr>
      </thead>
      <tbody>
        {projects.map((p) => (
          <tr key={p.projectId} data-testid="rollup-project-row" className="border-b">
            <td className="py-2 pr-4 font-medium">{p.name}</td>
            <td className="py-2 pr-4 tabular-nums">{p.requirements}</td>
            <td className="py-2 pr-4 tabular-nums">{p.linkedCrossProject}</td>
            <td className="py-2 pr-4">
              <CoverageBadge fraction={p.specCoverage} />
            </td>
            <td className="py-2">
              <CoverageBadge fraction={p.codeCoverage} />
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function CrossProjectLinkMap({
  summary,
}: {
  summary: WorkspaceTraceabilitySummary;
}): React.ReactElement {
  const source = React.useMemo(() => buildCrossProjectLinkMermaid(summary), [summary]);
  const [svg, setSvg] = React.useState<string>("");
  const [failed, setFailed] = React.useState(false);

  React.useEffect(() => {
    if (!source) return;
    let cancelled = false;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
    mermaid
      .render(`rollup-links-${Math.random().toString(36).slice(2, 8)}`, source)
      .then(({ svg }) => {
        if (!cancelled) {
          setSvg(svg);
          setFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [source]);

  if (!source) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="rollup-no-links">
        No cross-project requirement links in this workspace.
      </p>
    );
  }
  if (failed) {
    return (
      <pre
        className="overflow-auto rounded-md border bg-muted p-3 text-xs"
        data-testid="rollup-mermaid-source"
      >
        {source}
      </pre>
    );
  }
  if (!svg) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="rollup-map-loading">
        Rendering link map…
      </p>
    );
  }
  const clean = DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true, html: true },
  });
  return (
    <div
      data-testid="rollup-link-map"
      className="not-prose overflow-auto rounded-md border bg-muted p-4"
      // nosemgrep: typescript.react.security.audit.react-dangerouslysetinnerhtml.react-dangerouslysetinnerhtml -- Mermaid strict-mode output sanitized with DOMPurify above; no user HTML reaches the DOM.
      dangerouslySetInnerHTML={{ __html: clean }}
    />
  );
}

export function WorkspaceTraceabilityRollup({
  workspaceId,
}: WorkspaceTraceabilityRollupProps): React.ReactElement {
  const query = useQuery({
    queryKey: workspaceTraceabilityKey(workspaceId),
    queryFn: () => traceabilityApi.workspaceSummary(workspaceId),
    enabled: Boolean(workspaceId),
  });

  if (query.isLoading) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="rollup-loading">
        Loading traceability rollup…
      </p>
    );
  }
  if (query.isError) {
    const message =
      query.error instanceof ApiError ? query.error.message : "Failed to load traceability rollup.";
    return (
      <p className="text-sm text-destructive" data-testid="rollup-error">
        {message}
      </p>
    );
  }

  const summary = query.data;
  if (!summary || summary.projects.length === 0) {
    return (
      <p className="text-sm text-muted-foreground" data-testid="rollup-empty">
        No accessible projects with traceability data in this workspace.
      </p>
    );
  }

  return (
    <div className="space-y-6" data-testid="workspace-traceability-rollup">
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Per-project coverage</h2>
        <SummaryTable projects={summary.projects} />
      </section>
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Cross-project link map</h2>
        <CrossProjectLinkMap summary={summary} />
      </section>
    </div>
  );
}
