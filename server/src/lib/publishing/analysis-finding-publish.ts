/**
 * Epic #176 / #179 — publish a Deep Dive analysis finding to GitHub or Jira.
 */
import { createHash } from "node:crypto";

import type { AnalysisAgentKey, AnalysisAgentSource, FindingIssueDraft } from "@metis/shared";

import { prisma } from "../prisma.js";
import { getPersona } from "../analysis/personas.js";
import { findSavedGitHubTarget } from "./saved-target.js";
import { PublishError, publishFinding } from "./finding-publisher.js";
import type {
  ExistingIssueLink,
  FindingPayload,
  GitHubIssueTarget,
  PublisherPorts,
} from "./finding-publisher.js";
import type { Publisher, Severity } from "./finding-publish-types.js";
import {
  buildSharedFindingPublisherPorts,
  PUBLISH_AUDIT_SUBJECTS,
} from "./finding-publish-ports.js";

// ---------------------------------------------------------------------------
// Epic #176 / #179 — analysis-finding publishing.
//
// Analysis findings use the generic `publishFinding` engine (marker dedup +
// idempotent IssueLink), keyed on `IssueLink.findingId`.
// ---------------------------------------------------------------------------

/** Deterministic 64-hex fingerprint for an analysis finding (marker dedup). */
function analysisFindingFingerprint(findingId: string): string {
  return createHash("sha256").update(`analysis-finding:${findingId}`).digest("hex");
}

/**
 * Build the published issue body for an analysis finding. Adds the
 * analysis back-link and persona attribution required by Epic #176 / #179.
 * The draft is operator-edited content; it is length-bounded by
 * `findingIssueDraftSchema` at the route boundary.
 */
export function buildAnalysisFindingBody(args: {
  analysisId: string;
  agentKey: AnalysisAgentKey;
  /** #338 — set for an agent-phase finding; wins over the `agentKey` persona. */
  agentSource?: AnalysisAgentSource | null;
  draft: FindingIssueDraft;
}): string {
  const { analysisId, agentKey, agentSource, draft } = args;
  const lines: string[] = [draft.problemStatement.trim()];
  if (draft.affected.files.length > 0) {
    lines.push("", "### Affected files");
    for (const f of draft.affected.files) lines.push(`- \`${f}\``);
  }
  if (draft.affected.requirementIds.length > 0) {
    lines.push("", "### Related requirements");
    for (const r of draft.affected.requirementIds) lines.push(`- ${r}`);
  }
  if (draft.acceptanceCriteria.length > 0) {
    lines.push("", "### Acceptance criteria");
    for (const a of draft.acceptanceCriteria) lines.push(`- [ ] ${a}`);
  }
  lines.push(
    "",
    "---",
    `From METIS analysis \`${analysisId}\` · reported by ${reporterAttribution(agentKey, agentSource)}.`,
  );
  return lines.join("\n");
}

/**
 * #338 — who reported the finding, for the published footer. An agent-phase
 * finding names its custom/library agent; a specialist finding names its
 * persona exactly as before. The agent name is operator-authored, so it is
 * collapsed to one line and every markdown/HTML metacharacter (and `@`, so it
 * cannot mention anyone) is backslash-escaped. The ref is validated by
 * `isAgentPhaseResultKey` upstream and sits in a code span.
 */
