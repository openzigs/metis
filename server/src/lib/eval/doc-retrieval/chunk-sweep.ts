/**
 * Epic #1156 / Issue #1160 — the chunk-size sweep: arms, the PRE-REGISTERED
 * decision rule, and the report.
 *
 * ## What #1184 changed, and what it deliberately did not
 *
 * #1184 re-opened the size question on a corpus sized for it rather than inherited.
 * Three changes, all of them to the instrument and none to the bar:
 *
 *   - **The corpus.** `queriesNeededForHalfWidth`, run over #1183's committed intervals
 *     (`power-sizing.ts`), put the size arms at roughly 100–190 queries to resolve their
 *     own +0.04 floor against the 48 available — so the arms were not merely null, they
 *     were unresolved AT THE FLOOR, which the overlap arms were not. That number bought
 *     a GO, and `docretrieval-02-metis-docs-wide` is what it bought.
 *   - **Overlap is held at the constant absolute {@link SIZE_ARM_OVERLAP}**, not at a
 *     constant ratio; see that constant for why #1183's overlap null is what licenses it.
 *   - **`all` is the decision statistic**, and every stratum row is a diagnostic beside
 *     it. This was true before #1184 and is restated because #1160's published verdict
 *     was read off `arm-sensitive ∧ coverage-clean`, which on this corpus is exactly the
 *     subset that discards the movers.
 *
 * {@link MIN_IMPORTANT_NDCG_DELTA} did not move, and a bar that survives a re-measurement
 * unchanged is the point of pre-registering it.
 *
 * ## What the wide corpus measured
 *
 * On `all`, 198 queries: `size-3072` +0.004 (p = 0.780), `size-1024` −0.026 (p = 0.422),
 * `size-768` −0.084 with CI [−0.122, −0.047] (p = 0.000). **Nothing clears the floor
 * upward, so `DEFAULT_RAG_CHUNK_SIZE` stays at 2048** — but this is now a RESOLVED null:
 * the run's own intervals need 109 / 174 / 85 queries at ±0.04 against the 198 run, where
 * 48 could not have resolved any arm. `size-768`'s `ciHigh` is −0.046914 (the artefact's
 * −0.047 is the rounded display value), so its whole interval lies beyond the
 * pre-registered ±0.04 floor and the smallest arm is established *worse* by more than the
 * floor rather than merely unhelpful.
 *
 * Two cautions a future reader needs. ±0.03 (308 queries) and ±0.02 (693) are still out of
 * reach at the pre-registered ceiling, so a sub-floor difference between 2048 and 3072 is
 * unproven and that is not the same claim as no effect. And the strata disagree with the
 * aggregate on every size arm — `arm-sensitive` reaches DIRECTION-ESTABLISHED on 1024 at
 * −0.054 while the complement it discards reads +0.023, opposite signs — which is the
 * unadjusted-subgroup behaviour described below, not new information.
 *
 * ## Read the units before reasoning about the hypothesis
 *
 * `DEFAULT_RAG_CHUNK_SIZE = 2048` and `DEFAULT_RAG_CHUNK_OVERLAP = 256`
 * (`packages/shared/src/constants.ts:547,550`) are **characters**, so today's
 * document chunk is already ≈512 tokens — at the *bottom* of the band usually
 * recommended for precise retrieval, not above it. "Chunks are too large" does
 * not survive the unit check, and #1160 does not assert it.
 *
 * The genuinely open question is whether going **smaller** helps. It is a
 * hypothesis, so it is tested in both directions: 768 and 1024 below the control,
 * and 3072 above it. An arm that only looks downward would confirm whichever way
 * the prior happened to point.
 *
 * ## The decision rule is pre-registered, and it is #1158's, not a new one
 *
 * {@link MIN_IMPORTANT_NDCG_DELTA} is a committed constant, fixed before the first
 * arm runs, so the bar cannot be moved to fit the result. Classification reuses
 * {@link classifyDelta} and {@link testsAgree} from the rerank sweep by IMPORT
 * rather than by copy — a second implementation of a decision rule is a decision
 * rule that will eventually disagree with itself.
 *
 * The rule, restated so the artefact is self-contained: a bootstrap CI excluding
 * zero establishes DIRECTION; it establishes MAGNITUDE only when its lower bound
 * also clears the pre-registered floor. **On disagreement between the bootstrap
 * interval and the exact sign test, the sign test wins** — it assumes nothing
 * about the size of the differences, and bootstrap tail coverage degrades when the
 * delta vector is sparse. #1158's pool-20 arm was a live instance: CI
 * [−0.106, −0.013] with sign p = 0.117, classified NOT-ESTABLISHED.
 *
 * ## Why the arm-sensitive stratum exists — and what #1183 MEASURED about it
 *
 * `chunkMarkdown` splits on ATX headings FIRST and only then slides a window
 * within each section, so a section already shorter than the smallest arm's chunk
 * size produces one identical chunk at every arm. The stratum was built on the
 * inference that a query whose answer span lives in such a section is therefore
 * *structurally incapable of moving* — delta exactly zero at every arm, by
 * construction rather than by measurement.
 *
 * **That inference is FALSIFIED, on all six arms of #1183's committed run.**
 * `armSensitiveQueryIds` compares only the BEST-COVERING chunk's text, so a query
 * counts as insensitive when *its own* answer chunk is byte-identical at both arms —
 * but nDCG is a property of the whole ranked list, and the competing chunks moved.
 * Movers OUTSIDE the stratum, arm by arm: 7 / 5 / 6 on the overlap arms and
 * 10 / 7 / 5 on `size-3072` / `size-1024` / `size-768`. Never zero.
 *
 * Two consequences, both load-bearing for #1184:
 *
 *   - The stratum is **not a superset of the movement**, so it is a diagnostic rather
 *     than a more powerful test, and `all` is the headline. {@link renderChunkSweep}
 *     fires its callout on ANY mover outside the stratum — not only when the
 *     complement happens to hold the majority, which would stay silent on exactly the
 *     two size arms #1184 re-measures.
 *   - Restricting to it is an **unadjusted subgroup selection**, not a
 *     power-preserving filter. On `size-1024` the stratum reads −0.002 (p = 1.000)
 *     while the subset it DISCARDS reads +0.065 (p = 0.016): opposite signs, and the
 *     complement carries the only verdict anywhere in the run that is not
 *     NOT-ESTABLISHED. A p-value computed on the stratum is not the isolating test it
 *     reads as.
 *
 * The reason for reporting both survives intact. Removing queries silently would be
 * the #1159 mistake in reverse — that PR's headline +0.053 (p=0.004) degraded to
 * +0.022 (p=0.125, NOT-ESTABLISHED) once five flattered queries were dropped, and the
 * lesson recorded was to **report the decision statistic on both the stratum and the
 * excluded subset**. So {@link compareChunkArm} computes the comparison three ways —
 * all queries, the stratum, and its complement — all three are printed, and a VERDICT
 * disagreement between the last two is a finding, not a nuisance.
 *
 * ## Two coverage controls, because one of them does not isolate
 *
 * An arm can move a score two ways at once: by RANKING differently, and by changing
 * how much of the answer span is in the index at all (#1178). Separating them takes
 * two subsets, not one, and the difference decides what may be claimed:
 *
 *   - `ranking only` excludes queries whose span the chunker DROPPED at either arm.
 *     It is one notch short of isolating, because it keeps spans that were merely
 *     **straddled** — split across two chunks, of which only the max-overlap one is
 *     graded relevant, so returning the sibling scores 0. Measured on the committed
 *     corpus, 1024 drops 2 spans but straddles 8, so `ranking only` removes 2 of the
 *     10 queries whose coverage actually changed.
 *   - `coverage-clean` keeps only queries whose span is FULLY covered at both arms
 *     ({@link COVERAGE_CLEAN_THRESHOLD}). That is the subset on which a delta is
 *     attributable to ranking.
 *
 * This is not bookkeeping: on `size-1024` the arm-sensitive verdict is
 * DIRECTION-ESTABLISHED before cleaning and NOT-ESTABLISHED after, so the two
 * subsets support different sentences. `arm-sensitive ∧ clean` is therefore reported
 * as its own row rather than left for a reader to intersect.
 *
 * **The index-level confound that made every pre-#1178 number unreadable is FIXED.**
 * The arms used to index 94.1% / 85.6% / 80.4% of the corpus's characters
 * (2048 / 1024 / 768) — four chunkings of corpora differing by 14 points of content,
 * where differential content loss MIMICS a chunk-size effect, so no doc-path number
 * could be attributed. #1178 gave `chunkMarkdown` its tiling property and #1183
 * re-ran the sweep: span coverage is now **1.000, with 0 spans dropped and 0
 * straddled at every arm**, so `ranking only` and `coverage-clean` are the whole
 * corpus and cannot differ from `all` on the committed run. Both subsets are retained
 * as the cheapest available regression detector — a non-empty `spans DROPPED` column
 * means the tiling property has gone again.
 */
