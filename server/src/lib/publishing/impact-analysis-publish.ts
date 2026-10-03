/**
 * Issue #963 (Epic #960) — publish an Impact Analysis run to Jira.
 * Moved unchanged out of the bug scanner's Prisma adapter by #800.
 */
import { createHash } from "node:crypto";

import { prisma } from "../prisma.js";
import { publishFinding } from "./finding-publisher.js";
import type { ExistingIssueLink, FindingPayload, PublisherPorts } from "./finding-publisher.js";
import type { Publisher, Severity } from "./finding-publish-types.js";
import {
  ANALYSIS_PUBLISH_ANCHOR,
  buildSharedFindingPublisherPorts,
} from "./finding-publish-ports.js";

// ---------------------------------------------------------------------------
// Issue #963 (Epic #960) — publish a whole ImpactAnalysis RUN as one external
// issue (Jira). Reuses the SAME generic `publishFinding` engine (marker dedup +
// idempotent IssueLink) as the scanner + analysis-finding flows. The ONLY
// differences are the persistence key (`IssueLink.impactAnalysisId`) and the
// stale-commit gate, which is N/A for an impact run (not anchored to a scanned
// repo commit) — satisfied with a constant anchor on both sides, never forked.
// ---------------------------------------------------------------------------

/** Deterministic 64-hex fingerprint for an impact-analysis run (marker dedup). */
function impactAnalysisFingerprint(analysisId: string): string {
  return createHash("sha256").update(`impact-analysis:${analysisId}`).digest("hex");
}

/**
 * Publisher ports for an impact-analysis run. Reuses the shared ports for issue
 * creation + audit, but keys idempotency on `IssueLink.impactAnalysisId` and
 * short-circuits the stale-commit gate (an impact run carries no scan commit).
 * The generic engine threads the analysis id through the `scanFindingId` slot.
 */
function buildImpactAnalysisPublisherPorts(): PublisherPorts {
  const base = buildSharedFindingPublisherPorts();
  return {
    ...base,
    async currentRepoCommitSha() {
      return ANALYSIS_PUBLISH_ANCHOR;
    },
    async findExistingLink(impactAnalysisId, provider) {
      const row = await prisma.issueLink.findFirst({ where: { impactAnalysisId, provider } });
      if (!row) return null;
      return {
        id: row.id,
        scanFindingId: row.impactAnalysisId ?? impactAnalysisId,
        provider: row.provider as Publisher,
        externalId: row.externalId,
        externalUrl: row.externalUrl,
      };
    },
    async saveLink({ scanFindingId, provider, externalId, externalUrl, fingerprint }) {
      const row = await prisma.issueLink.upsert({
        where: { impactAnalysisId_provider: { impactAnalysisId: scanFindingId, provider } },
        update: { externalId, externalUrl, fingerprint },
        create: { impactAnalysisId: scanFindingId, provider, externalId, externalUrl, fingerprint },
      });
      return {
        id: row.id,
        scanFindingId: row.impactAnalysisId ?? scanFindingId,
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
    // The generic engine uses this slot as the idempotency id; our impact ports
    // persist it as IssueLink.impactAnalysisId.
    scanFindingId: input.analysisId,
    scanId: input.analysisId,
    projectId: input.jiraProjectId,
    repoConnectionId: "",
    title: input.title,
    body: input.body,
    severity: input.severity ?? "medium",
    category: "impact-analysis",
    filePath: "",
    evidenceLines: [],
    qualifiedName: "",
    ruleId: null,
    commitSha: ANALYSIS_PUBLISH_ANCHOR,
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
