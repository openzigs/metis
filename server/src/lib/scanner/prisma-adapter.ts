/**
 * Epic #708 — Prisma + production-port bindings for the scanner.
 *
 * This module is the only place where the pure scanner pipeline meets:
 *   - Prisma (Scan, Rule, RuleSet, ScanFinding, IssueLink, CodeSymbol, CodeGraph)
 *   - The repo clone cache (`pullOrCloneRepo`)
 *   - The LLM provider (`buildProvider` / `loadAIConfig`)
 *   - GitHub / Jira publishing (the shared ports in `../publishing/finding-publish-ports`)
 *
 * The pure modules in `./orchestrator`, `./per-symbol-scanner`,
 * `./fp-filter` and `./context-assembler` (plus the publishing engine in
 * `../publishing/finding-publisher`) are unit-tested in isolation. This adapter is intentionally thin so the
 * integration surface area stays auditable.
 */
import { promises as fs } from "node:fs";
import path from "node:path";

import { Prisma, prisma } from "../prisma.js";
import { findSavedGitHubTarget } from "../publishing/saved-target.js";
import { audit } from "../audit/audit-service.js";
import { buildProvider, loadAIConfig } from "../ai/index.js";
import { HAIKU_MODEL_ID, SONNET_MODEL_ID, tierModelFor } from "../ai/model-router.js";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import { recordUsage } from "../finops/token-tracker.js";
import { pullOrCloneRepo } from "../connectors/repo/repo-service.js";
import { getKnowledgeService } from "../rag/knowledge-service.js";
import {
  buildFindingMarker,
  injectFindingMarker,
  publishFinding,
} from "../publishing/finding-publisher.js";
import type {
  ExistingIssueLink,
  FindingPayload,
  GitHubIssueTarget,
  PublisherPorts,
} from "../publishing/finding-publisher.js";
import { buildSharedFindingPublisherPorts } from "../publishing/finding-publish-ports.js";
import type { CodeCitation } from "@metis/shared";

import { assembleContext } from "./context-assembler.js";
import type { AssembledNeighbour, AssembledRagHit, AssembledSymbol } from "./context-assembler.js";
import { filterCandidate } from "./fp-filter.js";
import { runScan as runScanPure, type ScannerPorts, type ScanRunResult } from "./orchestrator.js";
import { SCAN_SYMBOL_ANSWER_TOKENS, scanSymbol } from "./per-symbol-scanner.js";
import { FP_FILTER_ANSWER_TOKENS } from "./fp-filter.js";
import { scannerMaxOutputTokens } from "./output-budget.js";
import type { Publisher, TriageStatus } from "./types.js";
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

/**
 * #718 — meter one scanner LLM call into the project's usage ledger
 * (`usage-summary`, budgets). Called for every response, including one whose
 * reply then fails to parse: those tokens were spent all the same.
 */
function meterScanCall(scan: { id: string; projectId: string }) {
  return (response: ChatResponse): void => {
    const { persisted } = recordUsage({
      projectId: scan.projectId,
      sessionId: `scan-${scan.id}`,
      agentStep: "bug-scan",
      provider: response.provider,
      model: response.model,
      inputTokens: response.usage.promptTokens,
      outputTokens: response.usage.completionTokens,
      cacheReadTokens: response.usage.cacheReadTokens,
      cacheWriteTokens: response.usage.cacheWriteTokens,
    });
    trackScanUsageWrite(scan.id, persisted);
  };
}

/** #759 — in-flight `token_usages` writes per scan, so totals can wait for them. */
const pendingScanUsage = new Map<string, Set<Promise<void>>>();

function trackScanUsageWrite(scanId: string, persisted: Promise<void>): void {
  let writes = pendingScanUsage.get(scanId);
  if (!writes) {
    writes = new Set();
    pendingScanUsage.set(scanId, writes);
  }
  writes.add(persisted);
  void persisted.finally(() => {
    writes.delete(persisted);
    if (writes.size === 0 && pendingScanUsage.get(scanId) === writes) {
      pendingScanUsage.delete(scanId);
    }
  });
}

/**
 * #759 — the scan's spend as the usage ledger metered it, across every
 * attempt, so the scan row agrees with `usage-summary`. `null` when the ledger
 * holds nothing for the scan (the orchestrator's own count then stands).
 */
async function meteredScanSpend(
  scanId: string,
): Promise<{ totalTokens: number; costCents: number } | null> {
  const writes = pendingScanUsage.get(scanId);
  if (writes) await Promise.all([...writes]);
  const scan = await prisma.scan.findUnique({
    where: { id: scanId },
    select: { projectId: true },
  });
  if (!scan) return null;
  const agg = await prisma.tokenUsage.aggregate({
    where: { projectId: scan.projectId, sessionId: `scan-${scanId}` },
    _sum: { totalTokens: true, costCents: true },
    _count: { _all: true },
  });
  if (!agg._count._all) return null;
  return { totalTokens: agg._sum.totalTokens ?? 0, costCents: agg._sum.costCents ?? 0 };
}

/**
 * A scan that ended without completing: `failed`, or (#759) `cancelled` by a
 * user. Either way the progress made is kept.
 */
