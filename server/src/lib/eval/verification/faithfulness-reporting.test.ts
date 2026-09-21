/**
 * Epic #1316 (#1318) — `eval:verification` reports the shared claim-level
 * faithfulness metric PER ARM.
 *
 * The acceptance criterion is easy to satisfy vacuously: declare a field, never
 * populate it, and the report gains a column of zeros nobody notices is fake.
 * These tests therefore drive the metric all the way from the arm's `verify`
 * through the scorer, the multi-run fold and both renderers, and pin the three
 * states the report must never collapse into one number:
 *
 *   `undefined` — this arm does not compute the metric (the free baseline);
 *   unverifiable — it tried and could not judge (EXCLUDED from the mean);
 *   a number — supported/total over the claims it actually judged.
 */
import { describe, expect, it, vi } from "vitest";
import type { FindingFaithfulness } from "@metis/shared";
import type { VerifierArm } from "./arms.js";
import { deterministicArm } from "./arms.js";
import type { VerificationCase, VerificationCorpus } from "./corpus.js";
import { panelArm } from "./panel-arm.js";
import { aggregateFaithfulness, scoreCase } from "./scorer.js";
import {
  buildReport,
  runArm,
  runArmRepeated,
  summarizeArmRuns,
  toJsonReport,
  toMarkdownReport,
} from "./runner.js";
import type { AIProvider, ChatOptions, ChatResponse } from "../../ai/types.js";

const FILE = "src/api/auth.ts";

function caseOf(id: string, supported: boolean): VerificationCase {
  return {
    id,
    hardCase: "semantic-mismatch",
    title: `case ${id}`,
    provenance: { origin: "synthesised", source: "unit test", groundTruth: "n/a" },
    finding: { title: `Finding ${id}`, body: `Body of ${id}.` },
    groundedCitations: [{ filePath: FILE, startLine: 1, endLine: 4 }],
    droppedCitations: [],
    absenceConfirmable: true,
    evidence: [{ filePath: FILE, startLine: 1, endLine: 4, excerpt: "export const a = 1;" }],
    expected: { supported, rationale: "unit test" },
  } as VerificationCase;
}

const CORPUS: VerificationCorpus = {
  id: "test-corpus",
  warning: "synthetic",
  provenanceNote: "unit test",
  cases: [caseOf("VC-1", false), caseOf("VC-2", true)],
} as VerificationCorpus;

/** Answers every lens SUPPORTED — the panel contributes no flag of its own. */
class StubProvider implements AIProvider {
  readonly key = "offline-stub" as AIProvider["key"];
  readonly model = "test-model";
  readonly offline = false;
  readonly capabilities = { responseFormat: false, nativeToolCalls: false };
  async chat(_m: unknown[], opts?: ChatOptions): Promise<ChatResponse> {
    const isAbsenceCheck = (opts?.systemMessage ?? "").includes("You verify ABSENCE CLAIMS");
    return {
      content: JSON.stringify(
        isAbsenceCheck
          ? { verdict: "supported", citation: `${FILE}:1`, reasoning: `${FILE}:1 backs it` }
          : { judgement: "supported", citation: `${FILE}:1`, reasoning: `${FILE}:1 backs it` },
      ),
      usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
      model: this.model,
      provider: this.key,
    };
  }
  async *stream(): AsyncGenerator<never> {
    throw new Error("not used");
  }
  async embed(): Promise<never> {
    throw new Error("not used");
  }
  async models(): Promise<string[]> {
    return [this.model];
  }
  async ping(): Promise<boolean> {
    return true;
  }
}

/** Claim/judge doubles: three claims, two supported ⇒ 2/3. */
const TWO_OF_THREE = {
  extractor: {
    decompose: vi.fn(async () => ({
      claims: [{ claim: "c1" }, { claim: "c2" }, { claim: "c3" }],
    })),
  },
  judge: {
    judge: vi.fn(async (claims: string[]) =>
      claims.map((claim, i) => ({ claim, supported: i < 2 })),
    ),
  },
};

/** A judge that cannot return a usable verdict set — UNVERIFIABLE, not zero. */
const UNVERIFIABLE_DEPS = {
  extractor: { decompose: vi.fn(async () => ({ claims: [{ claim: "c1" }] })) },
  judge: { judge: vi.fn(async () => null) },
};