import { resolveChunkParams } from "../../rag/chunker.js";
import {
  classifyDelta,
  MIN_IMPORTANT_DELTA,
  testsAgree,
  type RerankVerdict,
} from "../embed-retrieval/rerank-sweep.js";
import { compareArms, type PairedComparison } from "../embed-retrieval/stats.js";
import {
  PRIOR_RUN_QUERY_COUNT,
  PRIOR_RUN_SIZING,
  renderCorpusSizing,
  type SizingInput,
} from "./power-sizing.js";
import { renderRerankBudget, type RerankBudgetProfile } from "./rerank-budget.js";
import type { ChannelMetrics, QueryScore } from "../embed-retrieval/metrics.js";

/**
 * Retrieval depth scored. nDCG@10 is the epic's headline metric.
 *
 * **Held FIXED across arms on purpose**, even though that hands the large arms more
 * characters per slot: production retrieves a fixed *count*
 * (`DEFAULT_RETRIEVE_K = 5`, `packages/shared/src/constants.ts:602`), not a fixed
 * character budget, so fixed-k is the deployment-relevant comparison. The alternative
 * — matched context budgets, k = 10/20/27 — was measured and leaves the ordering
 * unchanged (0.756 / 0.663 / 0.641); see `chunk-alignment.ts`'s header for the table.
 * Recorded here so the next reader does not re-derive it.
 */
export const DOC_EVAL_K = 10;

/**
 * Span coverage above which a query counts as coverage-clean at an arm.
 *
 * Not `=== 1`: coverage is a ratio of integer character counts, so an exactly-covered
 * span can land a float ulp below one. Anything genuinely straddled is far below this.
 */
export const COVERAGE_CLEAN_THRESHOLD = 0.999;

/**
 * The minimum practically-important nDCG@10 delta, PRE-REGISTERED.
 *
 * Fixed at #1160's stated target (≥ +0.04 over the 2048 control), which is also
 * {@link MIN_IMPORTANT_DELTA}, the floor #1158 pre-registered. Held identical on
 * purpose: two sub-issues of one epic reporting against two different bars would
 * make their verdicts incomparable.
 */
export const MIN_IMPORTANT_NDCG_DELTA = MIN_IMPORTANT_DELTA;

/** Overlap as a fraction of chunk size — the shipped 256/2048 ratio. */
export const OVERLAP_RATIO = 0.125;

/** The chunk size shipped today, and the sweep's control arm. */
export const CONTROL_CHUNK_SIZE = 2048;

/**
 * Absolute overlap every size arm requests — the control's own 256 (#1184).
 *
 * The size arms used to hold overlap at a constant RATIO (1024/128, 768/96, 3072/384),
 * on the reasoning that a fixed ratio is what keeps the arms comparable in scale. That
 * was the right call while overlap was unmeasured; it is the wrong one now. #1183 ran
 * the ladder 0 / 128 / 256 / 512 at this size and found a **measured null** — every arm
 * NOT-ESTABLISHED, the largest effect +0.005, and removing carry-over entirely costing
 * −0.002 — so a ratio-held overlap buys nothing and charges a second moving part to
 * every size delta. Holding the absolute value constant makes chunk size the only
 * parameter that differs from the control.
 *
 * **768 is the exception and it is visible rather than silent.** `resolveChunkParams`
 * caps carry-over at `maxOverlapFor(chunkSize)` ≈ `chunkSize / 4` (#1185), which is 192
 * at 768, so that arm runs at 192 and the artefact prints `CLAMPED from 256`. Requesting
 * the constant and letting the documented cap show is deliberate: the alternative —
 * writing 192 into the arm — states a number without stating why it differs, and #1183's
 * lesson is that the dangerous overlap value is the one nobody can see was changed.
 */
export const SIZE_ARM_OVERLAP = 256;

/** One point in the sweep. */
export interface ChunkArmSpec {
  id: string;
  chunkSize: number;
  overlap: number;
  /** True for the arm that reproduces today's shipped configuration. */
  control: boolean;
  /** Why this arm is in the sweep — printed into the artefact. */
  rationale: string;
}

/** Overlap held at {@link OVERLAP_RATIO} for a given chunk size. */
export function ratioOverlap(chunkSize: number): number {
  return Math.round(chunkSize * OVERLAP_RATIO);
}

/**
 * The size sweep: the control, two smaller arms, one larger.
 *
 * Overlap is held at the constant ABSOLUTE {@link SIZE_ARM_OVERLAP} across all four, so
 * chunk size is the only parameter that differs from the control. Sweeping overlap at
 * the same time would confound the two and neither would be attributable — the
 * #931-vs-#936 lesson #1156 is built on — and holding it at a constant *ratio*, as
 * these arms did before #1184, is a milder form of the same thing now that #1183 has
 * measured overlap to be a null at this size.
 */
export const CHUNK_SIZE_ARMS: readonly ChunkArmSpec[] = [
  {
    id: "size-2048",
    chunkSize: CONTROL_CHUNK_SIZE,
    overlap: SIZE_ARM_OVERLAP,
    control: true,
    rationale: "Shipped default (DEFAULT_RAG_CHUNK_SIZE / DEFAULT_RAG_CHUNK_OVERLAP), ≈512 tokens.",
  },
  {
    id: "size-1024",
    chunkSize: 1024,
    overlap: SIZE_ARM_OVERLAP,
    control: false,
    rationale:
      "≈256 tokens — the smaller-is-more-precise hypothesis, and the arm #1178 moved from " +
      "−0.111 to +0.024 once the chunker tiled.",
  },
  {
    id: "size-768",
    chunkSize: 768,
    overlap: SIZE_ARM_OVERLAP,
    control: false,
    rationale:
      "≈192 tokens — the smallest arm #1160 names. The chunker caps carry-over at 192 here, " +
      "so this is the one arm whose overlap the cap moves off the constant (#1185).",
  },
  {
    id: "size-3072",
    chunkSize: 3072,
    overlap: SIZE_ARM_OVERLAP,
    control: false,
    rationale: "≈768 tokens — tests the hypothesis UPWARD so the sweep is not one-sided.",
  },
];

