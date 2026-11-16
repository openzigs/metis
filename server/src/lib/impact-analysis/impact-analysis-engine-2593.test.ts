/**
 * #2593 — the engine grades an item's match through its seed evidence, as the
 * read path does: five near-tied seeds in unrelated files read "scattered" (a
 * weak word match), unless the code agent's citations led the files to edit.
 * The grade reaches the summarizer, so its caveat and the page's banner agree.
 */
import { describe, expect, it } from "vitest";
import type { ImpactSeedEvidence } from "@metis/shared";
import type { ChangeSeeds } from "./change-seeds.js";
import { computeProjectImpact, InMemoryCodeGraphDataSource } from "./impact-analysis-engine.js";

const FILES = [
  "internal/api/api_key.go",
  "internal/storage/feed.go",
  "internal/ui/settings.go",
  "internal/model/user.go",
  "internal/database/migrations.go",
];
const ids = FILES.map((_f, i) => `S${i + 1}`);

const graph = new InMemoryCodeGraphDataSource(
  FILES.map((filePath, i) => ({
    id: ids[i]!,
    qualifiedName: `${filePath}::fn`,
    kind: "function",
    filePath,
    language: "go",
    startLine: 1,
    endLine: 9,
  })),
  [],
);

const seedsWith = (evidence?: ImpactSeedEvidence): ChangeSeeds => ({
  editCandidates: FILES.map((filePath, i) => ({
    codeSymbolId: ids[i]!,
    filePath,
    qualifiedName: `${filePath}::fn`,
    startLine: 1,
    endLine: 9,
    confidence: 1,
  })),
  related: [],
  schemaSeeds: [],
  ...(evidence ? { evidence } : {}),
});

const change = {
  requirementId: "req-1",
  title: "API keys expire",
  body: "Add an expiry to API keys.",
  changeType: "added" as const,
  bodyDelta: 20,
};

const run = (seeds: ChangeSeeds) =>
  computeProjectImpact(change, "p1", {
    mapRequirement: async () => [],
    seedChange: async () => seeds,
    dataSourceFor: () => graph,
    includeSchemaImpact: false,
  });

describe("computeProjectImpact — match quality through the seed evidence (#2593)", () => {
  it("grades scattered word-match seeds weak/scattered", async () => {
    const result = await run(seedsWith());
    expect(result.matchQuality).toBe("weak");
    expect(result.matchQualityReason).toBe("scattered");
  });

  it("grades the same seeds moderate when cited files led the files to edit", async () => {
    const result = await run(
      seedsWith({ agentCitations: { used: 5, stale: 0, led: 5 }, editCandidates: [] }),
    );
    expect(result.matchQuality).toBe("moderate");
    expect(result.matchQualityReason).toBeNull();
  });
});
