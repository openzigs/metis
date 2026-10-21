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
import { jiraLabels } from "./label-sync.js";
import { bodyWithCodeAsText } from "./draft-code-links.js";
import { withUnverifiedNote } from "./published-body.js";
import { publishableBody, sourceIds, sourceMarkerForDraft } from "./dedup.js";

/**
 * #1103 — the Jira issue property that routes an issue back to its METIS
 * requirement: `{ projectId, analysisId, requirementId }`. A property, not
 * text: #1064 keeps ids out of the visible description, and Jira shows an
 * HTML comment as text or drops it. Like `parseSourceMarker`'s comment, it is
 * a HINT — anyone who can edit the issue can rewrite it — so whatever reads it
 * must confirm it against the `PublishedIssue` rows, never authorise on it.
 */
export const JIRA_SOURCE_PROPERTY_KEY = "metis.source";

/** The draft's columns the source property is built from. */
interface DraftSource {
  projectId: string;
  requirementId: string | null;
  metadata?: string | null;
}

/** #1103 — the `metis.source` value for a draft, or null when it has no plain project id. */
export function jiraSourceProperty(draft: DraftSource): ReturnType<typeof sourceIds> {
  return sourceIds(sourceMarkerForDraft({ ...draft, metadata: draft.metadata ?? null }));
}

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
    metadata?: string | null;
  },
  projectKey: string,
  mapping: JiraFieldMapping,
  additionalLabels: readonly string[] = [],
): JiraCreateIssueFields {
  const issueType = draft.draftType === "epic" ? "Epic" : mapping.issueType || "Story";
  const draftLabels = safeParseLabelArray(draft.labels);

  const fields: JiraCreateIssueFields = {
    project: { key: projectKey },
    summary: draft.title.slice(0, 255),
    issuetype: { name: issueType },
    // #1064 — a Jira project is never the repository the code was analysed
    // from, so the Related code section goes out in its plain form: paths and
    // symbols as code, with no owner, commit SHA or URL of that repository.
    // #1276 — a draft labelled `unverified` says so in a sentence instead.
    // #1103 — marker-shaped text a stored draft may hold is sent inert, as on
    // GitHub (`publishableBody`); drift detection compares against that form.
    description: withUnverifiedNote(publishableBody(bodyWithCodeAsText(draft)), draftLabels),
    ...mapping.additionalFields,
  };

  // Map labels — never a hidden `finding:<id>` traceability label (#744), nor
  // the internal `unverified` (#1276). #1049 — plus the batch's requested ones.
  const labels = jiraLabels(draftLabels, additionalLabels);
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

/**
 * #1103 — write `metis.source` on a just-created issue. Best effort: the issue
 * exists whether or not this succeeds, so a refusal (a permission the token
 * lacks, an old Data Center) is logged and audited, never turned into a
 * failed publish that a retry would duplicate.
 */
async function setSourceProperty(
  client: JiraClient,
  issueKey: string,
  draft: DraftSource,
  opts: { draftId: string; batchId: string; actorId: string },
): Promise<void> {
  const value = jiraSourceProperty(draft);
  if (!value) return;
  try {
    await client.setIssueProperty(issueKey, JIRA_SOURCE_PROPERTY_KEY, value);
  } catch (err) {
    const status = err instanceof JiraApiError ? err.status : null;
    log.warn("Could not set the METIS source property on a Jira issue", {
      draftId: opts.draftId,
      issueKey,
      status,
    });
    audit({
      actor: { id: opts.actorId },
      action: "publish.jira.source_property_failed",
      target: { type: "issue_draft", id: opts.draftId },
      metadata: { batchId: opts.batchId, jiraKey: issueKey, status },
    });
  }
}

/** #1103 — what one Jira issue of a batch will be created with. */
export interface JiraPlannedIssue {
  draftId: string;
  title: string;
  issueType: string;
  labels: string[];
  description: string;
  sourceProperty: { key: string; value: NonNullable<ReturnType<typeof sourceIds>> } | null;
}

/**
 * #1103 — the Jira leg of a dry run: each issue as `publishDraftToJira` would
 * create it (the same field mapping) and the `metis.source` property it would
 * then set. Pure: no Jira call.
 */
export function planJiraIssues(
  drafts: ReadonlyArray<
    {
      id: string;
      title: string;
      body: string;
      draftType: string;
      labels: string;
      storyPoints: number | null;
    } & DraftSource
  >,
  opts: { projectKey: string; additionalLabels?: readonly string[]; mapping?: JiraFieldMapping },
): { projectKey: string; issues: JiraPlannedIssue[] } {
  const mapping = opts.mapping ?? DEFAULT_FIELD_MAPPING;
  return {
    projectKey: opts.projectKey,
    issues: drafts.map((d) => {
      const fields = mapDraftToJiraFields(d, opts.projectKey, mapping, opts.additionalLabels);
      const value = jiraSourceProperty(d);
      return {
        draftId: d.id,
        title: fields.summary,
        issueType: fields.issuetype.name,
        labels: Array.isArray(fields.labels) ? (fields.labels as string[]) : [],
        description: String(fields.description ?? ""),
        sourceProperty: value ? { key: JIRA_SOURCE_PROPERTY_KEY, value } : null,
      };
    }),
  };
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
  /** #1049 — the batch's "Additional labels", applied after the draft's own. */
  additionalLabels?: readonly string[];
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
    const fields = mapDraftToJiraFields(
      draft,
      opts.projectKey,
      mapping,
      opts.additionalLabels ?? [],
    );
    const created = await client.createIssue(fields);
    await setSourceProperty(client, created.key, draft, opts);

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
  /** #1049 — the batch's "Additional labels", applied to every issue. */
  additionalLabels?: readonly string[];
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
      additionalLabels: opts.additionalLabels,
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
