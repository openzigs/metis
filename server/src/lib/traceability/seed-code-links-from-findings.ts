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
 *   - Idempotent: deduped within a run and against existing rows (any source)
 *     by (requirementId, filePath, codeSymbolId). Re-running synthesis creates
 *     no duplicates.
 *   - Prisma is dependency-injected so the orchestration is unit-testable with
 *     no DB.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { extractRepoRelPath } from "../rag/fused-code-context.js";

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
}

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
  const citations = (parsed as { citations?: unknown }).citations;
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
      });
      continue;
    }
    if (typeof c.filename === "string") {
      const rel = extractRepoRelPath(c.filename.trim());
      const filePath = rel === null ? "" : normalizeFilePath(rel);
      if (filePath) targets.push({ filePath });
    }
  }
  return targets;
}

interface GraphSymbol {
  id: string;
  filePath: string;
  startLine: number;
  endLine: number;
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

/** Resolve a citation against the graph symbols of its file; `null` when unresolved. */
function resolveTarget(
  target: CitationTarget,
  symbolsByFile: Map<string, GraphSymbol[]>,
): Pick<SeedCandidate, "codeSymbolId" | "filePath" | "startLine" | "endLine"> | null {
  const inFile = symbolsByFile.get(target.filePath);
  if (!inFile || inFile.length === 0) return null; // not code the graph knows
  if (target.startLine === undefined || target.endLine === undefined) {
    return { codeSymbolId: null, filePath: target.filePath, startLine: null, endLine: null };
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
    };
  }
  return {
    codeSymbolId: null,
    filePath: target.filePath,
    startLine: target.startLine,
    endLine: target.endLine,
  };
}

const mappingKey = (filePath: string, codeSymbolId: string | null): string =>
  `${filePath}\u0000${codeSymbolId ?? ""}`;

/** A spine row candidate derived from a finding citation (pre-persistence). */
export interface SeedCandidate {
  requirementId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  confidence: number;
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
    const findings = await prisma.finding.findMany({
      where: {
        id: { in: findingIds },
        agentResult: { analysis: { projectId: input.projectId } },
      },
      select: { evidence: true, confidence: true },
    });

    // Collect the citations that could be code, with the confidence of the
    // finding that cites them.
    const cited: Array<{ target: CitationTarget; confidence: number }> = [];
    for (const finding of findings) {
      const rawConfidence =
        typeof finding.confidence === "number" && Number.isFinite(finding.confidence)
          ? finding.confidence
          : DEFAULT_SEED_CONFIDENCE;
      // Clamp to [0,1]: confidence is an LLM self-reported probability and the
      // DB column has no CHECK, so an out-of-range value (e.g. 1.7) would
      // otherwise propagate and render as "170%" in the UI ConfidenceBadge.
      const confidence = Math.min(1, Math.max(0, rawConfidence));
      for (const target of parseCitationTargets(finding.evidence)) {
        cited.push({ target, confidence });
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
      select: { id: true, filePath: true, startLine: true, endLine: true },
    });
    const symbolsByFile = new Map<string, GraphSymbol[]>();
    for (const row of graphRows) {
      const list = symbolsByFile.get(row.filePath) ?? [];
      list.push(row);
      symbolsByFile.set(row.filePath, list);
    }

    // One candidate per (filePath, codeSymbolId), keeping the highest confidence.
    const candidates = new Map<string, SeedCandidate>();
    for (const { target, confidence } of cited) {
      const resolved = resolveTarget(target, symbolsByFile);
      if (!resolved) continue;
      const key = mappingKey(resolved.filePath, resolved.codeSymbolId);
      const prev = candidates.get(key);
      if (!prev || confidence > prev.confidence) {
        candidates.set(key, { requirementId, projectId: input.projectId, ...resolved, confidence });
      }
    }
    if (candidates.size === 0) continue;

    // Dedupe against existing spine rows for this requirement (any source) so a
    // re-run — or a manual/semantic link that already exists — is never
    // duplicated.
    const existing = await prisma.requirementCodeMapping.findMany({
      where: { requirementId, projectId: input.projectId },
      select: { filePath: true, codeSymbolId: true },
    });
    const existingKeys = new Set(existing.map((e) => mappingKey(e.filePath, e.codeSymbolId)));

    let seededAny = false;
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
        },
      });
      existingKeys.add(key);
      linksCreated += 1;
      seededAny = true;
    }
    if (seededAny) requirementsSeeded += 1;
  }

  const summary: SeedSummary = { requirementsSeeded, linksCreated, linksSkipped };
  log.info("seeded requirement→code links from analysis grounding", {
    analysisId: input.analysisId,
    projectId: input.projectId,
    ...summary,
  });
  return summary;
}
