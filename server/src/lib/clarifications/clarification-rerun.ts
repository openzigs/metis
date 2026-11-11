/**
 * Issue #2236 — an answer re-runs what it changes.
 *
 * When a clarification answer is new or changed, for the requirements it
 * applies to:
 *
 *   - **extraction** — already done by the dialog's resolution call, which
 *     rewrites each answered requirement's description, and by
 *     `applyClarificationsToRequirements`, which writes the answers into the
 *     stored requirement's body;
 *   - **code mapping** — each stored requirement the answers were written into
 *     is mapped to code again (`mapRequirementToCode`, persisted), so its
 *     semantic links follow the clarified wording;
 *   - **impact** — governing-rule applicability is decided again on the
 *     requirement's text with the answers, and its governing findings are
 *     produced again. The old findings are marked as being re-checked (the
 *     findings response's `refreshing`, shown on the analysis view) from the
 *     moment the answer is in until the new ones are stored: the re-decision
 *     runs as the `prepare` step of one findings run.
 *
 * Everything here runs after the answer is committed, off the request path,
 * and never throws: a failure is logged and the earlier results stand.
 */
import type { AIProvider } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import {
  ATTRIBUTION_THRESHOLD,
  containmentScore,
  sanitizeClarificationText,
  significantTokens,
} from "../analysis/clarification-enrichment.js";
import { getStructuredRequirements } from "../analysis/analysis-service.js";
import {
  toStoredApplicability,
  readGoverningApplicability,
} from "../governing/applicability-store.js";
import { updateGoverningApplicabilityMetadata } from "../analysis/analysis-service.js";
import {
  governingApplicabilityHookFor,
  type GoverningApplicabilityHook,
} from "../governing/applicability.js";
import { produceGoverningFindingsForAnalysis } from "../governing/findings-store.js";
import { mapRequirementToCode } from "../traceability/requirement-code-mapping.js";
import type { GoverningAnalysisApplicability } from "@metis/shared";
import type { StoredClarification } from "./clarification-records.js";

const log = createChildLogger("clarification-rerun");

/** The line between a requirement's own text and the answers appended to it. */
export const CLARIFIED_TEXT_MARKER = "\n\nClarified by the analyst:";

/** `text` without answers appended by an earlier re-run. */
export function baseRequirementText(text: string): string {
  const at = text.indexOf(CLARIFIED_TEXT_MARKER);
  return at === -1 ? text : text.slice(0, at);
}

/** A requirement's text with `answers` appended, replacing any appended before. */
export function clarifiedRequirementText(
  text: string,
  answers: ReadonlyArray<Pick<StoredClarification, "question" | "answer">>,
): string {
  const base = baseRequirementText(text);
  if (answers.length === 0) return base;
  const lines = answers.map(
    (a) =>
      `- Q: ${a.question.replace(/\s+/g, " ").trim()}\n  A: ${a.answer.replace(/\s+/g, " ").trim()}`,
  );
  return `${base}${CLARIFIED_TEXT_MARKER}\n${lines.join("\n")}`;
}

/**
 * The stored applicability entries the requirement `id` (titled `title`) was
 * decided as: the entry with its id, else the one entry whose text holds most
 * of the title's words (at least {@link ATTRIBUTION_THRESHOLD}). Applicability
 * is decided over the code agent's requirement list, whose ids need not be the
 * dialog's, so the title is the join; a tie matches nothing (a missed re-run
 * is logged, a wrong one would re-judge an unrelated requirement).
 */
export function applicabilityEntryFor(
  stored: GoverningAnalysisApplicability,
  requirement: { id: string; title: string | undefined },
): string | null {
  if (stored.requirements.some((r) => r.requirementId === requirement.id)) return requirement.id;
  if (!requirement.title) return null;
  const needle = significantTokens(requirement.title);
  let best: { id: string; score: number } | null = null;
  let tied = false;
  for (const r of stored.requirements) {
    const score = containmentScore(needle, significantTokens(baseRequirementText(r.text)));
    if (score < ATTRIBUTION_THRESHOLD) continue;
    if (!best || score > best.score) {
      best = { id: r.requirementId, score };
      tied = false;
    } else if (score === best.score) {
      tied = true;
    }
  }
  return best && !tied ? best.id : null;
}

export interface ClarificationRerunInput {
  analysisId: string;
  projectId: string;
  provider: AIProvider;
  model?: string;
  /** The records whose answer is new or changed. */
  records: readonly StoredClarification[];
}

export interface ClarificationRerunDeps {
  mapToCode?: (
    requirement: { id: string; title: string; body: string },
    projectId: string,
  ) => Promise<unknown>;
  applicabilityHookFor?: (input: {
    projectId: string;
    provider: AIProvider;
    model?: string;
  }) => Promise<Pick<GoverningApplicabilityHook, "decide"> | null>;
  produceFindings?: typeof produceGoverningFindingsForAnalysis;
}

/** What one re-run did, for the log and the tests. */
export interface ClarificationRerunResult {
  /** Stored requirements mapped to code again. */
  codeMapped: number;
  /** Requirements whose governing applicability and findings were re-run. */
  governingRequirements: string[];
  /** Answered requirements no applicability entry could be found for. */
  governingUnmatched: string[];
}

