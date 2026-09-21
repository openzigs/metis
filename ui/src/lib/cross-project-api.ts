/**
 * Typed wrappers around the cross-project impact endpoints — Epic #295 Phase 4
 * (#309/#310). All reads are authz-gated server-side by workspace membership +
 * project access; the client just surfaces the typed result.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  CrossProjectImpactResult,
  CrossProjectObjectUsage,
  ProjectObjectUsage,
  UsageObjectKind,
} from "@metis/shared";

/**
 * "Which projects use object X" within a workspace the caller belongs to.
 * Throws ApiError(404) when the object/workspace is not visible to the caller.
 */
export async function fetchProjectsUsingObject(params: {
  workspaceId: string;
  objectName: string;
  schemaName?: string | null;
  objectType?: UsageObjectKind;
}): Promise<CrossProjectObjectUsage> {
  return apiFetch<CrossProjectObjectUsage>(
    `/impact-analyses/workspaces/${encodeURIComponent(params.workspaceId)}/objects/usage`,
    {
      params: {
        objectName: params.objectName,
        schemaName: params.schemaName ?? undefined,
        objectType: params.objectType ?? undefined,
      },
    },
  );
}

/**
 * Aggregated cross-project impact for a source project: the OTHER projects in
 * the same workspace that use the source's affected objects.
 */
export async function fetchCrossProjectImpact(
  projectId: string,
): Promise<CrossProjectImpactResult> {
  return apiFetch<CrossProjectImpactResult>(
    `/impact-analyses/projects/${encodeURIComponent(projectId)}/cross-project-impact`,
  );
}

/**
 * Project the aggregated {@link CrossProjectImpactResult} into the
 * `Record<canonicalName, ProjectObjectUsage[]>` shape consumed by
 * {@link AffectedTablesSection}'s "used by N projects" badge — Epic #295 Phase 4
 * (#310). The canonical name (`<schema>.<object>` or bare `<object>`) is built
 * the SAME way the server qualifies a `tableName`, so it lines up with the
 * affected-table rows on the detail page. Pure (no I/O) so it is trivially
 * unit-tested and reusable wherever the aggregated result is already fetched.
 */
export function crossProjectUsageByObject(
  result: CrossProjectImpactResult | null | undefined,
): Record<string, ProjectObjectUsage[]> {
  const map: Record<string, ProjectObjectUsage[]> = {};
  for (const obj of result?.affectedObjects ?? []) {
    if (obj.alsoUsedByProjects.length === 0) continue;
    const name = obj.schemaName ? `${obj.schemaName}.${obj.objectName}` : obj.objectName;
    map[name] = obj.alsoUsedByProjects;
  }
  return map;
}
