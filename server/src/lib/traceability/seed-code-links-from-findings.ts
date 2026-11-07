/**
 * Auto-seed the requirement→code traceability spine from analysis grounding —
 * branch `feat/req-code-traceability`.
 *
 * Each `Finding.evidence` JSON carries a `citations[]` array, and each
 * synthesized requirement records the finding ids it draws on as
 * `finding:<id>` entries inside its `labels` JSON.
 *
 * #768 — a citation is not necessarily code. A document citation's `filename`
 * is the retrieval document's name: a man page, an uploaded `api.html`, the
 * `Live database schema`, a `connector:db:…` doc, or a repository file keyed
 * `connector:repo:<id>:src/<relPath>`. Writing every such name as a "direct
 * code link" inflated workspace code coverage with links that point at no
 * code. A link is therefore written only for a citation that RESOLVES to the
 * project's code graph:
 *   - a code citation (`filePath` + `startLine`/`endLine`) whose file is in the
 *     graph — bound to the citation's own symbol when that symbol is in the
 *     file, else the innermost symbol enclosing the span, else file-level with
 *     the cited lines;
 *   - a repository source document (`connector:repo:<id>:src/<relPath>`) whose
 *     `<relPath>` is a graph file — a file-level link (a chunk has no lines).
 * Anything else is evidence, not code, and writes nothing.
 *
 * This module joins those two facts to mint `RequirementCodeMapping` rows so a
 * requirement's "Requirement → Spec → Code" panel shows the specific code files
 * it impacts — with no manual click and no Prisma migration (the spine model,
 * the spine query, and the UI all pre-exist).
 *
 * Design notes (mirrors the DI pattern in `backfill-spec-links.ts` /
 * `traceability-spine.ts`):
 *   - Conservative: a path is never invented, and never stored unless the
 *     project's code graph contains it.
 *   - Idempotent: deduped within a run and against the requirement's existing
 *     `analysis-grounding` rows by (requirementId, filePath, codeSymbolId).
 *     Re-running synthesis creates no duplicates. #1818 — a link of another
 *     source (`manual`, `semantic`) does NOT suppress the agent's citation of
 *     the same code: a file a person linked that the agent also cited counts as
 *     cited, so `IMPACT_AGENT_SEEDS` (#1759) can lead with it. The semantic
 *     mapper's write does not dedupe against these rows either.
 *   - Ordered (#1818): rows are written one at a time in CITATION ORDER — the
 *     requirement's evidence findings in the order its labels list them, then
 *     each finding's citations in theirs — so `IMPACT_AGENT_SEEDS`, which reads
 *     them back in stored order, sees the same order on every run.
 *   - Versioned (#1830): each row records the code graph it was read from
 *     (`codeGraphId`, the graph of the repository the cited file belongs to),
 *     that graph's `commitSha` at write time, and `freshness = "fresh"` with
 *     `validatedAt`, because the citation was just checked against the graph.
 *     The repository is the one the citation names (`repoConnectionId`, or the
 *     `connector:repo:<id>:` key), else the one the finding's code pass ran
 *     for; a file both repositories hold resolves against that repository's
 *     symbols. When no single graph can be told apart the row is written
 *     `unverified` with no graph, never stamped with a guess. #1961 — the
 *     pass's repository is only a hint: a pass searches the whole project's
 *     graph, so a file its own repository does not hold resolves (and is
 *     stamped) as if no repository were named. Only a repository the citation
 *     itself names withholds the stamp when its graph lacks the file.
 *   - Prisma is dependency-injected so the orchestration is unit-testable with
 *     no DB.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { noteRequirementCodeLinksChanged } from "../docs-gen/approved-requirements-staleness.js";
import { createChildLogger } from "../logger.js";
import { extractRepoRelPath } from "../rag/fused-code-context.js";
import { codeLinkKey as mappingKey } from "./code-link-key.js";

const log = createChildLogger("seed-code-links-from-findings");

/** Provenance recorded on auto-seeded spine rows. */
export const ANALYSIS_GROUNDING_SOURCE = "analysis-grounding";

