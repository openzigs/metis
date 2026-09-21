/**
 * Auto-seed the requirement→code traceability spine from analysis grounding —
 * branch `feat/req-code-traceability`.
 *
 * The analysis CODE agent already grounds every finding in resolvable code
 * references: each `Finding.evidence` JSON carries a `citations[]` array whose
 * `filename` is the ingested code file path (enriched in agent-runner). Each
 * synthesized requirement records the finding ids it draws on as
 * `finding:<id>` entries inside its `labels` JSON.
 *
 * This module joins those two facts to mint `RequirementCodeMapping` rows so a
 * requirement's "Requirement → Spec → Code" panel shows the specific code files
 * it impacts — with no manual click and no Prisma migration (the spine model,
 * the spine query, and the UI all pre-exist).
 *
 * Design notes (mirrors the DI pattern in `backfill-spec-links.ts` /
 * `traceability-spine.ts`):
 *   - Conservative: a link is created ONLY when a finding cites a real,
 *     non-empty `filename`. Findings with no citations / no filename produce
 *     nothing. We never invent a path.
 *   - `codeSymbolId` is left null — the analysis pipeline never resolves a
 *     symbol id (see persistAgentResult), and a file-only spine row is valid
 *     (the column is nullable, the UI renders file:line fine).
 *   - Idempotent: deduped within a run and against existing rows by
 *     (requirementId, filePath, codeSymbolId). Re-running synthesis creates no
 *     duplicates.
 *   - Prisma is dependency-injected so the orchestration is unit-testable with
 *     no DB.
 */
import type { PrismaClient } from "@prisma/client";
import { prisma as defaultPrisma } from "../prisma.js";
import { createChildLogger } from "../logger.js";

const log = createChildLogger("seed-code-links-from-findings");

/** Provenance recorded on auto-seeded spine rows. */
export const ANALYSIS_GROUNDING_SOURCE = "analysis-grounding";

/**
 * Confidence used when a finding does not carry a usable per-finding
 * probability. Deliberately below the 0.7 spine default so an auto-seeded link
 * reads as a suggestion rather than a hand-verified mapping.
 */
export const DEFAULT_SEED_CONFIDENCE = 0.5;

type SeedPrisma = Pick<PrismaClient, "requirement" | "finding" | "requirementCodeMapping">;

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

interface ParsedCitation {
  filename?: unknown;
}

/** Pull the usable (non-empty string) `filename`s out of a finding's evidence JSON. */
export function parseCitationFilenames(rawEvidence: string | null | undefined): string[] {
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
  const files: string[] = [];
  for (const c of citations as ParsedCitation[]) {
    if (c && typeof c.filename === "string") {
      const f = c.filename.trim();
      if (f) files.push(f);
    }
  }
  return files;
}

/** A spine row candidate derived from a finding citation (pre-persistence). */
export interface SeedCandidate {
  requirementId: string;
  projectId: string;
  codeSymbolId: string | null;
  filePath: string;
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

    // Collect unique candidate file paths for this requirement, keeping the
    // highest finding confidence observed for each path.
    const byPath = new Map<string, number>();
    for (const finding of findings) {
      const rawConfidence =
        typeof finding.confidence === "number" && Number.isFinite(finding.confidence)
          ? finding.confidence
          : DEFAULT_SEED_CONFIDENCE;
      // Clamp to [0,1]: confidence is an LLM self-reported probability and the
      // DB column has no CHECK, so an out-of-range value (e.g. 1.7) would
      // otherwise propagate and render as "170%" in the UI ConfidenceBadge.
      const confidence = Math.min(1, Math.max(0, rawConfidence));
      for (const filePath of parseCitationFilenames(finding.evidence)) {
        const prev = byPath.get(filePath);
        if (prev === undefined || confidence > prev) byPath.set(filePath, confidence);
      }
    }
    if (byPath.size === 0) continue;

    // Dedupe against existing spine rows for this requirement (any source) so a
    // re-run — or a manual/semantic link that already exists — is never
    // duplicated. We key on (filePath, codeSymbolId) and we only ever seed
    // codeSymbolId = null, so a matching filePath with a null symbol is a dup.
    const existing = await prisma.requirementCodeMapping.findMany({
      where: { requirementId, projectId: input.projectId },
      select: { filePath: true, codeSymbolId: true },
    });
    const existingFileOnly = new Set(
      existing.filter((e) => e.codeSymbolId == null).map((e) => e.filePath),
    );

    let seededAny = false;
    for (const [filePath, confidence] of byPath) {
      if (existingFileOnly.has(filePath)) {
        linksSkipped += 1;
        continue;
      }
      await prisma.requirementCodeMapping.create({
        data: {
          requirementId,
          projectId: input.projectId,
          codeSymbolId: null,
          filePath,
          startLine: null,
          endLine: null,
          confidence,
          source: ANALYSIS_GROUNDING_SOURCE,
        },
      });
      existingFileOnly.add(filePath);
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
