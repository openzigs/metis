/**
 * #2270 — the clarification dialog of an Impact Analysis run and of a
 * portfolio check started on a document: `GET|POST /api/impact-analyses/:id/clarify`
 * and `GET|POST /api/portfolio-assessments/:id/clarify`. The same dialog, and
 * the same payloads, as a requirements analysis's (`analysis-api.ts`); the
 * requirements asked about are the ones the run read, so a start sends no list.
 */
import { apiFetch } from "@/lib/api-client";
import type {
  ClarificationStatePayload,
  ClarifySubmitResult,
  StructuredRequirementsPayload,
} from "@/lib/analysis-api";

/** Whose dialog: an impact run's or a portfolio check's. */
export type ClarifySubjectKind = "impact" | "portfolio";

/** `GET …/clarify`: both null when the result has no dialog (or the reader may not see it). */
export interface SubjectClarification {
  state: ClarificationStatePayload | null;
  requirements: StructuredRequirementsPayload | null;
}

function path(kind: ClarifySubjectKind, id: string): string {
  const base = kind === "impact" ? "/impact-analyses" : "/portfolio-assessments";
  return `${base}/${encodeURIComponent(id)}/clarify`;
}

export const subjectClarifyApi = {
  get: (kind: ClarifySubjectKind, id: string) => apiFetch<SubjectClarification>(path(kind, id)),

  /** Start the dialog, or read back its open round. */
  start: (kind: ClarifySubjectKind, id: string) =>
    apiFetch<ClarificationStatePayload>(path(kind, id), { method: "POST", body: {} }),

  submit: (
    kind: ClarifySubjectKind,
    id: string,
    answers: Array<{ questionId: string; answer: string }>,
  ) => apiFetch<ClarifySubmitResult>(path(kind, id), { method: "POST", body: { answers } }),
};
