/**
 * Citation resolution validator (Epic #204 / Issue #224).
 *
 * Post-validates that every `sourceId` emitted by claim decomposition (#223)
 * resolves to a REAL retrieved source in the grounding context (#222). Claims
 * whose citations don't resolve — or that carry no citation at all — are
 * UNGROUNDED. The validator flags them and (optionally) strips them, and records
 * a per-section grounding result that feeds the degraded-output warnings (#225).
 *
 * "Resolves" means: the claim cites at least one `sourceId` that is a member of
 * the grounding context's `sourceIds` set. A claim that cites a fabricated id
 * (e.g. `rag:made-up:99`) plus no real id is ungrounded; a claim that cites one
 * real id and one fabricated id is grounded but its unknown ids are reported.
 */
import type { GroundingContext } from "./grounding-context.js";
import type { GroundedClaim, ClaimExtractor } from "./claim-extractor.js";
import type { ClaimVerdict, FaithfulnessJudge } from "./faithfulness-judge.js";

/** Why a claim failed grounding. */
export type UngroundedReason = "no-citation" | "unresolved-citation";

/** A claim that did not resolve against the retrieved set. */
export interface UngroundedClaim {
  claim: string;
  /** The (possibly empty) ids the claim cited. */
  sourceIds: string[];
  reason: UngroundedReason;
}

/** Per-section grounding/faithfulness result. */
export interface GroundingResult {
  /** Claims with ≥1 resolvable citation. */
  groundedClaims: GroundedClaim[];
  /** Claims with no resolvable citation. */
  ungroundedClaims: UngroundedClaim[];
  /** Cited ids that are not in the retrieved set (fabricated/unknown). */
  unknownSourceIds: string[];
  totalClaims: number;
  /** groundedClaims / totalClaims in [0,1]; 1 when there are no claims. */
  groundingRatio: number;
  /** True when at least one claim is ungrounded. */
  hasUngrounded: boolean;
  /**
   * True when {@link ValidateCitationsOptions.strip} was set AND at least one
   * ungrounded claim was removed. Lets the caller decide whether to re-render
   * the section from `groundedClaims` only.
   */
  stripped: boolean;
}

export interface ValidateCitationsOptions {
  /**
   * When true, ungrounded claims are removed from `groundedClaims` (strip mode).
   * When false (default), grounded/ungrounded are partitioned but nothing is
   * mutated — the caller decides. Either way `ungroundedClaims` is populated.
   */
  strip?: boolean;
}

/**
 * Validate a section's claims against the grounding context. Partitions claims
 * into grounded vs ungrounded and reports any fabricated source ids.
 */
export function validateCitations(
  claims: GroundedClaim[],
  ctx: GroundingContext,
  options: ValidateCitationsOptions = {},
): GroundingResult {
  const groundedClaims: GroundedClaim[] = [];
  const ungroundedClaims: UngroundedClaim[] = [];
  const unknownSourceIds = new Set<string>();

  for (const claim of claims) {
    const cited = claim.sourceIds ?? [];
    const resolved = cited.filter((id) => ctx.sourceIds.has(id));
    const unknown = cited.filter((id) => !ctx.sourceIds.has(id));
    for (const id of unknown) unknownSourceIds.add(id);

    if (resolved.length > 0) {
      // Keep only the resolvable ids on a grounded claim (strip fabricated ids).
      groundedClaims.push({ claim: claim.claim, sourceIds: resolved });
    } else {
      ungroundedClaims.push({
        claim: claim.claim,
        sourceIds: cited,
        reason: cited.length === 0 ? "no-citation" : "unresolved-citation",
      });
    }
  }

  const totalClaims = claims.length;
  const groundingRatio = totalClaims === 0 ? 1 : groundedClaims.length / totalClaims;

  // Strip mode: when requested, ungrounded claims are simply not retained on
  // `groundedClaims` (they already aren't — they were partitioned out above),
  // so the only observable difference is the `stripped` flag the caller uses to
  // decide whether to re-render the section from grounded claims alone.
  const stripped = Boolean(options.strip) && ungroundedClaims.length > 0;

  return {
    groundedClaims,
    ungroundedClaims,
    unknownSourceIds: Array.from(unknownSourceIds),
    totalClaims,
    groundingRatio,
    hasUngrounded: ungroundedClaims.length > 0,
    stripped,
  };
}

/**
 * Best-effort removal of ungrounded claim text from a section's markdown.
 *
 * Claim decomposition (#223) emits the verbatim (or near-verbatim) sentence for
 * each claim, so we strip any line whose trimmed, fence/marker-normalised text
 * exactly matches an ungrounded claim. This is intentionally conservative — it
 * only drops whole lines it can match exactly, never partial sentences — so it
 * cannot corrupt surrounding prose, headings, code fences, or diagrams. Lines it
 * cannot confidently match are left in place and surfaced via the warning
 * instead.
 */
