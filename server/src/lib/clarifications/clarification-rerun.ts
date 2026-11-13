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
 *     runs as the `prepare` step of one findings run. As #2222's re-check
 *     (`recheck.ts`), the findings are produced from the new entry in memory
 *     and the entry is stored only once they are; every pair the BA already
 *     settled keeps its settlement. #2310 — when some of the requirements'
 *     findings could not be produced, the entries of the others are still
 *     stored, matching the findings that were written. An answered
 *     requirement no applicability entry matches is re-checked under the
 *     stored requirement's own id instead (#2222's **Re-check this
 *     requirement**).
 *
 * Everything here runs after the answer is committed, off the request path,
 * and never throws: a failure is logged and the earlier results stand.
 */
import type { AIProvider } from "../ai/types.js";
import { createChildLogger } from "../logger.js";
import { prisma } from "../prisma.js";
import {
  ATTRIBUTION_THRESHOLD,
  clarificationBlockEntries,
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
import {
  recheckGoverningRequirement,
  type RecheckGoverningRequirementInput,
  type RecheckGoverningRequirementOutcome,
} from "../governing/recheck.js";
import { mapRequirementToCode } from "../traceability/requirement-code-mapping.js";
import type {
  GoverningAnalysisApplicability,
  GoverningRequirementApplicability,
} from "@metis/shared";
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
  /**
   * Every answer the analysis holds for a requirement's wording, in the
   * dialog's order. A re-decided requirement's text carries all of them, not
   * only this round's, so an answer from an earlier round is not lost.
   */
  settled?: readonly SettledRequirementAnswer[];
}

/**
 * One answer the analysis holds for a requirement's wording, whether or not it
 * changed this round: what the requirement body carries
 * (`applyClarificationsToRequirements`), so a re-decision judges the same text.
 */
export interface SettledRequirementAnswer {
  /** The question key, or `record:<id>` for an answer reused from a record. */
  key: string;
  question: string;
  answer: string;
  requirementIds: readonly string[];
}

/**
 * The answers requirement `requirementId`'s text carries: every settled answer
 * for it, in order, with each changed record in place of the earlier version
 * of the same question (matched by question key or record id); a changed
 * record not among them is appended.
 */
export function answersForRequirement(
  requirementId: string,
  settled: readonly SettledRequirementAnswer[],
  changed: readonly StoredClarification[],
): Array<{ key: string; question: string; answer: string }> {
  const out = settled
    .filter((a) => a.requirementIds.includes(requirementId))
    .map(({ key, question, answer }) => ({ key, question, answer }));
  for (const r of changed) {
    if (r.ambiguityField === null || !r.requirementIds.includes(requirementId)) continue;
    const next = { key: r.questionKey, question: r.question, answer: r.answer };
    const at = out.findIndex((a) => a.key === r.questionKey || a.key === `record:${r.id}`);
    if (at === -1) out.push(next);
    else out[at] = next;
  }
  return out;
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
  /** #2310 — #2222's re-check, for a requirement no applicability entry matches. */
  recheck?: (
    input: RecheckGoverningRequirementInput,
  ) => Promise<RecheckGoverningRequirementOutcome>;
}

