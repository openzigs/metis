/**
 * Epic #739 — Bidirectional Issue Sync module barrel.
 */
export {
  reconcileIssueChange,
  resolveDriftEvent,
  getDriftEventProjectId,
  listDriftEvents,
  getDriftCount,
} from "./reconcile-service.js";
export { verifyGithubIssueSignature, normalizeGithubIssueEvent } from "./github-issue-webhook.js";
export { verifyJiraWebhookSignature, normalizeJiraIssueEvent } from "./jira-webhook.js";
export { executeJiraPoll } from "./jira-poll-worker.js";
export type { ReconcileDeps, ReconcileResult } from "./reconcile-service.js";
export type { GithubIssueWebhookPayload, NormalizeResult } from "./github-issue-webhook.js";
export type { JiraWebhookPayload, JiraNormalizeResult } from "./jira-webhook.js";
export type { JiraPollTaskPayload, JiraPollResult } from "./jira-poll-worker.js";