export function stripUngroundedClaims(
  markdown: string,
  ungroundedClaims: UngroundedClaim[],
): string {
  if (ungroundedClaims.length === 0) return markdown;
  const targets = new Set(
    ungroundedClaims.map((c) => normalizeClaimLine(c.claim)).filter((t) => t.length > 0),
  );
  if (targets.size === 0) return markdown;

  const kept = markdown.split("\n").filter((line) => {
    const norm = normalizeClaimLine(line);
    // Never strip headings, fences, or blank lines even if they "match".
    if (!norm || line.trim().startsWith("#") || line.trim().startsWith("```")) return true;
    return !targets.has(norm);
  });
  // Collapse any 3+ consecutive blank lines left by removals.
  return kept.join("\n").replace(/\n{3,}/g, "\n\n");
}

/** Normalise a markdown line for exact claim matching (drop list/quote markers). */
function normalizeClaimLine(line: string): string {
  return line
    .trim()
    .replace(/^[-*]\s+/, "")
    .replace(/^>\s+/, "")
    .trim();
}

/**
 * Render a compact, human-readable summary of a grounding result — used in
 * degraded-output warnings (#225) and logs.
 */
export function summarizeGrounding(result: GroundingResult): string {
  const pct = Math.round(result.groundingRatio * 100);
  const parts = [`${result.groundedClaims.length}/${result.totalClaims} claims grounded (${pct}%)`];
  if (result.ungroundedClaims.length > 0) {
    parts.push(`${result.ungroundedClaims.length} ungrounded`);
  }
  if (result.unknownSourceIds.length > 0) {
    parts.push(`${result.unknownSourceIds.length} fabricated citation(s)`);
  }
  return parts.join("; ");
}

// ============================================================================
// Issue #273 — entailment-based faithfulness (RAGAS-style).
//
// The id-reproduction model above (`validateCitations`) structurally
// false-flags accurate ABSTRACTIVE synthesis: a cross-module overview claim is
// entailed by the facts bundle as a whole but maps to no single pre-existing id,
// so it gets no citation and is marked ungrounded → the doc is degraded even
// when correct. `scoreFaithfulness` replaces "claim must cite an id" with
// "claim must be ENTAILED BY the section's grounding context", scored as:
//
//     faithfulness = supported claims / total claims
//
// (RAGAS faithfulness — claim decomposition + NLI entailment; see
//  https://docs.ragas.io/en/stable/concepts/metrics/available_metrics/faithfulness/).
// `sourceIds` are retained as OPTIONAL attribution only; grounded-status is no
// longer gated on id reproduction.
// ============================================================================

/** A claim the judge could not verify against the grounding context. */
export interface UnsupportedClaim {
  claim: string;
}

/** A supported claim plus its (optional) attribution ids. */
export interface SupportedAttribution {
  claim: string;
  /** Optional attribution — may be empty even for a supported claim. */
  sourceIds: string[];
}

/** Per-section faithfulness result (#273). */
export interface FaithfulnessResult {
  /** Section label (for warnings/logs). */
  section: string;
  totalClaims: number;
  supportedClaims: number;
  /**
   * supported / total in [0,1]; 1 when there are no claims OR the section is
   * unverifiable (see {@link verified}) — a neutral value that never produces a
   * false degraded.
   */
  faithfulness: number;
  /**
   * True when the judge actually returned a usable verdict set. When false the
   * section is UNVERIFIABLE (offline, empty context, parse/count failure) and
   * must be treated as pass-through, NOT a faithfulness failure.
   */
  verified: boolean;
  /** Claims judged unsupported (only meaningful when {@link verified}). */
  unsupportedClaims: UnsupportedClaim[];
  /** Supported claims with their optional attribution ids. */
  supportedAttributions: SupportedAttribution[];
  /**
   * #117 — which grounding reply could not be parsed, when one could not:
   * `claims` (the decomposition, so nothing was checked) or `verdicts` (at least
   * one judge batch, so its claims went unscored). Absent when everything parsed.
   */
  unparseable?: "claims" | "verdicts";
  /**
   * #152 — set with {@link unparseable} when the reply was cut off at the output
   * cap rather than malformed, so the warning names the cap, not the
   * structured-output mode.
   */
  truncated?: true;
}

