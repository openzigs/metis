/**
 * #1759 (epic #1751) — the Analysis code agent's citations LEAD the files to edit.
 *
 * "Evaluate new requirements" already localizes a requirement with a model: its
 * agentic code pass investigates the code with tools and cites files and lines,
 * and `seedRequirementCodeLinksFromFindings` stores every citation whose file is
 * in the code graph as a `RequirementCodeMapping` row with source
 * {@link ANALYSIS_GROUNDING_SOURCE}. #1755 measured those citations as impact
 * seeds (arm A3A, the citations alone, 2026-11-05): Recall@5 +0.31 over the
 * hybrid seeding pooled on 29 held-out items on `claude-sonnet-5-5`
 * (p < 0.001), and +0.29 on `deepseek-flash`. Appended after the hybrid picks
 * (A3, the #1754 stored-link channel) they cannot move Recall@5 at all.
 *
 * So this stage, behind `IMPACT_AGENT_SEEDS` (off by default), REUSES the
 * stored citations — no model call, no agent loop, nothing that can miss the
 * 60-second impact deadline — and puts their files at the HEAD of the edit
 * candidates:
 *
 *   - the first {@link MAX_AGENT_LEAD_FILES} distinct cited files, in citation
 *     order (the order the links were stored), lead; any further cited file
 *     follows the existing candidates, as the #1754 channel would add it;
 *   - every existing edit candidate stays one, as the SAME object with the SAME
 *     score (the #931 rule): a candidate the agent also cited moves up, the
 *     rest keep their relative order after the lead;
 *   - a cited file the code graph no longer holds is dropped and counted, so
 *     every agent-named file in the output resolves to the graph;
 *   - links are read for the requirement AND the project, never by id alone.
 *
 * It applies only to a change about a tracked requirement (a `requirementId`):
 * a pasted request has no stored citations, and is seeded exactly as before.
 *
 * OWASP LLM01: the citations were written by a model that read untrusted code,
 * so nothing here trusts them beyond a path. A path counts only when the
 * project's own code graph holds it; the symbols seeded are the graph's rows,
 * never the citation's text; and the model's text never reaches a prompt here.
 *
 * Never throws: a lookup fault keeps the seeds as they were.
 */
import type { PrismaClient } from "@prisma/client";
import type { ImpactSeedChannel, ImpactSeedEvidence } from "@metis/shared";
import { getConfigService } from "../config/config-service.js";
import { createChildLogger } from "../logger.js";
import { ANALYSIS_GROUNDING_SOURCE } from "../traceability/seed-code-links-from-findings.js";
import type { RequirementCodeMatch } from "../traceability/requirement-code-mapping.js";
import {
  MAX_EDIT_FILES,
  linkSymbols,
  prismaFileSymbolLoader,
  type ChangeSeeds,
  type StoredLinkDeps,
  type StoredLinkRow,
} from "./change-seeds.js";

const log = createChildLogger("impact-agent-seeder");

/** The env/runtime flag for this stage. Off by default (#1759). */
export const AGENT_SEEDS_FLAG = "IMPACT_AGENT_SEEDS";

/** #1759 — whether the code agent's citations lead the files to edit. */
export function impactAgentSeedsEnabled(): boolean {
  return getConfigService().getBool(AGENT_SEEDS_FLAG, false);
}

/** Distinct cited files that lead the files to edit, at most: the edit-file cut. */
export const MAX_AGENT_LEAD_FILES = MAX_EDIT_FILES;

export interface AgentCitationDeps {
  /**
   * The code agent's stored citations for a requirement IN ONE PROJECT
   * (filtered on both columns), in the order they were stored.
   */
  loadCitations: (requirementId: string, projectId: string) => Promise<StoredLinkRow[]>;
  /** The project's code-graph symbols in the given files: none for a file the graph lost. */
  loadFileSymbols: StoredLinkDeps["loadFileSymbols"];
}

