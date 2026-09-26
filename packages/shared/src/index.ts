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
export * from "./cross-doc.js";
export * from "./publishing.js";
export * from "./vault.js";
export * from "./platform.js";
export * from "./mcp-validators.js";
export * from "./rbac.js";
export * from "./http.js";
export * from "./socket.js";
export * from "./connectors.js";
export * from "./jira.js";
export * from "./import.js";
export * from "./change-analysis.js";
export * from "./impact.js";
export * from "./schema-impact.js";
export * from "./impact-table-grouping.js";
export * from "./cross-project.js";
export * from "./requirement-links.js";
export * from "./finops.js";
export * from "./rag-hardening.js";
export * from "./sdk-alignment.js";
export * from "./spec-kit.js";
export * from "./product-docs.js";
export * from "./sync.js";
export * from "./testcoverage.js";
export * from "./test-management.js";
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
// Epic #129 — one agent definition, progressive skills and sub-agents.
export * from "./agents.js";

export const SHARED_PACKAGE_NAME = "@metis/shared";

export interface PackageMetadata {
  readonly name: string;
  readonly version: string;
}

export function describePackage(meta: PackageMetadata): string {
  return `${meta.name}@${meta.version}`;
}
