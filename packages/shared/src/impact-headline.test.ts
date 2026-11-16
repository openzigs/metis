/**
 * #2593 — what an impact result leads with, and the one source of its
 * low-confidence caveat.
 */
import { describe, expect, it } from "vitest";
import {
  IMPACT_DATABASE_NOT_CHECKED,
  impactCountLabel,
  impactEditFileKeys,
  impactReachLabel,
  impactRunHeadline,
} from "./impact-headline.js";
import {
  deriveImpactItemMatchQuality,
  deriveMatchQualityDetailed,
  impactFileKey,
  impactMatchCaveat,
  type ImpactSeedEvidence,
} from "./impact.js";

const sym = (
  filePath: string,
  depth: number,
  repo: { id: string; name: string } | null = null,
) => ({
  filePath,
  depth,
  repo,
});

/** Five near-tied seeds in unrelated files: the shape the word-match rule calls scattered. */
const scatteredSeeds = [
  "internal/api/api_key.go",
  "internal/storage/feed.go",
  "internal/ui/settings.go",
  "internal/model/user.go",
  "internal/database/migrations.go",
].map((filePath) => ({ filePath, confidence: 1 }));

const evidence = (over: Partial<ImpactSeedEvidence> = {}): ImpactSeedEvidence => ({
  editCandidates: [],
  ...over,
});

describe("deriveImpactItemMatchQuality (#2593)", () => {
  it("is the word-match grade when the code agent's citations did not lead", () => {
    expect(deriveMatchQualityDetailed(scatteredSeeds)).toEqual({
      quality: "weak",
      reason: "scattered",
    });
    expect(deriveImpactItemMatchQuality(scatteredSeeds, undefined)).toEqual({
      quality: "weak",
      reason: "scattered",
    });
    expect(
      deriveImpactItemMatchQuality(
        scatteredSeeds,
        evidence({ agentCitations: { used: 3, stale: 0, led: 0 } }),
      ),
    ).toEqual({ quality: "weak", reason: "scattered" });
  });

  it("drops a scattered grade when cited files led the files to edit", () => {
    expect(
      deriveImpactItemMatchQuality(
        scatteredSeeds,
        evidence({ agentCitations: { used: 5, stale: 0, led: 5 } }),
      ),
    ).toEqual({ quality: "moderate", reason: null });
  });

  it("keeps a no-entity grade, which no citation can explain away", () => {
    expect(
      deriveImpactItemMatchQuality([], evidence({ agentCitations: { used: 0, stale: 0, led: 1 } })),
    ).toEqual({ quality: "weak", reason: "no-entity" });
  });

  it("leaves a strong grade alone", () => {
    expect(
      deriveImpactItemMatchQuality(
        [{ filePath: "a.go", confidence: 1 }],
        evidence({ agentCitations: { used: 1, stale: 0, led: 1 } }),
      ),
    ).toEqual({ quality: "strong", reason: null });
  });
});

describe("impactMatchCaveat (#2593)", () => {
  it("says nothing unless the match is weak", () => {
    expect(impactMatchCaveat({ matchQuality: "strong", matchQualityReason: null })).toBeNull();
    expect(impactMatchCaveat({ matchQuality: "moderate", matchQualityReason: null })).toBeNull();
  });

  it("states the reason the match is weak", () => {
    expect(impactMatchCaveat({ matchQuality: "weak", matchQualityReason: "scattered" })).toMatch(
      /several unrelated areas/,
    );
    expect(impactMatchCaveat({ matchQuality: "weak", matchQualityReason: "no-entity" })).toMatch(
      /didn't clearly name an entity/,
    );
  });
});

describe("impactEditFileKeys (#2593)", () => {
  it("lists each depth-0 file once, and no blast-radius file", () => {
    const keys = impactEditFileKeys({
      affectedSymbols: [sym("a.go", 0), sym("a.go", 0), sym("b.go", 0), sym("c.go", 1)],
    });
    expect(keys).toEqual([
      impactFileKey({ filePath: "a.go" }),
      impactFileKey({ filePath: "b.go" }),
    ]);
  });

  it("keeps one path in two repositories as two files", () => {
    const r1 = { id: "r1", name: "one" };
    const r2 = { id: "r2", name: "two" };
    expect(
      impactEditFileKeys({ affectedSymbols: [sym("a.go", 0, r1), sym("a.go", 0, r2)] }),
    ).toHaveLength(2);
  });

  it("leaves out a file the edit check doubted", () => {
    const keys = impactEditFileKeys({
      affectedSymbols: [sym("a.go", 0), sym("b.go", 0)],
      seedEvidence: evidence({
        editCandidates: [
          { filePath: "a.go", channels: ["hybrid"], verdict: { kind: "doubtful", reason: "no" } },
          { filePath: "b.go", channels: ["hybrid"] },
        ],
      }),
    });
    expect(keys).toEqual([impactFileKey({ filePath: "b.go" })]);
  });

  it("matches the doubt to the file's own repository", () => {
    const r1 = { id: "r1", name: "one" };
    const r2 = { id: "r2", name: "two" };
    const keys = impactEditFileKeys({
      affectedSymbols: [sym("a.go", 0, r1), sym("a.go", 0, r2)],
      seedEvidence: evidence({
        editCandidates: [
          {
            filePath: "a.go",
            repoConnectionId: "r1",
            channels: ["hybrid"],
            verdict: { kind: "doubtful", reason: "no" },
          },
        ],
      }),
    });
    expect(keys).toEqual([impactFileKey({ filePath: "a.go", repo: r2 })]);
  });
});

describe("impactRunHeadline (#2593)", () => {
  it("counts requirements and files to edit, not symbols", () => {
    const headline = impactRunHeadline([
      {
        id: "i1",
        projectId: "p1",
        requirementId: "req-1",
        affectedSymbols: [sym("a.go", 0), sym("b.go", 0), ...Array(50).fill(sym("x.go", 2))],
      },
      { id: "i2", projectId: "p1", requirementId: "req-2", affectedSymbols: [sym("a.go", 0)] },
      // The same requirement in a second project: one requirement, its own file.
      { id: "i3", projectId: "p2", requirementId: "req-1", affectedSymbols: [sym("a.go", 0)] },
      // An untracked change counts as its own requirement.
      { id: "i4", projectId: "p1", requirementId: null, affectedSymbols: [] },
    ]);
    expect(headline).toEqual({ requirementCount: 3, editFileCount: 3 });
  });
});

describe("labels (#2593)", () => {
  it("pluralises", () => {
    expect(impactCountLabel(1, "file")).toBe("1 file");
    expect(impactCountLabel(0, "file")).toBe("0 files");
    expect(impactCountLabel(2, "repository", "repositories")).toBe("2 repositories");
  });

  it("calls the symbol reach review material", () => {
    expect(impactReachLabel(3305)).toBe(
      "Reach: 3305 code symbols — the callers and related code to review; not each one changes.",
    );
    expect(IMPACT_DATABASE_NOT_CHECKED).toBe(
      "Database impact not checked (no database connection)",
    );
  });
});
