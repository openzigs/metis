/**
 * Issue #921 — the files a draft generated from an IMPORTED requirement most
 * likely affects.
 *
 * A draft from an analysed run lists the code links its requirement holds
 * (`draft-code-links.ts`, #1064): the analysis seeded them. An imported
 * requirement is upstream issue text that nothing has mapped to code, so its
 * draft had no such section at all. When the drafts of an import run are
 * generated, each selected requirement that holds no link is now mapped here,
 * with the requirement→code mapper the analysis path shows its links with
 * (#1097: the hybrid search over the project's symbol embeddings, BM25 when it
 * cannot, and the same link rules), and its best few FILES are rendered into
 * the same "Related code" section — said to be derived, not recorded.
 *
 * COST, bounded: no LLM call at all. One corpus load per Generate, and one
 * query embedding per requirement on the local embedder. At most
 * {@link MAX_DERIVED_REQUIREMENTS} requirements are mapped per Generate; a
 * draft past that says its files were not derived rather than leaving the
 * section out.
 *
 * NOTHING IS PERSISTED. The files are derived when the drafts are generated
 * and written into the body only: they are not `RequirementCodeMapping` rows,
 * so they never count as traceability coverage and never stand in for a link
 * an analysis recorded.
 */
import type { PrismaClient } from "@prisma/client";
import { createChildLogger } from "../logger.js";
import { prisma as defaultPrisma } from "../prisma.js";
import {
  ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
  ANALYSIS_LINK_SEARCH_OPTIONS,
  mapRequirementToCode,
  type RequirementCodeMatch,
  type RequirementRetrievalMode,
} from "../traceability/requirement-code-mapping.js";
import {
  createRequirementCodeSearcher,
  type HybridCodeSymbolSearcher,
} from "../traceability/requirement-code-searcher.js";
import { MAX_DERIVED_REQUIREMENTS, type DraftCodeLink } from "./draft-code-links.js";

export { MAX_DERIVED_REQUIREMENTS };

const log = createChildLogger("draft-impact-files");

/** The most files one draft lists as likely affected. */
export const MAX_DERIVED_FILES = 5;

/** Matches read per requirement before they are reduced to files. */
const MATCHES_PER_REQUIREMENT = 10;

/** What a draft's Related code section says when it was not given recorded links. */
export type DerivedImpact =
  | {
      status: "derived";
      links: DraftCodeLink[];
      retrievalMode: RequirementRetrievalMode | null;
    }
  /** The project has no code graph: nothing to map to. */
  | { status: "no-code-graph" }
  /** Past {@link MAX_DERIVED_REQUIREMENTS} in one Generate. */
  | { status: "over-limit" }
  /** The mapping failed for this requirement. */
  | { status: "failed" };

export interface DerivedImpactFiles {
  /** Per requirement id. A requirement absent from the map was not asked for. */
  byRequirement: Map<string, DerivedImpact>;
}

export interface DeriveImpactDeps {
  prisma?: Pick<PrismaClient, "codeSymbol">;
  /** The requirement→code searcher. Defaults to the production one (#1097). */
  searcher?: HybridCodeSymbolSearcher;
}

/** The symbol's name as a draft row writes it: its qualified name without its file. */
function symbolNameOf(match: RequirementCodeMatch): string | null {
  const { qualifiedName, filePath } = match;
  if (qualifiedName === filePath) return null; // a file's own row
  const prefix = `${filePath}::`;
  return qualifiedName.startsWith(prefix) ? qualifiedName.slice(prefix.length) : qualifiedName;
}

/**
 * A requirement's matches as the files it most likely affects: one row per
 * file, its most confident symbol, most confident file first, at most
 * {@link MAX_DERIVED_FILES}.
 */
export function filesOf(matches: readonly RequirementCodeMatch[]): DraftCodeLink[] {
  const byFile = new Map<string, RequirementCodeMatch>();
  for (const m of [...matches].sort((a, b) => b.confidence - a.confidence)) {
    if (m.filePath && !byFile.has(m.filePath)) byFile.set(m.filePath, m);
  }
  return [...byFile.values()].slice(0, MAX_DERIVED_FILES).map((m) => ({
    filePath: m.filePath,
    startLine: m.startLine,
    endLine: m.endLine,
    symbolName: symbolNameOf(m),
    symbolKind: null,
  }));
}

/**
 * Map each requirement to the files it most likely affects. Never throws: a
 * failure for one requirement is recorded as `failed` for that requirement,
 * and a failure to read the code graph as `failed` for all of them.
 */
export async function deriveDraftImpactFiles(
  projectId: string,
  requirements: ReadonlyArray<{ id: string; title: string; body: string }>,
  deps: DeriveImpactDeps = {},
): Promise<DerivedImpactFiles> {
  const byRequirement = new Map<string, DerivedImpact>();
  if (requirements.length === 0) return { byRequirement };
  const prisma = deps.prisma ?? (defaultPrisma as unknown as Pick<PrismaClient, "codeSymbol">);
  // The links a person is shown on the analysis page, under the same rules.
  const searcher = (deps.searcher ?? createRequirementCodeSearcher(prisma)).withOptions(
    ANALYSIS_LINK_SEARCH_OPTIONS,
    ANALYSIS_HYBRID_LINK_SEARCH_OPTIONS,
  );

  if (!(await searcher.loadsCodeGraph(projectId))) {
    for (const r of requirements) byRequirement.set(r.id, { status: "no-code-graph" });
    return { byRequirement };
  }

  for (const [i, r] of requirements.entries()) {
    if (i >= MAX_DERIVED_REQUIREMENTS) {
      byRequirement.set(r.id, { status: "over-limit" });
      continue;
    }
    let mode: RequirementRetrievalMode | null = null;
    try {
      const matches = await mapRequirementToCode(
        { id: r.id, title: r.title, body: r.body },
        projectId,
        {
          topK: MATCHES_PER_REQUIREMENT,
          onRetrievalMode: (m) => {
            mode = m;
          },
        },
        { prisma: prisma as never, searcher },
      );
      byRequirement.set(r.id, { status: "derived", links: filesOf(matches), retrievalMode: mode });
    } catch (err) {
      // `mapRequirementToCode` itself turns a search failure into no matches;
      // anything that still escapes is this requirement's alone.
      log.warn("could not derive impact files for a requirement", {
        projectId,
        requirementId: r.id,
        error: (err as Error).message,
      });
      byRequirement.set(r.id, { status: "failed" });
    }
  }
  return { byRequirement };
}
