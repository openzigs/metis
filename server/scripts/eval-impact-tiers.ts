/**
 * #2302 — `pnpm eval:impact-tiers`: the hit rate of each Impact Analysis tier
 * (verified by graph path / likely / possible / needs review), measured before
 * its thresholds were fixed. Deterministic: no model is called.
 *
 *   pnpm eval:impact-tiers           # both held-out localization corpora + impact-recall-01
 *   pnpm eval:impact-tiers --embed   # embed missing vectors with the local model (Miniflux's first run)
 *
 * Miniflux's vectors are not committed (`pnpm eval:localization` says why), so
 * its first run needs `--embed` and the local model:
 *
 *   EMBED_BACKEND=xenova EMBED_MODEL=Alibaba-NLP/gte-modernbert-base \
 *   TRANSFORMERS_CACHE=~/.cache/metis-transformers HF_HUB_OFFLINE=1 \
 *   pnpm eval:impact-tiers --embed
 *
 * The logic is in the unit-tested `src/lib/eval/impact-tiers.ts`; this file
 * reads the corpora and prints the table.
 */
import path from "node:path";
import { impactSymbolTier, impactTableTier } from "@metis/shared";
import { computeProjectImpact } from "../src/lib/impact-analysis/impact-analysis-engine.js";
import { resolveChangeSeeds } from "../src/lib/impact-analysis/change-seeds.js";
import { extractChangesByShape } from "../src/lib/impact-analysis/change-request.js";
import {
  fileKey,
  loadLocalizationCorpus,
  resolveSymbolsPath,
  type LocalizationCorpusName,
} from "../src/lib/eval/localization/corpus.js";
import {
  EmbedCache,
  assertNoMissingVectors,
  buildCorpusSearch,
} from "../src/lib/eval/localization/search.js";
import { requirementText } from "../src/lib/eval/localization/arm-core.js";
import { fixtureSearchRows } from "../src/lib/eval/localization/table-guard.js";
import { loadRecordedVectors, writeRecordedVectors } from "../src/lib/eval/recorded-vectors.js";
import {
  loadImpactRecallFixture,
  recordedVectorsFile,
  resolveCorpusDir,
  type ImpactRecallCorpusName,
} from "../src/lib/eval/impact-recall/fixture.js";
import { requirementToChange } from "../src/lib/eval/impact-recall/runner.js";
import { normalizeCodeSymbol, normalizeTable } from "../src/lib/eval/impact-recall/scorer.js";
import {
  seedTierObservations,
  tierPrecision,
  tierPrecisionMarkdown,
  type TierObservation,
} from "../src/lib/eval/impact-tiers.js";
import type { EmbedService } from "../src/lib/code-graph/symbol-embeddings.js";

const LOCALIZATION: LocalizationCorpusName[] = [
  "localization-01-miniflux-heldout",
  "localization-02-fixture-portfolio",
];
/** The impact-recall corpora with recorded vectors (the split seeding needs them). */
const IMPACT_RECALL: ImpactRecallCorpusName[] = ["impact-recall-01-jpetstore"];
const SEARCH_RELATIONS: ReadonlySet<string> = new Set(["direct", "related"]);

