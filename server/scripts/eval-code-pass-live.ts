/**
 * #2568 — one live "Evaluate new requirements" analysis on the materialized
 * Miniflux project, with several requirements in ONE code pass, in the mode
 * `--mode` names. The localization eval scores one requirement per pass;
 * production packs many into one, and this records that shape's wall time,
 * turns, tokens and cost for each mode.
 *
 *   pnpm eval:materialize localization-01-miniflux-heldout   # once, $0
 *   pnpm eval:code-pass-live --mode fast    --budget 1.5
 *   pnpm eval:code-pass-live --mode explore --budget 1.5
 *
 * The requirements are the first `--requirements` (default 5) of the held-out
 * items picked by `--items` (default every fifth), one paragraph each, as an
 * analyst would paste them. The run uses the real `AnalysisOrchestrator` over
 * the eval database (`eval-data/.materialized/`), through the METERED provider;
 * `--budget` stops it (every later model call is refused) once the meter has
 * recorded that many dollars. It prints the run's mode, its code passes'
 * outcomes (an escalated run has a deep and a standard pass), the meter's spend
 * and the ledger's (`token_usages`), and the wall time.
 */
import { bindMaterializedEnv } from "../src/lib/eval/localization/agent-env.js";
import { materializeLayout } from "../src/lib/eval/localization/materialize.js";

// Prisma binds its database when first imported: bind the eval one first.
bindMaterializedEnv(process.env, materializeLayout());

/* eslint-disable no-console -- a local CLI whose output is the measurement */
const CORPUS = "localization-01-miniflux-heldout";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i < 0 ? undefined : process.argv[i + 1];
}

async function main(): Promise<void> {
  const mode = arg("mode");
  if (mode !== "explore" && mode !== "fast") throw new Error("--mode explore|fast is required");
  const budgetUsd = Number(arg("budget") ?? "1.5");
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error("--budget must be > 0");
  const count = Number(arg("requirements") ?? "5");
  const step = Number(arg("items") ?? "5");
  process.env.ANALYSIS_CODE_EXPLORATION = mode;
  // The analysis monthly TOKEN cap counts every analysis in the eval database;
  // --budget holds the spend instead. An explicit setting is kept.
  process.env.ANALYSIS_MONTHLY_TOKEN_CAP ??= "0";

  const { assertEvalDatabase, readMaterializedState, EVAL_USER_EMAIL } =
    await import("../src/lib/eval/localization/materialize.js");
  const { loadLocalizationCorpus } = await import("../src/lib/eval/localization/corpus.js");
  const { LedgerCostMeter, meterProvider } = await import("../src/lib/eval/localization/cost.js");
  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const { prisma, boundDatabaseUrl } = await import("../src/lib/prisma.js");
  const { AnalysisOrchestrator } = await import("../src/lib/analysis/orchestrator.js");
  const { getAnalysisSnapshot } = await import("../src/lib/analysis/analysis-service.js");
  const { waitForAnalysis } = await import("../src/lib/eval/localization/analysis-pass.js");

  const layout = materializeLayout();
  assertEvalDatabase(boundDatabaseUrl, layout);
  const state = await readMaterializedState(CORPUS, layout);
  if (!state) throw new Error(`${CORPUS} is not materialized: run pnpm eval:materialize ${CORPUS}`);
  const repo = state.repos[0]!;
  const corpus = await loadLocalizationCorpus(CORPUS);
  const items = corpus.manifest.items.filter((_, i) => i % step === 0).slice(0, count);
  const text = items.map((it) => `${it.title}. ${it.text}`).join("\n\n");

  const meter = new LedgerCostMeter();
  const live = buildProvider({ config: loadAIConfig() });
  if (live.offline) throw new Error("a live provider is required (AI_PROVIDER and its key)");
  const metered = meterProvider(live, meter);
  // Every later call is refused once the budget is spent; the pipeline degrades.
  const provider = new Proxy(metered, {
    get(target, prop, receiver) {
      if (prop === "chat" || prop === "stream") {
        if (meter.spentUsd() >= budgetUsd || meter.unpricedCalls() > 0) {
          return () => {
            throw new Error(
              `--budget: $${meter.spentUsd().toFixed(4)} spent of $${budgetUsd} (or an unpriced call)`,
            );
          };
        }
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
  console.log(
    `${mode}: ${items.length} requirements (${items.map((i) => i.id).join(", ")}) on ${live.key}/${live.model}, budget $${budgetUsd}`,
  );

  const user = await prisma.user.findUnique({ where: { email: EVAL_USER_EMAIL } });
  if (!user)
    throw new Error(`no ${EVAL_USER_EMAIL} in the eval database: run pnpm eval:materialize`);
  const orchestrator = new AnalysisOrchestrator({ provider });
  const startedAt = new Date();
  const { id } = await orchestrator.start({
    projectId: repo.projectId,
    startedById: user.id,
    agentKeys: ["code"],
    extraInstructions: text,
  });
  // The A7 arms' wait: the row's terminal status, and the pipeline gone.
  await waitForAnalysis(id, {
    readState: (analysisId) =>
      prisma.analysis.findUnique({
        where: { id: analysisId },
        select: { status: true, errorMessage: true },
      }),
    isActive: (analysisId) => orchestrator.isActive(analysisId),
    cancel: (analysisId) => orchestrator.cancel(analysisId, user.id),
    pollMs: 2000,
  });
  const seconds = (Date.now() - startedAt.getTime()) / 1000;
  const row = await prisma.analysis.findUnique({
    where: { id },
    select: { status: true, errorMessage: true },
  });
  const snapshot = await getAnalysisSnapshot(id);
  const capability = snapshot?.capability as Record<string, unknown> | undefined;
  const ledger = await prisma.tokenUsage.findMany({
    where: { projectId: repo.projectId, createdAt: { gte: startedAt } },
    select: { costUsd: true, agentStep: true, inputTokens: true, outputTokens: true },
  });
  const requirements = await prisma.requirement.count({ where: { analysisId: id } });
  console.log(
    JSON.stringify(
      {
        analysisId: id,
        mode,
        status: row?.status,
        errorMessage: row?.errorMessage ?? null,
        requirementsPasted: items.length,
        requirementsStored: requirements,
        seconds: Math.round(seconds),
        meterUsd: Number(meter.spentUsd().toFixed(4)),
        meterCalls: meter.callCount(),
        unpricedCalls: meter.unpricedCalls(),
        ledgerUsd: Number(ledger.reduce((s, r) => s + (r.costUsd ?? 0), 0).toFixed(4)),
        ledgerRows: ledger.length,
        ledgerUnpricedRows: ledger.filter((r) => r.costUsd === null).length,
        ledgerBySteps: Object.fromEntries(
          [...new Set(ledger.map((r) => r.agentStep ?? "none"))].map((s) => [
            s,
            Number(
              ledger
                .filter((r) => (r.agentStep ?? "none") === s)
                .reduce((n, r) => n + (r.costUsd ?? 0), 0)
                .toFixed(4),
            ),
          ]),
        ),
        codePassMode: capability?.codePassMode,
        codePassModeReason: capability?.codePassModeReason,
        codePassOutcomes: capability?.codePassOutcomes,
        codePassCostCeiling: capability?.codePassCostCeiling,
        // #739 — null unless the escalation policy is on: then one pass, unsplit.
        escalation: snapshot?.escalation ?? null,
      },
      null,
      2,
    ),
  );
  await prisma.$disconnect();
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