/**
 * Confidence used when a finding does not carry a usable per-finding
 * probability. Deliberately below the 0.7 spine default so an auto-seeded link
 * reads as a suggestion rather than a hand-verified mapping.
 */
export const DEFAULT_SEED_CONFIDENCE = 0.5;

type SeedPrisma = Pick<
  PrismaClient,
  "requirement" | "finding" | "requirementCodeMapping" | "codeSymbol"
>;

export interface SeedDeps {
  prisma?: SeedPrisma;
}

export interface SeedInput {
  analysisId: string;
  projectId: string;
  requirementIds: string[];
}

export interface SeedSummary {
  requirementsSeeded: number;
  linksCreated: number;
  linksSkipped: number;
}

function pickPrisma(deps?: SeedDeps): SeedPrisma {
  return (deps?.prisma ?? (defaultPrisma as unknown as SeedPrisma)) as SeedPrisma;
}

/** Extract the `finding:<id>` evidence finding ids out of a requirement's labels JSON. */
export function parseEvidenceFindingIds(rawLabels: string | null | undefined): string[] {
  if (!rawLabels) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawLabels);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const ids: string[] = [];
  for (const label of parsed) {
    if (typeof label === "string" && label.startsWith("finding:")) {
      const id = label.slice("finding:".length);
      if (id) ids.push(id);
    }
  }
  return [...new Set(ids)];
}

/**
 * A citation that may name code: a repository file path, plus the cited span
 * and symbol id when the citation is a code citation.
 */
export interface CitationTarget {
  filePath: string;
  startLine?: number;
  endLine?: number;
  symbolId?: string;
  /**
   * #1830 — the repository the citation names: a code citation's
   * server-stamped `repoConnectionId` (#1611), or the `<id>` of a
   * `connector:repo:<id>:src/` document key.
   */
  repoConnectionId?: string;
}

/** The `<id>` of a `connector:repo:<id>:src/…` (or lenient `repo:<id>:src/…`) key. */
const REPO_KEY_CONNECTOR = /^(?:connector:)?repo:([^:]+):src\//;

/** Repo-relative form of a path: forward slashes, no leading `./` or `/`. */
function normalizeFilePath(p: string): string {
  return p
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.?\//, "");
}

function isPositiveInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 1;
}

/**
 * The citations in a finding's evidence JSON that could be code (#768): code
 * citations, and document citations whose filename is a repository source key
 * (the key is stripped to the repo-relative path). Every other document name —
 * a man page, an upload, the live schema, a `connector:db:` doc, a repository
 * metadata unit such as `OVERVIEW.md` — is dropped here.
 */
export function parseCitationTargets(rawEvidence: string | null | undefined): CitationTarget[] {
  if (!rawEvidence) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawEvidence);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  return citationTargets((parsed as { citations?: unknown }).citations);
}

/**
 * {@link parseCitationTargets} over an already-parsed `citations` value. #1568 —
 * the Approvals tab reads it to say, before approval, which requirements have
 * no evidence that could become a code link.
 */
export function citationTargets(citations: unknown): CitationTarget[] {
  if (!Array.isArray(citations)) return [];
  const targets: CitationTarget[] = [];
  for (const c of citations as Array<Record<string, unknown> | null>) {
    if (!c || typeof c !== "object") continue;
    if (typeof c.filePath === "string" && isPositiveInt(c.startLine) && isPositiveInt(c.endLine)) {
      const filePath = normalizeFilePath(c.filePath);
      if (!filePath) continue;
      targets.push({
        filePath,
        startLine: Math.min(c.startLine, c.endLine),
        endLine: Math.max(c.startLine, c.endLine),
        ...(typeof c.symbolId === "string" && c.symbolId ? { symbolId: c.symbolId } : {}),
        ...(typeof c.repoConnectionId === "string" && c.repoConnectionId
          ? { repoConnectionId: c.repoConnectionId }
          : {}),
      });
      continue;
    }
    if (typeof c.filename === "string") {
      const key = c.filename.trim();
      const rel = extractRepoRelPath(key);
      const filePath = rel === null ? "" : normalizeFilePath(rel);
      const repoConnectionId = REPO_KEY_CONNECTOR.exec(key)?.[1];
      if (filePath) targets.push({ filePath, ...(repoConnectionId ? { repoConnectionId } : {}) });
    }
  }
  return targets;
}

