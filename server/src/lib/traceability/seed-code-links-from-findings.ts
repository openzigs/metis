/**
 * Auto-seed requirement→code traceability links from analysis grounding.
 * Document citations are only eligible when their persisted Document is a repo
 * source and its source path resolves to one unambiguous code-graph module.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { extractRepoRelPath } from "../rag/fused-code-context.js";

const log = createChildLogger("seed-code-links-from-findings");

/** Provenance recorded on auto-seeded spine rows. */
export const ANALYSIS_GROUNDING_SOURCE = "analysis-grounding";

/** Confidence used when a finding does not carry a usable per-finding probability. */
export const DEFAULT_SEED_CONFIDENCE = 0.5;

type SeedPrisma = Pick<
  PrismaClient,
  "requirement" | "finding" | "requirementCodeMapping" | "document" | "codeSymbol"
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

export type FindingCitation =
  | { kind: "code"; filePath: string; startLine: number; endLine: number; symbolId?: string }
  | { kind: "document"; documentId: string; filename?: string };

/** Parse only the two persisted citation shapes; labels are never treated as paths. */
export function parseFindingCitations(rawEvidence: string | null | undefined): FindingCitation[] {
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

  const result: FindingCitation[] = [];
  for (const value of citations) {
    if (!value || typeof value !== "object") continue;
    const citation = value as Record<string, unknown>;
    if (
      typeof citation.filePath === "string" &&
      Number.isInteger(citation.startLine) &&
      Number.isInteger(citation.endLine) &&
      (citation.symbolId === undefined || typeof citation.symbolId === "string")
    ) {
      const startLine = citation.startLine as number;
      const endLine = citation.endLine as number;
      if (startLine > 0 && endLine >= startLine) {
        result.push({
          kind: "code",
          filePath: citation.filePath,
          startLine,
          endLine,
          ...(typeof citation.symbolId === "string" ? { symbolId: citation.symbolId } : {}),
        });
      }
      continue;
    }
    if (
      typeof citation.documentId === "string" &&
      Number.isInteger(citation.chunkIndex) &&
      (citation.chunkIndex as number) >= 0
    ) {
      result.push({
        kind: "document",
        documentId: citation.documentId,
        ...(typeof citation.filename === "string" ? { filename: citation.filename } : {}),
      });
    }
  }
  return result;
}

/** A spine row candidate derived from a resolved code citation. */
export interface SeedCandidate {
  requirementId: string;
  projectId: string;
  codeSymbolId: string;
  filePath: string;
  startLine: number;
  endLine: number;
  confidence: number;
}

interface CodeSymbolRow {
  id: string;
  kind: string;
  filePath: string;
  startLine: number;
  endLine: number;
}

