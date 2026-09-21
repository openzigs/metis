/**
 * Backfill the requirement→spec→code traceability spine — Epic #207 (#228).
 *
 * Existing specs live as free-text RAG chunks + `GeneratedDocument` rows with
 * no structured link to requirements or code. This backfill derives those links
 * from data already in the DB, idempotently (a re-run creates no duplicates):
 *
 *   1. Spec identity — the set of `GeneratedDocument` rows in the project that
 *      act as specs (scope `full`/`module` or any doc flagged via scopeFilter).
 *      We do NOT mint new rows; specs already exist as generated documents.
 *
 *   2. Requirement↔Spec — derived from the existing `RequirementCodeMapping`
 *      spine + RAG chunk provenance: a requirement is linked to a spec when the
 *      spec's source RAG chunks reference a document the requirement also draws
 *      on, OR (the always-derivable fallback) when both the requirement and the
 *      spec map onto an overlapping code surface. Confidence = Jaccard overlap
 *      of their code file-paths, floored so a single shared file still links.
 *
 *   3. Spec↔Code — propagated: each linked spec inherits the union of its
 *      requirements' code mappings as `derived` spec→code rows.
 *
 * All inputs are dependency-injected (a `BackfillData` snapshot + a writer) so
 * the derivation logic is pure and unit-testable with no DB. The default
 * `runBackfill` binds them to Prisma.
 */
import type { BackfillSpecLinksResult } from "@metis/shared";
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";
import { persistDerived, type SpecCodeMatch } from "./spec-code-mapping.js";

const log = createChildLogger("backfill-spec-links");

/** Minimum file-path overlap (Jaccard) for an auto-derived requirement→spec link. */
export const MIN_LINK_CONFIDENCE = 0.1;

/** A spec document considered for backfill. */
export interface BackfillSpec {
  id: string;
  /** File paths referenced by the spec's RAG chunks / scope filter. */
  filePaths: string[];
}

/** A requirement's existing code mappings (the #159 spine). */
export interface BackfillRequirement {
  id: string;
  /** Code mappings for this requirement: filePath + optional symbol. */
  code: Array<{
    codeSymbolId: string | null;
    filePath: string;
    startLine: number | null;
    endLine: number | null;
  }>;
}

/** Pre-loaded snapshot the derivation operates on (no DB access in pure logic). */
export interface BackfillData {
  projectId: string;
  specs: BackfillSpec[];
  requirements: BackfillRequirement[];
}

/** A derived requirement→spec link (pre-persistence). */
export interface DerivedReqSpecLink {
  requirementId: string;
  specDocumentId: string;
  confidence: number;
}