// ── The three states, at the aggregate level ───────────────────────────────

describe("aggregateFaithfulness (#1318)", () => {
  const score = (f: FindingFaithfulness | null | undefined) =>
    scoreCase(
      {
        id: "x",
        hardCase: "semantic-mismatch",
        title: "t",
        expected: { supported: true } as VerificationCase["expected"],
      },
      "confirmed",
      f,
    );

  it("returns null when NO case carried the metric — the arm does not compute it", () => {
    expect(aggregateFaithfulness([score(undefined), score(undefined)])).toBeNull();
  });

  it("EXCLUDES unverifiable cases from the mean rather than scoring them 0", () => {
    const agg = aggregateFaithfulness([
      score({ score: 1, totalClaims: 2, supportedClaims: 2 }),
      score({ score: null, totalClaims: 0, supportedClaims: 0, unverifiableReason: "no-claims" }),
    ]);
    expect(agg).toMatchObject({ mean: 1, scored: 1, unverifiable: 1 });
  });

  it("treats a case the arm could not even attempt as unverifiable, not as a pass", () => {
    const agg = aggregateFaithfulness([
      score({ score: 0.5, totalClaims: 2, supportedClaims: 1 }),
      score(null),
    ]);
    expect(agg).toMatchObject({ mean: 0.5, scored: 1, unverifiable: 1 });
  });

  it("reports mean null — never 1 — when everything was unverifiable", () => {
    const agg = aggregateFaithfulness([score(null), score(null)]);
    expect(agg?.mean).toBeNull();
    expect(agg?.unverifiable).toBe(2);
  });
});

// ── End to end through the arms ────────────────────────────────────────────

describe("the arms report faithfulness per arm (#1318)", () => {
  it("the deterministic baseline reports NOTHING — it cannot read the evidence", async () => {
    const run = await runArm(CORPUS, deterministicArm());
    expect(run.faithfulness).toBeNull();
    for (const s of run.scores) expect("faithfulness" in s).toBe(false);
  });

  it("the panel arm reports nothing unless --faithfulness asked for it", async () => {
    const run = await runArm(CORPUS, panelArm({ provider: new StubProvider() }));
    expect(run.faithfulness).toBeNull();
  });

  it("the panel arm scores every case through production's own scorer when asked", async () => {
    const arm = panelArm({
      provider: new StubProvider(),
      faithfulness: true,
      faithfulnessDeps: TWO_OF_THREE,
    });
    const run = await runArm(CORPUS, arm);
    expect(run.faithfulness).toMatchObject({ scored: 2, unverifiable: 0 });
    expect(run.faithfulness?.mean).toBeCloseTo(2 / 3, 10);
    expect(run.scores[0].faithfulness).toEqual({
      score: 2 / 3,
      totalClaims: 3,
      supportedClaims: 2,
    });
  });

  it("records an unverifiable judge as unverifiable, and the mean stays null", async () => {
    const run = await runArm(
      CORPUS,
      panelArm({
        provider: new StubProvider(),
        faithfulness: true,
        faithfulnessDeps: UNVERIFIABLE_DEPS,
      }),
    );
    expect(run.faithfulness).toMatchObject({ mean: null, scored: 0, unverifiable: 2 });
  });

  it("folds the metric's own round-trips into the arm's reported cost", async () => {
    const withMetric = await runArm(
      CORPUS,
      panelArm({
        provider: new StubProvider(),
        faithfulness: true,
        faithfulnessDeps: TWO_OF_THREE,
      }),
    );
    const withoutMetric = await runArm(CORPUS, panelArm({ provider: new StubProvider() }));
    // The doubles make no provider call, so the metric costs nothing here — the
    // point is that the accounting path exists and does not double-count.
    expect(withMetric.cost.llmCalls).toBe(withoutMetric.cost.llmCalls);
    expect(withMetric.cost.totalTokens).toBe(withoutMetric.cost.totalTokens);
  });

  it("counts the metric's REAL round-trips when it actually calls the provider", async () => {
    // Drive the real ClaimExtractor + FaithfulnessJudge: 2 calls per case.
    const provider = new StubProvider();
    const replies = [
      JSON.stringify({ claims: [{ claim: "c1", sourceIds: [] }] }),
      JSON.stringify({ verdicts: [{ claim: "c1", supported: true, sourceIds: [] }] }),
    ];
    let i = 0;
    vi.spyOn(provider, "chat").mockImplementation(async (_m, opts) => {
      const isLens = (opts?.systemMessage ?? "").length > 0;
      return {
        content: isLens
          ? JSON.stringify({
              judgement: "supported",
              citation: `${FILE}:1`,
              reasoning: `${FILE}:1 backs it`,
            })
          : replies[i++ % 2],
        usage: { promptTokens: 50, completionTokens: 5, totalTokens: 55 },
        model: provider.model,
        provider: provider.key,
      };
    });
    const withMetric = await runArm(CORPUS, panelArm({ provider, faithfulness: true }));
    // 2 cases x (decompose + judge) = 4 metric calls beyond the lens calls.
    expect(withMetric.cost.llmCalls).toBeGreaterThanOrEqual(4);
  });
});