async function localization(name: LocalizationCorpusName, embed: boolean) {
  const corpus = await loadLocalizationCorpus(name);
  let inner: EmbedService | null = null;
  let model = process.env.EMBED_MODEL ?? "Alibaba-NLP/gte-modernbert-base";
  if (embed) {
    const { getEmbedder } = await import("../src/lib/rag/embedder.js");
    const embedder = getEmbedder();
    inner = embedder;
    model = embedder.model;
  }
  const file = path.join(
    path.dirname(resolveSymbolsPath(corpus.dir, corpus.manifest)),
    `vectors.${model.split("/").pop()}.json`,
  );
  const cache = new EmbedCache(
    await loadRecordedVectors(file),
    inner,
    "pnpm eval:impact-tiers --embed (with the local model)",
  );
  const search = await buildCorpusSearch(corpus.symbols, cache);
  const out: TierObservation[] = [];
  for (const item of corpus.manifest.items) {
    const gold = new Set(item.expectedFiles);
    for (const repo of corpus.manifest.repos) {
      for (const change of extractChangesByShape(requirementText(item))) {
        const seeds = await resolveChangeSeeds(change, repo.name, {
          searcher: search.searcher,
          loadSymbols: search.loadSymbols,
          loadWriterIds: search.loadWriterIds,
        });
        out.push(
          ...seedTierObservations(`localization/${name}`, seeds, (f) =>
            gold.has(fileKey(repo.name, f)),
          ),
        );
      }
    }
  }
  assertNoMissingVectors(cache);
  if (cache.embeddedCount > 0) {
    await writeRecordedVectors(
      file,
      cache.toFiles("Recorded by `pnpm eval:impact-tiers --embed` (#2302)."),
    );
  }
  return out;
}

/**
 * The engine over an impact-recall corpus, seeded as production seeds it: the
 * split seeding (`resolveChangeSeeds`) over the corpus's recorded vectors. Only
 * impact-recall-01 has them committed.
 */
async function impactRecall(name: ImpactRecallCorpusName) {
  const fixture = await loadImpactRecallFixture(resolveCorpusDir(name));
  const cache = new EmbedCache(
    await loadRecordedVectors(recordedVectorsFile(resolveCorpusDir(name))),
    null,
    `pnpm eval:impact-recall --corpus ${name} --no-filter --searcher hybrid --record-vectors`,
  );
  const search = await buildCorpusSearch(fixtureSearchRows(fixture), cache);
  const out: TierObservation[] = [];
  for (const r of fixture.requirements) {
    const impact = await computeProjectImpact(requirementToChange(r), fixture.projectId, {
      seedChange: (change, projectId) =>
        resolveChangeSeeds(change, projectId, {
          searcher: search.searcher,
          loadSymbols: search.loadSymbols,
        }),
      mapRequirement: () => Promise.reject(new Error("the split seeding replaces the mapper")),
      dataSourceFor: () => fixture.codeDataSource,
      schemaDataSourceFor: () => fixture.schemaDataSource,
      includeSchemaImpact: true,
      expandDaoSiblings: true,
    });
    if (r.expectedCodeSymbols) {
      const gold = new Set(r.expectedCodeSymbols.map(normalizeCodeSymbol));
      for (const s of impact.affectedSymbols) {
        const found = SEARCH_RELATIONS.has(s.relation) ? "search" : "graph";
        out.push({
          source: `impact-recall/${name}/symbols (${found})`,
          tier: impactSymbolTier(s),
          hit: gold.has(normalizeCodeSymbol(s.qualifiedName)),
        });
      }
    }
    const tables = new Set(r.expectedTables.map(normalizeTable));
    for (const t of impact.affectedTables) {
      if (t.objectKind !== "table") continue;
      out.push({
        source: `impact-recall/${name}/tables`,
        tier: impactTableTier(t),
        hit: tables.has(normalizeTable(t.tableName)),
      });
    }
  }
  assertNoMissingVectors(cache);
  return out;
}

async function main() {
  const embed = process.argv.includes("--embed");
  const observations: TierObservation[] = [];
  for (const name of LOCALIZATION) observations.push(...(await localization(name, embed)));
  for (const name of IMPACT_RECALL) observations.push(...(await impactRecall(name)));
  // eslint-disable-next-line no-console
  console.log(
    "Impact Analysis tiers (#2302) — hit rate per tier. A caller's hit is a file to edit, " +
      "not 'affected': no corpus labels the blast radius.\n\n" +
      tierPrecisionMarkdown(tierPrecision(observations)),
  );
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("eval:impact-tiers failed:", err);
  process.exit(1);
});