interface GraphSymbol {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
  /** #1830 — the symbol's code graph, and that graph's repository and commit. */
  codeGraphId: string;
  graph: { repoConnectionId: string | null; commitSha: string | null };
  /** #1831 — the symbol's identity, kept on the link so re-validation can find it again. */
  qualifiedName: string;
  kind: string;
  contentHash: string;
}

/** #1831 — the identity of the symbol a link names; nulls on a file-level link. */
interface CitedSymbolIdentity {
  symbolQualifiedName: string | null;
  symbolKind: string | null;
  symbolContentHash: string | null;
}

const NO_SYMBOL: CitedSymbolIdentity = {
  symbolQualifiedName: null,
  symbolKind: null,
  symbolContentHash: null,
};

/** #1830 — the code-graph version a citation was read from. */
interface CitationVersion {
  codeGraphId: string | null;
  commitSha: string | null;
}

/** The one graph every symbol in `symbols` belongs to; nulls when they span several. */
function soleGraph(symbols: GraphSymbol[]): CitationVersion {
  const ids = new Set(symbols.map((s) => s.codeGraphId));
  if (ids.size !== 1) return { codeGraphId: null, commitSha: null };
  return { codeGraphId: symbols[0].codeGraphId, commitSha: symbols[0].graph.commitSha };
}

/** The innermost symbol whose range encloses `[start, end]`, if any. */
function enclosingSymbol(
  symbols: GraphSymbol[],
  start: number,
  end: number,
): GraphSymbol | undefined {
  let best: GraphSymbol | undefined;
  for (const sym of symbols) {
    if (sym.startLine > start || sym.endLine < end) continue;
    const span = sym.endLine - sym.startLine;
    if (!best || span < best.endLine - best.startLine) best = sym;
  }
  return best;
}

/**
 * Resolve a citation against the graph symbols of its file; `null` when
 * unresolved. #1830 — when the citation's repository holds the file, only that
 * repository's symbols are considered, so a path two repositories share
 * resolves (and is stamped) to the right one. `repoConnectionId` is the
 * citation's own repository, else the one its finding's code pass ran for.
 */
function resolveTarget(
  target: CitationTarget,
  symbolsByFile: Map<string, GraphSymbol[]>,
  repoConnectionId: string | undefined,
): Omit<SeedCandidate, "requirementId" | "projectId" | "confidence"> | null {
  const allInFile = symbolsByFile.get(target.filePath);
  if (!allInFile || allInFile.length === 0) return null; // not code the graph knows
  const inRepo = repoConnectionId
    ? allInFile.filter((s) => s.graph.repoConnectionId === repoConnectionId)
    : [];
  const inFile = inRepo.length > 0 ? inRepo : allInFile;
  // A citation naming a repository whose graph does not hold the file still
  // resolves its location against the other repos, but is never stamped with
  // another repository's graph: the row is written unverified.
  // #1961 — only a repository the citation ITSELF names. The pass's repository
  // is a fallback hint, not a claim: a secondary repository's pass that cites
  // the primary repository's code (its tools search the whole project) would
  // otherwise leave every such citation unverified until the next re-ingest.
  const foreignRepo = target.repoConnectionId !== undefined && inRepo.length === 0;
  const versionOf = (v: CitationVersion): CitationVersion =>
    foreignRepo ? { codeGraphId: null, commitSha: null } : v;
  if (target.startLine === undefined || target.endLine === undefined) {
    return {
      codeSymbolId: null,
      filePath: target.filePath,
      startLine: null,
      endLine: null,
      ...versionOf(soleGraph(inFile)),
      ...NO_SYMBOL,
    };
  }
  const sym =
    (target.symbolId ? inFile.find((s) => s.id === target.symbolId) : undefined) ??
    enclosingSymbol(inFile, target.startLine, target.endLine);
  if (sym) {
    return {
      codeSymbolId: sym.id,
      filePath: sym.filePath,
      startLine: sym.startLine,
      endLine: sym.endLine,
      ...versionOf({ codeGraphId: sym.codeGraphId, commitSha: sym.graph.commitSha }),
      symbolQualifiedName: sym.qualifiedName,
      symbolKind: sym.kind,
      symbolContentHash: sym.contentHash,
    };
  }
  return {
    codeSymbolId: null,
    filePath: target.filePath,
    startLine: target.startLine,
    endLine: target.endLine,
    ...versionOf(soleGraph(inFile)),
    ...NO_SYMBOL,
  };
}