/**
 * How an arm's REQUESTED overlap survives {@link resolveChunkParams}' cap (#1185).
 *
 * `ChunkArmSpec.overlap` is what the arm asks for; `chunkMarkdown` carries over
 * `min(requested, maxOverlapFor(chunkSize))` ≈ `chunkSize / 4`. Those differ silently,
 * and every place this sweep prints or divides by an overlap has to use the EFFECTIVE
 * value or it describes a run that did not happen — see {@link overlapArmsFor}.
 */
export interface ArmOverlap {
  /** What `chunkMarkdown` actually carries over — the number to print and divide by. */
  effective: number;
  /** What the arm asked for. */
  requested: number;
  /** `maxOverlapFor(chunkSize)`. */
  maxOverlap: number;
  clamped: boolean;
  /**
   * The chunk size `chunkMarkdown` will actually use — `resolveChunkParams` normalises
   * it too (`max(64, floor(size))`, with a 2048 fallback for non-finite).
   *
   * Carried for the same reason as {@link ArmOverlap.effective}: an arm id or ratio
   * built from the RAW size would name a chunk size the run did not use — the identical
   * label-vs-effective defect #1183 fixed for overlap, left standing for size.
   * Unreachable with today's hand-written {@link CHUNK_SIZE_ARMS}, and #1184 adds size
   * arms; the lesson #1183 recorded is that a COMPUTED value is the one a grep audit
   * misses.
   */
  chunkSize: number;
}

/**
 * Resolve one arm's overlap against the chunker's cap.
 *
 * Calls `resolveChunkParams` — the SAME function `chunkMarkdown` calls at
 * `chunker.ts:289` — rather than re-deriving from `maxOverlapFor`, so the two cannot
 * drift arithmetically. That coupling is the point, and it is pinned by a test that
 * chunks a real document at a clamped overlap and asserts byte-identical output to the
 * same call at `effective`; asserting against `maxOverlapFor` alone would pin this to a
 * formula rather than to the path `chunkMarkdown` takes.
 */
export function armOverlap(chunkSize: number, overlap: number): ArmOverlap {
  const resolved = resolveChunkParams({ chunkSize, overlap });
  return {
    effective: resolved.overlap,
    requested: resolved.requestedOverlap,
    maxOverlap: resolved.maxOverlap,
    clamped: resolved.requestedOverlap > resolved.maxOverlap,
    chunkSize: resolved.chunkSize,
  };
}

/** An overlap printed as it will actually behave, with the clamp made visible. */
export function renderOverlapValue(chunkSize: number, overlap: number): string {
  const o = armOverlap(chunkSize, overlap);
  return o.clamped
    ? `${o.effective} (CLAMPED from ${o.requested}, cap ${o.maxOverlap})`
    : `${o.effective}`;
}

/**
 * The overlap ladder for #1183, run at ONE chunk size.
 *
 * PRE-REGISTERED: this array and {@link MIN_IMPORTANT_NDCG_DELTA} were committed
 * before the first arm ran, so neither the arms nor the bar can be chosen to fit the
 * result. 256 is the control's own value and is therefore not re-run as an arm; 0 is
 * the falsifying arm — if overlap does nothing, no-carry-over scores the control.
 */
export const OVERLAP_LADDER: readonly number[] = [0, 128, 256, 512];

/**
 * Ladder values a {@link CHUNK_SIZE_ARMS} entry already runs at this size.
 *
 * Re-running one would be the same chunking measured twice, so {@link overlapArmsFor}
 * skips it — and the artefact has to NAME what it skipped. Both call this rather than
 * spelling the predicate twice: the renderer used to hardcode "256 is the control
 * itself", which this epic exists to make movable. The moment
 * `DEFAULT_RAG_CHUNK_OVERLAP` changes, a hardcoded sentence describes a run that did
 * not happen — the genus of defect #1183 is about.
 *
 * **The comparison is against the EFFECTIVE overlap, and #1184 is why.** Holding the size
 * arms at the absolute {@link SIZE_ARM_OVERLAP} put a *requested* 256 on the 768 arm,
 * which the chunker clamps to 192. Matching on the request made `ladderArmsAlreadyRun(768)`
 * claim that `size-768` already runs the ladder's 256 — while {@link overlapArmsFor} was
 * simultaneously excluding 256 at that size because the cap forbids it. One artefact would
 * then have printed both "not run at 768: 256 (chunker cap 192)" and "256 (`size-768`)
 * already runs as a size arm here", which cannot both be true. The arm runs at 192, 192 is
 * not a ladder value, and nothing is skipped.
 */
export function ladderArmsAlreadyRun(chunkSize: number): ChunkArmSpec[] {
  return CHUNK_SIZE_ARMS.filter(
    (a) =>
      a.chunkSize === chunkSize &&
      OVERLAP_LADDER.includes(armOverlap(a.chunkSize, a.overlap).effective),
  );
}

/** {@link overlapArmsFor}'s output: the arms that will run, and what the cap forbade. */
export interface OverlapArmPlan {
  chunkSize: number;
  arms: ChunkArmSpec[];
  /**
   * Ladder values `chunkMarkdown` would silently clamp at this size. NOT run, and
   * named in the artefact — a silently DROPPED arm is the same class of defect as a
   * silently clamped one.
   */
  excluded: { requested: number; maxOverlap: number }[];
}

/**
 * The overlap arms, at a FIXED chunk size and honouring the chunker's cap.
 *
 * **This arm was UNINTERPRETABLE when #1160 ran it, and is readable now.** The
 * pre-#1178 chunker delivered 19.2% of the configured overlap, so two overlap settings
 * at one chunk size produced two nearly identical chunkings and their near-equal scores
 * said nothing about overlap; #1160's overlap result was withdrawn for that reason
 * rather than believed. Since #1178 the window resumes at the cut and 98–99% is
 * delivered. {@link renderOverlapDelivery} still prints the realised-vs-configured
 * table beside the arms and computes the verdict from it, so a future regression
 * re-flags them instead of silently reinstating the old error.
 *
 * ## Why the arms are clamp-aware, and why a grep could not have found this (#1183)
 *
 * This function used to derive its overlap from the chunk size — `ratioOverlap(size)`,
 * then "256, or 512 when 256 is already the ratio". #1185 then capped `overlap` at
 * `maxOverlapFor(chunkSize)` ≈ `chunkSize / 4`, and at a 768 winner the derived 256
 * exceeded that cap of 192. `chunkMarkdown` clamped it, the arm ran at 192 / 25%, and
 * the arm id and rationale both said 256 / 33%: an overlap A/B **mislabelling its own
 * arms**. Worse, `measureOverlapDelivery` divided by the CONFIGURED value.
 *
 * That denominator lied in BOTH directions, which is why no single symptom exposes it.
 * At 768/256 it UNDERSTATED delivery — a quarter of the apparent shortfall charged to
 * #1178's tiling rather than to the clamp — yet still read 0.74, comfortably over the
 * `OVERLAP_INTERPRETABLE_FRACTION` bar of 0.5, so the READABLE/UNINTERPRETABLE guard
 * did not misfire and the error was invisible. At 1024/512 it reads **0.496** and at
 * 768/512 **0.371**: below the bar, so the same bug would have stamped UNINTERPRETABLE
 * over a chunker delivering 99% and thrown away a valid measurement. The value was
 * COMPUTED, not written, so #1185's own grep-for-literals caller audit could not see it.
 *
 * So: only overlaps the cap permits are requested, the rest are reported in
 * {@link OverlapArmPlan.excluded}, and everything downstream divides by
 * {@link armOverlap}'s effective value.
 *
 * ## Why a FIXED size rather than the winning one
 *
 * Every arm is paired against the 2048/256 control. An overlap arm run at the winning
 * size is therefore a comparison in which size AND overlap both moved — the exact
 * confound #1183 exists to remove, and the reason #1160 could not answer the overlap
 * question. At {@link CONTROL_CHUNK_SIZE} overlap is the only free variable.
 */
