/**
 * Issue #963 (Epic #960) — publish an Impact Analysis run to Jira.
 */
import { createHash } from "node:crypto";

import { prisma } from "../prisma.js";
import { publishFinding } from "./finding-publisher.js";
import type { ExistingIssueLink, FindingPayload, PublisherPorts } from "./finding-publisher.js";
import type { Publisher, Severity } from "./finding-publish-types.js";
import {
  buildSharedFindingPublisherPorts,
  PUBLISH_AUDIT_SUBJECTS,
} from "./finding-publish-ports.js";

// ---------------------------------------------------------------------------
// Issue #963 (Epic #960) — publish a whole ImpactAnalysis RUN as one external
// issue (Jira). Uses the same generic `publishFinding` engine (marker dedup +
// idempotent IssueLink) as the analysis-finding flow, keyed on
// `IssueLink.impactAnalysisId`.
// ---------------------------------------------------------------------------

/** Deterministic 64-hex fingerprint for an impact-analysis run (marker dedup). */
function impactAnalysisFingerprint(analysisId: string): string {
  return createHash("sha256").update(`impact-analysis:${analysisId}`).digest("hex");
}

/**
 * Publisher ports for an impact-analysis run. Reuses the shared ports for issue
 * creation + audit, and keys idempotency on `IssueLink.impactAnalysisId`: the
 * engine's `sourceId` is the run id.
 */
function buildImpactAnalysisPublisherPorts(): PublisherPorts {
  const base = buildSharedFindingPublisherPorts(PUBLISH_AUDIT_SUBJECTS.impactAnalysis);
  return {
    ...base,
    async findExistingLink(impactAnalysisId, provider) {
      const row = await prisma.issueLink.findFirst({ where: { impactAnalysisId, provider } });
      if (!row) return null;
      return {
        id: row.id,
        sourceId: row.impactAnalysisId ?? impactAnalysisId,
        provider: row.provider as Publisher,
        externalId: row.externalId,
        externalUrl: row.externalUrl,
      };
    },
    async saveLink({ sourceId, provider, externalId, externalUrl, fingerprint }) {
      const row = await prisma.issueLink.upsert({
        where: { impactAnalysisId_provider: { impactAnalysisId: sourceId, provider } },
        update: { externalId, externalUrl, fingerprint },
        create: { impactAnalysisId: sourceId, provider, externalId, externalUrl, fingerprint },
      });
      return {
        id: row.id,
        sourceId: row.impactAnalysisId ?? sourceId,
        provider: row.provider as Publisher,
        externalId: row.externalId,
        externalUrl: row.externalUrl,
      };
    },
  };
}

export interface PublishImpactAnalysisInput {
  /** The impact-analysis run id (idempotency key together with the provider). */
  analysisId: string;
  /**
   * The RUN project whose configured Jira connection + project key are used to
   * create the issue. Resolved by the route from the run's projects; the
   * createJiraIssue port throws ERR_JIRA_NOT_CONFIGURED when it is unconfigured.
   */
  jiraProjectId: string;
  /** Pre-serialized issue title (plain text) and body (sanitized markdown). */
  title: string;
  body: string;
  /** Run-level severity for the Jira issue footer; defaults to `medium`. */
  severity?: Severity;
  extraLabels?: readonly string[];
}

/**
 * Publish a single ImpactAnalysis run to Jira as ONE issue via the shared
 * finding-publisher. Idempotent per (analysisId, `jira`): a re-publish returns
 * the existing IssueLink untouched (no duplicate Jira issue). The body is
 * produced by the caller (the deterministic {@link serializeImpactAnalysisMarkdown}
 * export) so this function makes no LLM call and never fabricates content.
 */
export async function publishImpactAnalysisToJira(
  input: PublishImpactAnalysisInput,
): Promise<ExistingIssueLink> {
  const payload: FindingPayload = {
    fingerprint: impactAnalysisFingerprint(input.analysisId),
    // Persisted by the impact ports as IssueLink.impactAnalysisId.
    sourceId: input.analysisId,
    projectId: input.jiraProjectId,
    repoConnectionId: "",
    title: input.title,
    body: input.body,
    severity: input.severity ?? "medium",
    category: "impact-analysis",
  };

  const ports = buildImpactAnalysisPublisherPorts();
  const outcome = await publishFinding(ports, {
    finding: payload,
    provider: "jira",
    sourceLabel: "metis-impact-analysis",
    extraLabels: input.extraLabels,
  });
  return outcome.link;
}
