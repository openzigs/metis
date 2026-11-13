/**
 * @metis/shared — public surface area.
 *
 * This barrel intentionally re-exports both the TypeScript type aliases (for
 * UI/server consumers that want plain types) and the zod schemas (for runtime
 * validation at API boundaries). Importing the package gives you both.
 */
export * from "./constants.js";
export * from "./common.js";
export * from "./user.js";
export * from "./project.js";
export * from "./analysis.js";
export * from "./acceptance-criteria-fallback.js";
export * from "./cross-doc.js";
// #1081 — a model step whose answer could not be read, and how it is worded.
export * from "./model-read.js";
// #1099 — what synthesis left out of a reply field by field, and how it is worded.
export * from "./synthesis-field-repairs.js";
export * from "./publishing.js";
export * from "./vault.js";
export * from "./platform.js";
export * from "./mcp-validators.js";
export * from "./rbac.js";
export * from "./http.js";
export * from "./socket.js";
export * from "./socket-rooms.js";
export * from "./connectors.js";
export * from "./jira.js";
export * from "./import.js";
export * from "./change-analysis.js";
export * from "./impact.js";
export * from "./schema-impact.js";
export * from "./impact-table-grouping.js";
export * from "./cross-project.js";
export * from "./requirement-links.js";
export * from "./requirement-approval.js";
export * from "./similar-requirements.js";
export * from "./finops.js";
export * from "./rag-hardening.js";
export * from "./sdk-alignment.js";
export * from "./spec-kit.js";
export * from "./product-docs.js";
// Epic #1608 (#1621) — the persisted portfolio assessment.
export * from "./portfolio-assessment.js";
export * from "./sync.js";
export * from "./traceability.js";
export * from "./stakeholder.js";
export * from "./elicitation.js";
export * from "./domain-eval.js";
export * from "./online-eval.js";
export * from "./notifications.js";
// Epic #1107 (#1110) — the support panel's presentation seam: ranking weights,
// wording, requirement rollup and the published-issue note. Shared so server
// synthesis, the API snapshot, the issue-draft generator and the UI badge all
// read one set of rules.
export * from "./support-panel-view.js";
export * from "./net/index.js";
// #1296 — the AGPL-3.0 §13 network source offer, shared by the `/source` route and
// the UI footer so the two can never disagree about the running commit.
export * from "./source-offer.js";
// #135 — the model catalog wire shape (`GET /api/ai/models`, every model picker).
export * from "./model-catalog.js";
// Epic #127 — the server-owned chat transcript (`/api/ai/sessions/:id/messages`, resume, fork).
export * from "./conversation.js";
// #2242 — a chat reply's citations, each checked against what the turn read.
export * from "./chat-citations.js";
// Epic #129 — one agent definition, progressive skills and sub-agents.
export * from "./agents.js";
// #346 — PATCH schemas whose omitted fields stay omitted under zod 4.
export * from "./zod-patch.js";
// #1170 — METIS's internal requirement-body markers, removed wherever a body is shown.
export * from "./metis-markers.js";
// #1230 — the run the Requirements hub opens on and a reader BRD reads.
export * from "./requirements-run.js";
// #1203 — criteria one synthesis item wrote for several requirements: the record
// promotion keeps and the note the requirement card, review card and issue show.
export * from "./shared-criteria.js";
// Epic #1866 (#1868) — workspace governing documents, revisions, rules and rule edits.
export * from "./governing.js";
// Epic #1866 (#1875) — the governing-findings wording guard: METIS never claims
// SOC 2 / GDPR compliance or certification, in the UI summary or in model prose.
export * from "./governing-wording.js";
// #2109 — governing checks are marked Preview; one setting for the UI and the BRD.
export * from "./governing-preview.js";

export const SHARED_PACKAGE_NAME = "@metis/shared";

export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

export function describePackage(meta: PackageMetadata): string {
  return `${meta.name}@${meta.version}`;
}
export * from "./schema-check.js";
// #2348 — Home "My work": change requests by state and reviews assigned to me.
export * from "./my-work.js";
export * from "./analysis-open-questions.js";
export * from "./ambiguity-keys.js";
// #2341 — a change request's eight steps and their states; shared so the UI's
// step header and the server's grouping by state (#2343, #2348) agree.
export * from "./change-request-steps.js";
export * from "./chat-subject.js";
export * from "./job-outcome.js";
