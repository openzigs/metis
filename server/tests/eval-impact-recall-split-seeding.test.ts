/**
 * #1786 — the impact-recall runner on the SPLIT seeding: production's
 * `defaultSeedChange` path (`resolveChangeSeeds` with the file pool), which is
 * the only path the #1756 edit-candidate check runs on.
 */
import { describe, expect, it, vi } from "vitest";
import type { SeedSearcher, SeedSymbolLoader } from "../src/lib/impact-analysis/change-seeds.js";
import { VERIFY_POOL_FILES } from "../src/lib/impact-analysis/change-seeds.js";
import type { EditCandidateVerifierFn } from "../src/lib/impact-analysis/impact-analysis-engine.js";
import { buildSyntheticFixture } from "../src/lib/eval/impact-recall/fixture.js";
import {
  describeConfiguration,
  observeChange,
  observeRequirement,
  runImpactRecallEval,
} from "../src/lib/eval/impact-recall/runner.js";
import type { CodeSymbolSearcher } from "../src/lib/traceability/requirement-code-mapping.js";

const fx = buildSyntheticFixture();
const byId = new Map(fx.manifest.codeSymbols.map((s) => [s.id, s]));

/** The hybrid search stand-in: readAlpha first, readBeta well below it. */
const searcher: SeedSearcher = {
  search: vi.fn(async () => [
    {
      symbolId: "m_readalpha",
      filePath: "DataMapper.java",
      name: "readAlpha",
      kind: "method",
      score: 1,
    },
    {
      symbolId: "s_readbeta",
      filePath: "DataMapper.xml",
      name: "readBeta",
      kind: "method",
      score: 0.2,
    },
  ]),
};
const loadSymbols: SeedSymbolLoader = async (ids) =>
  ids.flatMap((id) => {
    const s = byId.get(id);
    return s
      ? [
          {
            id,
            qualifiedName: s.qualifiedName,
            filePath: s.filePath,
            kind: s.kind,
            language: s.language,
            startLine: 1,
            endLine: 2,
          },
        ]
      : [];
  });
/** A mapper searcher that must never be asked on the split path. */
const mapperSearcher: CodeSymbolSearcher = { search: vi.fn(async () => []) };

describe("observeRequirement on the split seeding (#1786)", () => {
  it("seeds through resolveChangeSeeds, never the mapper, and hands the check its file pool", async () => {
    const verifier = vi.fn<EditCandidateVerifierFn>(async () => ({
      applied: true,
      promoted: [],
      doubtful: [],
      droppedPromotions: 0,
      namedFiles: [],
    }));
    const requirement = fx.requirements[0]!;
    const out = await observeRequirement(fx, requirement, mapperSearcher, {
      splitSeeding: { searcher, loadSymbols, editCandidateVerifier: verifier },
    });
    expect(mapperSearcher.search).not.toHaveBeenCalled();
    expect(searcher.search).toHaveBeenCalled();
    expect(out.foundCodeSymbols).toContain("DataMapper.java::DataMapper::readAlpha");
    expect(verifier).toHaveBeenCalledTimes(1);
    const input = verifier.mock.calls[0]![0];
    expect(input.projectId).toBe(fx.projectId);
    expect(input.pool.map((f) => f.filePath)).toEqual(["DataMapper.java", "DataMapper.xml"]);
    expect(input.pool.length).toBeLessThanOrEqual(VERIFY_POOL_FILES);
  });

  it("runs no check when none is given: the split seeding alone", async () => {
    const result = await runImpactRecallEval(fx, {
      searcher: mapperSearcher,
      splitSeeding: { searcher, loadSymbols },
    });
    expect(mapperSearcher.search).not.toHaveBeenCalled();
    expect(result.configuration.seeding).toBe("split");
    expect(result.searcherKind).toBe("hybrid");
  });
});

describe("describeConfiguration names the seeding (#1786)", () => {
  it("labels the mapper path, the split seeding and the split seeding with the check apart", () => {
    expect(describeConfiguration({}).seeding).toBe("mapper");
    const split = describeConfiguration({ splitSeeding: { searcher, loadSymbols } });
    expect(split).toMatchObject({ seeding: "split", isProductionConfiguration: false });
    expect(split.label).toContain("SPLIT SEEDING");
    expect(split.label).not.toContain("edit-candidate check");
    const checked = describeConfiguration({
      splitSeeding: { searcher, loadSymbols, editCandidateVerifier: vi.fn() },
      tableRelevanceFilter: vi.fn(),
    });
    expect(checked).toMatchObject({
      seeding: "split + edit-candidate check",
      tableFilter: "llm",
      // The impact-recall floors were measured on the mapper path: never gate this as production.
      isProductionConfiguration: false,
    });
    expect(checked.label).toContain("IMPACT_LLM_EDIT_VERIFY=1");
  });
});

describe("the split seeding with the stored agent citations leading (#1823)", () => {
  it("names the stage, and leads with the cited file for a change with a requirement id", async () => {
    const loadCitations = vi.fn(async () => [
      {
        codeSymbolId: "s_readbeta",
        filePath: "DataMapper.xml",
        startLine: null,
        endLine: null,
        confidence: 0.9,
        source: "analysis-grounding",
      },
    ]);
    /** The search finds only readAlpha: beta is reachable only through the citation. */
    const alphaOnly: SeedSearcher = {
      search: async () => [
        {
          symbolId: "m_readalpha",
          filePath: "DataMapper.java",
          name: "readAlpha",
          kind: "method",
          score: 1,
        },
      ],
    };
    // No DAO sibling expansion: it would reach readBeta from readAlpha's mapper.
    const opts = {
      expandDaoSiblings: false,
      splitSeeding: {
        searcher: alphaOnly,
        loadSymbols,
        agentSeeds: {
          loadCitations,
          loadFileSymbols: async (paths: string[]) =>
            fx.manifest.codeSymbols
              .filter((s) => paths.includes(s.filePath))
              .map((s) => ({
                id: s.id,
                qualifiedName: s.qualifiedName,
                filePath: s.filePath,
                kind: s.kind,
                language: s.language,
                startLine: 1,
                endLine: 2,
                signature: null,
              })),
        },
      },
    };
    expect(describeConfiguration(opts)).toMatchObject({
      seeding: "split + agent citations",
      isProductionConfiguration: false,
    });
    expect(describeConfiguration(opts).label).toContain("IMPACT_AGENT_SEEDS=1");
    const requirement = fx.requirements[0]!;
    const change = {
      requirementId: "persisted-1",
      title: requirement.text,
      body: requirement.text,
      changeType: "added" as const,
      bodyDelta: requirement.text.length,
    };
    const led = await observeChange(fx, change, mapperSearcher, opts);
    expect(loadCitations).toHaveBeenCalledWith("persisted-1", fx.projectId);
    expect(led.foundTables.sort()).toEqual(["alpha", "beta"]);
    expect(led.foundCodeSymbols).toContain("syn.DataMapper.readBeta.statement");
    const unled = await observeChange(fx, change, mapperSearcher, {
      expandDaoSiblings: false,
      splitSeeding: { searcher: alphaOnly, loadSymbols },
    });
    expect(unled.foundTables).toEqual(["alpha"]);
  });
});
