import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_VERIFICATION_CORPUS,
  REQUIRED_HARD_CASES,
  loadVerificationCorpus,
  parseVerificationCorpusName,
  provenanceMix,
  resolveVerificationCorpusDir,
  validateVerificationCorpus,
  type VerificationCase,
  type VerificationCorpus,
} from "./corpus.js";

function aCase(overrides: Partial<VerificationCase> = {}): VerificationCase {
  return {
    id: "X-1",
    hardCase: "semantic-mismatch",
    title: "t",
    provenance: { origin: "real", source: "s", groundTruth: "g" },
    finding: { title: "ft", body: "fb" },
    groundedCitations: [],
    droppedCitations: [],
    absenceConfirmable: true,
    evidence: [],
    expected: { supported: false, rationale: "r" },
    ...overrides,
  };
}

function aCorpus(cases: VerificationCase[]): VerificationCorpus {
  return { id: "c", description: "d", warning: "w", provenanceNote: "p", cases };
}

describe("resolveVerificationCorpusDir", () => {
  it("resolves a registered corpus", () => {
    expect(resolveVerificationCorpusDir(DEFAULT_VERIFICATION_CORPUS)).toContain(
      DEFAULT_VERIFICATION_CORPUS,
    );
  });

  it("throws with the known names on a typo rather than loading the default", () => {
    expect(() => resolveVerificationCorpusDir("nope")).toThrow(/unknown verification corpus/);
    expect(() => resolveVerificationCorpusDir("nope")).toThrow(DEFAULT_VERIFICATION_CORPUS);
  });
});

describe("parseVerificationCorpusName", () => {
  it("defaults to the committed corpus", () => {
    expect(parseVerificationCorpusName(["node", "x"])).toBe(DEFAULT_VERIFICATION_CORPUS);
  });

  it("reads --corpus <name>", () => {
    expect(parseVerificationCorpusName(["--corpus", "other"])).toBe("other");
  });

  it("ignores a --corpus followed by another flag", () => {
    expect(parseVerificationCorpusName(["--corpus", "--md"])).toBe(DEFAULT_VERIFICATION_CORPUS);
  });
});

describe("validateVerificationCorpus", () => {
  const allFour = REQUIRED_HARD_CASES.map((k, i) => aCase({ id: `H-${i}`, hardCase: k }));

  it("accepts a corpus carrying every required hard case", () => {
    expect(validateVerificationCorpus(aCorpus(allFour)).cases).toHaveLength(4);
  });

  it("rejects a corpus that lost one of the four hard cases", () => {
    const missingSemantic = allFour.filter((c) => c.hardCase !== "semantic-mismatch");
    expect(() => validateVerificationCorpus(aCorpus(missingSemantic))).toThrow(
      /missing required hard case\(s\): semantic-mismatch/,
    );
  });

  it("rejects duplicate case ids", () => {
    const dup = [...allFour, aCase({ id: allFour[0].id, hardCase: allFour[0].hardCase })];
    expect(() => validateVerificationCorpus(aCorpus(dup))).toThrow(/duplicate case id/);
  });

  it("rejects an empty corpus", () => {
    expect(() => validateVerificationCorpus(aCorpus([]))).toThrow(/no cases/);
  });
});

describe("provenanceMix", () => {
  it("counts real and synthesised cases separately", () => {
    const mix = provenanceMix(
      aCorpus([
        aCase({ id: "a" }),
        aCase({ id: "b", provenance: { origin: "synthesised", source: "s", groundTruth: "g" } }),
      ]),
    );
    expect(mix).toEqual({ real: 1, synthesised: 1 });
  });
});

describe("the committed corpus", () => {
  it("loads, validates, and carries all four hard cases #1108 names", async () => {
    const corpus = await loadVerificationCorpus(
      resolveVerificationCorpusDir(DEFAULT_VERIFICATION_CORPUS),
    );
    expect(corpus.id).toBe(DEFAULT_VERIFICATION_CORPUS);
    const kinds = new Set(corpus.cases.map((c) => c.hardCase));
    for (const required of REQUIRED_HARD_CASES) expect(kinds.has(required)).toBe(true);
  });

  it("labels every case with a ground truth and a disputable rationale", async () => {
    const corpus = await loadVerificationCorpus(
      resolveVerificationCorpusDir(DEFAULT_VERIFICATION_CORPUS),
    );
    for (const c of corpus.cases) {
      expect(typeof c.expected.supported).toBe("boolean");
      // A label nobody can dispute is not evidence — every case must justify itself.
      expect(c.expected.rationale.length).toBeGreaterThan(40);
      expect(c.provenance.source.length).toBeGreaterThan(0);
    }
  });

  it("is majority-real, per #1108's warning that a synthesised corpus flatters", async () => {
    const corpus = await loadVerificationCorpus(
      resolveVerificationCorpusDir(DEFAULT_VERIFICATION_CORPUS),
    );
    const mix = provenanceMix(corpus);
    expect(mix.real).toBeGreaterThan(mix.synthesised);
  });

  it("carries both classes so neither precision nor recall is vacuous", async () => {
    const corpus = await loadVerificationCorpus(
      resolveVerificationCorpusDir(DEFAULT_VERIFICATION_CORPUS),
    );
    const unsupported = corpus.cases.filter((c) => !c.expected.supported);
    const supported = corpus.cases.filter((c) => c.expected.supported);
    expect(unsupported.length).toBeGreaterThan(0);
    expect(supported.length).toBeGreaterThan(0);
  });
});