async function markEnded(
  scanId: string,
  status: "failed" | "cancelled",
  reason: string,
  summary?: ScanRunResult,
): Promise<void> {
  const metered = summary ? await meteredScanSpend(scanId) : null;
  await prisma.scan.update({
    where: { id: scanId },
    data: {
      status,
      errorMessage: reason.slice(0, 1000),
      completedAt: new Date(),
      // #718 — keep the progress made before the failure, so a failed
      // scan does not read "0/0 symbols · 0 tokens".
      ...(summary
        ? {
            totalSymbols: summary.totalSymbols,
            scannedSymbols: summary.symbolsScanned,
            totalTokens: summary.tokenSpend,
          }
        : {}),
      ...(metered ?? {}),
    },
  });
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
  // The scanner only reads snippets from the checkout. Recording the pulled
  // commit would move lastCommitSha past the graph's label and this scan's own
  // anchor, making its findings unpublishable (#757).
  const { path: repoPath } = await pullOrCloneRepo(scan.projectId, scan.repoConnectionId, actorId, {
    recordCommit: false,
  });

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
        // #759 — where an earlier attempt stopped. `tokenSpend` is the row's
        // totalTokens, which markFailed/markCompleted re-sync from the usage
        // ledger (canonical: includes cache reads). The live counter then adds
        // per-response totals, so the two can drift until the next mark call
        // re-syncs it from the ledger.
        resume: {
          symbolCursor: row.symbolCursor,
          symbolsScanned: row.scannedSymbols,
          tokenSpend: row.totalTokens,
        },
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
        // #759 — a total order: the resume cursor is an index into this list,
        // and qualifiedName alone can tie (overloads).
        orderBy: [{ qualifiedName: "asc" }, { id: "asc" }],
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
        { recordCommit: false }, // read-only use — see loadNeighboursForScan (#757)
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
      // #532 — a Claude tier id only on a provider that serves it.
      const model = tierModelFor(provider, HAIKU_MODEL_ID);
      const result = await scanSymbol(provider, {
        symbol: assembled,
        context: ctx,
        modelOverride: model,
        // #718 — room to reason on a thinking-by-default model.
        maxTokens: scannerMaxOutputTokens(SCAN_SYMBOL_ANSWER_TOKENS, model),
        onUsage: meterScanCall(scan),
        signal,
      });
      return { candidates: result.candidates, totalTokens: result.totalTokens };
    },

    async runFpFilter({ scan, candidate, body, signal }) {
      const provider = getProvider();
      const model = tierModelFor(provider, SONNET_MODEL_ID);
      const result = await filterCandidate(provider, {
        candidate,
        symbolBody: body,
        modelOverride: model,
        maxTokens: scannerMaxOutputTokens(FP_FILTER_ANSWER_TOKENS, model),
        onUsage: meterScanCall(scan),
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

    async recordProgress(scanId, progress) {
      await prisma.scan.update({
        where: { id: scanId },
        data: {
          symbolCursor: progress.symbolCursor,
          totalSymbols: progress.totalSymbols,
          scannedSymbols: progress.symbolsScanned,
          totalTokens: progress.tokenSpend,
        },
      });
    },

    async discardSymbolFindings(scanId, symbolId) {
      // Scoped to this scan; a finding already triaged is a user's decision
      // and is kept.
      await prisma.scanFinding.deleteMany({
        where: { scanId, symbolId, triageStatus: "pending" },
      });
    },

    async markRunning(scanId, commitSha) {
      await prisma.scan.update({
        where: { id: scanId },
        data: { status: "running", commitSha, startedAt: new Date() },
      });
    },

    async markFailed(scanId, reason, summary) {
      await markEnded(scanId, "failed", reason, summary);
    },

    async markCancelled(scanId, reason, summary) {
      await markEnded(scanId, "cancelled", reason, summary);
    },

    async markCompleted(scanId, summary) {
      const metered = await meteredScanSpend(scanId);
      await prisma.scan.update({
        where: { id: scanId },
        data: {
          status: summary.bailedOnBudget ? "budget_exceeded" : "completed",
          totalSymbols: summary.totalSymbols,
          totalTokens: summary.tokenSpend,
          scannedSymbols: summary.symbolsScanned,
          // #718 — a completed scan can still have skipped symbols; say so.
          errorMessage:
            summary.symbolsFailed > 0
              ? `${summary.symbolsFailed} of ${summary.totalSymbols} symbols skipped: the model reply was not parseable JSON. Last: ${summary.lastSymbolError ?? "unknown"}`.slice(
                  0,
                  1000,
                )
              : null,
          completedAt: new Date(),
          ...(metered ?? {}),
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
export async function runScanWithPrismaPorts(
  scanId: string,
  signal: AbortSignal,
  attempt?: { attempts: number; maxAttempts: number },
): Promise<void> {
  const ports = buildScannerPorts();
  await runScanPure(ports, { scanId, signal, attempt });
}

// ---------------------------------------------------------------------------
// Publisher ports — Prisma + GitHub. Issue creation and audit are shared with
// the non-scanner publish flows (`lib/publishing/finding-publish-ports.ts`,
// #800); only the ScanFinding-keyed halves are defined here.
// ---------------------------------------------------------------------------

/** Build production PublisherPorts. */
export function buildPublisherPorts(): PublisherPorts {
  const base = buildSharedFindingPublisherPorts();
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

    createGitHubIssue: base.createGitHubIssue,

    createJiraIssue: base.createJiraIssue,

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
  /** #733 — the GitHub repository to file into; else the project's saved target. */
  target?: GitHubIssueTarget;
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

  // #733 — like the Deep Dive: the caller's explicit target, else the project's
  // saved one. Resolved without throwing so an already-published finding still
  // returns its existing link; with neither, `createGitHubIssue` refuses with
  // ERR_NO_PUBLISH_TARGET rather than filing into the scanned (upstream) repo.
  if (input.provider === "github") {
    const target = input.target ?? (await findSavedGitHubTarget(sf.scan.projectId));
    if (target) payload.target = target;
  }

  const ports = buildPublisherPorts();
  const outcome = await publishFinding(ports, {
    finding: payload,
    provider: input.provider,
    extraLabels: input.extraLabels,
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
