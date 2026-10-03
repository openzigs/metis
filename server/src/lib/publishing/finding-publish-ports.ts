/**
 * Epic #708 / #800 — the shared halves of the finding publisher's production
 * ports: GitHub and Jira issue creation, plus the best-effort audit.
 *
 * Every finding-publish flow — the scanner's `publishScanFinding`, Deep Dive's
 * `publishAnalysisFinding` and Impact Analysis's `publishImpactAnalysisToJira`
 * — creates its external issue through these. Each flow supplies its own
 * idempotency key (`findExistingLink` / `saveLink`) and stale-commit anchor
 * (`currentRepoCommitSha`) on top. Moved unchanged out of the bug scanner's
 * Prisma adapter by #800 so that publishing does not depend on the scanner.
 */
import { prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { readBoundSecret } from "../connectors/vault-resolver.js";
import { getVaultService } from "../vault/vault-service.js";
import { assertConnectorHostAllowed } from "../connectors/network-allowlist.js";
import { createJiraClient } from "../connectors/jira/jira-client.js";
import { acquirePublishOctokit } from "./octokit-factory.js";
import { PublishError, type CreatedIssue, type PublisherPorts } from "./finding-publisher.js";

/**
 * Sentinel commit anchor — analysis findings and impact runs have no scanned
 * commit SHA, so both sides of the stale-commit gate carry this constant.
 */
export const ANALYSIS_PUBLISH_ANCHOR = "analysis-finding-anchor";

interface GhIssueResponse {
  number: number;
  html_url: string;
}

function noPublishTargetError(): PublishError {
  return new PublishError(
    "ERR_NO_PUBLISH_TARGET",
    "No GitHub publish target is configured for this project — choose a target repository, or set one on the Publishing page (Save as project target).",
  );
}

function publisherStateForUpsert(): Pick<PublisherPorts, "audit"> {
  return {
    async audit(event, scanFindingId, meta) {
      const sf = await prisma.scanFinding.findUnique({
        where: { id: scanFindingId },
        select: { scan: { select: { createdById: true } } },
      });
      audit({
        actor: { id: sf?.scan.createdById ?? "system" },
        action: `scanner.${event}`,
        target: { type: "scan_finding", id: scanFindingId },
        metadata: { ...meta },
      });
    },
  };
}

/** The ports every finding-publish flow shares; the rest are flow-specific. */
export type SharedFindingPublisherPorts = Pick<
  PublisherPorts,
  "createGitHubIssue" | "createJiraIssue" | "audit"
>;

/** Build the production issue-creation + audit ports. */
export function buildSharedFindingPublisherPorts(): SharedFindingPublisherPorts {
  const base = publisherStateForUpsert();
  return {
    async createGitHubIssue({
      projectId,
      repoConnectionId,
      title,
      body,
      labels,
      target,
    }): Promise<CreatedIssue> {
      const conn = await prisma.repoConnection.findFirst({
        where: { id: repoConnectionId, projectId, deletedAt: null },
      });
      if (!conn) {
        throw new Error(`repo connection ${repoConnectionId} not found`);
      }
      // #733 — the issue goes to the resolved target (the caller's choice or the
      // project's saved publish target); the connector only supplies the
      // credential. There is deliberately NO fallback to `conn.ownerOrOrg/
      // conn.repoName`: for an analysed project that is its upstream, and every
      // publish path — scanner and analysis alike — funnels through here.
      if (!target) throw noPublishTargetError();
      const { owner, repo } = target;
      // #480 — the connector's bound secret by id, never re-resolved by label.
      const token = conn.secretId ? await readBoundSecret(conn.secretId, getVaultService()) : null;
      if (!token) {
        throw new Error("repo connection missing vault-resolved token");
      }
      const baseUrl = conn.apiBaseUrl ?? "https://api.github.com";
      const client = await acquirePublishOctokit({
        owner,
        baseUrl,
        token,
      });
      const res = await client.request<GhIssueResponse>({
        method: "POST",
        url: `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`,
        data: { title, body, labels },
      });
      const data = res.data;
      return {
        externalId: String(data.number),
        externalUrl: data.html_url,
      };
    },

    async createJiraIssue({ projectId, title, body, labels, severity }): Promise<CreatedIssue> {
      // Resolve the project's Jira destination — single-finding publishing
      // reuses the same connection + project key configured by the
      // batch-publishing pipeline (Epic #557).
      const project = await prisma.project.findUnique({
        where: { id: projectId },
        select: { jiraConnectionId: true, jiraProjectKey: true },
      });
      if (!project?.jiraConnectionId || !project?.jiraProjectKey) {
        throw new PublishError(
          "ERR_JIRA_NOT_CONFIGURED",
          "Project has no Jira connection or project key configured — wire one in project settings before publishing to Jira.",
        );
      }
      const conn = await prisma.jiraConnection.findFirst({
        where: { id: project.jiraConnectionId, deletedAt: null },
      });
      if (!conn) {
        throw new PublishError(
          "ERR_JIRA_NOT_CONFIGURED",
          `Jira connection ${project.jiraConnectionId} not found`,
        );
      }
      if (conn.status === "error") {
        throw new PublishError(
          "ERR_JIRA_NOT_CONFIGURED",
          "Jira connection is in error state — re-test it before publishing",
        );
      }
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
      const created = await client.createIssue({
        project: { key: project.jiraProjectKey },
        summary: title.slice(0, 255),
        issuetype: { name: "Bug" },
        description: `${body}\n\n_Severity: ${severity}_`,
        labels: Array.from(new Set(labels.filter(Boolean))).slice(0, 25),
      });
      const baseUrl = conn.baseUrl.replace(/\/$/, "");
      return {
        externalId: created.key,
        externalUrl: `${baseUrl}/browse/${created.key}`,
      };
    },

    audit: base.audit,
  };
}