/** Minimal extractor surface needed for scoring (eases testing/mocking). */
type ExtractorLike = Pick<ClaimExtractor, "decompose">;
/** Minimal judge surface needed for scoring (eases testing/mocking). */
type JudgeLike = Pick<FaithfulnessJudge, "judge">;

export interface ScoreFaithfulnessDeps {
  extractor: ExtractorLike;
  judge: JudgeLike;
  signal?: AbortSignal;
}

/** A clean, unverified (pass-through) result for sections we cannot judge. */
function unverifiedResult(section: string, totalClaims: number): FaithfulnessResult {
  return {
    section,
    totalClaims,
    supportedClaims: totalClaims,
    faithfulness: 1,
    verified: false,
    unsupportedClaims: [],
    supportedAttributions: [],
  };
}

/**
 * Score one section's faithfulness against its grounding context (#273).
 *
 * Pipeline: decompose section → atomic claims (#223), then ask the
 * {@link FaithfulnessJudge} whether each claim is ENTAILED BY the context (which
 * sees the source TEXT, not just ids). The score is supported/total.
 *
 * Pass-through (verified=false, faithfulness=1) when: the context is empty, the
 * section yields no claims, or the judge returns no usable verdict (offline,
 * parse/count failure). This guarantees an UNVERIFIABLE section is never falsely
 * degraded — only a section the judge actually evaluated below threshold is.
 */
export async function scoreFaithfulness(
  section: string,
  sectionMarkdown: string,
  ctx: GroundingContext,
  deps: ScoreFaithfulnessDeps,
): Promise<FaithfulnessResult> {
  if (ctx.isEmpty || !sectionMarkdown.trim()) {
    return unverifiedResult(section, 0);
  }

  const { claims, unparseable, truncated } = await deps.extractor.decompose(
    sectionMarkdown,
    ctx,
    deps.signal,
  );
  if (unparseable) {
    // #117 — "the reply did not parse" is not "the section makes no claims".
    // #152 — and a reply cut off at the output cap says so.
    return {
      ...unverifiedResult(section, 0),
      unparseable: "claims",
      ...(truncated ? { truncated: true as const } : {}),
    };
  }
  if (claims.length === 0) {
    // No substantive claims → nothing to verify; clean and (trivially) fine.
    return {
      section,
      totalClaims: 0,
      supportedClaims: 0,
      faithfulness: 1,
      verified: true,
      unsupportedClaims: [],
      supportedAttributions: [],
    };
  }

  const diagnostics = { batches: 0, unparseableBatches: 0, truncatedBatches: 0 };
  const verdicts = await deps.judge.judge(
    claims.map((c) => c.claim),
    ctx,
    deps.signal,
    diagnostics,
  );
  const verdictsUnparseable = {
    ...(diagnostics.unparseableBatches > 0 ? { unparseable: "verdicts" as const } : {}),
    ...(diagnostics.truncatedBatches > 0 ? { truncated: true as const } : {}),
  };
  if (!verdicts) {
    // Unverifiable: keep the section as-is (never a false degraded).
    return { ...unverifiedResult(section, claims.length), ...verdictsUnparseable };
  }

  return { ...aggregateVerdicts(section, verdicts), ...verdictsUnparseable };
}

/**
 * Aggregate per-claim verdicts into a {@link FaithfulnessResult}. Exposed so the
 * scoring math is independently testable.
 */
export function aggregateVerdicts(section: string, verdicts: ClaimVerdict[]): FaithfulnessResult {
  const supportedAttributions: SupportedAttribution[] = [];
  const unsupportedClaims: UnsupportedClaim[] = [];
  for (const v of verdicts) {
    if (v.supported) {
      supportedAttributions.push({ claim: v.claim, sourceIds: v.sourceIds });
    } else {
      unsupportedClaims.push({ claim: v.claim });
    }
  }
  const totalClaims = verdicts.length;
  const supportedClaims = supportedAttributions.length;
  const faithfulness = totalClaims === 0 ? 1 : supportedClaims / totalClaims;
  return {
    section,
    totalClaims,
    supportedClaims,
    faithfulness,
    verified: true,
    unsupportedClaims,
    supportedAttributions,
  };
}

/** Compact, human-readable summary of a faithfulness result (warnings/logs). */
export function summarizeFaithfulness(result: FaithfulnessResult): string {
  if (!result.verified) {
    return `faithfulness unverified (${result.totalClaims} claim(s))`;
  }
  const pct = Math.round(result.faithfulness * 100);
  const parts = [`${result.supportedClaims}/${result.totalClaims} claims supported (${pct}%)`];
  if (result.unsupportedClaims.length > 0) {
    parts.push(`${result.unsupportedClaims.length} unsupported`);
  }
  return parts.join("; ");
}
