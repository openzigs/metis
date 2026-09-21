/**
 * Issue #966 (Epic #960) — `pnpm eval:harvest-feedback` entrypoint.
 *
 * Reads every persisted `ImpactTableFeedback` row, aggregates it (pure logic
 * in `src/lib/eval/impact-recall/feedback-harvest.ts`) into fragments shaped
 * like `FixtureRequirement` (fixture.ts), and writes the result to
 * `eval-results/impact-feedback-harvest-<timestamp>.json`.
 *
 * This is EXPORT ONLY: the output is for a HUMAN to review and manually copy
 * the entries they trust into `eval-data/corpus/<name>/manifest.json`. Nothing
 * here writes into the corpus, and nothing in the capture/read path (routes,
 * table-feedback.ts) feeds the impact engine or the #936 LLM relevance filter.
 *
 *   pnpm eval:harvest-feedback           # writes the harvest file, prints a summary
 *   pnpm eval:harvest-feedback --md      # also print a markdown table to stdout
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prisma } from "../src/lib/prisma.js";
import {
  buildFeedbackHarvest,
  type HarvestFeedbackRow,
} from "../src/lib/eval/impact-recall/feedback-harvest.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");

function toMarkdownTable(rows: ReturnType<typeof buildFeedbackHarvest>["requirements"]): string {
  const lines = [
    "| id | text | expectedTables | notRelevantTables | marks |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const r of rows) {
    lines.push(
      `| ${r.id} | ${r.text} | ${r.expectedTables.join(", ")} | ${r.notRelevantTables.join(", ")} | ${r.markCount} |`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const printMd = process.argv.includes("--md");

  const feedbackRows = await prisma.impactTableFeedback.findMany({
    include: { impactItem: { include: { requirement: { select: { title: true } } } } },
    orderBy: [{ impactItemId: "asc" }, { createdAt: "asc" }],
  });

  const harvestRows: HarvestFeedbackRow[] = feedbackRows.map((row) => ({
    impactItemId: row.impactItemId,
    // #1013 — same precedence as the read projection: the tracked requirement's
    // live title, else the per-item snapshot the engine took. Without the
    // snapshot every pasted-text run harvested as `Impact item <id>`.
    requirementTitle: row.impactItem.requirement?.title ?? row.impactItem.requirementTitle ?? null,
    tableName: row.tableName,
    verdict: row.verdict === "not-relevant" ? "not-relevant" : "relevant",
  }));

  const report = buildFeedbackHarvest(harvestRows);

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const resultsDir = path.join(REPO_ROOT, "eval-results");
  await mkdir(resultsDir, { recursive: true });
  const resultPath = path.join(resultsDir, `impact-feedback-harvest-${runId}.json`);
  await writeFile(resultPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  if (printMd) {
    // eslint-disable-next-line no-console
    console.log(toMarkdownTable(report.requirements));
  }

  // eslint-disable-next-line no-console
  console.log(
    `Feedback harvest — ${report.requirementCount} requirement(s), ${report.feedbackCount} mark(s) → ${resultPath}\n` +
      `This is EXPORT ONLY — review before merging any entry into an eval-data corpus manifest.`,
  );
}

main()
  .catch((err) => {
    // eslint-disable-next-line no-console
    console.error("eval:harvest-feedback failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
