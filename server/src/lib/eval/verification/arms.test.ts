import { describe, expect, it } from "vitest";
import {
  deterministicArm,
  parseArmSelection,
  resolveArm,
  resolvePanelArm,
  type VerifierArm,
} from "./arms.js";
import {
  DEFAULT_VERIFICATION_CORPUS,
  loadVerificationCorpus,
  resolveVerificationCorpusDir,
  type VerificationCase,
} from "./corpus.js";

function aCase(overrides: Partial<VerificationCase> = {}): VerificationCase {
  return {
    id: "X-1",
    hardCase: "semantic-mismatch",
    title: "t",
    provenance: { origin: "real", source: "s", groundTruth: "g" },
    finding: { title: "A thing is implemented", body: "It is implemented, see the file." },
    groundedCitations: [],
    droppedCitations: [],
    absenceConfirmable: true,
    evidence: [],
    expected: { supported: false, rationale: "r" },
    ...overrides,
  };
}

describe("deterministicArm", () => {
  const arm = deterministicArm();

  it("declares itself free of model calls", () => {
    expect(arm.usesLlm).toBe(false);
    expect(arm.id).toBe("deterministic");
  });

  it("costs zero tokens — the whole point of the baseline", async () => {
    const verdict = await arm.verify(aCase());
    expect(verdict.usage).toBeUndefined();
  });

  it("confirms a finding whose code citation survived the #734 gate", async () => {
    const verdict = await arm.verify(
      aCase({
        groundedCitations: [{ filePath: "a.ts", startLine: 1, endLine: 2 }],
      }),
    );
    expect(verdict.status).toBe("confirmed");
  });

  it("marks a finding unverified when every code citation was dropped", async () => {
    const verdict = await arm.verify(
      aCase({ droppedCitations: [{ filePath: "gone.ts", reason: "file-not-retrieved" }] }),
    );
    expect(verdict.status).toBe("unverified");
  });

  it("abstains (null) when the finding made no code-evidence claim", async () => {
    expect((await arm.verify(aCase())).status).toBeNull();
  });

  it("CALLS the real absence classifier rather than reading a corpus label", async () => {
    // VC-12's shape: the primary claim is positive, but a subordinate clause
    // trips the deliberately-generous ABSENCE_PATTERNS. If the arm read a label
    // instead of calling `assertsAbsence`, this would abstain.
    const verdict = await arm.verify(
      aCase({
        finding: {
          title: "Retries use capped exponential backoff",
          body: "Backoff is capped at 30s. Note there is no dedicated handling for 429 responses.",
        },
        absenceConfirmable: false,
      }),
    );
    expect(verdict.status).toBe("could-not-verify");
  });

  it("ranks the #773 absence rule above a surviving citation", async () => {
    const verdict = await arm.verify(
      aCase({
        finding: { title: "No evidence found for X", body: "Not implemented." },
        groundedCitations: [{ filePath: "a.ts", startLine: 1, endLine: 2 }],
        absenceConfirmable: false,
      }),
    );
    expect(verdict.status).toBe("could-not-verify");
  });
});

describe("resolvePanelArm", () => {
  it("throws a named error until #1109 wires a factory", () => {
    expect(() => resolvePanelArm()).toThrow(/not wired yet \(#1109\)/);
  });

  it("refuses to fall back to the baseline under a panel label", () => {
    // Reporting baseline numbers under a panel label is the #1016 defect.
    expect(() => resolvePanelArm()).toThrow(/will NOT fall back to the baseline/);
  });

  it("returns the injected arm once a factory exists", () => {
    const fake: VerifierArm = {
      id: "panel",
      label: "fake",
      usesLlm: true,
      verify: async () => ({ status: null }),
    };
    expect(resolvePanelArm(() => fake)).toBe(fake);
  });
});

describe("resolveArm", () => {
  it("resolves the deterministic arm without a factory", () => {
    expect(resolveArm("deterministic").id).toBe("deterministic");
  });

  it("routes `panel` through the panel resolver", () => {
    expect(() => resolveArm("panel")).toThrow(/#1109/);
  });
});

describe("parseArmSelection", () => {
  it("defaults to the arm that runs offline", () => {
    expect(parseArmSelection(["node", "x"])).toEqual(["deterministic"]);
  });

  it("reads each explicit selection", () => {
    expect(parseArmSelection(["--arm", "panel"])).toEqual(["panel"]);
    expect(parseArmSelection(["--arm", "deterministic"])).toEqual(["deterministic"]);
    expect(parseArmSelection(["--arm", "both"])).toEqual(["deterministic", "panel"]);
  });

  it("throws on an unknown arm rather than silently defaulting", () => {
    expect(() => parseArmSelection(["--arm", "panl"])).toThrow(/unknown --arm/);
  });

  it("treats a trailing --arm with no value as the default", () => {
    expect(parseArmSelection(["--arm"])).toEqual(["deterministic"]);
    expect(parseArmSelection(["--arm", "--md"])).toEqual(["deterministic"]);
  });
});

describe("the baseline arm on the committed corpus", () => {
  it("reproduces the verdict each case's rationale predicts", async () => {
    const corpus = await loadVerificationCorpus(
      resolveVerificationCorpusDir(DEFAULT_VERIFICATION_CORPUS),
    );
    const arm = deterministicArm();
    const actual: Record<string, string> = {};
    for (const c of corpus.cases) actual[c.id] = String((await arm.verify(c)).status);

    // This is the measured baseline, pinned. If production's `verifyFinding` or
    // `assertsAbsence` changes behaviour, THIS test names the case that moved —
    // which is the only way the recorded floors below stay honest.
    expect(actual).toEqual({
      "VC-01": "confirmed", // absence contradicted by its own citation — MISSED
      "VC-02": "null", // supported absence, correctly not flagged
      "VC-03": "confirmed", // semantic mismatch — MISSED (the case A1 exists for)
      "VC-04": "confirmed", // well-grounded, correctly not flagged
      "VC-05": "unverified", // hallucinated citation — CAUGHT, for free
      "VC-06": "could-not-verify", // degraded-retrieval absence — CAUGHT, for free
      "VC-07": "null", // doc-only supported, abstained
      "VC-08": "null", // doc-only overstatement — MISSED (docs are never validated)
      "VC-09": "confirmed", // survivor backs the claim despite a drop
      "VC-10": "confirmed", // survivor is tangential — MISSED
      "VC-11": "unverified", // OVER-FLAG: backed by a retrieved document
      "VC-12": "could-not-verify", // OVER-FLAG: generous absence classifier
    });
  });
});
