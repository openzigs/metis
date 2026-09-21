/**
 * Jira issue publishing service — Epic #557 / Issue #566.
 *
 * Publishes requirements as Jira issues using the Jira client from Epic #556.
 * Supports field mapping, status sync, and batch operations.
 */
import { prisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { audit } from "../audit/audit-service.js";
import { getVaultService } from "../vault/vault-service.js";
import { createJiraClient, JiraApiError, type JiraClient } from "../connectors/jira/jira-client.js";
import { assertConnectorHostAllowed } from "../connectors/network-allowlist.js";
import type { JiraCreateIssueFields } from "../connectors/jira/types.js";

const log = createChildLogger("jira-publisher");

// ---- Types -----------------------------------------------------------------

export interface JiraPublishResult {
  issueKey: string;
  issueId: string;
  htmlUrl: string;
  status: "created" | "failed";
  errorMessage?: string;
}

export interface JiraFieldMapping {
  issueType: string;
  priorityMap: Record<string, string>;
  additionalFields?: Record<string, unknown>;
}

export const DEFAULT_FIELD_MAPPING: JiraFieldMapping = {
  issueType: "Story",
  priorityMap: {
    critical: "Highest",
    high: "High",
    medium: "Medium",
    low: "Low",
  },
};

export class JiraPublishError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "JiraPublishError";
  }
}

// ---- Client resolution -----------------------------------------------------

async function resolveJiraClient(connectionId: string): Promise<{
  client: JiraClient;
  baseUrl: string;
}> {
  const conn = await prisma.jiraConnection.findFirst({
    where: { id: connectionId, deletedAt: null },
  });
  if (!conn) {
    throw new JiraPublishError(404, "JIRA_CONNECTION_NOT_FOUND", "Jira connection not found");
  }
  if (conn.status === "error") {
    throw new JiraPublishError(
      400,
      "JIRA_CONNECTION_ERROR",
      "Jira connection is in error state — test it first",
    );
  }

  // SSRF guard
  const { hostname } = new URL(conn.baseUrl);
  await assertConnectorHostAllowed(hostname, "jira");

  const vault = getVaultService();
  const { plaintext: apiToken } = await vault.read(conn.secretId);
  let tlsCaCert: string | null = null;
  if (conn.tlsCaSecretId) {
    const ca = await vault.read(conn.tlsCaSecretId);
    tlsCaCert = ca.plaintext;
  }

  const client = createJiraClient({
    edition: conn.edition as "cloud" | "datacenter",
    baseUrl: conn.baseUrl,
    username: conn.username,
    apiToken,
    proxyUrl: conn.proxyUrl,
    tlsRejectUnauthorized: conn.tlsRejectUnauthorized,
    tlsCaCert,
  });

  return { client, baseUrl: conn.baseUrl };
}

// ---- Field mapping ---------------------------------------------------------

function mapDraftToJiraFields(
  draft: {
    title: string;
    body: string;
    draftType: string;
    labels: string;
    storyPoints: number | null;
  },
  projectKey: string,
  mapping: JiraFieldMapping,
): JiraCreateIssueFields {
  const issueType = draft.draftType === "epic" ? "Epic" : mapping.issueType || "Story";

  const fields: JiraCreateIssueFields = {
    project: { key: projectKey },
    summary: draft.title.slice(0, 255),
    issuetype: { name: issueType },
    description: draft.body,
    ...mapping.additionalFields,
  };

  // Map labels
  const labels = safeParseLabelArray(draft.labels);
  if (labels.length > 0) {
    fields.labels = labels;
  }

  // Map story points (if supported)
  if (draft.storyPoints != null) {
    fields.story_points = draft.storyPoints;
  }

  return fields;
}

function safeParseLabelArray(labelsJson: string): string[] {
  try {
    const parsed = JSON.parse(labelsJson);
    return Array.isArray(parsed) ? parsed.filter((l): l is string => typeof l === "string") : [];
  } catch {
    return [];
  }
}

// ---- Publishing API --------------------------------------------------------

/**
 * Publish a single draft as a Jira issue.
 */
export async function publishDraftToJira(opts: {
  draftId: string;
  batchId: string;
  connectionId: string;
  projectKey: string;
  fieldMapping?: JiraFieldMapping;
  actorId: string;
}): Promise<JiraPublishResult> {
  const draft = await prisma.issueDraft.findFirst({
    where: { id: opts.draftId, deletedAt: null },
  });
  if (!draft) {
    throw new JiraPublishError(404, "DRAFT_NOT_FOUND", "Issue draft not found");
  }

  const mapping = opts.fieldMapping ?? DEFAULT_FIELD_MAPPING;

  try {
    const { client, baseUrl } = await resolveJiraClient(opts.connectionId);
    const fields = mapDraftToJiraFields(draft, opts.projectKey, mapping);
    const created = await client.createIssue(fields);

    const htmlUrl = `${baseUrl.replace(/\/+$/, "")}/browse/${created.key}`;

    audit({
      actor: { id: opts.actorId },
      action: "publish.jira.issue_created",
      target: { type: "issue_draft", id: opts.draftId },
      metadata: {
        batchId: opts.batchId,
        jiraKey: created.key,
        projectKey: opts.projectKey,
      },
    });

    return {
      issueKey: created.key,
      issueId: created.id,
      htmlUrl,
      status: "created",
    };
  } catch (err) {
    const msg = err instanceof JiraApiError ? err.message : String(err);
    log.error("Failed to publish draft to Jira", {
      draftId: opts.draftId,
      error: msg,
    });
    return {
      issueKey: "",
      issueId: "",
      htmlUrl: "",
      status: "failed",
      errorMessage: msg,
    };
  }
}

/**
 * Publish multiple drafts to Jira in batch.
 */
export async function publishBatchToJira(opts: {
  batchId: string;
  draftIds: string[];
  connectionId: string;
  projectKey: string;
  fieldMapping?: JiraFieldMapping;
  actorId: string;
  /** Inter-call delay (ms) to respect Jira rate limits. Default 500ms. */
  delayMs?: number;
  sleep?: (ms: number) => Promise<void>;
}): Promise<{
  results: JiraPublishResult[];
  publishedCount: number;
  failedCount: number;
}> {
  const delay = opts.delayMs ?? 500;
  const sleep = opts.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));

  const results: JiraPublishResult[] = [];
  let publishedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < opts.draftIds.length; i++) {
    const draftId = opts.draftIds[i];
    const result = await publishDraftToJira({
      draftId,
      batchId: opts.batchId,
      connectionId: opts.connectionId,
      projectKey: opts.projectKey,
      fieldMapping: opts.fieldMapping,
      actorId: opts.actorId,
    });

    results.push(result);
    if (result.status === "created") publishedCount++;
    else failedCount++;

    // Inter-call delay except after last item
    if (i < opts.draftIds.length - 1) {
      await sleep(delay);
    }
  }

  audit({
    actor: { id: opts.actorId },
    action: "publish.jira.batch_completed",
    target: { type: "publish_batch", id: opts.batchId },
    metadata: {
      total: opts.draftIds.length,
      publishedCount,
      failedCount,
    },
  });

  return { results, publishedCount, failedCount };
}