export function overlapArmsFor(chunkSize: number): OverlapArmPlan {
  const arms: ChunkArmSpec[] = [];
  const excluded: { requested: number; maxOverlap: number }[] = [];
  for (const requested of OVERLAP_LADDER) {
    const o = armOverlap(chunkSize, requested);
    if (o.clamped) {
      excluded.push({ requested, maxOverlap: o.maxOverlap });
      continue;
    }
    // A ladder value that reproduces an arm `CHUNK_SIZE_ARMS` already runs — the
    // control's own 256 at 2048 — would be the same chunking measured twice. Compared on
    // the EFFECTIVE overlap on both sides: two arms are the same chunking when the
    // chunker carries the same number of characters over, not when they ask for it.
    if (
      ladderArmsAlreadyRun(chunkSize).some(
        (a) => armOverlap(a.chunkSize, a.overlap).effective === o.effective,
      )
    ) {
      continue;
    }
    // Both the id and the ratio use the RESOLVED size, never the raw argument — see
    // `ArmOverlap.chunkSize`.
    const pct = Math.round((o.effective / o.chunkSize) * 100);
    arms.push({
      id: `overlap-${o.chunkSize}-${o.effective}`,
      chunkSize: o.chunkSize,
      overlap: o.effective,
      control: false,
      rationale:
        o.effective === 0
          ? `No carry-over at the fixed ${chunkSize} control size — the FALSIFYING arm. If ` +
            `overlap does nothing, this scores the control.`
          : `Overlap ${o.effective} chars (${pct}% ratio) at the fixed ${chunkSize} control ` +
            `size, so overlap is the only free variable against the control. Chunker cap ` +
            `here is ${o.maxOverlap}.`,
    });
  }
  return { chunkSize, arms, excluded };
}

/** The plan as one progress line, so a clamped-away arm is visible while the sweep runs. */
export function describeOverlapPlan(plan: OverlapArmPlan): string {
  const arms = plan.arms.map((a) => a.overlap).join(", ") || "none";
  const excluded =
    plan.excluded.map((e) => `${e.requested} > cap ${e.maxOverlap}`).join(", ") || "none";
  return `Overlap ladder at ${plan.chunkSize}: ${arms} (excluded by the chunker's cap: ${excluded})`;
}

/** Everything one arm produced. */
export interface ChunkArmResult {
  spec: ChunkArmSpec;
  /** Chunks the corpus produced at this arm. */
  chunkCount: number;
  /** Wall-clock seconds spent ingesting + embedding the whole corpus. */
  reindexSeconds: number;
  /** Per-query scores against the span-derived relevant chunk. */
  perQuery: QueryScore[];
  metrics: ChannelMetrics;
  /**
   * Mean fraction of each answer span held by its best-covering chunk. Below 1.0
   * means spans are straddling boundaries — the quality cost of a small chunk that
   * the max-overlap relevance rule deliberately does not charge to nDCG.
   */
  meanSpanCoverage: number;
  /**
   * Per-query span coverage at this arm, keyed by query id; 0 for a dropped span.
   *
   * A plain record rather than a `Map` because the whole result is serialised into
   * the committed JSON artefact, where a `Map` renders as `{}`.
   */
  spanCoverage: Record<string, number>;
  /**
   * Characters adjacent chunks actually SHARE across the whole corpus at this arm,
   * and what a correctly tiled window would have produced. The ratio is ~2% (#1178),
   * which is what makes the overlap arm uninterpretable rather than a measured null.
   */
  realisedOverlapChars: number;
  expectedOverlapChars: number;
  /**
   * Query ids whose best-covering chunk TEXT differs from the control's. These are
   * the only queries whose score can move; see this module's header.
   */
  sensitiveQueryIds: string[];
  /**
   * Query ids whose answer span the chunker DROPPED at this arm, scored 0.
   *
   * Expected to be EMPTY since #1178 gave `chunkMarkdown` its tiling property. It
   * is retained because a non-empty list is the cheapest possible detector for that
   * regression: before the fix it held 2 ids at 1024/128 and 5 at 768/96. See
   * `wired-harness.ts`'s `relevantChunksForArm` for the mechanism.
   */
  uncoveredQueryIds: string[];
}

/** Per-query nDCG@10, keyed by query id — the input {@link compareArms} wants. */
export function ndcgByQuery(perQuery: readonly QueryScore[]): Map<string, number> {
  return new Map(perQuery.map((q) => [q.queryId, q.ndcgAtK[DOC_EVAL_K] ?? 0]));
}

/** A paired comparison plus the classification it earns. */
export interface ClassifiedComparison {
  paired: PairedComparison;
  verdict: RerankVerdict;
  /** False when the bootstrap interval and the sign test point different ways. */
  agree: boolean;
  /** Deltas that are not exactly zero — sparse deltas degrade bootstrap coverage. */
  nonZeroDeltas: number;
}

function classify(paired: PairedComparison, nonZeroDeltas: number): ClassifiedComparison {
  return {
    paired,
    verdict: classifyDelta(paired, MIN_IMPORTANT_NDCG_DELTA),
    agree: testsAgree(paired),
    nonZeroDeltas,
  };
}

/** One arm judged against the control, on all queries AND on the sensitive subset. */
export interface ChunkArmComparison {
  armId: string;
  chunkSize: number;
  overlap: number;
  ndcgAt10: number;
  recallAt10: number;
  mrr: number;
  chunkCount: number;
  chunkMultiplier: number;
  reindexSeconds: number;
  meanSpanCoverage: number;
  /** Every query in the corpus. */
  all: ClassifiedComparison;
  /**
   * Only queries whose chunking actually changed. `null` when the arm re-chunked
   * nothing — an arm identical to the control has no subset to compare, and
   * inventing one would be a comparison over nothing.
   */
  sensitive: ClassifiedComparison | null;
  sensitiveCount: number;
  /**
   * The COMPLEMENT of the arm-sensitive stratum — every query the stratum excluded.
   *
   * #1159's lesson, applied: its headline +0.053 (p=0.004) degraded to +0.022
   * (p=0.125, NOT-ESTABLISHED) once five flattered queries were removed, and all five
   * were among its nine movers. So an excluded subset is reported, never merely
   * excluded.
   *
   * It is not the formality it looks. `armSensitiveQueryIds` compares only the
   * best-covering chunk TEXT, so a query is "insensitive" when ITS answer chunk is
   * byte-identical at both arms — but ranking is a property of the whole index, and
   * every other chunk may have moved. On #1183's overlap arms the complement carried
   * MORE movers than the stratum (7 vs 1 at `overlap-2048-0`), which means the stratum
   * is not a superset of the movement and cannot be read as one.
   */
  sensitiveExcluded: ClassifiedComparison | null;
  sensitiveExcludedCount: number;
  /**
   * The isolating control. An arm can change the score two ways at once: by
   * re-ranking, and by DROPPING an answer span out of the index entirely (possible
   * whenever the chunker fails to tile — see `wired-harness.ts`). Restricting
   * to queries whose span survives at BOTH this arm and the control removes the
   * coverage channel and leaves the ranking change alone, so a delta can be
   * attributed instead of merely observed. `null` when no such query exists.
   */
  rankingOnly: ClassifiedComparison | null;
  /**
   * The subset that actually isolates ranking: queries whose span is FULLY covered
   * at BOTH this arm and the control. `rankingOnly` excludes dropped spans but keeps
   * straddled ones, so a delta measured on it is still part coverage; see this
   * module's header. `null` when no query qualifies.
   */
  coverageClean: ClassifiedComparison | null;
  coverageCleanCount: number;
  /**
   * `arm-sensitive ∧ coverage-clean` — the only subset that is both capable of
   * moving and free of coverage loss. Reported as its own row because the two
   * subsets can carry different verdicts, which on `size-1024` they do.
   */
  sensitiveClean: ClassifiedComparison | null;
  sensitiveCleanCount: number;
  /** Spans this arm dropped that the control kept, and vice versa. */
  uncoveredCount: number;
  controlUncoveredCount: number;
  /** Spans this arm STRADDLED (covered, but not wholly, by one chunk). */
  straddledCount: number;
  /** Realised vs configured overlap at this arm — see {@link ChunkArmResult}. */
  realisedOverlapChars: number;
  expectedOverlapChars: number;
}