/** The production lookups: the agent's links only, project-scoped, in stored order. */
export function prismaAgentCitationDeps(
  prisma: Pick<PrismaClient, "codeSymbol" | "requirementCodeMapping">,
): AgentCitationDeps {
  return {
    loadCitations: (requirementId, projectId) =>
      prisma.requirementCodeMapping.findMany({
        where: { requirementId, projectId, source: ANALYSIS_GROUNDING_SOURCE },
        select: {
          codeSymbolId: true,
          filePath: true,
          startLine: true,
          endLine: true,
          confidence: true,
          source: true,
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      }),
    loadFileSymbols: prismaFileSymbolLoader(prisma),
  };
}

/**
 * Put the requirement's agent-cited files at the head of `seeds.editCandidates`.
 * Returns `seeds` with `evidence.agentCitations` set (and every edit file's
 * channels, in the new order). On a lookup fault, returns the seeds unchanged
 * with nothing counted.
 */
export async function leadWithAgentCitations(
  seeds: ChangeSeeds,
  requirementId: string,
  projectId: string,
  deps: AgentCitationDeps,
): Promise<ChangeSeeds> {
  let links: StoredLinkRow[];
  let fileRows: Awaited<ReturnType<AgentCitationDeps["loadFileSymbols"]>>;
  try {
    links = await deps.loadCitations(requirementId, projectId);
    fileRows =
      links.length === 0
        ? []
        : await deps.loadFileSymbols([...new Set(links.map((l) => l.filePath))], projectId);
  } catch (err) {
    log.warn("agent citation lookup failed; seeds kept", { projectId, error: String(err) });
    return {
      ...seeds,
      evidence: withAgentCounts(seeds, { used: 0, stale: 0, led: 0 }),
    };
  }
  const byFile = new Map<string, typeof fileRows>();
  for (const r of fileRows) byFile.set(r.filePath, [...(byFile.get(r.filePath) ?? []), r]);

  // The cited files the graph holds, in first-cited order, with their links.
  const cited = new Map<string, StoredLinkRow[]>();
  let used = 0;
  let stale = 0;
  for (const link of links) {
    if ((byFile.get(link.filePath) ?? []).length === 0) {
      stale++;
      continue;
    }
    used++;
    cited.set(link.filePath, [...(cited.get(link.filePath) ?? []), link]);
  }
  if (cited.size === 0) {
    return { ...seeds, evidence: withAgentCounts(seeds, { used, stale, led: 0 }) };
  }

  const existingBy = new Map<string, RequirementCodeMatch[]>();
  for (const m of seeds.editCandidates) {
    existingBy.set(m.filePath, [...(existingBy.get(m.filePath) ?? []), m]);
  }
  const taken = new Set(seeds.editCandidates.map((m) => m.codeSymbolId));
  /** A cited file's matches: the existing candidates (same objects), else the graph's symbols. */
  const matchesOf = (filePath: string): RequirementCodeMatch[] => {
    const own = existingBy.get(filePath);
    if (own) return own;
    const out: RequirementCodeMatch[] = [];
    for (const link of cited.get(filePath)!) {
      for (const row of linkSymbols(link, byFile.get(filePath)!)) {
        if (taken.has(row.id)) continue;
        taken.add(row.id);
        out.push({
          codeSymbolId: row.id,
          filePath: row.filePath,
          qualifiedName: row.qualifiedName,
          startLine: row.startLine,
          endLine: row.endLine,
          confidence: Math.min(1, Math.max(0, link.confidence)),
        });
      }
    }
    return out;
  };

  const citedFiles = [...cited.keys()];
  const lead = citedFiles.slice(0, MAX_AGENT_LEAD_FILES);
  const leadSet = new Set(lead);
  const tail = citedFiles.slice(MAX_AGENT_LEAD_FILES).filter((f) => !existingBy.has(f));
  const rest = seeds.editCandidates.filter((m) => !leadSet.has(m.filePath));
  const editCandidates = [...lead.flatMap(matchesOf), ...rest, ...tail.flatMap(matchesOf)];

  const prior = new Map((seeds.evidence?.editCandidates ?? []).map((e) => [e.filePath, e]));
  const citedSet = new Set(citedFiles);
  const editFiles = [...new Set(editCandidates.map((m) => m.filePath))];
  return {
    ...seeds,
    editCandidates,
    evidence: {
      ...withAgentCounts(seeds, { used, stale, led: lead.length }),
      editCandidates: editFiles.map((filePath) => {
        const before = prior.get(filePath);
        const base: ImpactSeedChannel[] =
          before?.channels ?? (existingBy.has(filePath) ? ["hybrid"] : []);
        return {
          ...before,
          filePath,
          channels: citedSet.has(filePath) ? [...base, "code-agent" as const] : base,
        };
      }),
    },
  };
}

/** The seeds' evidence with the agent counts set, and every edit file's channels. */
function withAgentCounts(
  seeds: ChangeSeeds,
  agentCitations: NonNullable<ImpactSeedEvidence["agentCitations"]>,
): ImpactSeedEvidence {
  return {
    ...seeds.evidence,
    agentCitations,
    editCandidates:
      seeds.evidence?.editCandidates ??
      [...new Set(seeds.editCandidates.map((m) => m.filePath))].map((filePath) => ({
        filePath,
        channels: ["hybrid" as const],
      })),
  };
}
