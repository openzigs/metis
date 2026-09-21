/**
 * Mounts every route module under `/api`. Auth endpoints are wrapped in the
 * shared rate limiter to throttle credential stuffing.
 */
import { Router } from "express";
import { authRouter } from "./auth.js";
import { healthRouter } from "./health.js";
import { sourceRouter } from "./source.js";
import { aiRouter } from "./ai.js";
import { projectsRouter } from "./projects.js";
import { documentsRouter, knowledgeRouter } from "./documents.js";
import { mcpRouter } from "./mcp.js";
import { initAnalysisRouter } from "./analysis.js";
import { connectorsRouter } from "./connectors.js";
import { importsRouter } from "./imports.js";
import { suggestedConnectorsRouter } from "./suggested-connectors.js";
import { publishingRouter } from "./publishing.js";
import { skillsRouter } from "./skills.js";
import { agentsRouter } from "./agents.js";
import { libraryRouter, projectLibraryRouter } from "./library.js";
import { schedulerRouter } from "./scheduler.js";
import { tasksRouter } from "./tasks.js";
import { settingsRouter } from "./settings.js";
import { securityEvalRouter } from "./security-eval.js";
import { runsRouter } from "./runs.js";
import { projectAgentsMdRouter } from "./agents-md.js";
import { customAgentsRouter } from "./custom-agents.js";
import { hooksRouter } from "./hooks.js";
import { skillDirectoriesRouter } from "./skill-directories.js";
import { pluginsRouter } from "./plugins.js";
import { aiSdkRouter } from "./ai-sdk.js";
import { backgroundRunsRouter } from "./background-runs.js";
import { projectTriggersRouter, triggersWebhookRouter } from "./triggers.js";
import { acpRouter } from "./acp.js";
import { vaultRouter } from "./vault.js";
import { specKitRouter } from "./spec-kit.js";
import { githubPrWebhookRouter } from "./webhooks-github.js";
import { runReviewsRouter } from "./run-reviews.js";
import { prReviewsRouter } from "./pr-reviews.js";
import { evalRouter } from "./eval.js";
import { domainEvalRouter } from "./eval-domain.js";
import { onlineEvalRouter } from "./eval-online.js";
import { findingsRouter } from "./findings.js";
import { sandboxRouter } from "./sandbox.js";
import { generatedDocsRouter } from "./generated-docs.js";
import { authRateLimiter } from "../middleware/rate-limit.js";
import { mcpAdminRateLimiter, mcpServerRateLimiter } from "../middleware/mcp-admin-rate-limit.js";
import { productsRateLimiter } from "../middleware/products-rate-limit.js";
import { jiraRateLimiter } from "../middleware/jira-rate-limit.js";
import { adminRouter } from "./admin/index.js";
import { searchRouter } from "./search.js";
import { productsRouter as productsMultiRouter } from "./products-multi.js";
import { jiraRouter } from "./jira.js";
import { testManagementRouter } from "./test-management.js";
import { changeAnalysisRouter } from "./change-analysis.js";
import { impactAnalysisRouter } from "./impact-analysis.js";
import { syncWebhookRouter, syncDriftRouter } from "./sync.js";
import { initModelPreferenceRouter, initModelRecommendationRouter } from "./model-preferences.js";
import { projectUsageRouter, projectTokenBudgetRouter } from "./usage.js";
import { inferenceProfileRouter } from "./inference-profile.js";
import { templatesRouter } from "./templates.js";
import { astCacheRouter } from "./ast-cache.js";
import { rulesRouter } from "./rules.js";
import { scansRouter } from "./scans.js";
import { triageRouter } from "./triage.js";
import { ssoRouter } from "./sso.js";
import { scimRouter } from "./scim.js";
import { workspacesRouter } from "./workspaces.js";
import { finopsWorkspaceRouter } from "./finops-workspace.js";
import { testCoverageRouter } from "./test-coverage.js";
import { dataMappingsRouter } from "./data-mappings.js";
import { traceabilityRouter, workspaceTraceabilityRouter } from "./traceability.js";
import { stakeholdersRouter } from "./stakeholders.js";
import { commentsRouter, specKitArtifactCommentsRouter } from "./comments.js";
import { requirementsCollaborationRouter } from "./requirements.js";
import {
  requirementLinksResourceRouter,
  workspaceRequirementSearchRouter,
} from "./requirement-links.js";
import { projectReviewsRouter, reviewsRouter } from "./reviews.js";
import { baselinesRouter, projectBaselinesRouter } from "./baselines.js";
import { usersRouter } from "./users.js";
import { notificationPreferencesRouter } from "./notification-preferences.js";
import { notificationsRouter } from "./notifications.js";
import { discussionsRouter } from "./discussions.js";
import { teamsIntegrationRouter } from "./integrations/teams.js";
import { pagerDutyIntegrationRouter } from "./integrations/pagerduty.js";
import { slackIntegrationRouter } from "./integrations/slack.js";

