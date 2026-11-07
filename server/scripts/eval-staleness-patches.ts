/**
 * #1834 — `pnpm eval:staleness-patches`: write the committed staleness patch
 * sets that `pnpm eval:localization --arms …,A7S,A7SD` applies, one per corpus,
 * into `server/scripts/eval-localization-staleness/<corpus>.json`.
 *
 *   pnpm eval:staleness-patches                # the two held-out corpora, from their committed rows
 *   pnpm eval:staleness-patches --table-guard  # + impact-recall-01-jpetstore, from the materialized
 *                                              #   repository (pnpm eval:materialize impact-recall-01-jpetstore)
 *
 * The targets follow `STALENESS_RULE` (`staleness.ts`) and are chosen from
 * committed data only, so a re-run writes the same files: a test pins the
 * held-out sets to what this rule generates. The table corpus has no committed
 * symbol rows (its graph is hand-authored), so its set is generated from the
 * materialized repository's graph, pinned to `TABLE_GUARD_REPO.sha`.
 */
/* eslint-disable no-console -- a local CLI whose output is what it wrote */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { bindMaterializedEnv } from "../src/lib/eval/localization/agent-env.js";
import {
  loadLocalizationCorpus,
  type LocalizationCorpusName,
} from "../src/lib/eval/localization/corpus.js";
import {
  assertEvalDatabase,
  materializeLayout,
  readMaterializedState,
} from "../src/lib/eval/localization/materialize.js";
import {
  generateStalenessPatchSet,
  type StalenessPatchSet,
} from "../src/lib/eval/localization/staleness.js";
import {
  guardPatchTargets,
  TABLE_GUARD_CORPUS,
  TABLE_GUARD_REPO,
} from "../src/lib/eval/localization/table-guard-source.js";

const OUT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "eval-localization-staleness",
);

const HELD_OUT: LocalizationCorpusName[] = [
  "localization-01-miniflux-heldout",
  "localization-02-fixture-portfolio",
];

async function write(set: StalenessPatchSet): Promise<void> {
  await mkdir(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, `${set.corpus}.json`);
  await writeFile(file, `${JSON.stringify(set, null, 2)}\n`, "utf8");
  console.log(`${set.corpus}: ${Object.keys(set.items).length} item patch(es) → ${file}`);
}

/** The table corpus's set: its requirements' files, the materialized graph's symbols. */
async function tableGuardSet(): Promise<StalenessPatchSet> {
  const layout = materializeLayout();
  bindMaterializedEnv(process.env, layout);
  const { prisma, boundDatabaseUrl } = await import("../src/lib/prisma.js");
  try {
    assertEvalDatabase(boundDatabaseUrl, layout);
    const state = await readMaterializedState(TABLE_GUARD_CORPUS, layout);
    const repo = state?.repos.find((r) => r.name === TABLE_GUARD_REPO.name);
    if (!repo) {
      throw new Error(
        `${TABLE_GUARD_CORPUS} is not materialized: run pnpm eval:materialize ${TABLE_GUARD_CORPUS}`,
      );
    }
    if (repo.sha !== TABLE_GUARD_REPO.sha) {
      throw new Error(
        `${TABLE_GUARD_CORPUS} is materialized at ${repo.sha}, not ${TABLE_GUARD_REPO.sha}`,
      );
    }
    const rows = await prisma.codeSymbol.findMany({
      where: { projectId: repo.projectId },
      select: {
        filePath: true,
        qualifiedName: true,
        kind: true,
        language: true,
        startLine: true,
        endLine: true,
      },
      orderBy: [{ filePath: "asc" }, { startLine: "asc" }, { qualifiedName: "asc" }],
    });
    const { loadImpactRecallFixture, resolveCorpusDir } =
      await import("../src/lib/eval/impact-recall/fixture.js");
    const fixture = await loadImpactRecallFixture(resolveCorpusDir(TABLE_GUARD_CORPUS));
    return generateStalenessPatchSet({
      corpus: TABLE_GUARD_CORPUS,
      items: guardPatchTargets(fixture),
      symbols: rows.map((r) => ({ ...r, repo: TABLE_GUARD_REPO.name })),
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function main(): Promise<void> {
  for (const name of HELD_OUT) {
    const corpus = await loadLocalizationCorpus(name);
    await write(
      generateStalenessPatchSet({
        corpus: name,
        items: corpus.manifest.items,
        symbols: corpus.symbols,
      }),
    );
  }
  if (process.argv.includes("--table-guard")) await write(await tableGuardSet());
}

main().catch((err) => {
  console.error("eval:staleness-patches failed:", err instanceof Error ? err.message : err);
  process.exit(1);
});
