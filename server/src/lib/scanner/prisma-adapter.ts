/**
 * Epic #708 — Prisma + production-port bindings for the scanner.
 *
 * This module is the only place where the pure scanner pipeline meets:
 *   - Prisma (Scan, Rule, RuleSet, ScanFinding, IssueLink, CodeSymbol, CodeGraph)
 *   - The repo clone cache (`pullOrCloneRepo`)
 *   - The LLM provider (`buildProvider` / `loadAIConfig`)
 *   - GitHub publishing (`acquirePublishOctokit`)
 *
 * The pure modules in `./orchestrator`, `./per-symbol-scanner`,
 * `./fp-filter`, `./context-assembler`, and `./finding-publisher` are
 * unit-tested in isolation. This adapter is intentionally thin so the
 * integration surface area stays auditable.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { Prisma, prisma } from "../prisma.js";
import { audit } from "../audit/audit-service.js";
import { buildProvider, loadAIConfig } from "../ai/index.js";
import { HAIKU_MODEL_ID, SONNET_MODEL_ID } from "../ai/model-router.js";
import type { AIProvider } from "../ai/types.js";
import { pullOrCloneRepo } from "../connectors/repo/repo-service.js";
import { resolveVaultRef } from "../connectors/vault-resolver.js";
import { getVaultService } from "../vault/vault-service.js";
import { assertConnectorHostAllowed } from "../connectors/network-allowlist.js";
import { createJiraClient } from "../connectors/jira/jira-client.js";
import { getKnowledgeService } from "../rag/knowledge-service.js";
import { acquirePublishOctokit } from "../publishing/octokit-factory.js";
import { getPersona } from "../analysis/personas.js";
import type { AnalysisAgentKey, CodeCitation, FindingIssueDraft } from "@metis/shared";

import { assembleContext } from "./context-assembler.js";
import type { AssembledNeighbour, AssembledRagHit, AssembledSymbol } from "./context-assembler.js";
import { filterCandidate } from "./fp-filter.js";
import { buildFindingMarker, injectFindingMarker, publishFinding } from "./finding-publisher.js";
import { PublishError } from "./finding-publisher.js";
import type {
  CreatedIssue,
  ExistingIssueLink,
  FindingPayload,
  PublisherPorts,
} from "./finding-publisher.js";
import { runScan as runScanPure, type ScannerPorts } from "./orchestrator.js";
import { scanSymbol } from "./per-symbol-scanner.js";
import type { Publisher, Severity, TriageStatus } from "./types.js";
import type { MaterialisedFindingInput } from "./triage-service.js";

// ---------------------------------------------------------------------------
// AI provider — lazy singleton so the heavy SDK is only loaded when a scan
// actually runs.
// ---------------------------------------------------------------------------

let cachedProvider: AIProvider | null = null;
function getProvider(): AIProvider {
  if (cachedProvider) return cachedProvider;
  cachedProvider = buildProvider({ config: loadAIConfig() });
  return cachedProvider;
}

// ---------------------------------------------------------------------------
// Neighbour + RAG loaders (Epic #708 follow-up — wire production
// 1-hop callee/caller resolution and per-project RAG retrieval into the
// scanner pipeline). The orchestrator stays unit-testable because these
// helpers are isolated and individually mockable.
// ---------------------------------------------------------------------------

/** Maximum 1-hop neighbours per direction (callers + callees) per symbol. */
const SCANNER_NEIGHBOURS_PER_DIRECTION = 6;
/** Token-ish budget for an individual neighbour snippet (chars/4 estimate). */
const SCANNER_NEIGHBOUR_SNIPPET_CAP_CHARS = 1200;
/** Max number of RAG hits stitched into a per-symbol prompt. */
const SCANNER_RAG_HITS = 4;
/** Max chars per RAG hit text — keep prompt cap predictable. */
const SCANNER_RAG_SNIPPET_CAP_CHARS = 900;

