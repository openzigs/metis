/**
 * Typed wrappers around the requirement→spec→code traceability endpoints
 * (Epic #207, issues #226/#227/#228/#229).
 *
 * Mirrors the shared DTOs so the UI stays in lockstep with the server.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  BackfillSpecLinksResult,
  RequirementChainWithLinks,
  RequirementSpecMappingDetail,
  RequirementTraceabilityChain,
  SpecCodeMappingDetail,
  WorkspaceTraceabilitySummary,
} from "@metis/shared";

type Id = string;

export const traceabilityApi = {
  /** #229 — the full requirement→spec→code chain. */
  chain: (projectId: Id, requirementId: Id) =>
    apiFetch<RequirementTraceabilityChain>(
      `/projects/${projectId}/requirements/${requirementId}/traceability`,
    ),

  /** #626 — the chain plus its cross-project linked chains (depth-capped). */
  chainWithLinks: (projectId: Id, requirementId: Id, depth = 1) =>
    apiFetch<RequirementChainWithLinks>(
      `/projects/${projectId}/requirements/${requirementId}/traceability`,
      { params: { includeLinked: "true", depth: String(depth) } },
    ),

  /** #626 — workspace-level rollup: per-project coverage + cross-project links. */
  workspaceSummary: (workspaceId: Id) =>
    apiFetch<WorkspaceTraceabilitySummary>(`/workspaces/${workspaceId}/traceability/summary`),

  /** #229 — reverse: which requirements touch a file. */
  byFile: (projectId: Id, filePath: string) =>
    apiFetch<{ filePath: string; requirementIds: string[] }>(
      `/projects/${projectId}/traceability/by-file`,
      { params: { filePath } },
    ),

  /** #226 — list a requirement's spec links. */
  listSpecLinks: (projectId: Id, requirementId: Id) =>
    apiFetch<RequirementSpecMappingDetail[]>(
      `/projects/${projectId}/requirements/${requirementId}/spec-mappings`,
    ),

  /** #227 — list a spec's code links. */
  listCodeLinks: (projectId: Id, specId: Id) =>
    apiFetch<SpecCodeMappingDetail[]>(`/projects/${projectId}/specs/${specId}/code-mappings`),

  /** #228 — run the idempotent backfill for the project. */
  backfill: (projectId: Id) =>
    apiFetch<BackfillSpecLinksResult>(`/projects/${projectId}/traceability/backfill`, {
      method: "POST",
    }),
};
