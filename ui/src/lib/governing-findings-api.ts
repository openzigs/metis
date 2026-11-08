/**
 * Typed wrappers around an analysis's governing-findings routes — Epic #1866
 * (#1874 the routes, #1876 the analysis view).
 *
 * The wire shapes are `@metis/shared`'s (`packages/shared/src/governing.ts`);
 * the routes are in `server/src/routes/analysis.ts`. Every governing route
 * answers 404 while `GOVERNING_DOCS_ENABLED` is off, so `list` reads a 404 as
 * "the feature is off" (`null`) rather than an error: the analysis view then
 * renders nothing and shows no request error.
 */
import type {
  GoverningAnalysisApplicability,
  GoverningFinding,
  GoverningFindingDecisionInput,
} from "@metis/shared";
import { apiFetch } from "@/lib/api-client";
import { isGoverningUnavailable } from "@/lib/governing-api";

/** One policy revision the findings cite, with its rule count (#1876). */
export interface GoverningFindingRevision {
  revisionId: string;
  documentTitle: string;
  revisionLabel: string;
  rules: number;
}

export interface GoverningFindingsPayload {
  findings: GoverningFinding[];
  revisions: GoverningFindingRevision[];
  /** True while a findings run a BA answer started is in flight (#2017): read again. */
  refreshing: boolean;
}

const base = (projectId: string, analysisId: string) =>
  `/projects/${encodeURIComponent(projectId)}/analyses/${encodeURIComponent(analysisId)}`;

/** A 404 (the flag is off) reads as `null`; any other failure still throws. */
async function orNullWhenOff<T>(request: Promise<T>): Promise<T | null> {
  try {
    return await request;
  } catch (error) {
    if (isGoverningUnavailable(error)) return null;
    throw error;
  }
}

export const governingFindingsApi = {
  list: (projectId: string, analysisId: string) =>
    orNullWhenOff(
      apiFetch<GoverningFindingsPayload>(`${base(projectId, analysisId)}/governing-findings`),
    ),

  /** The requirement text each finding's requirement was judged on. */
  applicability: async (projectId: string, analysisId: string) =>
    (
      await orNullWhenOff(
        apiFetch<{ applicability: GoverningAnalysisApplicability | null }>(
          `${base(projectId, analysisId)}/governing-applicability`,
        ),
      )
    )?.applicability ?? null,

  decide: (
    projectId: string,
    analysisId: string,
    findingId: string,
    body: GoverningFindingDecisionInput,
  ) =>
    apiFetch<{ finding: GoverningFinding }>(
      `${base(projectId, analysisId)}/governing-findings/${encodeURIComponent(findingId)}/decision`,
      { method: "POST", body },
    ),
};

export const governingFindingsKeys = {
  all: (analysisId: string) => ["analyses", analysisId, "governing"] as const,
  findings: (analysisId: string) => [...governingFindingsKeys.all(analysisId), "findings"] as const,
  applicability: (analysisId: string) =>
    [...governingFindingsKeys.all(analysisId), "applicability"] as const,
};