async function readSymbolSlice(
  repoPath: string,
  filePath: string | null,
  startLine: number | null,
  endLine: number | null,
): Promise<string> {
  if (!filePath) return "";
  const abs = path.resolve(repoPath, filePath);
  if (!abs.startsWith(path.resolve(repoPath) + path.sep)) return "";
  let body: string;
  try {
    body = await fs.readFile(abs, "utf8");
  } catch {
    return "";
  }
  const lines = body.split(/\r?\n/);
  const start = Math.max(1, startLine ?? 1);
  const end = Math.min(lines.length, Math.max(start, endLine ?? start));
  return lines
    .slice(start - 1, end)
    .join("\n")
    .slice(0, SCANNER_NEIGHBOUR_SNIPPET_CAP_CHARS);
}

interface NeighbourLoaderScan {
  id: string;
  projectId: string;
  repoConnectionId: string;
  createdById: string | null;
}

interface NeighbourSymbolRow {
  id: string;
  qualifiedName: string;
  filePath: string | null;
  startLine: number | null;
  endLine: number | null;
  language: string | null;
  kind: string;
}

/**
 * Resolve 1-hop neighbours (callers + callees) for `symbolId`, strictly
 * scoped to the scan's (projectId, repoConnectionId). Cross-project edges
 * cannot leak: the `projectId` filter is mandatory at the SQL layer.
 */
export async function loadNeighboursForScan(
  scan: NeighbourLoaderScan,
  symbolId: string,
): Promise<AssembledNeighbour[]> {
  const [outgoing, incoming] = await Promise.all([
    prisma.codeEdge.findMany({
      where: {
        fromSymbolId: symbolId,
        projectId: scan.projectId,
        graph: { repoConnectionId: scan.repoConnectionId },
        NOT: { toSymbolId: null },
      },
      take: SCANNER_NEIGHBOURS_PER_DIRECTION,
      include: { toSymbol: true },
    }),
    prisma.codeEdge.findMany({
      where: {
        toSymbolId: symbolId,
        projectId: scan.projectId,
        graph: { repoConnectionId: scan.repoConnectionId },
      },
      take: SCANNER_NEIGHBOURS_PER_DIRECTION,
      include: { fromSymbol: true },
    }),
  ]);

  if (outgoing.length === 0 && incoming.length === 0) return [];

  const actorId = scan.createdById ?? "system";
  const { path: repoPath } = await pullOrCloneRepo(scan.projectId, scan.repoConnectionId, actorId);

  const neighbours: AssembledNeighbour[] = [];
  for (const edge of outgoing) {
    const target = edge.toSymbol as NeighbourSymbolRow | null;
    if (!target) continue;
    const snippet = await readSymbolSlice(
      repoPath,
      target.filePath,
      target.startLine,
      target.endLine,
    );
    neighbours.push({
      qualifiedName: target.qualifiedName,
      filePath: target.filePath ?? "",
      relation: "callee",
      snippet,
    });
  }
  for (const edge of incoming) {
    const source = edge.fromSymbol as NeighbourSymbolRow | null;
    if (!source) continue;
    const snippet = await readSymbolSlice(
      repoPath,
      source.filePath,
      source.startLine,
      source.endLine,
    );
    neighbours.push({
      qualifiedName: source.qualifiedName,
      filePath: source.filePath ?? "",
      relation: "caller",
      snippet,
    });
  }
  return neighbours;
}

/**
 * Retrieve project-scoped RAG hits for a symbol. Per-project isolation is
 * enforced by `KnowledgeService.search`, which filters every vector
 * lookup by `projectId` before returning chunks.
 */
export async function loadRagHitsForScan(
  scan: NeighbourLoaderScan,
  symbol: { qualifiedName: string; body: string },
  options?: { specOnly?: boolean },
): Promise<AssembledRagHit[]> {
  const query = `${symbol.qualifiedName}\n${symbol.body.slice(0, 400)}`.trim();
  if (!query) return [];
  let knowledge: ReturnType<typeof getKnowledgeService>;
  try {
    knowledge = getKnowledgeService();
  } catch {
    return [];
  }

  // Epic #724 — when specOnly is true, restrict retrieval to spec-tagged documents.
  let documentIds: string[] | undefined;
  if (options?.specOnly) {
    const specDocs = await prisma.document.findMany({
      where: { projectId: scan.projectId, isSpec: true, deletedAt: null, indexState: "indexed" },
      select: { id: true },
    });
    if (specDocs.length === 0) return [];
    documentIds = specDocs.map((d) => d.id);
  }

  let hits;
  try {
    hits = await knowledge.search(scan.projectId, query, {
      k: SCANNER_RAG_HITS,
      ...(documentIds ? { documentIds } : {}),
    });
  } catch {
    return [];
  }
  return hits.hits.map((h) => ({
    source: `${h.filename}#${h.position}`,
    snippet: (h.text ?? "").slice(0, SCANNER_RAG_SNIPPET_CAP_CHARS),
  }));
}

