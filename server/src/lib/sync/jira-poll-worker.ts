/**
 * Epic #739 / Issue #744 — Jira DC background re-poll worker.
 *
 * Scheduler task handler that periodically polls Jira Data Center instances
 * for issue changes when webhooks are not available (firewalled environments).
 *
 * Features:
 * - Per-project enable/disable toggle via project settings
 * - Configurable poll interval (default 300s)
 * - Exponential backoff on Jira 5xx errors
 * - Diff polled state against last-known to detect changes
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { createJiraClient } from "../connectors/jira/jira-client.js";
import { getVaultService } from "../vault/vault-service.js";
import { reconcileIssueChange, type ReconcileDeps } from "./reconcile-service.js";
import type { IssueChangeEvent, IssueChangeFields } from "@metis/shared";
import { ulid } from "ulid";

const log = createChildLogger("sync-jira-poll");

/** Max backoff: 30 minutes. */
const MAX_BACKOFF_MS = 30 * 60 * 1000;
const BASE_BACKOFF_MS = 10_000;

export interface JiraPollTaskPayload {
  projectId: string;
  jiraConnectionId: string;
  /** JQL filter to scope the poll — defaults to project-level if empty. */
  jqlFilter?: string;
}

export interface JiraPollResult {
  polled: number;
  drifts: number;
  errors: number;
  backoffMs?: number;
}

/**
 * Task handler for the scheduler — polls Jira DC for changes.
 */
export async function executeJiraPoll(
  payload: JiraPollTaskPayload,
  deps: ReconcileDeps = {},
  signal?: AbortSignal,
): Promise<JiraPollResult> {
  const { projectId, jiraConnectionId, jqlFilter: _jqlFilter } = payload;

  // Load connection details
  const connection = await prisma.jiraConnection.findUnique({
    where: { id: jiraConnectionId },
  });
  if (!connection) {
    log.warn("sync.jira_poll.connection_not_found", { jiraConnectionId });
    return { polled: 0, drifts: 0, errors: 1 };
  }

  // Get credentials from vault
  const vault = getVaultService();
  let apiToken: string;
  try {
    const { plaintext } = await vault.read(connection.secretId!);
    apiToken = plaintext;
  } catch {
    log.error("sync.jira_poll.vault_error", { jiraConnectionId });
    return { polled: 0, drifts: 0, errors: 1 };
  }

  // Create Jira client
  const client = createJiraClient({
    baseUrl: connection.baseUrl,
    username: connection.username,
    apiToken,
    edition: connection.edition as "cloud" | "datacenter",
  });

  // Find published issues linked to this connection's project
  const publishedIssues = await prisma.publishedIssue.findMany({
    where: {
      batch: { projectId },
      destination: "jira",
      status: "created",
    },
    include: { draft: true },
  });

  if (publishedIssues.length === 0) {
    log.debug("sync.jira_poll.no_issues", { projectId });
    return { polled: 0, drifts: 0, errors: 0 };
  }

  let polled = 0;
  let drifts = 0;
  let errors = 0;
  let consecutiveErrors = 0;

  for (const published of publishedIssues) {
    if (signal?.aborted) break;

    try {
      // The issueId for Jira is stored as the issue key (e.g., PROJ-123)
      const issueKey = published.issueId;
      const jiraIssue = await client.getIssue(issueKey);
      polled++;
      consecutiveErrors = 0;

      // Cast once — JiraIssueDetail.fields is Record<string, unknown>.
      type F = {
        summary?: string;
        description?: string;
        status?: { name?: string };
        labels?: Array<string | { name?: string }>;
        assignee?: { displayName?: string; name?: string };
      };
      const f = jiraIssue.fields as F;

      const current: IssueChangeFields = {
        title: f.summary ?? "",
        body: f.description ?? "",
        state: mapJiraStatus(f.status?.name),
        labels: (f.labels ?? []).map((l) => (typeof l === "string" ? l : (l.name ?? ""))),
        assignees: f.assignee ? [f.assignee.displayName ?? f.assignee.name ?? ""] : [],
      };

      const event: IssueChangeEvent = {
        deliveryId: `poll-${ulid()}`,
        source: "jira",
        externalId: published.issueId,
        externalRef: issueKey,
        action: "edited",
        changes: {},
        current,
        timestamp: new Date().toISOString(),
      };

      const result = await reconcileIssueChange(event, deps);
      if (result.handled) drifts++;
    } catch (err: unknown) {
      errors++;
      consecutiveErrors++;
      const status = (err as { status?: number })?.status;

      if (status && status >= 500) {
        const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, consecutiveErrors), MAX_BACKOFF_MS);
        log.warn("sync.jira_poll.5xx_backoff", {
          issueId: published.issueId,
          status,
          backoffMs: backoff,
        });

        // If too many consecutive 5xx, abort the batch
        if (consecutiveErrors >= 3) {
          return { polled, drifts, errors, backoffMs: backoff };
        }

        await sleep(backoff, signal);
      } else {
        log.error("sync.jira_poll.issue_error", {
          issueId: published.issueId,
          error: (err as Error).message,
        });
      }
    }
  }

  return { polled, drifts, errors };
}

function mapJiraStatus(statusName: string | undefined): "open" | "closed" {
  if (!statusName) return "open";
  const lower = statusName.toLowerCase();
  if (lower === "done" || lower === "closed" || lower === "resolved") return "closed";
  return "open";
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