/** The ambiguity answers among `records`, by the requirement id they apply to. */
function answersByRequirement(
  records: readonly StoredClarification[],
): Map<string, StoredClarification[]> {
  const out = new Map<string, StoredClarification[]>();
  for (const r of records) {
    // A governing answer settles its rules through the dialog's own settle,
    // which refreshes those findings; it does not change the requirement's text.
    if (r.ambiguityField === null) continue;
    for (const id of r.requirementIds) out.set(id, [...(out.get(id) ?? []), r]);
  }
  return out;
}

/**
 * Map the analysis's stored requirements that carry the changed answers to
 * code again. They are the rows `applyClarificationsToRequirements` wrote
 * those answers into: rows of this analysis, in this project, live, whose
 * clarifications block holds one of the answers as it was written there.
 */
async function remapCode(
  input: ClarificationRerunInput,
  mapToCode: NonNullable<ClarificationRerunDeps["mapToCode"]>,
): Promise<number> {
  const rows = await prisma.requirement.findMany({
    where: {
      analysisId: input.analysisId,
      projectId: input.projectId,
      deletedAt: null,
      body: { contains: "metis:clarifications:start" },
    },
    select: { id: true, title: true, body: true },
  });
  const written = input.records
    .filter((r) => r.ambiguityField !== null)
    .map((r) => sanitizeClarificationText(r.answer))
    .filter((a) => a.length > 0);
  let mapped = 0;
  for (const row of rows.filter((r) => written.some((a) => r.body.includes(a)))) {
    try {
      await mapToCode(row, input.projectId);
      mapped++;
    } catch (err) {
      log.warn("a clarified requirement could not be mapped to code again", {
        analysisId: input.analysisId,
        requirementId: row.id,
        error: (err as Error).message,
      });
    }
  }
  return mapped;
}

/** Re-run code mapping and governing impact for the requirements `records` apply to. */
export async function rerunAfterClarification(
  input: ClarificationRerunInput,
  deps: ClarificationRerunDeps = {},
): Promise<ClarificationRerunResult> {
  const result: ClarificationRerunResult = {
    codeMapped: 0,
    governingRequirements: [],
    governingUnmatched: [],
  };
  const byRequirement = answersByRequirement(input.records);
  if (byRequirement.size === 0) return result;

  const mapToCode =
    deps.mapToCode ?? ((row, projectId) => mapRequirementToCode(row, projectId, { persist: true }));
  try {
    result.codeMapped = await remapCode(input, mapToCode);
  } catch (err) {
    log.warn("clarified requirements could not be mapped to code again", {
      analysisId: input.analysisId,
      error: (err as Error).message,
    });
  }

  try {
    await rerunGoverning(input, byRequirement, deps, result);
  } catch (err) {
    log.warn("governing impact could not be re-run after a clarification", {
      analysisId: input.analysisId,
      error: (err as Error).message,
    });
  }
  log.info("re-ran what a clarification answer changes", {
    analysisId: input.analysisId,
    codeMapped: result.codeMapped,
    governing: result.governingRequirements.length,
    governingUnmatched: result.governingUnmatched.length,
  });
  return result;
}

async function rerunGoverning(
  input: ClarificationRerunInput,
  byRequirement: Map<string, StoredClarification[]>,
  deps: ClarificationRerunDeps,
  result: ClarificationRerunResult,
): Promise<void> {
  const stored = await readGoverningApplicability(input.analysisId);
  if (!stored) return;
  const hookFor = deps.applicabilityHookFor ?? governingApplicabilityHookFor;
  const hook = await hookFor({
    projectId: input.projectId,
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
  });
  if (!hook) return;

  const titles = new Map(
    ((await getStructuredRequirements(input.analysisId))?.requirements ?? []).map((r) => [
      r.id,
      r.title,
    ]),
  );
  // Applicability entry id → every answer that applies to it.
  const targets = new Map<string, StoredClarification[]>();
  for (const [id, answers] of byRequirement) {
    const entry = applicabilityEntryFor(stored, { id, title: titles.get(id) });
    if (!entry) {
      result.governingUnmatched.push(id);
      continue;
    }
    targets.set(entry, [...(targets.get(entry) ?? []), ...answers]);
  }
  if (targets.size === 0) return;

  const requirementIds = [...targets.keys()];
  const produce = deps.produceFindings ?? produceGoverningFindingsForAnalysis;
  await produce({
    analysisId: input.analysisId,
    projectId: input.projectId,
    provider: input.provider,
    ...(input.model ? { model: input.model } : {}),
    requirementIds,
    // Decided in the findings run's own turn, so `refreshing` marks the old
    // findings from now until the new ones are stored.
    prepare: async () => {
      const current = (await readGoverningApplicability(input.analysisId)) ?? stored;
      const decided = await Promise.all(
        requirementIds.map(async (requirementId) => {
          const entry = current.requirements.find((r) => r.requirementId === requirementId);
          const text = clarifiedRequirementText(entry?.text ?? "", targets.get(requirementId)!);
          const set = await hook.decide({ id: requirementId, text });
          return toStoredApplicability([{ requirementId, text, chunks: [], governing: set }])
            .requirements[0]!;
        }),
      );
      const fresh = new Map(decided.map((d) => [d.requirementId, d]));
      await updateGoverningApplicabilityMetadata(input.analysisId, (raw) => {
        const now = raw as GoverningAnalysisApplicability | undefined;
        if (!now?.requirements) return undefined;
        return {
          ...now,
          requirements: now.requirements.map((r) => fresh.get(r.requirementId) ?? r),
        };
      });
    },
  });
  result.governingRequirements = requirementIds;
}
