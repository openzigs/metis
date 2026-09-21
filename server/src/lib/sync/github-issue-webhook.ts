/**
 * Epic #739 / Issue #740 — GitHub issue lifecycle webhook handler.
 *
 * Processes `issues.{edited,closed,reopened,labeled,unlabeled,assigned,unassigned}`
 * events, normalizes them into `IssueChangeEvent`, and feeds the reconciliation
 * service. Verifies HMAC signature (X-Hub-Signature-256).
 */
import crypto from "node:crypto";
import type { IssueChangeEvent, IssueChangeFields, IssueChangeAction } from "@metis/shared";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("sync-github-webhook");

const SUPPORTED_ACTIONS: Set<string> = new Set([
  "edited",
  "closed",
  "reopened",
  "labeled",
  "unlabeled",
  "assigned",
  "unassigned",
]);

export interface GithubIssueWebhookPayload {
  action: string;
  issue: {
    id: number;
    node_id: string;
    number: number;
    title: string;
    body: string | null;
    state: "open" | "closed";
    labels?: Array<{ name: string }>;
    assignees?: Array<{ login: string }>;
  };
  changes?: Record<string, { from: unknown }>;
  sender?: { login: string };
}

export interface VerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify the GitHub webhook HMAC-SHA256 signature.
 */
export function verifyGithubIssueSignature(
  rawBody: string,
  secret: string,
  signature: string | undefined,
): VerifyResult {
  if (!secret) return { ok: false, reason: "NO_SECRET_CONFIGURED" };
  if (!signature) return { ok: false, reason: "NO_SIGNATURE" };

  const expected = "sha256=" + crypto.createHmac("sha256", secret).update(rawBody).digest("hex");

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }
  return { ok: true };
}

export interface NormalizeResult {
  event: IssueChangeEvent | null;
  reason?: string;
}

/**
 * Normalize a GitHub issues webhook payload into an IssueChangeEvent.
 * Returns null if the action is not supported.
 */
export function normalizeGithubIssueEvent(
  payload: GithubIssueWebhookPayload,
  deliveryId: string,
  timestamp?: string,
): NormalizeResult {
  if (!SUPPORTED_ACTIONS.has(payload.action)) {
    log.debug("sync.github.unsupported_action", { action: payload.action });
    return { event: null, reason: "UNSUPPORTED_ACTION" };
  }

  const issue = payload.issue;
  if (!issue) {
    return { event: null, reason: "NO_ISSUE_PAYLOAD" };
  }

  const current: IssueChangeFields = {
    title: issue.title ?? "",
    body: issue.body ?? "",
    state: issue.state ?? "open",
    labels: (issue.labels ?? []).map((l) => l.name),
    assignees: (issue.assignees ?? []).map((a) => a.login),
  };

  // Build changes based on the action
  const changes: Partial<IssueChangeFields> = {};
  if (payload.action === "edited" && payload.changes) {
    if (payload.changes.title) changes.title = current.title;
    if (payload.changes.body) changes.body = current.body;
  }
  if (payload.action === "closed" || payload.action === "reopened") {
    changes.state = current.state;
  }
  if (payload.action === "labeled" || payload.action === "unlabeled") {
    changes.labels = current.labels;
  }
  if (payload.action === "assigned" || payload.action === "unassigned") {
    changes.assignees = current.assignees;
  }

  const event: IssueChangeEvent = {
    deliveryId,
    source: "github",
    externalId: issue.node_id,
    externalRef: String(issue.number),
    action: payload.action as IssueChangeAction,
    changes,
    current,
    timestamp: timestamp ?? new Date().toISOString(),
    actor: payload.sender?.login,
  };

  return { event };
}