// ---------------------------------------------------------------------------
// Scanner ports — Prisma + filesystem implementation.
// ---------------------------------------------------------------------------

/** Build production ScannerPorts. The orchestrator stays unit-testable. */
export function buildScannerPorts(): ScannerPorts {
  return {
    async loadScan(scanId) {
      const row = await prisma.scan.findUnique({ where: { id: scanId } });
      if (!row) return null;
      return {
        id: row.id,
        projectId: row.projectId,
        repoConnectionId: row.repoConnectionId,
        commitSha: row.commitSha,
        mode: row.mode as "rules" | "heuristic" | "both" | "spec",
        budgetCapTokens: row.budgetCapTokens,
        createdById: row.createdById,
      };
    },

    async graphCommitSha(projectId, repoConnectionId) {
      const graph = await prisma.codeGraph.findFirst({
        where: { projectId, repoConnectionId },
        orderBy: { updatedAt: "desc" },
        select: { commitSha: true },
      });
      return graph?.commitSha ?? null;
    },

    async listSymbols(scan) {
      // Pick the most-recent CodeGraph for the (project, repo).
      const graph = await prisma.codeGraph.findFirst({
        where: { projectId: scan.projectId, repoConnectionId: scan.repoConnectionId },
        orderBy: { updatedAt: "desc" },
        select: { id: true },
      });
      if (!graph) return [];
      const rows = await prisma.codeSymbol.findMany({
        where: { codeGraphId: graph.id, projectId: scan.projectId },
        select: {
          id: true,
          qualifiedName: true,
          kind: true,
          language: true,
          filePath: true,
          startLine: true,
          endLine: true,
        },
        // Cap so a 100k-symbol repo cannot wedge a scan worker; budget gate
        // will stop sooner anyway.
        take: 10000,
        orderBy: { qualifiedName: "asc" },
      });
      return rows.map(
        (r: {
          id: string;
          qualifiedName: string;
          kind: string;
          language: string | null;
          filePath: string | null;
          startLine: number | null;
          endLine: number | null;
        }) => ({
          id: r.id,
          qualifiedName: r.qualifiedName,
          kind: r.kind,
          language: r.language ?? "unknown",
          filePath: r.filePath ?? "",
          startLine: r.startLine ?? 1,
          endLine: r.endLine ?? r.startLine ?? 1,
        }),
      );
    },

    async readSymbolBody(scan, symbol) {
      // Repo is cloned/pulled lazily; subsequent reads in the same scan reuse
      // the on-disk checkout.
      const actorId = scan.createdById ?? "system";
      const { path: repoPath } = await pullOrCloneRepo(
        scan.projectId,
        scan.repoConnectionId,
        actorId,
      );
      if (!symbol.filePath) return "";
      const abs = path.resolve(repoPath, symbol.filePath);
      // Containment check — repo source paths must not escape the clone.
      if (!abs.startsWith(path.resolve(repoPath) + path.sep)) return "";
      let body: string;
      try {
        body = await fs.readFile(abs, "utf8");
      } catch {
        return "";
      }
      const lines = body.split(/\r?\n/);
      const start = Math.max(1, symbol.startLine);
      const end = Math.min(lines.length, Math.max(start, symbol.endLine));
      return lines.slice(start - 1, end).join("\n");
    },

    async ruleInstructions(scan) {
      if (scan.mode === "heuristic" || scan.mode === "spec") return "";
      const ruleSets = await prisma.ruleSet.findMany({
        where: { projectId: scan.projectId, isActive: true },
        include: {
          rules: {
            where: { status: "active" },
            select: {
              id: true,
              naturalLanguage: true,
              severity: true,
              category: true,
            },
          },
        },
      });
      const blocks: string[] = [];
      for (const rs of ruleSets) {
        for (const r of rs.rules) {
          blocks.push(
            `- (${r.id}) [${r.severity}/${r.category}] ${r.naturalLanguage.slice(0, 600)}`,
          );
        }
      }
      return blocks.join("\n");
    },

    async runFirstPass({ scan, symbol, body, ruleInstructions, signal }) {
      const provider = getProvider();
      const assembled: AssembledSymbol = {
        symbolId: symbol.id,
        qualifiedName: symbol.qualifiedName,
        filePath: symbol.filePath,
        language: symbol.language,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
        body,
      };
      // Production wiring: 1-hop callee/caller neighbours and project-scoped
      // RAG retrieval. Failures are non-fatal — the scanner still runs with
      // whatever context it could assemble.
      const loaderScan: NeighbourLoaderScan = {
        id: scan.id,
        projectId: scan.projectId,
        repoConnectionId: scan.repoConnectionId,
        createdById: scan.createdById,
      };
      const [neighbours, ragHits] = await Promise.all([
        loadNeighboursForScan(loaderScan, symbol.id).catch(() => [] as AssembledNeighbour[]),
        loadRagHitsForScan(
          loaderScan,
          {
            qualifiedName: symbol.qualifiedName,
            body,
          },
          { specOnly: scan.mode === "spec" },
        ).catch(() => [] as AssembledRagHit[]),
      ]);
      const ctx = assembleContext({
        symbol: assembled,
        neighbours,
        ragHits,
        ruleInstructions,
        specMode: scan.mode === "spec",
      });
      const result = await scanSymbol(provider, {
        symbol: assembled,
        context: ctx,
        modelOverride: HAIKU_MODEL_ID,
        signal,
      });
      return { candidates: result.candidates, totalTokens: result.totalTokens };
    },

    async runFpFilter({ candidate, body, signal }) {
      const provider = getProvider();
      const result = await filterCandidate(provider, {
        candidate,
        symbolBody: body,
        modelOverride: SONNET_MODEL_ID,
        signal,
      });
      return {
        keep: result.keep,
        finalConfidence: result.finalConfidence,
        rationales: result.verdicts.map((v) => v.rationale).filter((r): r is string => !!r),
        totalTokens: result.totalTokens,
      };
    },

    async upsertFinding(scanId, finding) {
      const c = finding.candidate;
      await prisma.scanFinding.upsert({
        where: {
          scanId_fingerprint: { scanId, fingerprint: finding.fingerprint },
        },
        update: {
          confidence: finding.finalConfidence,
          severity: c.severity,
          category: c.category,
          title: c.title.slice(0, 200),
          body: c.body,
          evidenceLines: JSON.stringify(c.evidenceLines),
          triageStatus: finding.triageStatus,
        },
        create: {
          scanId,
          ruleId: c.ruleId,
          symbolId: c.symbolId,
          fingerprint: finding.fingerprint,
          title: c.title.slice(0, 200),
          body: c.body,
          severity: c.severity,
          category: c.category,
          evidenceLines: JSON.stringify(c.evidenceLines),
          confidence: finding.finalConfidence,
          triageStatus: finding.triageStatus,
        },
      });
    },

    async markRunning(scanId, commitSha) {
      await prisma.scan.update({
        where: { id: scanId },
        data: { status: "running", commitSha, startedAt: new Date() },
      });
    },

    async markFailed(scanId, reason) {
      await prisma.scan.update({
        where: { id: scanId },
        data: { status: "failed", errorMessage: reason.slice(0, 1000), completedAt: new Date() },
      });
    },

    async markCompleted(scanId, summary) {
      await prisma.scan.update({
        where: { id: scanId },
        data: {
          status: summary.bailedOnBudget ? "budget_exceeded" : "completed",
          totalSymbols: summary.totalSymbols,
          totalTokens: summary.tokenSpend,
          scannedSymbols: summary.symbolsScanned,
          completedAt: new Date(),
        },
      });
    },

    async audit(event, scanId, meta) {
      const scan = await prisma.scan.findUnique({ where: { id: scanId } });
      audit({
        actor: { id: scan?.createdById ?? "system" },
        action: `scanner.${event}`,
        target: { type: "scan", id: scanId },
        metadata: { ...meta },
      });
    },
  };
}