function countNonZero(a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): number {
  let n = 0;
  for (const [id, av] of a) {
    const bv = b.get(id);
    if (bv !== undefined && av - bv !== 0) n += 1;
  }
  return n;
}

/**
 * Compare one arm against the control on per-query nDCG@10.
 *
 * `armId` is the FIRST argument to {@link compareArms}, so a positive `meanDelta`
 * means the arm beat the control — the direction a reader will assume.
 */
export function compareChunkArm(
  control: ChunkArmResult,
  arm: ChunkArmResult,
  opts: { seed?: number; resamples?: number } = {},
): ChunkArmComparison {
  const controlScores = ndcgByQuery(control.perQuery);
  const armScores = ndcgByQuery(arm.perQuery);

  const all = classify(
    compareArms(
      `${arm.spec.id} vs control (all queries)`,
      arm.spec.id,
      control.spec.id,
      armScores,
      controlScores,
      opts,
    ),
    countNonZero(armScores, controlScores),
  );

  const compareOn = (ids: ReadonlySet<string>, label: string): ClassifiedComparison | null => {
    if (ids.size === 0) return null;
    const subset = (m: ReadonlyMap<string, number>): Map<string, number> =>
      new Map([...m].filter(([id]) => ids.has(id)));
    const armSubset = subset(armScores);
    const controlSubset = subset(controlScores);
    if (armSubset.size === 0 || controlSubset.size === 0) return null;
    return classify(
      compareArms(label, arm.spec.id, control.spec.id, armSubset, controlSubset, opts),
      countNonZero(armSubset, controlSubset),
    );
  };

  const sensitiveIds = new Set(arm.sensitiveQueryIds);
  const sensitive = compareOn(sensitiveIds, `${arm.spec.id} vs control (arm-sensitive only)`);
  const sensitiveExcludedIds = new Set([...armScores.keys()].filter((id) => !sensitiveIds.has(id)));
  const sensitiveExcluded = compareOn(
    sensitiveExcludedIds,
    `${arm.spec.id} vs control (arm-sensitive EXCLUDED)`,
  );

  const dropped = new Set([...arm.uncoveredQueryIds, ...control.uncoveredQueryIds]);
  const rankingOnlyIds = new Set([...armScores.keys()].filter((id) => !dropped.has(id)));
  const rankingOnly = compareOn(rankingOnlyIds, `${arm.spec.id} vs control (ranking only)`);

  // Coverage-clean: fully covered at BOTH arms. `ranking only` above removes only the
  // spans the chunker DROPPED and still carries every straddled span, whose sibling
  // chunk scores 0 under the max-overlap rule — so it is not the isolating control it
  // reads as. A query missing from either coverage record is treated as uncovered
  // rather than as clean: the conservative direction, since an absent measurement is
  // not evidence of full coverage.
  const cleanAt = (r: ChunkArmResult, id: string): boolean =>
    (r.spanCoverage[id] ?? 0) > COVERAGE_CLEAN_THRESHOLD;
  const coverageCleanIds = new Set(
    [...armScores.keys()].filter((id) => cleanAt(arm, id) && cleanAt(control, id)),
  );
  const coverageClean = compareOn(coverageCleanIds, `${arm.spec.id} vs control (coverage-clean)`);
  const sensitiveCleanIds = new Set([...coverageCleanIds].filter((id) => sensitiveIds.has(id)));
  const sensitiveClean = compareOn(
    sensitiveCleanIds,
    `${arm.spec.id} vs control (arm-sensitive ∧ coverage-clean)`,
  );

  const straddledCount = [...armScores.keys()].filter((id) => {
    const c = arm.spanCoverage[id] ?? 0;
    return c > 0 && c <= COVERAGE_CLEAN_THRESHOLD;
  }).length;

  return {
    armId: arm.spec.id,
    chunkSize: arm.spec.chunkSize,
    overlap: arm.spec.overlap,
    ndcgAt10: arm.metrics.ndcgAtK[DOC_EVAL_K] ?? 0,
    recallAt10: arm.metrics.recallAtK[DOC_EVAL_K] ?? 0,
    mrr: arm.metrics.mrr,
    chunkCount: arm.chunkCount,
    chunkMultiplier: control.chunkCount === 0 ? 0 : arm.chunkCount / control.chunkCount,
    reindexSeconds: arm.reindexSeconds,
    meanSpanCoverage: arm.meanSpanCoverage,
    all,
    sensitive,
    sensitiveCount: sensitiveIds.size,
    sensitiveExcluded,
    sensitiveExcludedCount: sensitiveExcludedIds.size,
    rankingOnly,
    coverageClean,
    coverageCleanCount: coverageCleanIds.size,
    sensitiveClean,
    sensitiveCleanCount: sensitiveCleanIds.size,
    uncoveredCount: arm.uncoveredQueryIds.length,
    controlUncoveredCount: control.uncoveredQueryIds.length,
    straddledCount,
    realisedOverlapChars: arm.realisedOverlapChars,
    expectedOverlapChars: arm.expectedOverlapChars,
  };
}

const f3 = (n: number): string => n.toFixed(3);

function comparisonCells(c: ClassifiedComparison): string {
  const { paired } = c;
  return [
    `${paired.meanDelta >= 0 ? "+" : ""}${f3(paired.meanDelta)}`,
    `[${f3(paired.ciLow)}, ${f3(paired.ciHigh)}]`,
    paired.signTestP.toFixed(3),
    `${paired.wins}/${paired.losses}/${paired.ties}`,
    String(c.nonZeroDeltas),
    c.verdict,
  ].join(" | ");
}

/** The full sweep, ready to render. */
export interface ChunkSweepReport {
  corpusId: string;
  snapshotCommit: string;
  queryCount: number;
  docCount: number;
  corpusChars: number;
  embeddingModel: string;
  control: ChunkArmResult;
  comparisons: ChunkArmComparison[];
  /** Overlap arms, compared against the SAME control. */
  overlapComparisons: ChunkArmComparison[];
  /**
   * The overlap ladder that was planned, including the values the chunker's cap
   * forbade at this size. Carried into the artefact so a reader can see what did NOT
   * run — see {@link overlapArmsFor}.
   */
  overlapPlan: OverlapArmPlan;
  /**
   * Cross-encoder input-truncation profile per arm — the question #1158's review
   * routed here. Empty when the reranker tokenizer was unavailable.
   */
  rerankBudget: RerankBudgetProfile[];
  generatedAt: string;
}