// ── Multi-run fold and rendering ───────────────────────────────────────────

describe("reporting the metric (#1318)", () => {
  const armWith = (deps: typeof TWO_OF_THREE | typeof UNVERIFIABLE_DEPS): VerifierArm =>
    panelArm({ provider: new StubProvider(), faithfulness: true, faithfulnessDeps: deps });

  it("POOLS across runs rather than averaging per-run means", async () => {
    const summary = await runArmRepeated(CORPUS, armWith(TWO_OF_THREE), 3);
    expect(summary.meanFaithfulness).toMatchObject({ scored: 6, unverifiable: 0 });
    expect(summary.meanFaithfulness?.mean).toBeCloseTo(2 / 3, 10);
  });

  it("keeps the summary null for an arm that never computed the metric", async () => {
    const summary = summarizeArmRuns([await runArm(CORPUS, deterministicArm())]);
    expect(summary.meanFaithfulness).toBeNull();
  });

  it("renders n/a — never 0 — for the arm that cannot compute it", async () => {
    const report = buildReport(CORPUS, [
      summarizeArmRuns([await runArm(CORPUS, deterministicArm())]),
    ]);
    const md = toMarkdownReport(report);
    expect(md).toContain("## Faithfulness — the one claim-level metric, shared with docs-gen");
    expect(md).toContain("| deterministic | n/a — arm does not compute it |");
    // No per-case faithfulness column for an arm that has none.
    expect(md).not.toContain(
      "| Case | Hard case | Origin | Expected | Verdict | Outcome | Faithfulness |",
    );
  });

  it("renders the mean, the scored/unverifiable split and a per-case column", async () => {
    const report = buildReport(CORPUS, [
      summarizeArmRuns([await runArm(CORPUS, deterministicArm())]),
      summarizeArmRuns([await runArm(CORPUS, armWith(TWO_OF_THREE))]),
    ]);
    const md = toMarkdownReport(report);
    expect(md).toContain("| panel | 0.6667 (2 scored, 0 unverifiable) | 4 / 6 |");
    expect(md).toContain(
      "| Case | Hard case | Origin | Expected | Verdict | Outcome | Faithfulness |",
    );
    expect(md).toContain("0.6667 (2/3)");
  });

  it("renders an all-unverifiable arm as unverifiable, not as zero", async () => {
    const report = buildReport(CORPUS, [
      summarizeArmRuns([await runArm(CORPUS, armWith(UNVERIFIABLE_DEPS))]),
    ]);
    const md = toMarkdownReport(report);
    expect(md).toContain("unverifiable (0 scored, 2 unverifiable)");
    expect(md).not.toContain("| panel | 0.0000");
  });

  it("carries the metric into the machine-readable artifact as its own key", async () => {
    const report = buildReport(CORPUS, [
      summarizeArmRuns([await runArm(CORPUS, deterministicArm())]),
      summarizeArmRuns([await runArm(CORPUS, armWith(TWO_OF_THREE))]),
    ]);
    const json = toJsonReport(report) as {
      arms: Array<{ arm: string; faithfulness: unknown; quality: unknown; cost: unknown }>;
    };
    expect(json.arms[0].faithfulness).toBeNull();
    expect(json.arms[1].faithfulness).toMatchObject({ scored: 2, unverifiable: 0 });
    // A SIBLING of quality and cost, never folded into either.
    expect(json.arms[1].quality).not.toHaveProperty("faithfulness");
    expect(json.arms[1].cost).not.toHaveProperty("faithfulness");
  });
});
