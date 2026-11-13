"use client";

/**
 * #2454 — whether a change request's project has any code to analyse.
 *
 * The run's capability record says so once the run has finished. Until then
 * (a run in progress, or one that failed before writing it) the record is
 * absent, so the project's live capability probe answers instead. Without that
 * fallback, a Documents-only project's Impact step read "Looking at the code."
 * mid-run and only flipped to "no code connected" afterwards.
 *
 * Absent or unknown reads as having code: the old behaviour, never a false
 * "no code" on a project that has some. The step header and the Impact and
 * portfolio card read this one hook, so the two never disagree.
 */
import { useQuery } from "@tanstack/react-query";
import { analysisApi, type AnalysisSnapshot } from "@/lib/analysis-api";

/** Shared with the start form's capability hint, so the probe is read once. */
export const capabilityPreviewKey = (projectId: string) =>
  ["analysis", "capability-preview", projectId] as const;

export function useCodeConnected(
  projectId: string,
  snapshot: Pick<AnalysisSnapshot, "capability">,
): boolean {
  const recorded = snapshot.capability;
  const preview = useQuery({
    queryKey: capabilityPreviewKey(projectId),
    queryFn: () => analysisApi.capabilityPreview(projectId),
    enabled: !recorded,
    retry: false,
  });
  if (recorded) return recorded.codeConnected !== false;
  return preview.data?.codeConnected !== false;
}