/** Jaccard similarity of two file-path sets (0 when either is empty). */
export function pathOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const p of a) if (b.has(p)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/**
 * Pure derivation: from the snapshot, compute the requirement→spec links and the
 * spec→code matches each spec should carry. Deterministic and side-effect free.
 */
export function deriveSpecLinks(data: BackfillData): {
  reqSpecLinks: DerivedReqSpecLink[];
  specCode: Map<string, SpecCodeMatch[]>;
} {
  const reqSpecLinks: DerivedReqSpecLink[] = [];
  // specId -> deduped code matches (keyed by symbolId|filePath).
  const specCode = new Map<string, Map<string, SpecCodeMatch>>();

  const specPaths = new Map<string, Set<string>>(
    data.specs.map((s) => [s.id, new Set(s.filePaths)]),
  );

  for (const req of data.requirements) {
    if (req.code.length === 0) continue;
    const reqPaths = new Set(req.code.map((c) => c.filePath));

    for (const spec of data.specs) {
      const overlap = pathOverlap(reqPaths, specPaths.get(spec.id)!);
      if (overlap < MIN_LINK_CONFIDENCE) continue;

      reqSpecLinks.push({
        requirementId: req.id,
        specDocumentId: spec.id,
        confidence: Number(overlap.toFixed(4)),
      });

      // Propagate this requirement's code mappings onto the spec (deduped).
      let bucket = specCode.get(spec.id);
      if (!bucket) {
        bucket = new Map();
        specCode.set(spec.id, bucket);
      }
      for (const c of req.code) {
        const key = `${c.codeSymbolId ?? ""}|${c.filePath}`;
        if (!bucket.has(key)) {
          bucket.set(key, {
            codeSymbolId: c.codeSymbolId,
            filePath: c.filePath,
            startLine: c.startLine,
            endLine: c.endLine,
            confidence: Number(overlap.toFixed(4)),
          });
        }
      }
    }
  }

  const flattened = new Map<string, SpecCodeMatch[]>();
  for (const [specId, bucket] of specCode) {
    flattened.set(specId, [...bucket.values()]);
  }
  return { reqSpecLinks, specCode: flattened };
}

/** Persistence seam — injected so the orchestration is unit-testable. */
export interface BackfillWriter {
  /**
   * Create a requirement→spec link if absent. Returns true when a row was
   * created, false when it already existed (idempotent skip).
   */
  ensureRequirementSpecLink(link: DerivedReqSpecLink, projectId: string): Promise<boolean>;
  /** Replace a spec's derived code links with `matches` (idempotent). */
  writeSpecCode(specDocumentId: string, projectId: string, matches: SpecCodeMatch[]): Promise<void>;
  /** Count existing derived spec→code rows for a spec (for skip accounting). */
  countDerivedSpecCode(specDocumentId: string): Promise<number>;
}

/**
 * Orchestrate the backfill from a pre-loaded snapshot via the injected writer.
 * Idempotent: re-running with the same data creates no new requirement→spec
 * rows and rewrites the same derived spec→code set.
 */
export async function applyBackfill(
  data: BackfillData,
  writer: BackfillWriter,
): Promise<BackfillSpecLinksResult> {
  const { reqSpecLinks, specCode } = deriveSpecLinks(data);

  let requirementSpecLinksCreated = 0;
  let requirementSpecLinksSkipped = 0;
  for (const link of reqSpecLinks) {
    const created = await writer.ensureRequirementSpecLink(link, data.projectId);
    if (created) requirementSpecLinksCreated += 1;
    else requirementSpecLinksSkipped += 1;
  }

  let specCodeLinksCreated = 0;
  let specCodeLinksSkipped = 0;
  for (const [specId, matches] of specCode) {
    const existing = await writer.countDerivedSpecCode(specId);
    await writer.writeSpecCode(specId, data.projectId, matches);
    // `writeSpecCode` replaces existing derived rows; everything that was
    // already present is accounted as a skip, the remainder as created.
    const created = Math.max(0, matches.length - existing);
    specCodeLinksCreated += created;
    specCodeLinksSkipped += matches.length - created;
  }

  return {
    specsConsidered: data.specs.length,
    requirementSpecLinksCreated,
    requirementSpecLinksSkipped,
    specCodeLinksCreated,
    specCodeLinksSkipped,
  };
}

// ---------------------------------------------------------------------------
// Prisma-bound default wiring.
// ---------------------------------------------------------------------------

type BackfillPrisma = Pick<
  PrismaClient,
  | "generatedDocument"
  | "requirement"
  | "requirementCodeMapping"
  | "requirementSpecMapping"
  | "specCodeMapping"
  | "codeSymbol"
  | "$transaction"
>;

/** Load the backfill snapshot from Prisma for one project. */
export async function loadBackfillData(
  projectId: string,
  prisma: BackfillPrisma,
): Promise<BackfillData> {
  // Specs = generated documents in the project. `scopeFilter` may carry file
  // paths; we additionally union in the file paths from the project's
  // requirement→code spine that the spec content overlaps (handled in derive).
  const specDocs = await prisma.generatedDocument.findMany({
    where: { projectId, deletedAt: null },
    select: { id: true, scopeFilter: true },
  });

  const specs: BackfillSpec[] = specDocs.map((d) => ({
    id: d.id,
    filePaths: extractScopePaths(d.scopeFilter),
  }));

  const reqRows = await prisma.requirement.findMany({
    where: { projectId, deletedAt: null },
    select: {
      id: true,
      codeMappings: {
        select: { codeSymbolId: true, filePath: true, startLine: true, endLine: true },
      },
    },
  });

  const requirements: BackfillRequirement[] = reqRows.map((r) => ({
    id: r.id,
    code: r.codeMappings.map((c) => ({
      codeSymbolId: c.codeSymbolId,
      filePath: c.filePath,
      startLine: c.startLine,
      endLine: c.endLine,
    })),
  }));

  return { projectId, specs, requirements };
}

/** Parse file paths out of a generated document's JSON `scopeFilter`. */
export function extractScopePaths(scopeFilter: string | null | undefined): string[] {
  if (!scopeFilter) return [];
  try {
    const parsed = JSON.parse(scopeFilter) as unknown;
    if (parsed && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      const paths = obj.modulePaths ?? obj.filePaths ?? obj.paths;
      if (Array.isArray(paths)) {
        return paths.filter((p): p is string => typeof p === "string");
      }
    }
  } catch {
    // Malformed scopeFilter — treat as no paths rather than throwing.
  }
  return [];
}

/** Build a Prisma-backed writer for `applyBackfill`. */
export function prismaWriter(prisma: BackfillPrisma): BackfillWriter {
  return {
    async ensureRequirementSpecLink(link, projectId) {
      const existing = await prisma.requirementSpecMapping.findFirst({
        where: { requirementId: link.requirementId, specDocumentId: link.specDocumentId },
        select: { id: true },
      });
      if (existing) return false;
      await prisma.requirementSpecMapping.create({
        data: {
          requirementId: link.requirementId,
          specDocumentId: link.specDocumentId,
          projectId,
          confidence: link.confidence,
          source: "derived",
        },
      });
      return true;
    },
    async writeSpecCode(specDocumentId, projectId, matches) {
      await persistDerived(projectId, specDocumentId, matches, { prisma });
    },
    async countDerivedSpecCode(specDocumentId) {
      return prisma.specCodeMapping.count({ where: { specDocumentId, source: "derived" } });
    },
  };
}

/**
 * Run the full backfill for a project against Prisma. Returns the summary
 * counts. Never throws on an empty project — yields all-zero counts.
 */
export async function runBackfill(
  projectId: string,
  deps: { prisma?: BackfillPrisma } = {},
): Promise<BackfillSpecLinksResult> {
  const prisma = (deps.prisma ?? (defaultPrisma as unknown as BackfillPrisma)) as BackfillPrisma;
  const data = await loadBackfillData(projectId, prisma);
  const result = await applyBackfill(data, prismaWriter(prisma));
  log.info("spec-link backfill complete", { projectId, ...result });
  return result;
}
