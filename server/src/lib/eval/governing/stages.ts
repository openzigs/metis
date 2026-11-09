/**
 * #2108 — where in the shipped path each error of a reading arose. A5 records,
 * per requirement, every candidate rule with the pass that found it, its
 * applicability verdict and its finding ({@link RuleStage}); this module reads
 * those records against the scored pairs and names the stage of each miss,
 * each extra rule and each wrong verdict. A reading then says which stage to
 * fix, instead of a person reconstructing it from the final findings.
 *
 * Nothing here is scored: the bars read the judgements alone.
 */
import type { GoverningVerdict } from "./corpus.js";
import type { PairOutcome } from "./scorer.js";

/** One candidate rule of one requirement, as the shipped path decided it. */
export interface RuleStage {
  ruleId: string;
  /** The passes that made it a candidate: the top-k search, the summary screen, or both. */
  foundBy: ("top-k" | "screen")[];
  applicability: "applies" | "does-not-apply" | "uncertain";
  /** The finding's status; absent when the rule did not apply or the findings call gave none. */
  finding?: GoverningVerdict;
}

/** What went wrong with one (requirement, rule) pair. */
export type StageErrorKind = "missed" | "extra" | "wrong-verdict";

/**
 * The stage an error arose in:
 *   - `not-a-candidate`: neither the top-k search nor the screen found the rule;
 *   - `judged-does-not-apply`: a candidate the applicability judge ruled out;
 *   - `applicability-applies` / `applicability-uncertain`: an extra rule the
 *     judge brought in, or (uncertain) a wrong verdict that is applicability's
 *     Needs BA input, given without a findings call;
 *   - `findings-call`: the findings call gave the wrong status, or none.
 */
export const STAGES = [
  "not-a-candidate",
  "judged-does-not-apply",
  "applicability-applies",
  "applicability-uncertain",
  "findings-call",
] as const;
export type Stage = (typeof STAGES)[number];

export interface StageError {
  ruleId: string;
  kind: StageErrorKind;
  stage: Stage;
  truth: GoverningVerdict | null;
  verdict: GoverningVerdict | null;
}

/** Each error of one record, with its stage; correct pairs are left out. */
export function stageErrors(
  pairs: readonly Pick<PairOutcome, "ruleId" | "truth" | "verdict">[],
  stages: readonly RuleStage[],
): StageError[] {
  const byRule = new Map(stages.map((s) => [s.ruleId, s]));
  const out: StageError[] = [];
  for (const p of pairs) {
    if (p.truth !== null && p.verdict === p.truth) continue;
    const s = byRule.get(p.ruleId);
    const at = { ruleId: p.ruleId, truth: p.truth, verdict: p.verdict };
    if (p.truth === null) {
      // An extra rule always passed applicability: only those reach a finding.
      const stage =
        s?.applicability === "uncertain" ? "applicability-uncertain" : "applicability-applies";
      out.push({ ...at, kind: "extra", stage });
    } else if (p.verdict === null) {
      const stage: Stage = !s
        ? "not-a-candidate"
        : s.applicability === "does-not-apply"
          ? "judged-does-not-apply"
          : "findings-call";
      out.push({ ...at, kind: "missed", stage });
    } else {
      const stage = s?.applicability === "uncertain" ? "applicability-uncertain" : "findings-call";
      out.push({ ...at, kind: "wrong-verdict", stage });
    }
  }
  return out;
}

interface StagedRecord {
  itemId: string;
  run: number;
  pairs: readonly Pick<PairOutcome, "ruleId" | "truth" | "verdict">[];
  stages?: readonly RuleStage[];
}

interface StagedArm {
  id: string;
  completedRuns: number;
  records: readonly StagedRecord[];
}

const KINDS: readonly StageErrorKind[] = ["missed", "extra", "wrong-verdict"];

/**
 * The report's "Where each error arose" section: per arm that records stages,
 * a count of errors by kind and stage over the scored runs, then each pair
 * with its stage and the number of runs it happened in. Nothing when no arm
 * records stages.
 */
export function stageSection(report: { arms: readonly StagedArm[] }): string[] {
  const arms = report.arms.filter((a) => a.records.some((r) => r.stages !== undefined));
  if (arms.length === 0) return [];
  const lines = ["## Where each error arose (#2108)", ""];
  lines.push(
    "Each miss, extra rule and wrong verdict of the scored runs, by the stage of the shipped path it arose in: " +
      "`not-a-candidate` (neither the top-k search nor the screen found the rule), " +
      "`judged-does-not-apply` (the applicability judge ruled a candidate out), " +
      "`applicability-applies` / `applicability-uncertain` (the judge brought an extra rule in, or left a rule " +
      "uncertain, which is Needs BA input without a findings call), and `findings-call` (the findings call " +
      "gave the wrong status). Whether a label itself is doubtful is a reader's call, recorded in ANNOTATION.md.",
    "",
  );
  for (const a of arms) {
    const counts = new Map<string, number>();
    const perPair = new Map<string, number>();
    for (const r of a.records) {
      if (r.run > a.completedRuns || r.stages === undefined) continue;
      for (const e of stageErrors(r.pairs, r.stages)) {
        counts.set(`${e.kind}|${e.stage}`, (counts.get(`${e.kind}|${e.stage}`) ?? 0) + 1);
        const said = e.verdict ?? "none";
        const key = `${r.itemId} → ${e.ruleId}: ${e.kind}, ${e.stage} (label ${e.truth ?? "none"}, said ${said})`;
        perPair.set(key, (perPair.get(key) ?? 0) + 1);
      }
    }
    lines.push(
      `### ${a.id}`,
      "",
      `| Kind | ${STAGES.join(" | ")} |`,
      `|---|${STAGES.map(() => "---").join("|")}|`,
    );
    for (const k of KINDS) {
      lines.push(
        `| ${k} | ${STAGES.map((s) => String(counts.get(`${k}|${s}`) ?? 0)).join(" | ")} |`,
      );
    }
    lines.push("");
    if (perPair.size === 0) {
      lines.push("No error in any scored run.", "");
      continue;
    }
    lines.push(
      ...[...perPair]
        .sort(([x], [y]) => x.localeCompare(y))
        .map(([k, n]) => `- ${k}: ${n} of ${a.completedRuns} run(s)`),
      "",
    );
  }
  return lines;
}
