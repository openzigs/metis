/**
 * Epic #708 / Issue #715 — Finding publisher.
 *
 * Publishes an approved ScanFinding as a GitHub issue or Jira ticket and
 * records the mapping in IssueLink for idempotency. Reuses the
 * marker-comment dedup pattern from Epic #556/#557, but with a scanner-
 * specific prefix so the two flows never collide.
 *
 * Idempotency contract:
 *   - One IssueLink per (scanFindingId, provider). Re-publish returns
 *     the existing link untouched.
 *   - The marker `<!-- metis-finding: fingerprint=<hex> -->` is injected
 *     into the published body so the link can be reconstructed if the
 *     IssueLink row is lost.
 *   - The stale-commit gate refuses to publish when the repo's current
 *     commitSha differs from the scan's snapshot — operators must
 *     re-scan against fresh code before pushing to external trackers.
 */
import { SCANNER_PUBLISH_MARKER_PREFIX, type Publisher, type Severity } from "./types.js";

const MARKER_PREFIX = `<!-- ${SCANNER_PUBLISH_MARKER_PREFIX}:`;

export function buildFindingMarker(fingerprint: string): string {
  return `${MARKER_PREFIX} fingerprint=${fingerprint} -->`;
}

const MARKER_RE = new RegExp(`${escape(MARKER_PREFIX)}\\s*fingerprint=([0-9a-f]{64})\\s*-->`, "i");

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function parseFindingMarker(
  body: string | null | undefined,
): { fingerprint: string } | null {
  if (!body) return null;
  const m = MARKER_RE.exec(body);
  return m ? { fingerprint: m[1] } : null;
}

const STRIP_RE = new RegExp(
  `\\n*${escape(MARKER_PREFIX)}\\s*fingerprint=[0-9a-f]{64}\\s*-->\\n*`,
  "gi",
);

export function injectFindingMarker(body: string, fingerprint: string): string {
  const stripped = body.replace(STRIP_RE, "\n");
  const trimmed = stripped.replace(/\s+$/u, "");
  return `${trimmed}\n\n${buildFindingMarker(fingerprint)}\n`;
}

export interface FindingPayload {
  fingerprint: string;
  scanFindingId: string;
  scanId: string;
  projectId: string;
  repoConnectionId: string;
  title: string;
  body: string;
  severity: Severity;
  category: string;
  filePath: string;
  evidenceLines: number[];
  qualifiedName: string;
  ruleId: string | null;
  commitSha: string;
}

export interface ExistingIssueLink {
  id: string;
  scanFindingId: string;
  provider: Publisher;
  externalId: string;
  externalUrl: string;
}

export interface CreatedIssue {
  externalId: string;
  externalUrl: string;
}

export interface PublisherPorts {
  /**
   * Returns the repo's current commit SHA (origin/HEAD, post-pull) or
   * `null` when none is recorded. The stale-commit gate rejects null
   * explicitly — adapters MUST NOT coerce missing values to `""` because
   * that would let a scan with an empty `commitSha` bypass the check.
   */
  currentRepoCommitSha(projectId: string, repoConnectionId: string): Promise<string | null>;
  /** Lookup existing link for (scanFindingId, provider). */
  findExistingLink(scanFindingId: string, provider: Publisher): Promise<ExistingIssueLink | null>;
  /** Provider-specific issue creation. */
  createGitHubIssue(args: {
    projectId: string;
    repoConnectionId: string;
    title: string;
    body: string;
    labels: string[];
  }): Promise<CreatedIssue>;
  createJiraIssue(args: {
    projectId: string;
    title: string;
    body: string;
    labels: string[];
    severity: Severity;
  }): Promise<CreatedIssue>;
  /** Persist the new link row. */
  saveLink(args: {
    scanFindingId: string;
    provider: Publisher;
    externalId: string;
    externalUrl: string;
    fingerprint: string;
  }): Promise<ExistingIssueLink>;
  /** Best-effort audit. */
  audit(event: string, scanFindingId: string, meta?: Record<string, unknown>): Promise<void>;
}

export interface PublishInput {
  finding: FindingPayload;
  provider: Publisher;
  /** Caller-supplied additional labels. */
  extraLabels?: readonly string[];
}

export interface PublishOutcome {
  link: ExistingIssueLink;
  /** True when the existing link was returned without a new external issue. */
  reused: boolean;
  /** True when the stale-commit gate vetoed the publish. */
  staleCommit: boolean;
  /** Reason describing the stale-commit veto, when applicable. */
  staleCommitReason?: string;
}

export class PublishError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PublishError";
  }
}

function defaultLabels(finding: FindingPayload, extras: readonly string[]): string[] {
  const labels = new Set<string>([
    "metis-scanner",
    `severity:${finding.severity}`,
    `category:${finding.category.toLowerCase().replace(/\s+/g, "-")}`,
  ]);
  if (finding.ruleId) labels.add(`rule:${finding.ruleId}`);
  for (const l of extras) {
    const t = l.trim();
    if (t.length > 0 && t.length <= 64) labels.add(t);
  }
  return [...labels];
}

export async function publishFinding(
  ports: PublisherPorts,
  input: PublishInput,
): Promise<PublishOutcome> {
  const { finding, provider } = input;

  // Idempotency: existing link wins, no external call.
  const existing = await ports.findExistingLink(finding.scanFindingId, provider);
  if (existing) {
    await ports.audit("scanner.publish.reused", finding.scanFindingId, {
      provider,
      externalUrl: existing.externalUrl,
    });
    return { link: existing, reused: true, staleCommit: false };
  }

  // Stale-commit gate. Reject when either side is missing OR when they
  // differ. Empty-vs-empty must NOT bypass the gate — an empty scan commit
  // anchor means we have no way to verify provenance.
  const currentSha = await ports.currentRepoCommitSha(finding.projectId, finding.repoConnectionId);
  const scanSha = finding.commitSha;
  const missingScanSha = !scanSha || scanSha.trim().length === 0;
  const missingCurrentSha = !currentSha || currentSha.trim().length === 0;
  if (missingScanSha || missingCurrentSha || currentSha !== scanSha) {
    const reason = missingScanSha
      ? `scan has no captured commit SHA — refuse to anchor a published issue`
      : missingCurrentSha
        ? `repo connection has no current commit SHA — cannot verify scan provenance`
        : `repo HEAD ${currentSha} has moved past scan commit ${scanSha}`;
    await ports.audit("scanner.publish.stale", finding.scanFindingId, {
      provider,
      currentSha,
      scanCommitSha: scanSha,
    });
    throw new PublishError("ERR_STALE_COMMIT", reason);
  }

  const stampedBody = injectFindingMarker(finding.body, finding.fingerprint);
  const labels = defaultLabels(finding, input.extraLabels ?? []);

  const created =
    provider === "github"
      ? await ports.createGitHubIssue({
          projectId: finding.projectId,
          repoConnectionId: finding.repoConnectionId,
          title: finding.title,
          body: stampedBody,
          labels,
        })
      : await ports.createJiraIssue({
          projectId: finding.projectId,
          title: finding.title,
          body: stampedBody,
          labels,
          severity: finding.severity,
        });

  const link = await ports.saveLink({
    scanFindingId: finding.scanFindingId,
    provider,
    externalId: created.externalId,
    externalUrl: created.externalUrl,
    fingerprint: finding.fingerprint,
  });
  await ports.audit("scanner.publish.created", finding.scanFindingId, {
    provider,
    externalId: created.externalId,
    externalUrl: created.externalUrl,
  });
  return { link, reused: false, staleCommit: false };
}