/** A spine row candidate derived from a finding citation (pre-persistence). */
export interface SeedCandidate {
  requirementId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
  /** #1830 — the graph the citation resolved in; null when no single graph could be told apart. */
  codeGraphId: string | null;
  commitSha: string | null;
  /** #1831 — the bound symbol's identity; null on a file-level link. */
  symbolQualifiedName: string | null;
  symbolKind: string | null;
  symbolContentHash: string | null;
}

/**
 * Auto-seed requirement→code spine rows from the analysis grounding of the
 * given requirements. Conservative, idempotent, and best-effort (callers should
 * wrap invocation so a failure never fails the analysis). Returns a small
 * summary of create/skip accounting.
 */
export async function seedRequirementCodeLinksFromFindings(
  input: SeedInput,
  deps?: SeedDeps,
): Promise<SeedSummary> {
  const prisma = pickPrisma(deps);
  let linksCreated = 0;
  let linksSkipped = 0;
  let requirementsSeeded = 0;
  const seededIds: string[] = [];

  for (const requirementId of input.requirementIds) {
    const requirement = await prisma.requirement.findFirst({
      where: { id: requirementId, projectId: input.projectId },
      select: { id: true, labels: true },
    });
    if (!requirement) continue;

    const findingIds = parseEvidenceFindingIds(requirement.labels);
    if (findingIds.length === 0) continue;

    // Scope the finding load to the analysis project (defense-in-depth): Finding
    // has no direct projectId, so we filter via the agentResult → analysis →
    // projectId relation path. Finding ids already come from the project-scoped
    // requirement's own labels, so this is belt-and-suspenders against a stray
    // id leaking a cross-project finding's citations into this project's spine.
    // #1818 — in the order the requirement's labels list them: `findMany`
    // returns rows in no guaranteed order, and that order becomes the stored
    // citation order `IMPACT_AGENT_SEEDS` leads with.
    const evidenceRank = new Map(findingIds.map((id, i) => [id, i]));
    const findings = (
      await prisma.finding.findMany({
        where: {
          id: { in: findingIds },
          agentResult: { analysis: { projectId: input.projectId } },
        },
        select: {
          id: true,
          evidence: true,
          confidence: true,
          // #1830 — the repository the finding's code pass ran for (#763).
          agentResult: { select: { connectorId: true } },
        },
      })
    ).sort((a, b) => evidenceRank.get(a.id)! - evidenceRank.get(b.id)!);

    // Collect the citations that could be code, with the confidence of the
    // finding that cites them and the repository they name.
    const cited: Array<{
      target: CitationTarget;
      confidence: number;
      repoConnectionId: string | undefined;
    }> = [];
    for (const finding of findings) {
      const rawConfidence =
        typeof finding.confidence === "number" && Number.isFinite(finding.confidence)
          ? finding.confidence
          : DEFAULT_SEED_CONFIDENCE;
      // Clamp to [0,1]: confidence is an LLM self-reported probability and the
      // DB column has no CHECK, so an out-of-range value (e.g. 1.7) would
      // otherwise propagate and render as "170%" in the UI ConfidenceBadge.
      const confidence = Math.min(1, Math.max(0, rawConfidence));
      const passRepo = finding.agentResult?.connectorId ?? undefined;
      for (const target of parseCitationTargets(finding.evidence)) {
        cited.push({ target, confidence, repoConnectionId: target.repoConnectionId ?? passRepo });
      }
    }
    if (cited.length === 0) continue;

    // #768 — resolve against this project's code graph; an unresolved citation
    // is not code and writes nothing.
    const graphRows = await prisma.codeSymbol.findMany({
      where: {
        projectId: input.projectId,
        filePath: { in: [...new Set(cited.map((c) => c.target.filePath))] },
      },
      select: {
        id: true,
        filePath: true,
        startLine: true,
        endLine: true,
        codeGraphId: true,
        graph: { select: { repoConnectionId: true, commitSha: true } },
        qualifiedName: true,
        kind: true,
        contentHash: true,
      },
    });
    const symbolsByFile = new Map<string, GraphSymbol[]>();
    for (const row of graphRows) {
      const list = symbolsByFile.get(row.filePath) ?? [];
      list.push(row);
      symbolsByFile.set(row.filePath, list);
    }

    // One candidate per (filePath, codeSymbolId), keeping the highest confidence.
    // A Map keeps first-cited order: a later, surer citation updates the value
    // in place.
    const candidates = new Map<string, SeedCandidate>();
    for (const { target, confidence, repoConnectionId } of cited) {
      const resolved = resolveTarget(target, symbolsByFile, repoConnectionId);
      if (!resolved) continue;
      const key = mappingKey(resolved.filePath, resolved.codeSymbolId);
      const prev = candidates.get(key);
      if (!prev || confidence > prev.confidence) {
        candidates.set(key, { requirementId, projectId: input.projectId, ...resolved, confidence });
      }
    }
    if (candidates.size === 0) continue;

    // Dedupe against this requirement's existing agent rows, so a re-run is
    // never duplicated. #1818 — not against other sources: a manual or
    // semantic link to the same code would otherwise hide the citation.
    const existing = await prisma.requirementCodeMapping.findMany({
      where: { requirementId, projectId: input.projectId, source: ANALYSIS_GROUNDING_SOURCE },
      select: { filePath: true, codeSymbolId: true },
    });
    const existingKeys = new Set(existing.map((e) => mappingKey(e.filePath, e.codeSymbolId)));

    let seededAny = false;
    const validatedAt = new Date();
    for (const [key, candidate] of candidates) {
      if (existingKeys.has(key)) {
        linksSkipped += 1;
        continue;
      }
      await prisma.requirementCodeMapping.create({
        data: {
          requirementId,
          projectId: input.projectId,
          codeSymbolId: candidate.codeSymbolId,
          filePath: candidate.filePath,
          startLine: candidate.startLine,
          endLine: candidate.endLine,
          confidence: candidate.confidence,
          source: ANALYSIS_GROUNDING_SOURCE,
          // #1830 — just checked against this graph; a row whose graph could
          // not be told apart stays `unverified`, as every pre-#1830 row is.
          codeGraphId: candidate.codeGraphId,
          commitSha: candidate.commitSha,
          // #1831 — what re-validation finds the symbol by after a re-ingest.
          symbolQualifiedName: candidate.symbolQualifiedName,
          symbolKind: candidate.symbolKind,
          symbolContentHash: candidate.symbolContentHash,
          freshness: candidate.codeGraphId ? "fresh" : "unverified",
          validatedAt: candidate.codeGraphId ? validatedAt : null,
        },
      });
      existingKeys.add(key);
      linksCreated += 1;
      seededAny = true;
    }
    if (seededAny) {
      requirementsSeeded += 1;
      seededIds.push(requirementId);
    }
  }
  // #1246 — a new code link can bring an approved requirement into a
  // repository- or path-scoped reader BRD's list: ask the check to look again.
  if (seededIds.length > 0) void noteRequirementCodeLinksChanged(seededIds);

  const summary: SeedSummary = { requirementsSeeded, linksCreated, linksSkipped };
  log.info("seeded requirement→code links from analysis grounding", {
    analysisId: input.analysisId,
    projectId: input.projectId,
    ...summary,
  });
  return summary;
}