export function apiRouter(): Router {
  const r = Router();
  const analysis = initAnalysisRouter();
  r.use("/health", healthRouter());
  // #1296 — AGPL-3.0 §13 source offer. Unauthenticated, like /health: the
  // licence obliges the offer to reach every remote user, not only signed-in
  // ones. Also mounted at top-level /source in app.ts.
  r.use("/source", sourceRouter());
  r.use("/auth", authRateLimiter, authRouter());
  // Epic #748 — SSO authentication routes (SAML + OIDC).
  r.use("/auth", authRateLimiter, ssoRouter());
  r.use("/ai", aiRouter());
  // Epic #165 — SDK alignment routes mounted alongside the existing AI router.
  r.use("/ai", aiSdkRouter());
  r.use("/projects", projectsRouter());
  // Issue #133 — production wires an IngestQueue (see server.ts) so uploads
  // return 202. Tests opt out by setting NODE_ENV=test so existing 201
  // assertions still hold; queue behavior has its own test coverage.
  r.use(
    "/projects/:projectId/documents",
    documentsRouter({ ingestQueue: process.env.NODE_ENV === "test" ? null : undefined }),
  );
  r.use("/projects/:projectId", knowledgeRouter());
  r.use("/projects/:projectId/analyses", analysis.projectScoped);
  r.use("/projects/:projectId/connectors", connectorsRouter());
  r.use("/projects/:projectId/imports", importsRouter());
  r.use("/projects/:projectId/suggested-connectors", suggestedConnectorsRouter());
  r.use("/projects/:projectId/publishing", publishingRouter());
  // Epic #595 — configurable issue templates.
  r.use("/projects/:projectId/templates", templatesRouter());
  // Epic #557 — change analysis routes.
  r.use("/projects/:projectId/change-analyses", changeAnalysisRouter());
  // Epic #593 — model preferences + recommendation.
  r.use("/projects/:projectId/model-preferences", initModelPreferenceRouter());
  r.use("/projects/:projectId/analyses/model-recommendation", initModelRecommendationRouter());
  // Epic #594 — token usage tracking + cost allocation.
  r.use("/projects/:projectId/usage", projectUsageRouter());
  r.use("/projects/:projectId/token-budget", projectTokenBudgetRouter());
  r.use("/projects/:projectId/inference-profile", inferenceProfileRouter());
  // Epic #596 — AST summary cache rebuild.
  r.use("/projects/:projectId/repositories/:repoId", astCacheRouter());
  r.use("/projects/:projectId/library", projectLibraryRouter());
  r.use("/analyses", analysis.topLevel);
  r.use("/mcp", mcpServerRateLimiter, mcpRouter());
  r.use("/skills", skillsRouter());
  r.use("/agents", agentsRouter());
  r.use("/library", libraryRouter());
  r.use("/scheduler", schedulerRouter());
  r.use("/tasks", tasksRouter());
  r.use("/settings", settingsRouter());
  r.use("/security-eval", securityEvalRouter());
  // Epic #156 — async agent platform. MUST mount BEFORE the deterministic
  // `runsRouter` because both share the `/runs` prefix and `runsRouter`
  // contains a parameterized `/:id` handler that would otherwise shadow the
  // literal `/runs/background` path and respond 404 RUN_NOT_FOUND (#381).
  r.use("/runs", backgroundRunsRouter());
  // Epic #158 — observability + interop.
  r.use("/runs", runsRouter());
  r.use("/projects/:projectId", projectAgentsMdRouter());
  // Epic #165 — SDK alignment.
  r.use("/custom-agents", customAgentsRouter());
  r.use("/projects/:projectId/hooks", hooksRouter());
  r.use("/projects/:projectId", skillDirectoriesRouter());
  r.use("/plugins", pluginsRouter());
  r.use("/projects/:projectId/triggers", projectTriggersRouter());
  r.use("/triggers", triggersWebhookRouter());
  r.use("/webhooks", triggersWebhookRouter());
  // Epic #163 — ACP token management. The actual ACP wire protocol is
  // served on the WebSocket upgrade at /api/acp (see server.ts).
  r.use("/acp", acpRouter());
  // Epic #196 / #222 — standalone /vault admin UI.
  r.use("/vault", vaultRouter());
  // Epic #193 — Spec Kit Mode (v1.2.0).
  r.use("/projects/:projectId/spec-kit", specKitRouter());
  // Epic #192 — Closed Loop (v1.2.0).
  r.use("/webhooks", githubPrWebhookRouter());
  r.use("/run-reviews", runReviewsRouter());
  // Epic #394 P2 (#404) — UI history endpoint for PR reviews.
  r.use("/projects/:projectId/pr-reviews", prReviewsRouter());
  // Epic #194 — Eval & Bench (v1.2.0).
  r.use("/eval", evalRouter());
  // Epic #803 — Domain Eval (BA pipeline regression suite). File-backed.
  r.use("/eval/domain", domainEvalRouter());
  r.use("/eval/online", onlineEvalRouter());
  // Epic #298 / #312 — finding-level review-ack endpoint.
  r.use("/findings", findingsRouter());
  // Epic #395 #420 — direct sandbox execution surface used by the BA-loop e2e.
  r.use("/sandbox", sandboxRouter());
  // Epic #486 — auto documentation generator.
  r.use("/projects/:projectId/docs", generatedDocsRouter());
  // Epic #526 — cross-project federated search.
  r.use("/search", searchRouter());
  // Epic #159 — multi-project requirement-change → code-impact analysis.
  r.use("/impact-analyses", impactAnalysisRouter());
  // Epic #544 — multi-repo product documentation.
  r.use("/products", productsRateLimiter, productsMultiRouter());
  // Epic #556 — Jira integration.
  r.use("/jira", jiraRateLimiter, jiraRouter());
  // Epic #856 Phase 3 (#871) — Xray/Zephyr/TestRail connection management.
  r.use("/test-management", testManagementRouter());
  // Epic #249 — runtime configuration management (Phase 1).
  r.use("/admin", mcpAdminRateLimiter, adminRouter());
  // Epic #708 — AI bug scanner: rule authoring, scans, triage + publish.
  r.use("/projects/:projectId/rule-sets", rulesRouter());
  r.use("/projects/:projectId", scansRouter());
  r.use("/projects/:projectId", triageRouter());
  // Epic #739 — Bidirectional Issue Sync.
  r.use("/webhooks", syncWebhookRouter());
  r.use("/sync", syncDriftRouter());
  // Epic #748 — SCIM 2.0 provisioning endpoints.
  r.use("/scim/v2", scimRouter());
  // Epic #759 — Workspaces multi-tenancy.
  r.use("/workspaces", workspacesRouter());
  // Epic #47 (#54) — workspace FinOps surface (forecast, budget, alerts, PDF).
  r.use("/workspaces/:workspaceId/finops", finopsWorkspaceRouter());
  // Epic #610 (#624) — workspace-scoped requirement search (link picker).
  r.use("/workspaces/:workspaceId/requirements", workspaceRequirementSearchRouter());
  // Epic #610 (#626) — workspace-level traceability rollup (coverage + link map).
  r.use("/workspaces/:workspaceId/traceability", workspaceTraceabilityRouter());
  // Epic #856 — Project-level test coverage gap analysis.
  r.use("/projects/:projectId/test-coverage", testCoverageRouter());
  // Epic #889 (#892) — requirement↔data traceability mappings.
  r.use("/projects/:projectId", dataMappingsRouter());
  // Epic #207 — requirement→spec→code traceability spine.
  r.use("/projects/:projectId", traceabilityRouter());
  // Epic #208 — stakeholder + project-context model.
  r.use("/projects/:projectId", stakeholdersRouter());
  // Epic #728 — multi-user collaboration (comments, assignments, optimistic lock).
  r.use("/requirements", requirementsCollaborationRouter());
  // Epic #610 (#624) — delete typed requirement links by id.
  r.use("/requirement-links", requirementLinksResourceRouter());
  r.use("/comments", commentsRouter());
  // Epic #609 (#617) — formal review & approval workflow (requirements/specs).
  r.use("/projects/:projectId/reviews", projectReviewsRouter());
  r.use("/reviews", reviewsRouter());
  // Epic #609 (#620) — immutable requirement baselines (list, contents, compare).
  r.use("/projects/:projectId/baselines", projectBaselinesRouter());
  r.use("/baselines", baselinesRouter());
  // Issue #612 (epic #608) — self-service notification preferences. Mounted
  // before the generic /users router so the /users/me/* path is unambiguous.
  r.use("/users/me/notification-preferences", notificationPreferencesRouter());
  // Issue #281 — user search for @mention autocomplete.
  r.use("/users", usersRouter());
  // Issue #416 — persisted notification center.
  r.use("/notifications", notificationsRouter());
  // Epic #475 — collaborative multi-analyst discussions.
  r.use("/discussions", discussionsRouter());
  // Epic #547 Phase 0 (#548) — Microsoft Teams app foundation (bot endpoint +
  // per-workspace OAuth install + ConversationReference store). Shared base for
  // the collaboration bridge (#549–#554) and ChatOps/notification epics (#63/#67).
  r.use("/integrations/teams", teamsIntegrationRouter());
  // Issue #580 (epic #63) — PagerDuty sev-1 alerting config (workspace admin).
  r.use("/integrations/pagerduty", pagerDutyIntegrationRouter());
  // Issue #579 (epic #63) — Slack app admin install + OAuth callback. The Bolt
  // slash-command/interactivity RECEIVER is mounted separately in app.ts (ahead
  // of the JSON parser) at /api/integrations/slack/events for raw-body signature
  // verification.
  r.use("/integrations/slack", slackIntegrationRouter());
  r.use(
    "/projects/:projectId/spec-kit/artifacts/:artifactName/comments",
    specKitArtifactCommentsRouter(),
  );
  return r;
}
