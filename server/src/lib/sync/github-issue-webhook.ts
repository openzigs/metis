/**
 * Epic #739 / Issue #740 — GitHub issue lifecycle webhook handler.
 *
 * Processes `issues.{edited,closed,reopened,labeled,unlabeled,assigned,unassigned}`
 * events, normalizes them into `IssueChangeEvent`, and feeds the reconciliation
 * service. The HMAC signature (X-Hub-Signature-256) is verified by the one
 * receiver, `routes/webhooks-github.ts`, before this runs (#113 removed an
 * unused second verifier from here).
 */
import type { IssueChangeEvent, IssueChangeFields, IssueChangeAction } from "@metis/shared";
import { createChildLogger } from "../logger.js";
import {
  reconcileIssueChange,
  type ReconcileDeps,
  type ReconcileResult,
} from "./reconcile-service.js";

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

export interface GithubIssueDriftDelivery {
  /** `X-GitHub-Event` header value. */
  eventType: string;
  /** `X-GitHub-Delivery` UUID — the DriftEvent's idempotency key. */
  deliveryId: string;
  /** Parsed JSON body, already signature-verified by the caller. */
  payload: unknown;
}

/**
 * Issue #96 — the drift half of `POST /api/webhooks/github/issues`.
 *
 * GitHub issue deliveries are received by ONE handler (`webhooks-github.ts`),
 * which runs the spec-kit `tasks.md` sync and then this. It used to be a second
 * `POST /github/issues` route in `routes/sync.ts`, registered after the spec-kit
 * one on the same `/webhooks` prefix — so Express never reached it and no
 * GitHub edit ever produced a `DriftEvent`. Signature verification and replay
 * dedup are the caller's; this only filters, normalizes and reconciles.
 */
export async function reconcileGithubIssueDelivery(
  delivery: GithubIssueDriftDelivery,
  deps: ReconcileDeps = {},
): Promise<ReconcileResult> {
  // A repo webhook set to "send everything" also delivers `issue_comment`
  // events, whose payload carries an `issue` and an `edited` action too.
  if (delivery.eventType !== "issues") {
    return { handled: false, reason: "NOT_ISSUES_EVENT" };
  }
  const payload = (delivery.payload ?? {}) as GithubIssueWebhookPayload;
  const { event, reason } = normalizeGithubIssueEvent(payload, delivery.deliveryId);
  if (!event) return { handled: false, reason };
  return reconcileIssueChange(event, deps);
}
