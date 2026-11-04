/**
 * #1786 — the table-precision guard on the split seeding: the fixture's search
 * rows, the edit-candidate check wired as the route wires it, and the two
 * readings (A0 on the split seeding, then the arm) taken on the same options.
 */
import { describe, expect, it, vi } from "vitest";
import type { AIProvider } from "../../ai/types.js";
import type { SeedPoolFile } from "../../impact-analysis/change-seeds.js";
import {
  buildSyntheticFixture,
  embeddableSymbols,
  loadImpactRecallFixture,
  recordedVectorsFile,
  resolveCorpusDir,
} from "../impact-recall/fixture.js";
import {
  runImpactRecallEval,
  type ImpactRecallRunSummary,
  type RunImpactRecallOptions,
} from "../impact-recall/runner.js";
import { loadRecordedVectors } from "../recorded-vectors.js";
import { EmbedCache, assertNoMissingVectors, buildCorpusSearch } from "./search.js";
import {
  fixtureEditCandidateVerifier,
  fixtureFileSymbols,
  fixtureSearchRows,
  measureSplitSeedingGuard,
} from "./table-guard.js";

describe("fixtureSearchRows (#1786)", () => {
  it("is the fixture's searchable symbols, in its project, with the text production embeds", () => {
    const fx = buildSyntheticFixture();
    const rows = fixtureSearchRows(fx);
    expect(rows.map((r) => r.id)).toEqual(["m_readalpha", "m_readbeta"]);
    expect(rows.every((r) => r.repo === fx.projectId && r.language === "java")).toBe(true);
    expect(rows.map((r) => r.embeddingText)).toEqual(
      embeddableSymbols(fx.manifest.codeSymbols).map((s) => s.embeddingText),
    );
  });
});

describe("fixtureFileSymbols (#1786)", () => {
  it("returns every symbol of the asked files, searchable or not, in the fixture's project only", async () => {
    const fx = buildSyntheticFixture();
    const load = fixtureFileSymbols(fx);
    expect((await load(["DataMapper.xml"], fx.projectId)).map((r) => r.id)).toEqual([
      "s_readalpha",
      "s_readbeta",
    ]);
    expect(await load(["DataMapper.xml"], "another-project")).toEqual([]);
  });
});

describe("fixtureEditCandidateVerifier (#1786)", () => {
  const fx = buildSyntheticFixture();
  const pool: SeedPoolFile[] = ["DataMapper.java", "DataMapper.xml"].map((filePath, i) => ({
    filePath,
    score: 1 - i * 0.5,
    editCandidate: i === 0,
    symbols: [],
  }));
  const saying = (content: string) =>
    ({
      key: "anthropic",
      model: "claude-sonnet-5-5",
      offline: false,
      chat: vi.fn(async () => ({ content, model: "claude-sonnet-5-5" })),
    }) as unknown as AIProvider;

  it("promotes a pool file at a line inside one of the fixture's symbols, and refuses one outside", async () => {
    const promote = (line: number) =>
      fixtureEditCandidateVerifier(
        fx,
        saying(`{"promote":[{"index":1,"line":${line},"reason":"It reads the row."}]}`),
      )({ requirementText: "Read alpha", pool, projectId: fx.projectId });
    const inside = await promote(2);
    expect(inside.promoted.map((p) => p.filePath)).toEqual(["DataMapper.xml"]);
    const outside = await promote(7);
    expect(outside.promoted).toEqual([]);
    expect(outside.droppedPromotions).toBe(1);
  });
});

describe("measureSplitSeedingGuard (#1786)", () => {
  const summary = (seeding: string, precision: number) =>
    ({
      runCount: 3,
      configuration: { seeding, label: `${seeding} label` },
      meanAggregate: { tables: { macroPrecision: precision } },
    }) as unknown as ImpactRecallRunSummary;

  it("reads A0 on the split seeding first, then the arm on it, with the same options", async () => {
    const seen: RunImpactRecallOptions[] = [];
    const verifier = vi.fn();
    const consumerResolver = () => [];
    const search = { searcher: { search: async () => [] }, loadSymbols: async () => [] };
    const reading = await measureSplitSeedingGuard({
      search,
      options: { consumerResolver },
      editCandidateVerifier: verifier,
      runRepeated: async (opts) => {
        seen.push(opts);
        return opts.splitSeeding?.editCandidateVerifier
          ? summary("split + edit-candidate check", 0.54)
          : summary("split", 0.5);
      },
      describe: (s) => `corpus, ${s.configuration.label}`,
    });
    expect(seen).toHaveLength(2);
    expect(seen.every((o) => o.consumerResolver === consumerResolver)).toBe(true);
    expect(seen.map((o) => o.splitSeeding?.searcher)).toEqual([search.searcher, search.searcher]);
    expect(seen[0]!.splitSeeding?.editCandidateVerifier).toBeUndefined();
    expect(seen[1]!.splitSeeding?.editCandidateVerifier).toBe(verifier);
    expect(reading).toEqual({
      measured: true,
      tablePrecision: 0.54,
      runs: 3,
      configuration: "corpus, split + edit-candidate check label",
      seeding: "split + edit-candidate check",
      baseline: {
        tablePrecision: 0.5,
        runs: 3,
        configuration: "corpus, split label",
        seeding: "split",
      },
    });
  });
});

/**
 * The split seeding on the committed impact-recall corpus, from its committed
 * recorded vectors: every query the seeding asks must be recorded, or the
 * hybrid search would fall back to BM25 under the hybrid label.
 */
describe("the split seeding on impact-recall-01-jpetstore (#1786)", () => {
  it("runs offline and fully hybrid from the committed recording", async () => {
    const dir = resolveCorpusDir("impact-recall-01-jpetstore");
    const fixture = await loadImpactRecallFixture(dir);
    const cache = new EmbedCache(
      await loadRecordedVectors(recordedVectorsFile(dir)),
      null,
      "pnpm eval:localization --arms A0,A4 --table-guard --embed",
    );
    const search = await buildCorpusSearch(fixtureSearchRows(fixture), cache);
    const result = await runImpactRecallEval(fixture, {
      splitSeeding: { searcher: search.searcher, loadSymbols: search.loadSymbols },
    });
    assertNoMissingVectors(cache);
    expect(result.configuration).toMatchObject({ seeding: "split", searcher: "hybrid" });
    expect(result.scores).toHaveLength(fixture.requirements.length);
    expect(result.aggregate.tables.macroRecall).toBeGreaterThan(0);
  });
});