/** Convenience wrapper used by the scheduler. */
export async function runScanWithPrismaPorts(scanId: string, signal: AbortSignal): Promise<void> {
  const ports = buildScannerPorts();
  await runScanPure(ports, { scanId, signal });
}

// ---------------------------------------------------------------------------
// Publisher ports — Prisma + GitHub.
// ---------------------------------------------------------------------------

interface GhIssueResponse {
  number: number;
  html_url: string;
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

/** Build production PublisherPorts. */
export function buildPublisherPorts(): PublisherPorts {
  const base = publisherStateForUpsert();
  return {
    async currentRepoCommitSha(projectId, repoConnectionId) {
      const conn = await prisma.repoConnection.findFirst({
        where: { id: repoConnectionId, projectId, deletedAt: null },
        select: { lastCommitSha: true },
      });
      // Return null (not empty string) when missing — the stale-commit gate
      // treats "missing" as a hard reject, not as "matches an empty scan
      // SHA". Conflating the two would let an unanchored scan publish.
      return conn?.lastCommitSha ?? null;
    },

    async findExistingLink(scanFindingId, provider) {
      const row = await prisma.issueLink.findFirst({
        where: { scanFindingId, provider },
      });
      if (!row) return null;
      return {
        id: row.id,
        scanFindingId: row.scanFindingId ?? scanFindingId,
        provider: row.provider as Publisher,
        externalId: row.externalId,
        externalUrl: row.externalUrl,
      };
    },

    async createGitHubIssue({
      projectId,
      repoConnectionId,
      title,
      body,
      labels,
    }): Promise<CreatedIssue> {
      const conn = await prisma.repoConnection.findFirst({
        where: { id: repoConnectionId, projectId, deletedAt: null },
      });
      if (!conn) {
        throw new Error(`repo connection ${repoConnectionId} not found`);
      }
      if (!conn.ownerOrOrg || !conn.repoName) {
        // Issue #288 — local/upload connectors have no owner/repo and cannot
        // publish GitHub issues.
        throw new Error("repo connection is not a GitHub repo (missing owner/repo)");
      }
      const secretRef = conn.secretId ? `\${vault:${conn.secretId}}` : "";
      const token = await resolveVaultRef(secretRef, getVaultService());
      if (!token) {
        throw new Error("repo connection missing vault-resolved token");
      }
      const baseUrl = conn.apiBaseUrl ?? "https://api.github.com";
      const client = await acquirePublishOctokit({
        owner: conn.ownerOrOrg,
        baseUrl,
        token,
      });
      const res = await client.request<GhIssueResponse>({
        method: "POST",
        url: `/repos/${conn.ownerOrOrg}/${conn.repoName}/issues`,
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

    async saveLink({ scanFindingId, provider, externalId, externalUrl, fingerprint }) {
      const row = await prisma.issueLink.upsert({
        where: {
          scanFindingId_provider: { scanFindingId, provider },
        },
        update: { externalId, externalUrl, fingerprint },
        create: { scanFindingId, provider, externalId, externalUrl, fingerprint },
      });
      return {
        id: row.id,
        scanFindingId: row.scanFindingId ?? scanFindingId,
        provider: row.provider as Publisher,
        externalId: row.externalId,
        externalUrl: row.externalUrl,
      };
    },

    audit: base.audit,
  };
}

/** Convenience wrapper — looks up the finding + scan, builds payload, publishes. */
export interface PublishScanFindingInput {
  scanFindingId: string;
  provider: Publisher;
  extraLabels?: readonly string[];
}

export async function publishScanFinding(
  input: PublishScanFindingInput,
): Promise<ExistingIssueLink> {
  const sf = await prisma.scanFinding.findUnique({
    where: { id: input.scanFindingId },
    include: {
      scan: true,
      symbol: { select: { qualifiedName: true, filePath: true } },
    },
  });
  if (!sf) throw new Error(`scan finding ${input.scanFindingId} not found`);

  let evidenceLines: number[] = [];
  try {
    const parsed = JSON.parse(sf.evidenceLines ?? "[]");
    if (Array.isArray(parsed)) {
      evidenceLines = parsed.filter((n): n is number => typeof n === "number");
    }
  } catch {
    evidenceLines = [];
  }

  const payload: FindingPayload = {
    fingerprint: sf.fingerprint,
    scanFindingId: sf.id,
    scanId: sf.scanId,
    projectId: sf.scan.projectId,
    repoConnectionId: sf.scan.repoConnectionId,
    title: sf.title,
    body: injectFindingMarker(sf.body ?? "", buildFindingMarker(sf.fingerprint)),
    severity: sf.severity as FindingPayload["severity"],
    category: sf.category,
    filePath: sf.symbol?.filePath ?? "",
    evidenceLines,
    qualifiedName: sf.symbol?.qualifiedName ?? "",
    ruleId: sf.ruleId,
    commitSha: sf.scan.commitSha,
  };

  const ports = buildPublisherPorts();
  const outcome = await publishFinding(ports, {
    finding: payload,
    provider: input.provider,
    extraLabels: input.extraLabels,
  });
  return outcome.link;
}

// ---------------------------------------------------------------------------
// Epic #176 / #179 — analysis-finding publishing.
//
// Analysis findings reuse the SAME generic `publishFinding` engine (marker
// dedup + idempotent IssueLink). The only differences from the scanner flow
// are the persistence key (`IssueLink.findingId` instead of `scanFindingId`)
// and the stale-commit gate, which is N/A for analysis findings (they are not
// anchored to a scanned repo commit). We satisfy the gate with a constant
// anchor on both sides rather than forking the publisher.
// ---------------------------------------------------------------------------

/** Sentinel commit anchor — analysis findings have no scanned commit SHA. */
const ANALYSIS_PUBLISH_ANCHOR = "analysis-finding-anchor";

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
  draft: FindingIssueDraft;
}): string {
  const { analysisId, agentKey, draft } = args;
  const persona = getPersona(agentKey);
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
    `From METIS analysis \`${analysisId}\` · reported by **${persona.name}** (${persona.role}).`,
  );
  return lines.join("\n");
}

/**
 * Publisher ports for analysis findings. Reuses the scanner ports for issue
 * creation + audit, but keys idempotency on `IssueLink.findingId` and short-
 * circuits the stale-commit gate (analysis findings carry no scan commit).
 */
function buildAnalysisPublisherPorts(): PublisherPorts {
  const base = buildPublisherPorts();
  return {
    ...base,
    // Stale-commit gate is N/A for analysis findings — return the same
    // sentinel the payload carries so the gate is a no-op.
    async currentRepoCommitSha() {
      return ANALYSIS_PUBLISH_ANCHOR;
    },
    // The generic engine threads the analysis finding id through the
    // `scanFindingId` slot; here it is the `IssueLink.findingId`.
    async findExistingLink(findingId, provider) {
      const row = await prisma.issueLink.findFirst({ where: { findingId, provider } });
      if (!row) return null;
      return {
        id: row.id,
        scanFindingId: row.findingId ?? findingId,
        provider: row.provider as Publisher,
        externalId: row.externalId,
        externalUrl: row.externalUrl,
      };
    },
    async saveLink({ scanFindingId, provider, externalId, externalUrl, fingerprint }) {
      const row = await prisma.issueLink.upsert({
        where: { findingId_provider: { findingId: scanFindingId, provider } },
        update: { externalId, externalUrl, fingerprint },
        create: { findingId: scanFindingId, provider, externalId, externalUrl, fingerprint },
      });
      return {
        id: row.id,
        scanFindingId: row.findingId ?? scanFindingId,
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
  severity: Severity;
  category: string;
  draft: FindingIssueDraft;
  provider: Publisher;
  extraLabels?: readonly string[];
}

/**
 * Publish a single analysis finding (with an operator-edited draft) to GitHub
 * or Jira via the shared finding-publisher. Idempotent per (findingId,
 * provider). For GitHub, resolves the project's primary/active repo
 * connection; Jira requires no repo connection.
 */
export async function publishAnalysisFinding(
  input: PublishAnalysisFindingInput,
): Promise<ExistingIssueLink> {
  let repoConnectionId = "";
  if (input.provider === "github") {
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
    draft: input.draft,
  });

  const payload: FindingPayload = {
    fingerprint: analysisFindingFingerprint(input.findingId),
    // The generic engine uses this slot as the idempotency id; our analysis
    // ports persist it as IssueLink.findingId.
    scanFindingId: input.findingId,
    scanId: input.analysisId,
    projectId: input.projectId,
    repoConnectionId,
    title: input.draft.title,
    body,
    severity: input.severity,
    category: input.category,
    filePath: "",
    evidenceLines: [],
    qualifiedName: "",
    ruleId: null,
    commitSha: ANALYSIS_PUBLISH_ANCHOR,
  };

  const extraLabels = [...input.draft.suggestedLabels, ...(input.extraLabels ?? [])];
  const ports = buildAnalysisPublisherPorts();
  const outcome = await publishFinding(ports, {
    finding: payload,
    provider: input.provider,
    extraLabels,
  });
  return outcome.link;
}

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
 * Publisher ports for an impact-analysis run. Reuses the scanner ports for issue
 * creation + audit, but keys idempotency on `IssueLink.impactAnalysisId` and
 * short-circuits the stale-commit gate (an impact run carries no scan commit).
 * The generic engine threads the analysis id through the `scanFindingId` slot.
 */
function buildImpactAnalysisPublisherPorts(): PublisherPorts {
  const base = buildPublisherPorts();
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
    extraLabels: ["metis-impact-analysis", ...(input.extraLabels ?? [])],
  });
  return outcome.link;
}

/**
 * Materialise a triaged ScanFinding into a `Finding` row (Epic #708/#714,
 * fixed by #1330 / ADR 0011).
 *
 * ## Why the payload is an ARGUMENT and not rebuilt here
 *
 * `applyTriageDecision` (`./triage-service.ts`) already produces a well-formed
 * {@link MaterialisedFindingInput} and the route already computes it. Between
 * #714 and #1330 this function threw that away and rebuilt a DIFFERENT payload
 * from the raw row — one that named five columns `Finding` does not have
 * (`projectId`, `description`, `source`, `metadata`, `createdById`) while
 * omitting the required `body`. It therefore threw `Argument 'body' is missing`
 * on EVERY approved triage, inside the transaction and AFTER the triage stamp,
 * so the rollback destroyed the reviewer's decision as well. Taking the
 * service's own output as an argument removes the second definition entirely.
 *
 * ## Provenance
 *
 * `agentResultId` is NULL: the AI bug scanner is not an analysis agent and
 * creates no `AgentResult`. The row's provenance is `scanFindingId`, the
 * `@unique` back-link Epic #708 added for exactly this and never wrote until
 * now. See `docs/decisions/0011-scan-finding-materialisation-provenance.md`.
 */
export async function materializeTriagedFinding(args: {
  scanFindingId: string;
  triagedById: string;
  triageStatus: TriageStatus;
  triageNote?: string;
  /**
   * The row to insert, straight from `applyTriageDecision`. MUST be present
   * when `triageStatus === "approved"` and is ignored otherwise.
   *
   * Required rather than optional-with-a-fallback on purpose: #1330's third
   * defeated guard was `if (!findingDelegate) return { findingId: undefined }`,
   * which reported SUCCESS when it could not write, so the route answered
   * `200 {materializedFindingId: null}` and a total failure was
   * indistinguishable from a rejected triage. Absence now throws.
   */
  materialised: MaterialisedFindingInput | null;
}): Promise<{ findingId?: string }> {
  const { scanFindingId, triagedById, triageStatus, triageNote, materialised } = args;
  if (triageStatus === "approved" && !materialised) {
    throw new Error(
      `cannot materialise scan finding ${scanFindingId}: approved triage requires a MaterialisedFindingInput`,
    );
  }

  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const sf = await tx.scanFinding.findUnique({
      where: { id: scanFindingId },
      select: { id: true, materializedFindingId: true },
    });
    if (!sf) throw new Error(`scan finding ${scanFindingId} not found`);

    await tx.scanFinding.update({
      where: { id: scanFindingId },
      data: {
        triageStatus,
        triageNote: triageNote ?? null,
        triagedAt: new Date(),
        triagedById,
      },
    });

    // The materialisation is gated to "approved" triage.
    if (triageStatus !== "approved" || !materialised) return { findingId: undefined };
    if (sf.materializedFindingId) return { findingId: sf.materializedFindingId };

    const created = await tx.finding.create({
      // `satisfies` is the type guard, and its placement is deliberate — it has
      // to be HERE, on the inline literal, to satisfy two checks at once.
      //
      //  - It restores the compile-time check the #1330 cast destroyed.
      //    `tx.finding.create` is generic (`create<T extends FindingCreateArgs>(
      //    args: SelectSubset<T, FindingCreateArgs>)`), so `data` is
      //    contextually typed by `T["data"]` — inferred from the literal itself
      //    — and gets NO excess-property check. Measured on this exact call:
      //    with the cast removed but no `satisfies`, both `projectId: …` and a
      //    nonsense `title2: …` still compiled clean. Removing the cast alone
      //    would not have restored anything. `satisfies` re-freshens the literal
      //    against a concrete type: an unknown column is TS2353 ("Object literal
      //    may only specify known properties") and a missing required one is
      //    TS1360 — both measured here by mutation.
      //  - It keeps the payload an inline OBJECT LITERAL, which the #1325
      //    ratchet needs to classify this site (it unwraps `satisfies`). Hoisting
      //    it to an annotated `const` type-checks identically but makes the site
      //    `unclassified` — permanently red and not registrable.
      data: {
        // #1330 (ADR 0011) — no AgentResult exists for a scanner finding.
        // Provenance is `scanFindingId` below. Explicit rather than omitted so
        // the intent is legible at the call site.
        agentResultId: null,
        scanFindingId: materialised.scanFindingId,
        title: materialised.title.slice(0, 255),
        body: materialised.body,
        severity: materialised.severity,
        category: materialised.category,
        // A string LITERAL, not `materialised.derivation`: the #1325 ratchet
        // (`server/tests/finding-provenance-ratchet.test.ts`) classifies a
        // write by the literal it can read statically, and an expression
        // downgrades this site to `guarded`. `satisfies` pins it to the
        // service's own contract, so the two cannot drift apart silently.
        derivation: "inferred" satisfies MaterialisedFindingInput["derivation"],
        confidence: materialised.confidence,
        evidence: JSON.stringify({
          citations: buildScanFindingCitations(materialised),
          tags: [],
          requirementId: null,
          verdict: null,
        }),
        symbolId: materialised.symbolId || null,
      } satisfies Prisma.FindingUncheckedCreateInput,
      select: { id: true },
    });

    await tx.scanFinding.update({
      where: { id: scanFindingId },
      data: { materializedFindingId: created.id },
    });
    return { findingId: created.id };
  });

  return result;
}

/**
 * The `citations` array for a materialised scan finding's `evidence` blob.
 *
 * Emits at most ONE code citation, in the same shape the analysis pipeline
 * writes (`packages/shared` `codeCitationSchema`), so the existing readers —
 * `parseEvidence` / `toResolvedEvidenceRef` in `analysis/analysis-service.ts`
 * — render it without a special case. Returns `[]` rather than a half-formed
 * citation when the scan finding has no file path or no evidence lines: the
 * schema requires `filePath`, `startLine` and `endLine` together, and inventing
 * a line number would assert a location nobody measured.
 */
function buildScanFindingCitations(materialised: MaterialisedFindingInput): CodeCitation[] {
  const lines = materialised.evidenceLines.filter((n) => Number.isInteger(n) && n >= 1);
  if (!materialised.filePath || lines.length === 0) return [];
  return [
    {
      filePath: materialised.filePath.slice(0, 1024),
      startLine: Math.min(...lines),
      endLine: Math.max(...lines),
      ...(materialised.symbolId ? { symbolId: materialised.symbolId.slice(0, 256) } : {}),
    },
  ];
}
