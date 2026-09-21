/**
 * Epic #739 / Issue #741 — Jira webhook receiver.
 *
 * Supports both Jira Cloud (signed payloads with `X-Hub-Signature` or
 * Atlassian Connect JWT) and Jira Data Center (shared-secret HMAC).
 *
 * Normalizes Jira issue events into `IssueChangeEvent` and feeds
 * the reconciliation service.
 */
import crypto from "node:crypto";
import type { IssueChangeEvent, IssueChangeFields, IssueChangeAction } from "@metis/shared";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("sync-jira-webhook");

/** Replay protection window: 5 minutes. */
const REPLAY_WINDOW_MS = 5 * 60 * 1000;

// ---- Supported Jira webhook event types ------------------------------------

const JIRA_ACTION_MAP: Record<string, IssueChangeAction | undefined> = {
  "jira:issue_updated": "edited",
  "jira:issue_deleted": "closed",
  issue_updated: "edited",
  issue_generic: "edited",
};

// Jira changelog field names → our normalized field names
const FIELD_MAP: Record<string, keyof IssueChangeFields | undefined> = {
  summary: "title",
  description: "body",
  status: "state",
  labels: "labels",
  assignee: "assignees",
};

// ---- Payload types ---------------------------------------------------------

export interface JiraWebhookPayload {
  webhookEvent?: string;
  timestamp?: number;
  issue?: {
    id: string;
    key: string;
    fields?: {
      summary?: string;
      description?: string;
      status?: { name: string };
      labels?: Array<{ name?: string } | string>;
      assignee?: { displayName?: string; accountId?: string; name?: string } | null;
    };
  };
  changelog?: {
    items?: Array<{
      field: string;
      fromString?: string | null;
      toString?: string | null;
    }>;
  };
  user?: { displayName?: string; accountId?: string; name?: string };
}

export interface JiraVerifyResult {
  ok: boolean;
  reason?: string;
}

/**
 * Verify Jira webhook signature.
 * - Cloud: HMAC-SHA256 via `X-Hub-Signature` header
 * - DC: shared-secret HMAC via custom header
 */
export function verifyJiraWebhookSignature(
  rawBody: string,
  secret: string,
  opts: {
    signature?: string;
    timestamp?: number;
  },
): JiraVerifyResult {
  if (!secret) return { ok: false, reason: "NO_SECRET_CONFIGURED" };
  if (!opts.signature) return { ok: false, reason: "NO_SIGNATURE" };

  // Replay protection
  if (opts.timestamp) {
    const age = Math.abs(Date.now() - opts.timestamp);
    if (age > REPLAY_WINDOW_MS) {
      return { ok: false, reason: "REPLAY_DETECTED" };
    }
  }

  const expected = crypto.createHmac("sha256", secret).update(rawBody).digest("hex");
  const provided = opts.signature.replace(/^sha256=/, "");

  // Validate hex format
  if (!/^[0-9a-f]+$/i.test(provided)) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }

  const sigBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");

  if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
    return { ok: false, reason: "SIGNATURE_MISMATCH" };
  }
  return { ok: true };
}

export interface JiraNormalizeResult {
  event: IssueChangeEvent | null;
  reason?: string;
}

/**
 * Normalize a Jira webhook payload into an IssueChangeEvent.
 */
export function normalizeJiraIssueEvent(
  payload: JiraWebhookPayload,
  deliveryId: string,
): JiraNormalizeResult {
  const webhookEvent = payload.webhookEvent ?? "";
  const baseAction = JIRA_ACTION_MAP[webhookEvent];

  if (!baseAction && !webhookEvent.includes("issue")) {
    log.debug("sync.jira.unsupported_event", { webhookEvent });
    return { event: null, reason: "UNSUPPORTED_EVENT" };
  }

  const issue = payload.issue;
  if (!issue) {
    return { event: null, reason: "NO_ISSUE_PAYLOAD" };
  }

  const fields = issue.fields ?? {};
  // Always infer action from changelog first, fall back to the base mapping
  const resolvedAction = inferActionFromChangelog(payload) ?? baseAction ?? "edited";

  const current: IssueChangeFields = {
    title: fields.summary ?? "",
    body: fields.description ?? "",
    state: mapJiraStatus(fields.status?.name),
    labels: normalizeJiraLabels(fields.labels),
    assignees: fields.assignee
      ? [fields.assignee.displayName ?? fields.assignee.accountId ?? fields.assignee.name ?? ""]
      : [],
  };

  // Build changes from changelog
  const changes: Partial<IssueChangeFields> = {};
  if (payload.changelog?.items) {
    for (const item of payload.changelog.items) {
      const mappedField = FIELD_MAP[item.field.toLowerCase()];
      if (mappedField) {
        (changes as Record<string, unknown>)[mappedField] = current[mappedField];
      }
    }
  }

  const event: IssueChangeEvent = {
    deliveryId,
    source: "jira",
    externalId: issue.id,
    externalRef: issue.key,
    action: resolvedAction,
    changes,
    current,
    timestamp: payload.timestamp
      ? new Date(payload.timestamp).toISOString()
      : new Date().toISOString(),
    actor: payload.user?.displayName ?? payload.user?.accountId ?? payload.user?.name,
  };

  return { event };
}

// ---- Helpers ---------------------------------------------------------------

function inferActionFromChangelog(payload: JiraWebhookPayload): IssueChangeAction | null {
  const items = payload.changelog?.items ?? [];
  // Priority: status changes > all others
  for (const item of items) {
    if (item.field.toLowerCase() === "status") {
      const to = (item.toString ?? "").toLowerCase();
      if (to === "done" || to === "closed" || to === "resolved") return "closed";
      return "reopened";
    }
  }
  // Non-status changes: only infer specific actions if that's the ONLY change
  if (items.length === 1) {
    const field = items[0]!.field.toLowerCase();
    if (field === "assignee") return "assigned";
    if (field === "labels") return "labeled";
  }
  return null;
}

function mapJiraStatus(statusName: string | undefined): "open" | "closed" {
  if (!statusName) return "open";
  const lower = statusName.toLowerCase();
  if (lower === "done" || lower === "closed" || lower === "resolved") return "closed";
  return "open";
}

function normalizeJiraLabels(labels: Array<{ name?: string } | string> | undefined): string[] {
  if (!labels) return [];
  return labels.map((l) => (typeof l === "string" ? l : (l.name ?? ""))).filter(Boolean);
}