/** What one re-run did, for the log and the tests. */
export interface ClarificationRerunResult {
  /** Stored requirements mapped to code again. */
  codeMapped: number;
  /** Requirements whose governing applicability and findings were re-run. */
  governingRequirements: string[];
  /** Answered requirements no applicability entry could be found for. */
  governingUnmatched: string[];
  /**
   * #2310 — the stored requirements carrying an unmatched requirement's
   * answers that were re-checked under their own id (#2222).
   */
  governingRechecked: string[];
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

/** A stored requirement of the analysis and the changed answers its body carries. */
interface CarryingRow {
  row: { id: string; title: string; body: string };
  records: StoredClarification[];
}

/**
 * The stored requirements that carry the changed answers. They are the rows
 * `applyClarificationsToRequirements` wrote those answers into: rows of this
 * analysis, in this project, live, whose clarifications block holds one of
 * the answers under its own question, both as written there. #2310 — only
 * the block is read, and the question must match as well as the answer: a
 * short answer ("Yes", "8") is in unrelated rows' text, and in their blocks.
 */
async function rowsCarrying(input: ClarificationRerunInput): Promise<CarryingRow[]> {
  const written = input.records
    .filter((r) => r.ambiguityField !== null)
    .map((r) => ({
      record: r,
      question: sanitizeClarificationText(r.question),
      answer: sanitizeClarificationText(r.answer),
    }))
    .filter((w) => w.answer.length > 0);
  if (written.length === 0) return [];
  const rows = await prisma.requirement.findMany({
    where: {
      analysisId: input.analysisId,
      projectId: input.projectId,
      deletedAt: null,
      body: { contains: "metis:clarifications:start" },
    },
    select: { id: true, title: true, body: true },
  });
  const out: CarryingRow[] = [];
  for (const row of rows) {
    const entries = clarificationBlockEntries(row.body);
    const records = written
      .filter((w) => entries.some((e) => e.answer === w.answer && e.question === w.question))
      .map((w) => w.record);
    if (records.length > 0) out.push({ row, records });
  }
  return out;
}

/** Map the rows carrying the changed answers to code again; returns how many were. */
async function remapCode(
  input: ClarificationRerunInput,
  carrying: readonly CarryingRow[],
  mapToCode: NonNullable<ClarificationRerunDeps["mapToCode"]>,
): Promise<number> {
  let mapped = 0;
  for (const { row } of carrying) {
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

/**
 * #2310 — an answered requirement no applicability entry matches is
 * re-checked as #2222's **Re-check this requirement** does: each stored
 * requirement carrying its answers is judged on its current wording, under
 * its own id and version, so the analysis's older result no longer stands
 * for it. Attributed to the person who answered; a row no one can be named
 * for is logged and left.
 */
async function recheckUnmatched(
  input: ClarificationRerunInput,
  carrying: readonly CarryingRow[],
  recheck: NonNullable<ClarificationRerunDeps["recheck"]>,
  result: ClarificationRerunResult,
): Promise<void> {
  const unmatched = new Set(result.governingUnmatched);
  for (const { row, records } of carrying) {
    const theirs = records.filter((r) => r.requirementIds.some((id) => unmatched.has(id)));
    if (theirs.length === 0) continue;
    const actorId = theirs.find((r) => r.answeredById)?.answeredById;
    if (!actorId) {
      log.info("an unmatched clarified requirement was not re-checked: no one answered it", {
        analysisId: input.analysisId,
        requirementId: row.id,
      });
      continue;
    }
    try {
      const outcome = await recheck({
        analysisId: input.analysisId,
        projectId: input.projectId,
        requirementId: row.id,
        provider: input.provider,
        ...(input.model ? { model: input.model } : {}),
        actorId,
      });
      if (outcome.ok) {
        result.governingRechecked.push(row.id);
        continue;
      }
      log.warn("an unmatched clarified requirement could not be re-checked", {
        analysisId: input.analysisId,
        requirementId: row.id,
        reason: outcome.reason,
      });
    } catch (err) {
      log.warn("an unmatched clarified requirement could not be re-checked", {
        analysisId: input.analysisId,
        requirementId: row.id,
        error: (err as Error).message,
      });
    }
  }
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
    governingRechecked: [],
  };
  const byRequirement = answersByRequirement(input.records);
  if (byRequirement.size === 0) return result;

  const mapToCode =
    deps.mapToCode ?? ((row, projectId) => mapRequirementToCode(row, projectId, { persist: true }));
  let carrying: CarryingRow[] = [];
  try {
    carrying = await rowsCarrying(input);
    result.codeMapped = await remapCode(input, carrying, mapToCode);
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
  if (result.governingUnmatched.length > 0) {
    await recheckUnmatched(input, carrying, deps.recheck ?? recheckGoverningRequirement, result);
  }
  log.info("re-ran what a clarification answer changes", {
    analysisId: input.analysisId,
    codeMapped: result.codeMapped,
    governing: result.governingRequirements.length,
    governingUnmatched: result.governingUnmatched.length,
    governingRechecked: result.governingRechecked.length,
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
  // Applicability entry id → every answer its requirement now carries: the
  // settled ones from earlier rounds as well as this round's.
  const targets = new Map<string, Array<{ key: string; question: string; answer: string }>>();
  for (const id of byRequirement.keys()) {
    const entry = applicabilityEntryFor(stored, { id, title: titles.get(id) });
    if (!entry) {
      result.governingUnmatched.push(id);
      continue;
    }
    const answers = targets.get(entry) ?? [];
    for (const a of answersForRequirement(id, input.settled ?? [], input.records)) {
      if (!answers.some((b) => b.key === a.key)) answers.push(a);
    }
    targets.set(entry, answers);
  }
  if (targets.size === 0) return;

  const requirementIds = [...targets.keys()];
  const produce = deps.produceFindings ?? produceGoverningFindingsForAnalysis;
  // The re-decided entries, in memory until the findings made from them are stored.
  let decided: GoverningRequirementApplicability[] = [];
  let committed = false;
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
      const fresh = await Promise.all(
        requirementIds.map(async (requirementId) => {
          const entry = current.requirements.find((r) => r.requirementId === requirementId);
          const text = clarifiedRequirementText(entry?.text ?? "", targets.get(requirementId)!);
          const set = await hook.decide({ id: requirementId, text });
          if (set.error) {
            // As #2222's re-check: an entry that could not be decided stores
            // nothing, and the earlier entry and findings stand.
            log.warn("governing applicability could not be re-decided after a clarification", {
              analysisId: input.analysisId,
              requirementId,
              error: set.error,
            });
            return null;
          }
          const next = toStoredApplicability([{ requirementId, text, chunks: [], governing: set }])
            .requirements[0]!;
          // The BA's governing answers on this requirement's pairs stand.
          return withSettlementsFrom(next, entry);
        }),
      );
      decided = fresh.filter((e): e is GoverningRequirementApplicability => e !== null);
      return { decidedAt: new Date().toISOString(), requirements: decided };
    },
    // #2222's order: the entries are stored only once their findings are, so
    // a failed evaluation leaves no stored applicability that no findings match.
    afterProduce: async (run) => {
      // #2310 — the entries of the requirements whose findings were written
      // are stored, so those findings never sit over their pre-answer entry
      // (which the next findings run would revert them to). A requirement
      // whose evaluation failed keeps its earlier entry and findings, as
      // #2222's all-or-nothing re-check does for its one requirement.
      if (run.failed > 0) {
        log.warn("governing findings could not be re-produced after a clarification", {
          analysisId: input.analysisId,
          failed: run.failed,
        });
        const failed = new Set(run.failedRequirementIds ?? []);
        // A failure the run did not name cannot be placed: store nothing.
        decided = run.failedRequirementIds
          ? decided.filter((d) => !failed.has(d.requirementId))
          : [];
      }
      if (decided.length === 0) return;
      const byId = new Map(decided.map((d) => [d.requirementId, d]));
      await updateGoverningApplicabilityMetadata(input.analysisId, (raw) => {
        const now = raw as GoverningAnalysisApplicability | undefined;
        if (!now?.requirements) return undefined;
        return {
          ...now,
          requirements: now.requirements.map((r) => {
            const next = byId.get(r.requirementId);
            // Carried again from what is stored now, so nothing settled since
            // the decision is lost.
            return next ? withSettlementsFrom(next, r) : r;
          }),
        };
      });
      committed = true;
    },
  });
  if (committed) result.governingRequirements = decided.map((d) => d.requirementId);
}

/**
 * `fresh` with every decision the BA settled on `previous` carried across
 * whole (#1873/#2059/#2068): a settled pair keeps the verdict, reason and
 * answers the BA's answer gave it, so the findings re-run reads them
 * (`findingPairsOf`) and the pair is not asked again. A settled rule the new
 * decision no longer names is kept too.
 */
export function withSettlementsFrom(
  fresh: GoverningRequirementApplicability,
  previous: GoverningRequirementApplicability | undefined,
): GoverningRequirementApplicability {
  const settled = (previous?.decisions ?? []).filter((d) => d.settled);
  if (settled.length === 0) return fresh;
  const byRule = new Map(settled.map((d) => [d.ruleId, d]));
  const decisions = fresh.decisions.map((d) => byRule.get(d.ruleId) ?? d);
  for (const d of settled) {
    if (!fresh.decisions.some((f) => f.ruleId === d.ruleId)) decisions.push(d);
  }
  return { ...fresh, decisions };
}