/**
 * Fraction of configured overlap that must actually be delivered before an overlap
 * arm compares two overlap settings rather than two near-identical chunkings.
 *
 * Deliberately loose. The point is to separate "the chunker tiles" (98–99% since
 * #1178) from "the chunker does not" (19.2% before it), not to police a tolerance —
 * a boundary cut trims a couple of characters at each seam, so 100% is unreachable
 * by construction.
 */
const OVERLAP_INTERPRETABLE_FRACTION = 0.5;

/**
 * The overlap section: the realised-vs-configured table, and a verdict on whether
 * the overlap arm can be read at all.
 *
 * The verdict is COMPUTED from the table rather than asserted, because it has already
 * changed once. Before #1178 `sliceSection` advanced `cursor` by a full stride
 * regardless of where `findBoundary` cut, so overlap was realised only when the
 * boundary happened to land inside the final `overlap` characters — 19.2% of what was
 * configured at the shipped arm. Two overlap arms at one chunk size were therefore two
 * nearly identical chunkings, and #1160's near-equal scores were evidence of THAT
 * rather than of overlap not mattering. Since #1178 the window resumes at the cut and
 * 98–99% is delivered, so the arm became readable — and hard-coding either verdict
 * into the renderer would have made the report lie in one direction or the other.
 *
 * The verdict is the WORST arm's delivery, not the pooled ratio. Summing realised and
 * expected across arms before dividing lets a healthy majority absorb a broken
 * minority: at the committed numbers one arm could deliver **0%** and the pooled ratio
 * would still read ~79%, comfortably above the threshold, so the header would announce
 * READABLE over an arm that tiles nothing. A per-arm minimum cannot be masked that way,
 * which is what the paragraph above already claims this verdict does.
 */
