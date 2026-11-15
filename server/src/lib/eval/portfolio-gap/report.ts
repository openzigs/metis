/**
 * #1766 — the Markdown report of a portfolio gap-verdict run. Pure: every
 * number is computed by `scorer.ts`; this only lays them out.
 */
import { minimumDetectableGapStatement } from "../localization/stats.js";
import {
  PREDICTED_VERDICTS,
  type ArmComparison,
  type ArmSummary,
  type PredictedVerdict,
  type GapTruth,
  type Rate,
  type ScoredOutcome,
} from "./scorer.js";
import type { GapArm } from "./plan.js";

export interface GapReportArm {
  arm: GapArm;
  model: string;
  configuration: Record<string, string | number | boolean>;
  summary: ArmSummary;
  scored: readonly ScoredOutcome[];
}

export interface GapReportInput {
  corpus: string;
  repos: readonly { name: string; sha: string }[];
  /** How the corpus is set up as a portfolio. */
  setup: string;
  runsRequested: number;
  budgetUsd: number;
  generatedAt: string;
  items: readonly Pick<GapTruth, "id" | "expectedVerdict">[];
  arms: readonly GapReportArm[];
  comparisons: readonly ArmComparison[];
  /** Arms the issue names that this run could not measure, with why. */
  notRun: readonly string[];
  /** Problems that fail the run (uncited `implemented` claims). */
  failures: readonly string[];
}

const f2 = (x: number) => x.toFixed(2);

export function formatRate(r: Rate | null | undefined): string {
  if (!r) return "n/a";
  return `${f2(r.value)} [${f2(r.ci[0])}, ${f2(r.ci[1])}] (n=${r.n})`;
}

const SHORT: Record<PredictedVerdict, string> = {
  implemented: "I",
  partial: "P",
  gap: "G",
  "could-not-verify": "?",
};

/** One item's predictions across its runs, as `I/P/G/?` letters in run order. */
export function predictionsOf(scored: readonly ScoredOutcome[], itemId: string): string {
  const mine = scored.filter((s) => s.itemId === itemId).sort((a, b) => a.run - b.run);
  return mine.length === 0 ? "–" : mine.map((s) => SHORT[s.predicted]).join("");
}

