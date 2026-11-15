/**
 * #1766 — `pnpm eval:portfolio-gap`: how often portfolio gap analysis gets the
 * verdict right, on the fixture-repo set of #1753
 * (`eval-data/corpus/localization-02-fixture-portfolio`).
 *
 *   pnpm eval:materialize localization-02-fixture-portfolio     # once: clones, projects, code graph
 *   pnpm eval:portfolio-gap --budget 10                          # P0 and P0′, 3 runs each
 *   pnpm eval:portfolio-gap --budget 10 --max-outcomes 8         # a slice; re-run to resume
 *   pnpm eval:portfolio-gap --budget 10 --baseline               # rewrite the committed baseline
 *
 * Set-up. The corpus's three repositories (orders, billing, notify), each in its
 * own materialized project, get what an analyst's project holds: their source
 * files as knowledge documents (the connector's own ingest, `ingestSourceAsKnowledge`).
 * One product, "Commerce services" (the #1749 walkthrough's shape), holds all
 * three, so #1763's per-repo search (P0′) has repositories to share a search
 * between. Each item is checked the way the app checks one requirement
 * (`portfolio-assessments.ts`): its title and text as the statement, no criteria
 * (the engine decomposes them), the one product in scope, as the eval user.
 *
 * Arms (`--arms`, default `P0,P0R`): P0, the shipped engine, and P0R (P0′, #1763),
 * `perRepoSearch` on. Each passes the engine's full limits explicitly, the
 * shipped defaults with only `perRepoSearch` changed, so no `PORTFOLIO_GAP_*`
 * variable changes what is measured. #1764's agentic pass (P1) is added to
 * `plan.ts` when it lands.
 *
 * The model is the configured provider's (`AI_PROVIDER`, `AI_MODEL`); every call
 * is metered at the usage ledger's price (`LedgerCostMeter`). `--budget` (USD) caps
 * the spend of every outcome recorded for that model, across resumed invocations:
 * the run stops before an item once the costliest item so far would cross it,
 * and on any unpriced call. An item stopped by an unpriced call records no
 * outcome (it stays pending) but a `kind: "spend"` line with its priced spend,
 * so a resumed slice still counts that money against the cap.
 *
 * `--max-outcomes N` caps the work units run this invocation: one unit is one
 * item x arm x run, so `--max-outcomes 8` may be eight items of P0's run 1 and
 * nothing of P0R (work is run-major). `--items FX-01,FX-02` restricts the items;
 * `--report-only` re-renders the report from the record file with no model call,
 * so it needs no provider key.
 *
 * Records. Each outcome is appended to `eval-results/portfolio-gap/records.jsonl`
 * (`--records`) as it ends, so a run cut short resumes where it stopped. The
 * report covers every recorded outcome of the selected arms and model:
 * `eval-results/portfolio-gap/<runId>.{json,md}`, or with `--baseline` the
 * committed `gap-baseline.{json,md}` beside the corpus.
 *
 * Exit code 1 when any arm holds an uncited `implemented` verdict: the run fails.
 */
/* eslint-disable no-console -- a local CLI whose output is the report */
import "./eval-portfolio-gap-env.js";
import { execFileSync } from "node:child_process";
import { existsSync, promises as fs } from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";
import { getPermissionsForRole, type AuthPayload } from "@metis/shared";
import {
  loadLocalizationCorpus,
  localizationCorpusRoot,
} from "../src/lib/eval/localization/corpus.js";
import {
  assertEvalDatabase,
  EVAL_USER_EMAIL,
  materializeLayout,
  readMaterializedState,
} from "../src/lib/eval/localization/materialize.js";
import { LedgerCostMeter, meterProvider } from "../src/lib/eval/localization/cost.js";
import {
  budgetStop,
  parseGapArms,
  parsePositiveInt,
  parseRecordFile,
  pendingWork,
  recordedSpendUsd,
  recordLine,
} from "../src/lib/eval/portfolio-gap/plan.js";
import {
  compareArms,
  gapTruths,
  outcomeFromResult,
  scoreArm,
  summarizeArm,
  uncitedViolations,
  type GapItemOutcome,
} from "../src/lib/eval/portfolio-gap/scorer.js";
import { renderGapReport, type GapReportArm } from "../src/lib/eval/portfolio-gap/report.js";