function normalizeCodePath(rawPath: string): string | null {
  const extracted = extractRepoRelPath(rawPath);
  const path = (extracted ?? rawPath).replace(/\\/g, "/").replace(/^\.\//, "");
  const segments = path.split("/");
  if (
    !path ||
    path.startsWith("/") ||
    /^[a-zA-Z]:/.test(path) ||
    segments.some((segment) => segment === ".." || segment === ".")
  ) {
    return null;
  }
  return path;
}

function mappingKey(filePath: string, codeSymbolId: string | null): string {
  return `${filePath}\u0000${codeSymbolId ?? ""}`;
}

function isCodeSymbol(symbol: CodeSymbolRow): boolean {
  return symbol.kind !== "table" && symbol.kind !== "column";
}

function addCandidate(candidates: Map<string, SeedCandidate>, candidate: SeedCandidate): void {
  const key = mappingKey(candidate.filePath, candidate.codeSymbolId);
  const previous = candidates.get(key);
  if (!previous) {
    candidates.set(key, candidate);
    return;
  }
  candidates.set(key, {
    ...previous,
    startLine: Math.min(previous.startLine, candidate.startLine),
    endLine: Math.max(previous.endLine, candidate.endLine),
    confidence: Math.max(previous.confidence, candidate.confidence),
  });
}

/**
 * Seed requirement→code spine rows only from code citations that resolve to a
 * project code symbol. Stale rows from this seeder are reconciled on reruns;
 * manual and semantic mappings are never deleted.
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
    const findings =
      findingIds.length === 0
        ? []
        : await prisma.finding.findMany({
            where: {
              id: { in: findingIds },
              agentResult: { analysis: { projectId: input.projectId } },
            },
            select: { evidence: true, confidence: true },
          });

    const citations = findings.flatMap((finding) => {
      const rawConfidence =
        typeof finding.confidence === "number" && Number.isFinite(finding.confidence)
          ? finding.confidence
          : DEFAULT_SEED_CONFIDENCE;
      const confidence = Math.min(1, Math.max(0, rawConfidence));
      return parseFindingCitations(finding.evidence).map((citation) => ({ citation, confidence }));
    });

    const documentIds = [
      ...new Set(
        citations.flatMap(({ citation }) =>
          citation.kind === "document" ? [citation.documentId] : [],
        ),
      ),
    ];
    const documents =
      documentIds.length === 0
        ? []
        : await prisma.document.findMany({
            where: { id: { in: documentIds }, projectId: input.projectId },
            select: { id: true, source: true, filename: true },
          });
    const documentsById = new Map(documents.map((document) => [document.id, document]));

    const repoDocumentPaths = new Map<string, number>();
    const codeCitations: Array<{
      filePath: string;
      startLine: number;
      endLine: number;
      symbolId?: string;
      confidence: number;
    }> = [];
    for (const { citation, confidence } of citations) {
      if (citation.kind === "document") {
        const document = documentsById.get(citation.documentId);
        if (!document || document.source !== "repo") continue;
        const filePath = extractRepoRelPath(document.filename);
        const normalizedPath = filePath ? normalizeCodePath(filePath) : null;
        if (normalizedPath) {
          repoDocumentPaths.set(
            normalizedPath,
            Math.max(repoDocumentPaths.get(normalizedPath) ?? 0, confidence),
          );
        }
        continue;
      }

      const filePath = normalizeCodePath(citation.filePath);
      if (filePath) codeCitations.push({ ...citation, filePath, confidence });
    }

    const modulePaths = [
      ...new Set([...repoDocumentPaths.keys(), ...codeCitations.map((c) => c.filePath)]),
    ];
    const symbolIds = [
      ...new Set(
        codeCitations.flatMap((citation) => (citation.symbolId ? [citation.symbolId] : [])),
      ),
    ];
    const [modules, citedSymbols] = await Promise.all([
      modulePaths.length === 0
        ? []
        : prisma.codeSymbol.findMany({
            where: { projectId: input.projectId, kind: "module", filePath: { in: modulePaths } },
            select: { id: true, kind: true, filePath: true, startLine: true, endLine: true },
          }),
      symbolIds.length === 0
        ? []
        : prisma.codeSymbol.findMany({
            where: { projectId: input.projectId, id: { in: symbolIds } },
            select: { id: true, kind: true, filePath: true, startLine: true, endLine: true },
          }),
    ]);

    const modulesByPath = new Map<string, CodeSymbolRow[]>();
    for (const module of modules) {
      const filePath = normalizeCodePath(module.filePath);
      if (!filePath) continue;
      const rows = modulesByPath.get(filePath) ?? [];
      rows.push(module);
      modulesByPath.set(filePath, rows);
    }
    const citedSymbolsById = new Map(citedSymbols.map((symbol) => [symbol.id, symbol]));
    const resolvedModules = new Map<string, CodeSymbolRow>();
    for (const [filePath, rows] of modulesByPath) {
      if (rows.length === 1) resolvedModules.set(filePath, rows[0]!);
    }

    const candidates = new Map<string, SeedCandidate>();
    for (const [filePath, confidence] of repoDocumentPaths) {
      const module = resolvedModules.get(filePath);
      if (!module) continue;
      const resolvedPath = normalizeCodePath(module.filePath);
      if (!resolvedPath) continue;
      addCandidate(candidates, {
        requirementId,
        projectId: input.projectId,
        codeSymbolId: module.id,
        filePath: resolvedPath,
        startLine: module.startLine,
        endLine: module.endLine,
        confidence,
      });
    }

    for (const citation of codeCitations) {
      const symbol = citation.symbolId
        ? citedSymbolsById.get(citation.symbolId)
        : resolvedModules.get(citation.filePath);
      if (!symbol || !isCodeSymbol(symbol)) continue;
      const resolvedPath = normalizeCodePath(symbol.filePath);
      if (resolvedPath !== citation.filePath) continue;
      if (citation.startLine < symbol.startLine || citation.endLine > symbol.endLine) continue;
      addCandidate(candidates, {
        requirementId,
        projectId: input.projectId,
        codeSymbolId: symbol.id,
        filePath: resolvedPath,
        startLine: citation.startLine,
        endLine: citation.endLine,
        confidence: citation.confidence,
      });
    }

    const existing = await prisma.requirementCodeMapping.findMany({
      where: { requirementId, projectId: input.projectId },
      select: { id: true, filePath: true, codeSymbolId: true, source: true },
    });
    const candidateKeys = new Set(
      [...candidates.values()].map((candidate) =>
        mappingKey(candidate.filePath, candidate.codeSymbolId),
      ),
    );
    const staleIds = existing
      .filter(
        (mapping) =>
          mapping.source === ANALYSIS_GROUNDING_SOURCE &&
          !candidateKeys.has(mappingKey(mapping.filePath, mapping.codeSymbolId)),
      )
      .map((mapping) => mapping.id);
    const staleIdSet = new Set(staleIds);
    const existingKeys = new Set(
      existing
        .filter((mapping) => !staleIdSet.has(mapping.id))
        .map((mapping) => mappingKey(mapping.filePath, mapping.codeSymbolId)),
    );
    let seededAny = false;
    for (const candidate of candidates.values()) {
      const key = mappingKey(candidate.filePath, candidate.codeSymbolId);
      if (existingKeys.has(key)) {
        linksSkipped += 1;
        continue;
      }
      await prisma.requirementCodeMapping.create({
        data: {
          ...candidate,
          source: ANALYSIS_GROUNDING_SOURCE,
        },
      });
      existingKeys.add(key);
      linksCreated += 1;
      seededAny = true;
    }
    if (staleIds.length > 0) {
      await prisma.requirementCodeMapping.deleteMany({ where: { id: { in: staleIds } } });
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
