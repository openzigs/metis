/**
 * Epic #1107 / Issue #1108 — `pnpm eval:verification` entrypoint.
 *
 * Scores the VERIFICATION LAYER specifically — not end-to-end analysis quality —
 * over a labelled corpus of findings with known verdicts, and reports precision,
 * recall and cost SEPARATELY for each verifier arm.
 *
 *   pnpm eval:verification                    # BASELINE arm only — offline, deterministic
 *   pnpm eval:verification --arm both         # baseline + #1109 panel, side by side
 *   pnpm eval:verification --runs 5           # more samples (default 3 when an LLM arm runs)
 *   pnpm eval:verification --md               # also print the Markdown report
 *   pnpm eval:verification --case VC-03       # inspect ONE case in full and exit
 *   pnpm eval:verification --no-fail          # always exit 0 (local exploration)
 *   pnpm eval:verification --arm panel --panel-flag-at medium
 *                                             # #1109: also warn on outvoted dissent
 *   pnpm eval:verification --arm both --faithfulness
 *                                             # #1318: also report the SHARED
 *                                             #        claim-level faithfulness metric
 *
 * The default run needs NO provider, NO network and NO database: the deterministic
 * arm is production's own `assertsAbsence` + `verifyFinding` fed from a committed
 * corpus, so it is byte-reproducible.
 *
 * #1109 WIRED THE PANEL ARM. It is built ONLY when actually selected, so the
 * default run still needs no credentials, and it REFUSES to run against an
 * offline provider stub: a stub answers nothing parseable, every lens degrades to
 * no signal, and the arm would quietly report the baseline's own numbers under a
 * "panel" label — the #1016 defect this harness was built to avoid.
 *
 * This file is thin orchestration; all logic lives in the unit-tested
 * `src/lib/eval/verification/*` modules.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadVerificationCorpus,
  parseVerificationCorpusName,
  resolveVerificationCorpusDir,
} from "../src/lib/eval/verification/corpus.js";
import {
  parseArmSelection,
  resolveArm,
  type PanelArmFactory,
  type VerifierArmId,
} from "../src/lib/eval/verification/arms.js";
import { panelArm, parsePanelFlagAt } from "../src/lib/eval/verification/panel-arm.js";
import {
  formatStructuredVerdictReport,
  structuredVerdictMetrics,
} from "../src/lib/analysis/structured-verdict.js";
import { buildProvider, loadAIConfig } from "../src/lib/ai/index.js";
import {
  buildReport,
  parseCaseId,
  parseRunCount,
  renderCaseDetail,
  runArmRepeated,
  toJsonReport,
  toMarkdownReport,
  type ArmRunSummary,
} from "../src/lib/eval/verification/runner.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * #1109 — build the multi-lens panel arm, but ONLY when it was actually selected:
 * `buildProvider` reads credentials, and a default `--arm deterministic` run must
 * keep working with none. Returns `undefined` otherwise, which leaves `resolveArm`
 * throwing its named error for a panel run that somehow got here without one.
 */
function panelArmFactory(argv: string[], armIds: VerifierArmId[]): PanelArmFactory | undefined {
  if (!armIds.includes("panel")) return undefined;
  const flagAt = parsePanelFlagAt(argv);
  return () => {
    const provider = buildProvider({ config: loadAIConfig() });
    if (provider.offline) {
      throw new Error(
        "the #1109 panel arm was selected but the resolved AI provider is an OFFLINE STUB. " +
          "Every lens would degrade to NO SIGNAL and the arm would report the deterministic " +
          "baseline's numbers under a 'panel' label. Set real provider credentials (e.g. " +
          "AI_PROVIDER=anthropic ANTHROPIC_API_KEY=…), or run `--arm deterministic`.",
      );
    }
    // #1318 — opt IN to the shared claim-level faithfulness metric. It is two
    // extra model round-trips per case on top of the three lens calls, so it is
    // off unless asked for: #1108's design is that a cost is measured before it
    // is defaulted on.
    return panelArm({
      provider,
      flagAt,
      metrics: structuredVerdictMetrics,
      faithfulness: argv.includes("--faithfulness"),
    });
  };
}