function reporterAttribution(
  agentKey: AnalysisAgentKey,
  agentSource: AnalysisAgentSource | null | undefined,
): string {
  if (!agentSource) {
    const persona = getPersona(agentKey);
    return `**${persona.name}** (${persona.role})`;
  }
  const name = agentSource.name
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[\\`*_{}[\]()<>#+\-.!|~@&]/g, "\\$&");
  return `**${name}** (${agentSource.kind} agent \`${agentSource.ref}\`)`;
}

/**
 * Publisher ports for analysis findings. Reuses the shared ports for issue
 * creation + audit, and keys idempotency on `IssueLink.findingId`: the engine's
 * `sourceId` is the analysis finding id.
 */
function buildAnalysisPublisherPorts(): PublisherPorts {
  const base = buildSharedFindingPublisherPorts(PUBLISH_AUDIT_SUBJECTS.analysis);
  return {
    ...base,
    async findExistingLink(findingId, provider) {
      const row = await prisma.issueLink.findFirst({ where: { findingId, provider } });
      if (!row) return null;
      return {
        id: row.id,
        sourceId: row.findingId ?? findingId,
        provider: row.provider as Publisher,
        externalId: row.externalId,
        externalUrl: row.externalUrl,
      };
    },
    async saveLink({ sourceId, provider, externalId, externalUrl, fingerprint }) {
      const row = await prisma.issueLink.upsert({
        where: { findingId_provider: { findingId: sourceId, provider } },
        update: { externalId, externalUrl, fingerprint },
        create: { findingId: sourceId, provider, externalId, externalUrl, fingerprint },
      });
      return {
        id: row.id,
        sourceId: row.findingId ?? sourceId,
        provider: row.provider as Publisher,
        externalId: row.externalId,
        externalUrl: row.externalUrl,
      };
    },
  };
}

export interface PublishAnalysisFindingInput {
  projectId: string;
  analysisId: string;
  findingId: string;
  agentKey: AnalysisAgentKey;
  /** #338 — the custom/library agent an agent-phase finding came from. */
  agentSource?: AnalysisAgentSource | null;
  severity: Severity;
  category: string;
  draft: FindingIssueDraft;
  provider: Publisher;
  extraLabels?: readonly string[];
  /** #733 — the GitHub repository to file into; else the project's configured target. */
  target?: GitHubIssueTarget;
}

/**
 * Publish a single analysis finding (with an operator-edited draft) to GitHub
 * or Jira via the shared finding-publisher. Idempotent per (findingId,
 * provider). For GitHub, the issue goes to the explicit or configured target
 * (#733) using the project's primary/active repo connection's credential; Jira
 * requires no repo connection.
 */
export async function publishAnalysisFinding(
  input: PublishAnalysisFindingInput,
): Promise<ExistingIssueLink> {
  let repoConnectionId = "";
  let target: GitHubIssueTarget | undefined;
  if (input.provider === "github") {
    // #733 — the caller's explicit target, else the project's saved one. There is
    // deliberately no fallback to the connector's own (upstream) repository.
    // Resolved WITHOUT throwing: an already-published
    // finding must still get its existing link back (the engine's idempotency
    // check runs first), and with no target `createGitHubIssue` refuses with
    // ERR_NO_PUBLISH_TARGET before any request leaves.
    target = input.target ?? (await findSavedGitHubTarget(input.projectId)) ?? undefined;
    const conn = await prisma.repoConnection.findFirst({
      where: {
        projectId: input.projectId,
        deletedAt: null,
        status: { in: ["connected", "pending"] },
      },
      orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    });
    if (!conn) {
      throw new PublishError(
        "ERR_NOT_IMPLEMENTED",
        "Project has no connected GitHub repository — connect a repo before publishing.",
      );
    }
    repoConnectionId = conn.id;
  }

  const body = buildAnalysisFindingBody({
    analysisId: input.analysisId,
    agentKey: input.agentKey,
    agentSource: input.agentSource,
    draft: input.draft,
  });

  const payload: FindingPayload = {
    fingerprint: analysisFindingFingerprint(input.findingId),
    // Persisted by the analysis ports as IssueLink.findingId.
    sourceId: input.findingId,
    projectId: input.projectId,
    repoConnectionId,
    title: input.draft.title,
    body,
    severity: input.severity,
    category: input.category,
    ...(target && { target }),
  };

  const extraLabels = [...input.draft.suggestedLabels, ...(input.extraLabels ?? [])];
  const ports = buildAnalysisPublisherPorts();
  const outcome = await publishFinding(ports, {
    finding: payload,
    provider: input.provider,
    sourceLabel: "metis-analysis",
    extraLabels,
  });
  return outcome.link;
}