describe("manifest parsing errors", () => {
  it("fails loud on an unregistered corpus directory", async () => {
    await expect(loadVerificationCorpus("/definitely/not/here")).rejects.toThrow();
  });

  async function loadRaw(manifest: unknown): Promise<VerificationCorpus> {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "verification-corpus-"));
    await fs.writeFile(path.join(dir, "manifest.json"), JSON.stringify(manifest), "utf8");
    return loadVerificationCorpus(dir);
  }

  const wellFormedCase = {
    id: "A-1",
    hardCase: "semantic-mismatch",
    title: "t",
    provenance: { origin: "real", source: "s", groundTruth: "g" },
    finding: { title: "ft", body: "fb", tags: ["x"] },
    groundedCitations: [],
    droppedCitations: [],
    absenceConfirmable: true,
    evidence: [],
    expected: { supported: false, rationale: "r" },
  };

  function manifestWith(cases: unknown[]): Record<string, unknown> {
    return { id: "c", description: "d", warning: "w", provenanceNote: "p", cases };
  }

  it("rejects a manifest missing a top-level string field", async () => {
    await expect(
      loadRaw({ description: "d", warning: "w", provenanceNote: "p", cases: [] }),
    ).rejects.toThrow(/id must be a non-empty string/);
  });

  it("rejects a non-array cases key", async () => {
    await expect(
      loadRaw({ id: "c", description: "d", warning: "w", provenanceNote: "p", cases: {} }),
    ).rejects.toThrow(/cases must be an array/);
  });

  it("rejects a non-object case", async () => {
    await expect(loadRaw(manifestWith(["nope"]))).rejects.toThrow(/case\[0\] must be an object/);
  });

  it("rejects an unknown hardCase kind", async () => {
    await expect(
      loadRaw(manifestWith([{ ...wellFormedCase, hardCase: "made-up" }])),
    ).rejects.toThrow(/unknown hardCase/);
  });

  it("rejects a case with no finding", async () => {
    const { finding: _finding, ...noFinding } = wellFormedCase;
    await expect(loadRaw(manifestWith([noFinding]))).rejects.toThrow(/has no finding/);
  });

  it("rejects a case with no ground-truth label", async () => {
    await expect(
      loadRaw(manifestWith([{ ...wellFormedCase, expected: { rationale: "r" } }])),
    ).rejects.toThrow(/must label expected\.supported/);
  });

  it("rejects a case that does not state its retrieval health", async () => {
    await expect(
      loadRaw(manifestWith([{ ...wellFormedCase, absenceConfirmable: "yes" }])),
    ).rejects.toThrow(/must label absenceConfirmable/);
  });

  it("rejects an unattributed case", async () => {
    await expect(
      loadRaw(manifestWith([{ ...wellFormedCase, provenance: { origin: "somewhere" } }])),
    ).rejects.toThrow(/must declare provenance\.origin/);
  });

  it("rejects a non-array citation list", async () => {
    await expect(
      loadRaw(manifestWith([{ ...wellFormedCase, groundedCitations: "x" }])),
    ).rejects.toThrow(/groundedCitations must be an array/);
  });

  it("rejects a citation that is not the shape production emits", async () => {
    // A corpus modelling a citation shape the agents never emit would measure a
    // world that does not exist — the #1016 lesson at the input side.
    await expect(
      loadRaw(manifestWith([{ ...wellFormedCase, groundedCitations: [{ filePath: "a.ts" }] }])),
    ).rejects.toThrow(/is not a valid Citation/);
  });

  it("rejects a dropped citation with an unknown reason", async () => {
    await expect(
      loadRaw(
        manifestWith([
          { ...wellFormedCase, droppedCitations: [{ filePath: "a.ts", reason: "vibes" }] },
        ]),
      ),
    ).rejects.toThrow(/must be \{ filePath, reason \}/);
  });

  it("rejects a dropped citation with no file path", async () => {
    await expect(
      loadRaw(manifestWith([{ ...wellFormedCase, droppedCitations: [{ reason: "vibes" }] }])),
    ).rejects.toThrow(/must be \{ filePath, reason \}/);
  });

  it("parses a well-formed case once every hard case is present", async () => {
    const cases = REQUIRED_HARD_CASES.map((kind, i) => ({
      ...wellFormedCase,
      id: `A-${i}`,
      hardCase: kind,
    }));
    const corpus = await loadRaw(manifestWith(cases));
    expect(corpus.cases).toHaveLength(4);
    expect(corpus.cases[0].finding.tags).toEqual(["x"]);
  });
});