async function main() {
  const argv = process.argv;
  const failOnBreak = !argv.includes("--no-fail");
  const printMd = argv.includes("--md");
  const corpusName = parseVerificationCorpusName(argv);
  const armIds = parseArmSelection(argv);

  const corpus = await loadVerificationCorpus(resolveVerificationCorpusDir(corpusName));
  const factory = panelArmFactory(argv, armIds);
  const arms = armIds.map((id) => resolveArm(id, factory));
  const runCount = parseRunCount(
    argv,
    arms.some((a) => a.usesLlm),
  );

  const summaries: ArmRunSummary[] = [];
  for (const arm of arms) summaries.push(await runArmRepeated(corpus, arm, runCount));

  const caseId = parseCaseId(argv);
  if (caseId) {
    // eslint-disable-next-line no-console
    console.log(renderCaseDetail(corpus, caseId, summaries));
    return;
  }

  const report = buildReport(corpus, summaries);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `verification-${corpus.id}-${runId}.json`);
  await writeFile(resultPath, `${JSON.stringify(toJsonReport(report), null, 2)}\n`, "utf8");

  if (printMd) {
    // eslint-disable-next-line no-console
    console.log(toMarkdownReport(report));
  }

  for (const a of report.arms) {
    const q = a.summary.meanAggregate;
    const c = a.summary.meanCost;
    // eslint-disable-next-line no-console
    console.log(
      `Verification eval [${corpus.id}] — ${a.summary.armId}\n` +
        `  cases=${q.caseCount} recall=${q.recall.toFixed(4)} precision=${q.precision.toFixed(4)} ` +
        `overFlag=${q.overFlagRate.toFixed(4)} | TP=${q.truePositives} FP=${q.falsePositives} ` +
        `FN=${q.falseNegatives} TN=${q.trueNegatives}\n` +
        `  cost: ${c.totalTokens.toFixed(0)} tok (${c.tokensPerFinding.toFixed(1)}/finding), ` +
        `${c.llmCalls.toFixed(0)} model calls, ${c.wallClockMs.toFixed(0)}ms ` +
        `over ${a.summary.runCount} run(s) → ${a.thresholds ? (a.passed ? "PASS" : "FAIL") : "no floors"}`,
    );
    // #1318 — the shared claim-level metric, printed as its OWN line so it is
    // never mistaken for one of the precision/recall axes above. `n/a` when the
    // arm cannot compute it; a mean over the SCORED cases only otherwise.
    const f = a.summary.meanFaithfulness;
    // eslint-disable-next-line no-console
    console.log(
      `  faithfulness (#1318, shared with docs-gen): ${
        !f
          ? "n/a — this arm does not compute it (pass --faithfulness on an LLM arm)"
          : f.mean === null
            ? `unverifiable on all ${f.unverifiable} case(s)`
            : `${f.mean.toFixed(4)} over ${f.scored} scored case(s), ${f.unverifiable} unverifiable (excluded)`
      }`,
    );
  }
  if (report.comparison) {
    const cmp = report.comparison;
    // eslint-disable-next-line no-console
    console.log(
      `  ${cmp.candidateArm} vs ${cmp.baselineArm}: ` +
        `${cmp.beatsBaseline ? "BEATS" : "DOES NOT BEAT"} baseline ` +
        `(recall ${cmp.recallDelta >= 0 ? "+" : ""}${cmp.recallDelta.toFixed(4)}, ` +
        `precision ${cmp.precisionDelta >= 0 ? "+" : ""}${cmp.precisionDelta.toFixed(4)}, ` +
        `${cmp.tokensPerFindingDelta.toFixed(1)} tok/finding)`,
    );
  }
  if (arms.some((a) => a.usesLlm)) {
    // #1114 — the real malformation/retry rate, per lens, rather than a guess.
    // eslint-disable-next-line no-console
    console.log(formatStructuredVerdictReport(structuredVerdictMetrics));
  }
  // eslint-disable-next-line no-console
  console.log(`  report: ${resultPath}`);

  if (!report.passed) {
    const failed = report.arms.flatMap((a) => a.checks.filter((c) => !c.passed));
    // eslint-disable-next-line no-console
    console.error("Verification eval FAILED:", JSON.stringify(failed));
    if (failOnBreak) process.exit(1);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eval:verification failed:", err);
  process.exit(1);
});