export function renderOverlapDelivery(report: ChunkSweepReport): string {
  const rows = [report.control, ...report.comparisons, ...report.overlapComparisons];
  if (rows.every((r) => r.expectedOverlapChars === 0)) return "";
  // Arms configured with no overlap have nothing to deliver, so they cannot fail the
  // check and are excluded rather than counted as a 0/0 miss.
  const ratios = rows
    .filter((r) => r.expectedOverlapChars > 0)
    .map((r) => r.realisedOverlapChars / r.expectedOverlapChars);
  const worst = ratios.length > 0 ? Math.min(...ratios) : Number.NaN;
  const interpretable = Number.isFinite(worst) && worst >= OVERLAP_INTERPRETABLE_FRACTION;
  const lines: string[] = [];
  lines.push(
    interpretable
      ? "## Overlap: configured vs delivered — the overlap arm is READABLE"
      : "## Overlap: configured vs delivered — the overlap arm is UNINTERPRETABLE",
  );
  lines.push("");
  lines.push(
    interpretable
      ? "The window resumes at the cut, so the configured overlap is actually delivered " +
          "(#1178) and two overlap arms at one chunk size are genuinely two overlap " +
          "settings. **A null here is a measured null.** Before #1178 it was not: " +
          "`sliceSection` advanced `cursor` by a full stride regardless of where " +
          "`findBoundary` cut, delivering 19.2% of the configured overlap at the shipped " +
          "arm, which is why #1160's overlap result was withdrawn rather than believed."
      : "**Do not read the overlap arm as a measured null.** Delivered overlap is below " +
          `${(OVERLAP_INTERPRETABLE_FRACTION * 100).toFixed(0)}% of what is configured, ` +
          "so two overlap arms at one chunk size are two nearly identical chunkings and " +
          "their near-equal scores are evidence of THAT, not evidence that overlap does " +
          "not matter. This is the state #1178 fixed; if it has returned, the chunker's " +
          "tiling property has regressed — see `chunker.ts`'s header.",
  );
  lines.push("");
  lines.push("| arm | chunk/overlap | realised duplicate chars | expected if tiled | delivered |");
  lines.push("|---|---:|---:|---:|---:|");
  const pct = (r: number, e: number): string => (e === 0 ? "—" : `${((r / e) * 100).toFixed(1)}%`);
  lines.push(
    `| \`${report.control.spec.id}\` (control) | ${report.control.spec.chunkSize}/` +
      `${renderOverlapValue(report.control.spec.chunkSize, report.control.spec.overlap)} | ` +
      `${report.control.realisedOverlapChars} | ` +
      `${report.control.expectedOverlapChars} | ` +
      `${pct(report.control.realisedOverlapChars, report.control.expectedOverlapChars)} |`,
  );
  for (const c of [...report.comparisons, ...report.overlapComparisons]) {
    lines.push(
      `| \`${c.armId}\` | ${c.chunkSize}/${renderOverlapValue(c.chunkSize, c.overlap)} | ` +
        `${c.realisedOverlapChars} | ` +
        `${c.expectedOverlapChars} | ${pct(c.realisedOverlapChars, c.expectedOverlapChars)} |`,
    );
  }
  lines.push("");
  if (
    [report.control.spec, ...report.comparisons, ...report.overlapComparisons].some(
      (r) => armOverlap(r.chunkSize, r.overlap).clamped,
    )
  ) {
    lines.push(
      "> **An arm marked `CLAMPED` did not run at the overlap its id names.** " +
        "`chunkMarkdown` caps carry-over at `maxOverlapFor(chunkSize)` ≈ `chunkSize / 4` " +
        "(#1185), so the requested value was reduced before any chunk was cut. The " +
        "`expected if tiled` column above divides by the EFFECTIVE value, not the " +
        "requested one — dividing by the request charges the clamp to the chunker's " +
        "tiling (#1183).",
    );
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Which ladder values a size arm already covers at this size, DERIVED not written.
 *
 * See {@link ladderArmsAlreadyRun} for why this is not the literal "256".
 */
function renderLadderSkips(chunkSize: number): string {
  const already = ladderArmsAlreadyRun(chunkSize);
  if (already.length === 0) return "no ladder value duplicates a size arm at this size";
  const named = already.map((a) => `${a.overlap} (\`${a.id}\`)`).join(", ");
  return `${named} already runs as a size arm here and is not re-run`;
}

/**
 * This run's own intervals, as the sizing consumes them.
 *
 * `all` only. #1183 measured the arm-sensitive stratum to be an unadjusted subgroup
 * rather than a power-preserving filter, so sizing a corpus against it would size
 * against the wrong denominator — and on `size-1024` against the subset carrying the
 * opposite sign.
 */
export function runSizingInputs(report: ChunkSweepReport): SizingInput[] {
  return [...report.comparisons, ...report.overlapComparisons].map((c) => ({
    armId: c.armId,
    subset: "all",
    n: c.all.paired.n,
    meanDelta: c.all.paired.meanDelta,
    ciLow: c.all.paired.ciLow,
    ciHigh: c.all.paired.ciHigh,
  }));
}

/** Render the sweep as the committed `eval-results/*.md` artefact. */
export function renderChunkSweep(report: ChunkSweepReport): string {
  const controlNdcg = report.control.metrics.ndcgAtK[DOC_EVAL_K] ?? 0;
  const lines: string[] = [];

  lines.push(`# Document-retrieval chunk-size sweep — ${report.corpusId}`);
  lines.push("");
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Corpus: ${report.docCount} documents, ${report.corpusChars} characters`);
  lines.push(`- Queries: ${report.queryCount} (hand-authored, span-anchored ground truth)`);
  lines.push(`- Snapshot commit: \`${report.snapshotCommit}\``);
  lines.push(`- Embedding model / identity: \`${report.embeddingModel}\``);
  lines.push(
    `- Pre-registered minimum important delta: **+${MIN_IMPORTANT_NDCG_DELTA}** nDCG@${DOC_EVAL_K}`,
  );
  lines.push("");
  lines.push(
    "Retrieval runs through the production `KnowledgeService.search` hybrid path " +
      "(dense + BM25, reciprocal-rank fusion) over chunks written by the production " +
      "`chunkMarkdown` + `Embedder` ingest path. **No canned retrieval** — that is the " +
      "gap in `rag:eval` this harness exists to close.",
  );
  lines.push("");

  lines.push("## Arms");
  lines.push("");
  lines.push(
    "| arm | chunk | overlap | chunks | ×control | reindex s | nDCG@10 | recall@10 | MRR | span coverage | spans DROPPED | spans straddled |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
  const controlRow = report.control;
  const controlStraddled = Object.values(controlRow.spanCoverage).filter(
    (c) => c > 0 && c <= COVERAGE_CLEAN_THRESHOLD,
  ).length;
  lines.push(
    `| \`${controlRow.spec.id}\` (control) | ${controlRow.spec.chunkSize} | ` +
      `${renderOverlapValue(controlRow.spec.chunkSize, controlRow.spec.overlap)} | ` +
      `${controlRow.chunkCount} | 1.00× | ${controlRow.reindexSeconds.toFixed(1)} | ` +
      `**${f3(controlNdcg)}** | ${f3(controlRow.metrics.recallAtK[DOC_EVAL_K] ?? 0)} | ` +
      `${f3(controlRow.metrics.mrr)} | ${f3(controlRow.meanSpanCoverage)} | ` +
      `${controlRow.uncoveredQueryIds.length} | ${controlStraddled} |`,
  );
  for (const c of [...report.comparisons, ...report.overlapComparisons]) {
    lines.push(
      `| \`${c.armId}\` | ${c.chunkSize} | ${renderOverlapValue(c.chunkSize, c.overlap)} | ` +
        `${c.chunkCount} | ` +
        `${c.chunkMultiplier.toFixed(2)}× | ${c.reindexSeconds.toFixed(1)} | ${f3(c.ndcgAt10)} | ` +
        `${f3(c.recallAt10)} | ${f3(c.mrr)} | ${f3(c.meanSpanCoverage)} | ${c.uncoveredCount} | ` +
        `${c.straddledCount} |`,
    );
  }
  lines.push("");

  lines.push(
    `The \`overlap-*\` arms hold chunk size at **${report.overlapPlan.chunkSize}** — the ` +
      "control's own size — so overlap is the only variable that moved against the control " +
      "(#1183). Ladder: " +
      `${OVERLAP_LADDER.join(" / ")}; ${renderLadderSkips(report.overlapPlan.chunkSize)}.`,
  );
  lines.push("");
  if (report.overlapPlan.excluded.length > 0) {
    lines.push(
      `> **Not run at ${report.overlapPlan.chunkSize}:** ` +
        report.overlapPlan.excluded
          .map((e) => `\`${e.requested}\` (chunker cap ${e.maxOverlap})`)
          .join(", ") +
        ". `chunkMarkdown` would have clamped these (#1185), so requesting them would have " +
        "produced an arm whose id named an overlap it did not run. They are named rather " +
        "than dropped silently.",
    );
    lines.push("");
  }

  const anyDropped =
    report.control.uncoveredQueryIds.length > 0 ||
    [...report.comparisons, ...report.overlapComparisons].some((c) => c.uncoveredCount > 0);
  if (anyDropped) {
    lines.push(
      "> **`spans DROPPED` is a defect in the production chunker, not a harness artefact — " +
        "and since #1178 it should be zero.** A non-empty column means `chunkMarkdown` has " +
        "stopped tiling its input: if `sliceSection` ever advances its cursor past the cut " +
        "it just emitted, everything in between is emitted by no chunk. Those answer spans " +
        "are then absent from the index at that arm and are scored 0, which is what a user " +
        "would experience. The `ranking only` rows below exclude every DROPPED query — but " +
        "a dropped span is only half the coverage channel, so read `coverage-clean` for the " +
        "isolated ranking delta.",
    );
    lines.push("");
  }

  lines.push("## Paired comparison against the control (nDCG@10)");
  lines.push("");
  lines.push(
    "`wins/losses/ties` and `non-zero` are per-query counts. **Believe the sign test on " +
      "disagreement** — see `stats.ts`'s header and #1158's pool-20 arm.",
  );
  lines.push("");
  lines.push("| arm | subset | n | Δ mean | 95% paired CI | sign p | w/l/t | non-zero | verdict |");
  lines.push("|---|---|---:|---:|---|---:|---|---:|---|");
  for (const c of [...report.comparisons, ...report.overlapComparisons]) {
    lines.push(`| \`${c.armId}\` | all | ${c.all.paired.n} | ${comparisonCells(c.all)} |`);
    if (c.sensitive) {
      lines.push(
        `| \`${c.armId}\` | arm-sensitive (${c.sensitiveCount}) | ${c.sensitive.paired.n} | ` +
          `${comparisonCells(c.sensitive)} |`,
      );
    } else {
      lines.push(`| \`${c.armId}\` | arm-sensitive (0) | — | — | — | — | — | — | NO-RE-CHUNKING |`);
    }
    if (c.sensitiveExcluded) {
      lines.push(
        `| \`${c.armId}\` | arm-sensitive EXCLUDED (${c.sensitiveExcludedCount}) | ` +
          `${c.sensitiveExcluded.paired.n} | ${comparisonCells(c.sensitiveExcluded)} |`,
      );
    }
    if (c.rankingOnly) {
      lines.push(
        `| \`${c.armId}\` | ranking only | ${c.rankingOnly.paired.n} | ` +
          `${comparisonCells(c.rankingOnly)} |`,
      );
    }
    if (c.coverageClean) {
      lines.push(
        `| \`${c.armId}\` | coverage-clean (${c.coverageCleanCount}) | ` +
          `${c.coverageClean.paired.n} | ${comparisonCells(c.coverageClean)} |`,
      );
    }
    if (c.sensitiveClean) {
      lines.push(
        `| \`${c.armId}\` | arm-sensitive ∧ clean (${c.sensitiveCleanCount}) | ` +
          `${c.sensitiveClean.paired.n} | ${comparisonCells(c.sensitiveClean)} |`,
      );
    }
  }
  lines.push("");

  const anyStraddled = [...report.comparisons, ...report.overlapComparisons].some(
    (c) => c.straddledCount > 0,
  );
  if (anyStraddled) {
    lines.push(
      "> **`ranking only` is not the isolating control; `coverage-clean` is.** " +
        "`ranking only` excludes spans the chunker DROPPED but keeps spans it " +
        "**straddled** — split across two chunks, of which only the max-overlap one is " +
        "graded relevant, so retrieving the sibling scores 0. That penalty lands almost " +
        "entirely on the small arms. `coverage-clean` keeps only queries whose span is " +
        `fully covered (> ${COVERAGE_CLEAN_THRESHOLD}) at BOTH arms, and ` +
        "`arm-sensitive ∧ clean` intersects that with the queries capable of moving. " +
        "**Read those rows as diagnostics beside `all`, never in place of it** — `all` is " +
        "the decision statistic (#1183: the arm-sensitive stratum is an unadjusted subgroup, " +
        "and on `size-1024` the subset it discards carried the opposite sign). Neither subset " +
        "repairs the index-level confound either: differential content loss (#1178) means the " +
        "arms index different fractions of the corpus, which MIMICS a chunk-size effect.",
    );
    lines.push("");
  }

  // ONE mover outside the stratum falsifies "structurally incapable of moving", so the
  // predicate is `> 0` — NOT `outside > inside`. Comparing raw mover counts across
  // subsets whose sizes differ by up to 8x (n=5 vs n=43, n=29 vs n=19) asks "is the
  // complement the bigger half of the movement?" when the claim under test is "is the
  // stratum a superset of it?". On the committed run the count form stayed silent on
  // `size-1024` (7 movers outside) and `size-768` (5) — the two arms #1184 re-measures,
  // and the two where the stratum most needs the warning. The count survives as a
  // SEVERITY distinction in the wording, not as the trigger.
  // Narrowed ONCE here so neither callout below needs a `?? 0` fallback for a null the
  // filter has already excluded — an unreachable branch is still an uncovered branch.
  const stratumPairs = [...report.comparisons, ...report.overlapComparisons].flatMap((c) =>
    c.sensitive && c.sensitiveExcluded
      ? [{ arm: c, inside: c.sensitive, outside: c.sensitiveExcluded }]
      : [],
  );

  const leaky = stratumPairs.filter((p) => p.outside.nonZeroDeltas > 0);
  if (leaky.length > 0) {
    const naming = (p: (typeof leaky)[number]): string =>
      `\`${p.arm.armId}\` (${p.outside.nonZeroDeltas} outside vs ${p.inside.nonZeroDeltas} inside)`;
    const majority = leaky.filter((p) => p.outside.nonZeroDeltas > p.inside.nonZeroDeltas);
    lines.push(
      "> **The arm-sensitive stratum is not a superset of the movement on:** " +
        `${leaky.map(naming).join(", ")}. \`armSensitiveQueryIds\` compares only the ` +
        "best-covering chunk TEXT, so a query counts as insensitive when its own answer " +
        "chunk is byte-identical at both arms — but nDCG is a property of the whole ranked " +
        "list, and the competing chunks moved. **A single mover outside the stratum is " +
        "enough**: it falsifies `structurally incapable of moving`, which is the whole " +
        "warrant for treating the stratum as the more powerful test. " +
        (majority.length > 0
          ? `More severe still on ${majority.map((p) => `\`${p.arm.armId}\``).join(", ")}, where ` +
            "the complement holds MORE movers than the stratum. "
          : "") +
        "Read `all` as the headline for these arms; the stratum is a diagnostic.",
    );
    lines.push("");
  }

  // #1183's acceptance criterion is that a subset disagreement is TREATED AS A FINDING.
  // `disagreements` below is bootstrap-vs-sign WITHIN one subset and never looks across
  // subsets, so nothing noticed that `size-1024`'s stratum and its complement reached
  // opposite verdicts — printed as two adjacent table rows and passed over.
  const subsetSplits = stratumPairs.filter((p) => p.inside.verdict !== p.outside.verdict);
  if (subsetSplits.length > 0) {
    const describeSplit = (p: (typeof subsetSplits)[number]): string => {
      const { inside, outside } = p;
      const opposed = Math.sign(inside.paired.meanDelta) * Math.sign(outside.paired.meanDelta) < 0;
      return (
        `\`${p.arm.armId}\` — arm-sensitive (${p.arm.sensitiveCount}) reads ${inside.verdict} at ` +
        `${inside.paired.meanDelta >= 0 ? "+" : ""}${f3(inside.paired.meanDelta)} ` +
        `(p = ${inside.paired.signTestP.toFixed(3)}) while arm-sensitive EXCLUDED ` +
        `(${p.arm.sensitiveExcludedCount}) reads ${outside.verdict} at ` +
        `${outside.paired.meanDelta >= 0 ? "+" : ""}${f3(outside.paired.meanDelta)} ` +
        `(p = ${outside.paired.signTestP.toFixed(3)})${opposed ? ", **opposite signs**" : ""}`
      );
    };
    lines.push(
      "> **Subset verdict disagreement — the stratum and the subset it DISCARDS do not " +
        `agree on:** ${subsetSplits.map(describeSplit).join("; ")}. This is a FINDING, not ` +
        "a formatting detail. Restricting to the arm-sensitive stratum is an **unadjusted " +
        "subgroup selection**, not a power-preserving filter: where the two disagree, the " +
        "stratum has discarded the queries carrying the signal, and a p-value computed on " +
        "it is not the isolating test it reads as. Neither row is the answer — the arm is " +
        "unresolved at this corpus size and must be handed on as such.",
    );
    lines.push("");
  }

  const disagreements = [...report.comparisons, ...report.overlapComparisons].filter(
    (c) => !c.all.agree || (c.sensitive && !c.sensitive.agree),
  );
  if (disagreements.length > 0) {
    lines.push(
      `> **Bootstrap/sign-test disagreement on:** ${disagreements
        .map((d) => `\`${d.armId}\``)
        .join(", ")}. The sign test governs, so those arms are reported NOT-ESTABLISHED.`,
    );
    lines.push("");
  }

  lines.push(
    renderCorpusSizing(PRIOR_RUN_SIZING, {
      heading: "Statistical resolution — the sizing this corpus was built from (#1184)",
      preamble:
        "Computed by `queriesNeededForHalfWidth` from the intervals committed in the " +
        "**previous** run (#1183, 48 queries on `docretrieval-01-metis-docs`), which is what " +
        "#1184's first acceptance criterion asks for: state the query count a decisive answer " +
        "needs BEFORE spending anything on a corpus. The counts are computed from those " +
        "committed inputs, never written — see `power-sizing.ts` for the inversion and its " +
        "normal-approximation caveat.",
      currentQueryCount: PRIOR_RUN_QUERY_COUNT,
    }),
  );

  lines.push(
    renderCorpusSizing(runSizingInputs(report), {
      heading: "Statistical resolution — what THIS run achieved",
      preamble:
        "The same sizing applied to this run's own `all` intervals. Read it as the honest " +
        "statement of what was and was not separable here: a target whose column exceeds the " +
        `${report.queryCount} queries actually run is a resolution this corpus does NOT have, ` +
        "and a delta inside that band is **unproven**, which is a different claim from " +
        "**no effect**.",
      currentQueryCount: report.queryCount,
    }),
  );

  const overlapSection = renderOverlapDelivery(report);
  if (overlapSection) lines.push(overlapSection);

  const budget = renderRerankBudget(report.rerankBudget);
  if (budget) lines.push(budget);

  lines.push("## Decision rule (pre-registered, not derived from these numbers)");
  lines.push("");
  lines.push(
    `- **SHIP** — the paired 95% CI excludes zero, the sign test agrees at p < 0.05, and the ` +
      `CI's lower bound clears +${MIN_IMPORTANT_NDCG_DELTA}.`,
  );
  lines.push(
    "- **DIRECTION-ESTABLISHED-MAGNITUDE-NOT** — CI excludes zero and the sign test agrees, " +
      "but the lower bound is inside the floor.",
  );
  lines.push(
    "- **NOT-ESTABLISHED** — CI includes zero, or the sign test declines to reject. " +
      "**A null result is a first-class outcome**: #1156 requires a change that does not " +
      "move nDCG@10 to be reverted and recorded, not kept for symmetry.",
  );
  lines.push("");
  return lines.join("\n");
}
