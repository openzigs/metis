/**
 * Epic #708 / Issue #715 / #804 — the generic finding publisher.
 *
 * Publishes one METIS result — a Deep Dive analysis finding or an Impact
 * Analysis run — as a GitHub issue or Jira ticket, and records the mapping in
 * IssueLink for idempotency. Each caller supplies the ports that key that
 * record on its own column; the engine itself knows nothing about the source.
 *
 * Idempotency contract:
 *   - One IssueLink per (sourceId, provider). Re-publish returns the existing
 *     link untouched, with no external call.
 *   - The marker `<!-- metis-finding: fingerprint=<hex> -->` is injected
 *     into the published body so the link can be reconstructed if the
 *     IssueLink row is lost.
 */
import {
  FINDING_MARKER_PREFIX,
  RETIRED_SOURCE_LABELS,
  SOURCE_LABELS,
  UMBRELLA_LABEL,
  type Publisher,
  type Severity,
  type SourceLabel,
} from "./finding-publish-types.js";

const MARKER_PREFIX = `<!-- ${FINDING_MARKER_PREFIX}:`;

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
  /**
   * The idempotency key: the analysis finding id or the impact-analysis run id.
   * The caller's ports persist it in the matching IssueLink column.
   */
  sourceId: string;
  projectId: string;
  repoConnectionId: string;
  title: string;
  body: string;
  severity: Severity;
  category: string;
  /**
   * #733 — the GitHub repository to file into: the caller's explicit choice or
   * the project's saved publish target. Absent = a GitHub publish is REFUSED
   * (`ERR_NO_PUBLISH_TARGET`); it never falls back to the repo connector's own
   * repository, which for an analysed project is its upstream.
   */
  target?: GitHubIssueTarget;
}

/** #733 — an explicit `owner/repo` a GitHub issue is created in. */
export interface GitHubIssueTarget {
  owner: string;
  repo: string;
}

export interface ExistingIssueLink {
  id: string;
  sourceId: string;
  provider: Publisher;
  externalId: string;
  externalUrl: string;
}

export interface CreatedIssue {
  externalId: string;
  externalUrl: string;
}

export interface PublisherPorts {
  /** Lookup existing link for (sourceId, provider). */
  findExistingLink(sourceId: string, provider: Publisher): Promise<ExistingIssueLink | null>;
  /** Provider-specific issue creation. */
  createGitHubIssue(args: {
    projectId: string;
    repoConnectionId: string;
    title: string;
    body: string;
    labels: string[];
    /**
     * #733 — the repository to file into; the token is still the connector's.
     * Absent = refused with `ERR_NO_PUBLISH_TARGET`, never the connector's repo.
     */
    target?: GitHubIssueTarget;
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
    sourceId: string;
    provider: Publisher;
    externalId: string;
    externalUrl: string;
    fingerprint: string;
  }): Promise<ExistingIssueLink>;
  /**
   * Best-effort audit. `action` is source-neutral — `publish.<provider>.created`
   * or `publish.<provider>.reused` (epic #799 decision 2); the port records
   * which source it was.
   */
  audit(action: string, sourceId: string, meta?: Record<string, unknown>): Promise<void>;
}

export interface PublishInput {
  finding: FindingPayload;
  provider: Publisher;
  /**
   * #802 — the label naming where the finding came from (`metis-analysis`,
   * `metis-impact-analysis`). Required so a new caller
   * cannot silently inherit a wrong default. The umbrella `metis` label is
   * always added alongside it.
   */
  sourceLabel: SourceLabel;
  /**
   * Caller-supplied additional labels. Reserved source labels and the
   * umbrella label are dropped from these: only `sourceLabel` names the source.
   */
  extraLabels?: readonly string[];
}

export interface PublishOutcome {
  link: ExistingIssueLink;
  /** True when the existing link was returned without a new external issue. */
  reused: boolean;
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

/**
 * #802 — labels an extra may not carry: every source label (the caller's own
 * is already present), the retired scanner label, and the umbrella label. Compared case-insensitively,
 * because GitHub treats labels that differ only in case as the same label.
 */
const RESERVED_LABELS: ReadonlySet<string> = new Set([
  UMBRELLA_LABEL,
  ...SOURCE_LABELS,
  ...RETIRED_SOURCE_LABELS,
]);

function defaultLabels(
  finding: FindingPayload,
  sourceLabel: SourceLabel,
  extras: readonly string[],
): string[] {
  const labels = new Set<string>([
    UMBRELLA_LABEL,
    sourceLabel,
    `severity:${finding.severity}`,
    `category:${finding.category.toLowerCase().replace(/\s+/g, "-")}`,
  ]);
  for (const l of extras) {
    const t = l.trim();
    if (RESERVED_LABELS.has(t.toLowerCase())) continue;
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
  const existing = await ports.findExistingLink(finding.sourceId, provider);
  if (existing) {
    await ports.audit(`publish.${provider}.reused`, finding.sourceId, {
      provider,
      externalUrl: existing.externalUrl,
    });
    return { link: existing, reused: true };
  }

  const stampedBody = injectFindingMarker(finding.body, finding.fingerprint);
  const labels = defaultLabels(finding, input.sourceLabel, input.extraLabels ?? []);

  const created =
    provider === "github"
      ? await ports.createGitHubIssue({
          projectId: finding.projectId,
          repoConnectionId: finding.repoConnectionId,
          title: finding.title,
          body: stampedBody,
          labels,
          ...(finding.target && { target: finding.target }),
        })
      : await ports.createJiraIssue({
          projectId: finding.projectId,
          title: finding.title,
          body: stampedBody,
          labels,
          severity: finding.severity,
        });

  const link = await ports.saveLink({
    sourceId: finding.sourceId,
    provider,
    externalId: created.externalId,
    externalUrl: created.externalUrl,
    fingerprint: finding.fingerprint,
  });
  await ports.audit(`publish.${provider}.created`, finding.sourceId, {
    provider,
    externalId: created.externalId,
    externalUrl: created.externalUrl,
  });
  return { link, reused: false };
}