export function renderGapReport(input: GapReportInput): string {
  const out: string[] = [];
  const arm = (a: GapReportArm) => `${a.arm.label} · ${a.model}`;
  out.push(`# Portfolio gap-verdict eval — \`${input.corpus}\``, "");
  out.push(
    `Items: **${input.items.length}** · Repos: ${input.repos
      .map((r) => `\`${r.name}@${r.sha.slice(0, 8)}\``)
      .join(
        ", ",
      )} · Runs requested: **${input.runsRequested}** · Budget: **$${input.budgetUsd}** · ` +
      `Spent: **$${input.arms.reduce((a, x) => a + x.summary.spentUsd, 0).toFixed(4)}** · ${input.generatedAt}`,
    "",
  );
  out.push(`Setup: ${input.setup}`, "");
  if (input.failures.length > 0) {
    out.push("> **FAILED.** Every arm must report zero uncited `implemented` verdicts:", "");
    for (const f of input.failures) out.push(`> - ${f}`);
    out.push("");
  }

  out.push("## Arms", "");
  for (const a of input.arms) {
    out.push(`### ${arm(a)} — ${a.arm.description}`, "");
    out.push(`Complete runs: ${a.summary.completeRuns} · outcomes: ${a.summary.outcomes}`, "");
    out.push("| Setting | Value |", "|---|---|");
    for (const [k, v] of Object.entries(a.configuration)) out.push(`| ${k} | ${String(v)} |`);
    out.push("");
  }
  if (input.notRun.length > 0) {
    out.push("Not run:", "");
    for (const n of input.notRun) out.push(`- ${n}`);
    out.push("");
  }

  out.push(
    "## Results (mean over items of each item's mean over its runs; 95% bootstrap interval)",
    "",
  );
  out.push(
    "| Arm | Verdict accuracy | Product accuracy | Answer repo's own verdict | Expected-repo recall | Uncited `implemented` | Valid citations | $ / req | s / req |",
    "|---|---|---|---|---|---|---|---|---|",
  );
  for (const a of input.arms) {
    const s = a.summary;
    out.push(
      `| ${arm(a)} | ${formatRate(s.accuracy)} | ${formatRate(s.productAccuracy)} | ` +
        `${formatRate(s.answerRepoAccuracy)} | ${formatRate(s.expectedRepoRecall)} | ` +
        `${s.uncitedImplemented} | ${s.validCitations}/${s.citations} | ` +
        `$${s.usdPerRequirement.toFixed(4)} | ${s.secondsPerRequirement.toFixed(1)} |`,
    );
  }
  out.push("");
  out.push(
    "Product accuracy reads the one product's coverage; with every repository in one product it equals the portfolio verdict. " +
      "Expected-repo recall is over `implemented` and `partial` answers: the share of answer repositories found implementing a criterion. " +
      "A citation is valid when its file exists in that repository at the pinned commit and its lines fall inside the file.",
    "",
  );

  out.push("### Accuracy by answer repository and by expected verdict", "");
  const strata = [...new Set(input.arms.flatMap((a) => Object.keys(a.summary.accuracyByStratum)))];
  out.push(
    `| Arm | ${strata.join(" | ")} | expected implemented | expected partial | expected gap |`,
    `|---|${strata.map(() => "---|").join("")}---|---|---|`,
  );
  for (const a of input.arms) {
    const s = a.summary;
    out.push(
      `| ${arm(a)} | ${strata.map((k) => formatRate(s.accuracyByStratum[k])).join(" | ")} | ` +
        `${formatRate(s.accuracyByExpected.implemented)} | ${formatRate(s.accuracyByExpected.partial)} | ` +
        `${formatRate(s.accuracyByExpected.gap)} |`,
    );
  }
  out.push("");

  out.push("### Confusion matrices (expected rows × predicted columns, every run)", "");
  for (const a of input.arms) {
    out.push(`**${arm(a)}**`, "");
    out.push(`| expected \\ predicted | ${PREDICTED_VERDICTS.join(" | ")} |`);
    out.push(`|---|${PREDICTED_VERDICTS.map(() => "---|").join("")}`);
    for (const row of ["implemented", "partial", "gap"] as const) {
      out.push(
        `| ${row} | ${PREDICTED_VERDICTS.map((c) => a.summary.confusion[row][c]).join(" | ")} |`,
      );
    }
    out.push("");
  }

  out.push("## Paired comparison", "");
  out.push(`> ${minimumDetectableGapStatement(input.items.length)}`, "");
  if (input.comparisons.length === 0) {
    out.push("No comparison: only one arm was scored.", "");
  } else {
    out.push(
      "| Arm vs baseline | Δ accuracy [95% CI] | bootstrap p | McNemar (arm only / baseline only) | McNemar p | Reading |",
      "|---|---|---|---|---|---|",
    );
    for (const c of input.comparisons) {
      const d = c.accuracy;
      out.push(
        `| ${c.arm} vs ${c.baseline} | ${d.meanDifference >= 0 ? "+" : ""}${f2(d.meanDifference)} ` +
          `[${f2(d.ci[0])}, ${f2(d.ci[1])}] | ${d.p.toFixed(3)} | ${c.mcnemar.armOnly} / ` +
          `${c.mcnemar.baselineOnly} | ${c.mcnemar.p.toFixed(3)} | ${c.reading} |`,
      );
    }
    out.push("");
  }

  out.push("## Per requirement", "");
  out.push("Predictions per run: I implemented, P partial, G gap, ? could not verify.", "");
  out.push(`| Item | Expected | ${input.arms.map(arm).join(" | ")} |`);
  out.push(`|---|---|${input.arms.map(() => "---|").join("")}`);
  for (const item of input.items) {
    out.push(
      `| ${item.id} | ${item.expectedVerdict} | ${input.arms.map((a) => predictionsOf(a.scored, item.id)).join(" | ")} |`,
    );
  }
  out.push("");
  return out.join("\n");
}