const CORPUS = "localization-02-fixture-portfolio" as const;
const PRODUCT_SLUG = "eval-portfolio-gap-commerce-services";
const PRODUCT_NAME = "Commerce services";
/** `<repo>/eval-data/corpus` → `<repo>`. */
const REPO_ROOT = path.resolve(localizationCorpusRoot(), "..", "..");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      arms: { type: "string" },
      runs: { type: "string" },
      budget: { type: "string" },
      "max-outcomes": { type: "string" },
      items: { type: "string" },
      records: { type: "string" },
      baseline: { type: "boolean" },
      "report-only": { type: "boolean" },
    },
  });
  const arms = parseGapArms(values.arms);
  const runs = parsePositiveInt(values.runs, "--runs", 3);
  const budget = Number(values.budget);
  if (!values.budget || !Number.isFinite(budget) || budget <= 0) {
    throw new Error("--budget <usd> is required: the run's spend cap");
  }
  const maxOutcomes = parsePositiveInt(
    values["max-outcomes"],
    "--max-outcomes",
    Number.MAX_SAFE_INTEGER,
  );

  const corpus = await loadLocalizationCorpus(CORPUS);
  const wanted = values.items
    ?.split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const items = wanted
    ? corpus.manifest.items.filter((i) => wanted.includes(i.id))
    : corpus.manifest.items;
  if (items.length === 0) throw new Error("no items selected");
  const truths = gapTruths(corpus.manifest.items);

  const layout = materializeLayout();
  const state = await readMaterializedState(CORPUS, layout);
  if (!state) throw new Error(`run pnpm eval:materialize ${CORPUS} first`);
  const nameOf = new Map<string, string>();
  const files = new Map<string, Map<string, number>>();
  for (const repo of corpus.manifest.repos) {
    const m = state.repos.find((r) => r.name === repo.name);
    if (!m || m.sha !== repo.sha || git(m.cloneDir, ["rev-parse", "HEAD"]) !== repo.sha) {
      throw new Error(
        `${repo.name} is not materialized at ${repo.sha}: re-run pnpm eval:materialize`,
      );
    }
    nameOf.set(m.connectorId, repo.name);
    // Every file at the pinned commit, with its line count: what a citation may name.
    const lines = new Map<string, number>();
    for (const rel of git(m.cloneDir, ["ls-files"]).split("\n").filter(Boolean)) {
      const text = await fs.readFile(path.join(m.cloneDir, rel), "utf8");
      lines.set(
        rel,
        text.length === 0 ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0),
      );
    }
    files.set(repo.name, lines);
  }

  const outDir = path.join(REPO_ROOT, "eval-results", "portfolio-gap");
  await fs.mkdir(outDir, { recursive: true });
  const recordsPath = path.resolve(values.records ?? path.join(outDir, "records.jsonl"));
  const recordFile = existsSync(recordsPath)
    ? parseRecordFile(await fs.readFile(recordsPath, "utf8"))
    : { outcomes: [], spends: [] };
  const recorded = recordFile.outcomes;

  const { prisma, boundDatabaseUrl } = await import("../src/lib/prisma.js");
  assertEvalDatabase(boundDatabaseUrl, layout);
  const { buildProvider, loadAIConfig } = await import("../src/lib/ai/index.js");
  const base = buildProvider({ config: loadAIConfig() });
  // --report-only makes no model call: it needs only the model's name, to select records.
  if (base.offline && !values["report-only"]) {
    throw new Error(
      "the gap engine needs a live provider (AI_PROVIDER and its key), not the offline stub",
    );
  }
  const model = `${base.key}/${base.model}`;
  console.log(`model ${model}; records ${recordsPath}`);

  const { DEFAULT_PORTFOLIO_GAP_LIMITS, evaluatePortfolioGap } =
    await import("../src/lib/portfolio/gap-engine.js");
  const configurationOf = (perRepoSearch: boolean) => ({
    ...DEFAULT_PORTFOLIO_GAP_LIMITS,
    perRepoSearch,
  });

  if (!values["report-only"]) {
    const { activeVectorBackend } = await import("../src/lib/rag/vector-store.js");
    if (activeVectorBackend() !== "lancedb") {
      throw new Error(`the eval needs the LanceDB vector store, not ${activeVectorBackend()}`);
    }
    const { getEmbedder } = await import("../src/lib/rag/embedder.js");
    if (getEmbedder().model !== state.embedModel) {
      throw new Error(
        `the embedder is ${getEmbedder().model}, the corpus used ${state.embedModel}`,
      );
    }
    const { ingestSourceAsKnowledge } = await import("../src/lib/connectors/connector-ingest.js");

    const dbUser = await prisma.user.upsert({
      where: { email: EVAL_USER_EMAIL },
      create: {
        email: EVAL_USER_EMAIL,
        displayName: "eval-materialize",
        username: "eval-materialize",
      },
      update: {},
    });
    // The eval user owns every materialized project; it reads as an admin, so
    // access rules (not what is measured) never hide a repository.
    const user: AuthPayload = {
      userId: dbUser.id,
      username: dbUser.username,
      role: "admin",
      permissions: getPermissionsForRole("admin"),
    };

    // The source files as knowledge documents: what the federated search returns.
    // The ingest skips a file whose indexed document is unchanged.
    for (const m of state.repos) {
      const t0 = performance.now();
      const s = await ingestSourceAsKnowledge(m.projectId, m.connectorId, dbUser.id, m.cloneDir);
      console.log(
        `${m.name}: ${s.documentsCreated + s.documentsUpdated} source documents ingested ` +
          `(${s.chunkCount} chunks, ${s.failures} failures) in ${((performance.now() - t0) / 1000).toFixed(0)}s`,
      );
      if (s.failures > 0)
        throw new Error(`${m.name}: ${s.failures} source documents failed to ingest`);
    }

    const product = await prisma.product.upsert({
      where: { slug: PRODUCT_SLUG },
      create: { slug: PRODUCT_SLUG, name: PRODUCT_NAME, createdById: dbUser.id },
      update: {},
    });
    for (const m of state.repos) {
      await prisma.productRepo.upsert({
        where: {
          productId_repoConnectionId: { productId: product.id, repoConnectionId: m.connectorId },
        },
        create: { productId: product.id, repoConnectionId: m.connectorId },
        update: {},
      });
    }
    // Nothing but the corpus's repositories: a stale connection would be checked too.
    await prisma.productRepo.deleteMany({
      where: {
        productId: product.id,
        repoConnectionId: { notIn: state.repos.map((r) => r.connectorId) },
      },
    });

    const meter = new LedgerCostMeter();
    const provider = meterProvider(base, meter);
    const priorUsd = recordedSpendUsd(recordFile, model);
    let costliest = [...recorded, ...recordFile.spends]
      .filter((o) => o.model === model)
      .reduce((a, o) => Math.max(a, o.costUsd), 0);
    const work = pendingWork({
      itemIds: items.map((i) => i.id),
      arms: arms.map((a) => a.id),
      runs,
      model,
      done: recorded,
    }).slice(0, maxOutcomes);
    console.log(
      `${work.length} outcome(s) to run; $${priorUsd.toFixed(4)} already recorded for ${model}`,
    );
    for (const w of work) {
      const stop = budgetStop({
        spentUsd: priorUsd + meter.spentUsd(),
        costliestItemUsd: costliest,
        budgetUsd: budget,
        unpricedCalls: meter.unpricedCalls(),
      });
      if (stop) {
        console.log(`stopping: ${stop}`);
        break;
      }
      const item = items.find((i) => i.id === w.itemId)!;
      const arm = arms.find((a) => a.id === w.arm)!;
      const before = meter.spentUsd();
      const t0 = performance.now();
      const result = await evaluatePortfolioGap(
        user,
        {
          statement: `${item.title}\n\n${item.text}`.trim(),
          scope: "product",
          productIds: [product.id],
        },
        { provider, limits: configurationOf(arm.perRepoSearch) },
      );
      const costUsd = meter.spentUsd() - before;
      costliest = Math.max(costliest, costUsd);
      const outcome: GapItemOutcome = outcomeFromResult(
        result,
        {
          itemId: item.id,
          arm: arm.id,
          run: w.run,
          model,
          costUsd,
          seconds: (performance.now() - t0) / 1000,
        },
        nameOf,
      );
      if (meter.unpricedCalls() > 0) {
        // Its spend is unknown: never recorded as a measured outcome, but its
        // priced calls were real spend, which a resumed slice's cap must count.
        const reason = `${meter.unpricedCalls()} unpriced model call(s)`;
        const spend = { kind: "spend" as const, itemId: item.id, arm: arm.id, run: w.run };
        await fs.appendFile(recordsPath, recordLine({ ...spend, model, costUsd, reason }), "utf8");
        console.log(
          `stopping: ${item.id} made an unpriced call; its priced $${costUsd.toFixed(4)} is ` +
            "recorded as spend, with no outcome",
        );
        break;
      }
      await fs.appendFile(recordsPath, recordLine(outcome), "utf8");
      recorded.push(outcome);
      console.log(
        `${arm.id} run ${w.run} ${item.id}: ${result.verdict} (expected ${item.expectedVerdict}) ` +
          `$${costUsd.toFixed(4)} ${outcome.seconds.toFixed(1)}s`,
      );
    }
  }

  // The report: every recorded outcome of the selected arms on this model.
  const reportArms: GapReportArm[] = arms
    .map((arm) => ({
      arm,
      model,
      configuration: { ...configurationOf(arm.perRepoSearch), model },
      summary: summarizeArm(
        arm.id,
        model,
        truths,
        recorded,
        files,
        wanted ? items.map((i) => i.id) : undefined,
      ),
      scored: scoreArm(arm.id, model, truths, recorded, files),
    }))
    .filter((a) => a.summary.outcomes > 0);
  const [baselineArm, ...others] = reportArms;
  const comparisons = baselineArm
    ? others.map((a) =>
        compareArms(
          { arm: baselineArm.arm.label, scored: baselineArm.scored },
          { arm: a.arm.label, scored: a.scored },
        ),
      )
    : [];
  const failures = uncitedViolations(reportArms.map((a) => a.summary));
  const generatedAt = new Date().toISOString();
  const report = renderGapReport({
    corpus: CORPUS,
    repos: corpus.manifest.repos,
    setup:
      `one product, "${PRODUCT_NAME}", holding the three repositories (each in its own project, ` +
      "source files ingested as knowledge documents); each item checked as one requirement " +
      "(title and text as the statement, criteria decomposed by the engine), the product in scope.",
    runsRequested: runs,
    budgetUsd: budget,
    generatedAt,
    items: truths,
    arms: reportArms,
    comparisons,
    notRun: ["P1 (#1764, the per-repo agentic evidence pass): not landed yet."],
    failures,
  });
  const stem = values.baseline
    ? path.join(corpus.dir, "gap-baseline")
    : path.join(outDir, generatedAt.replace(/[:.]/g, "-"));
  await fs.writeFile(`${stem}.md`, report, "utf8");
  await fs.writeFile(
    `${stem}.json`,
    `${JSON.stringify(
      {
        corpus: CORPUS,
        generatedAt,
        model,
        budgetUsd: budget,
        runsRequested: runs,
        summaries: reportArms.map((a) => ({ ...a.summary, configuration: a.configuration })),
        comparisons,
        failures,
        outcomes: recorded.filter((o) => o.model === model && arms.some((a) => a.id === o.arm)),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  console.log(`report → ${stem}.md`);
  await prisma.$disconnect();
  if (failures.length > 0) {
    console.error(`FAILED: ${failures.join("; ")}`);
    process.exitCode = 1;
  }
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error("eval:portfolio-gap failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  });
