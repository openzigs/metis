/**
 * DOCS_GEN_GROUNDING — how much of each generated section is fact-checked.
 *
 * Fact-checking a section is two model stages (#273): claim DECOMPOSITION
 * (one call per ~8,000-character passage, whose reply restates every claim)
 * and the faithfulness JUDGE (one call per 40 claims, each re-reading the
 * section's whole evidence block and restating every claim with a verdict). On
 * a local model, one request at a time, that costs about three times the
 * section's own writing time. Production keeps the full check; a local test
 * run can turn it down:
 *
 *   - `on` (default, and any unrecognised value) — every claim of every
 *     section is decomposed and judged, exactly as before this setting existed.
 *   - `sample` — a deterministic, spread-out SAMPLE of the section's passages
 *     is decomposed, and only their claims are judged. The score is an
 *     estimate and is labelled `sampled` wherever it surfaces.
 *   - `off` — no claim extraction and no judge call. The section is recorded as
 *     not fact-checked (`grounding-skipped`).
 *
 * WHY SAMPLE PASSAGES, NOT CLAIMS. Sampling the extracted claims would cut
 * only the judge: every passage would still be decomposed, and decomposition
 * emits as many output tokens as the judge does (both restate every claim).
 * Sampling at the passage level cuts BOTH stages in proportion. For a
 * 30,000-character section with ~200 claims: full = 4 decomposition + 5 judge
 * calls; claim sampling at 25% = 4 + 2; passage sampling at 25% = 1 + 2 (~50
 * claims). The sample is still a sample of the section's own statements —
 * each drawn passage is decomposed whole, under its heading — so the ratio
 * estimates the same quantity the full check measures.
 */
import { createHash } from "node:crypto";
import { getConfigService, type ConfigService } from "../../config/config-service.js";
import { createChildLogger } from "../../logger.js";
import type { GroundedClaim } from "./claim-extractor.js";
import {
  judgeDecomposedClaims,
  scoreFaithfulness,
  type FaithfulnessResult,
  type ScoreFaithfulnessDeps,
} from "./citation-validator.js";
import type { GroundingContext } from "./grounding-context.js";

const log = createChildLogger("docs-gen:grounding-mode");

export const GROUNDING_MODE_KEY = "DOCS_GEN_GROUNDING";
export const GROUNDING_SAMPLE_RATE_KEY = "DOCS_GEN_GROUNDING_SAMPLE_RATE";

/** Values accepted by `DOCS_GEN_GROUNDING`. */
export const GROUNDING_MODES = ["on", "sample", "off"] as const;
export type GroundingMode = (typeof GROUNDING_MODES)[number];

/** Default share of a section's passages a sampled check decomposes. */
export const DEFAULT_GROUNDING_SAMPLE_RATE = 0.25;

/**
 * Fewest claims a sampled check judges per section when the section has that
 * many: a small sample is topped up with further passages until it holds this
 * many claims, or the section runs out.
 */
export const GROUNDING_SAMPLE_MIN_CLAIMS = 10;

/**
 * Characters of section text expected per extracted claim, used only to size
 * the FIRST draw so it is likely to reach the claim minimum in one
 * decomposition call (a claim list is about as long as its passage — see
 * DEFAULT_CLAIM_BATCH_CHARS — and a claim runs ~100–150 characters). A draw
 * that still falls short is topped up, so this is a call-count optimisation,
 * never a correctness assumption.
 */
export const SAMPLE_CHARS_PER_CLAIM_ESTIMATE = 120;

/** The resolved grounding policy for one document run. */
export interface GroundingPolicy {
  mode: GroundingMode;
  /** Share of passages decomposed in `sample` mode, in (0, 1]. */
  sampleRate: number;
  /** {@link GROUNDING_SAMPLE_MIN_CLAIMS}. */
  minClaims: number;
}

/** Today's behaviour: every claim checked. */
export const FULL_GROUNDING: GroundingPolicy = Object.freeze({
  mode: "on",
  sampleRate: DEFAULT_GROUNDING_SAMPLE_RATE,
  minClaims: GROUNDING_SAMPLE_MIN_CLAIMS,
});

function readSampleRate(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_GROUNDING_SAMPLE_RATE;
  const rate = Number(raw.trim());
  if (Number.isFinite(rate) && rate > 0 && rate <= 1) return rate;
  log.warn(`Invalid ${GROUNDING_SAMPLE_RATE_KEY}; using the default`, {
    default: DEFAULT_GROUNDING_SAMPLE_RATE,
  });
  return DEFAULT_GROUNDING_SAMPLE_RATE;
}

/**
 * Resolve `DOCS_GEN_GROUNDING` / `DOCS_GEN_GROUNDING_SAMPLE_RATE` (runtime
 * config, then env). Unset → `on`. An unrecognised mode falls back to `on` —
 * the safe direction — with a warning, never to a weaker check.
 */
export function resolveGroundingPolicy(
  config: Pick<ConfigService, "get"> = getConfigService(),
): GroundingPolicy {
  const raw = config.get(GROUNDING_MODE_KEY)?.trim().toLowerCase();
  let mode: GroundingMode = "on";
  if (raw) {
    if ((GROUNDING_MODES as readonly string[]).includes(raw)) {
      mode = raw as GroundingMode;
    } else {
      log.warn(`Invalid ${GROUNDING_MODE_KEY}; falling back to full fact-checking (on)`, {
        accepted: GROUNDING_MODES.join(" | "),
      });
    }
  }
  if (mode === "on") return FULL_GROUNDING;
  const policy: GroundingPolicy = {
    mode,
    sampleRate:
      mode === "sample"
        ? readSampleRate(config.get(GROUNDING_SAMPLE_RATE_KEY))
        : DEFAULT_GROUNDING_SAMPLE_RATE,
    minClaims: GROUNDING_SAMPLE_MIN_CLAIMS,
  };
  log.warn(
    mode === "off"
      ? "Docs-gen fact-checking is OFF for this run: sections will be marked not fact-checked"
      : "Docs-gen fact-checking is SAMPLED for this run: section scores are estimates",
    { mode, ...(mode === "sample" ? { sampleRate: policy.sampleRate } : {}) },
  );
  return policy;
}

// ---------------------------------------------------------------------------
// Passage sampling
// ---------------------------------------------------------------------------

/** One sampleable passage of a section: a paragraph, list, table or fenced block. */
export interface SamplePassage {
  /** Position in the section. */
  index: number;
  /** The passage text. */
  text: string;
  /** The heading in force above it (context for decomposition), if any. */
  heading: string | null;
}

const HEADING_RE = /^#{1,6}\s/;

/**
 * Split a section into passages: blank-line separated blocks, fenced blocks
 * kept whole. A block that is only a heading is not a passage — it becomes the
 * `heading` of the passages under it. Pure.
 */
export function splitSamplePassages(markdown: string): SamplePassage[] {
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    if (!inFence && line.trim() === "") {
      if (current.length > 0) blocks.push(current.join("\n"));
      current = [];
      continue;
    }
    current.push(line);
  }
  if (current.length > 0) blocks.push(current.join("\n"));

  const passages: SamplePassage[] = [];
  let heading: string | null = null;
  for (const block of blocks) {
    const lines = block.split("\n");
    if (HEADING_RE.test(lines[0])) {
      // The last heading line of the block governs what follows it.
      const headings = lines.filter((l) => HEADING_RE.test(l));
      if (headings.length === lines.length) {
        heading = headings[headings.length - 1];
        continue;
      }
      heading = lines[0];
      passages.push({ index: passages.length, text: block, heading: null });
      continue;
    }
    passages.push({ index: passages.length, text: block, heading });
  }
  return passages;
}

/** Deterministic rank of a passage, seeded from its text only. */
function rankOf(text: string): number {
  return createHash("sha256").update(text).digest().readUInt32BE(0);
}

/**
 * The deterministic draw order of `passages` for a sample of `rate`: the
 * section is cut into `ceil(n × rate)` contiguous strata and each round takes
 * one passage from every stratum — the one whose text hashes lowest among
 * those not yet drawn. Round 0 is the sample; later rounds top it up. Seeded
 * from the passage text, so a re-run over the same section draws the same
 * passages; stratified, so the sample spans the whole section rather than its
 * first N passages. Pure.
 */
export function sampleDrawOrder(passages: readonly SamplePassage[], rate: number): number[][] {
  const n = passages.length;
  if (n === 0) return [];
  const k = Math.min(n, Math.max(1, Math.ceil(n * rate)));
  const strata: number[][] = [];
  for (let j = 0; j < k; j++) {
    const from = Math.floor((j * n) / k);
    const to = Math.floor(((j + 1) * n) / k);
    const members = passages.slice(from, to).map((p) => ({ i: p.index, r: rankOf(p.text) }));
    members.sort((a, b) => a.r - b.r || a.i - b.i);
    strata.push(members.map((m) => m.i));
  }
  const rounds: number[][] = [];
  for (let round = 0; ; round++) {
    const picks = strata.filter((s) => round < s.length).map((s) => s[round]);
    if (picks.length === 0) break;
    rounds.push(picks);
  }
  return rounds;
}

/** Render drawn passages, in section order, each under its heading once. */
export function renderSampledPassages(
  passages: readonly SamplePassage[],
  indices: readonly number[],
): string {
  const out: string[] = [];
  let lastHeading: string | null = null;
  for (const i of [...indices].sort((a, b) => a - b)) {
    const p = passages[i];
    if (p.heading && p.heading !== lastHeading) out.push(p.heading);
    lastHeading = p.heading ?? (HEADING_RE.test(p.text) ? p.text.split("\n")[0] : lastHeading);
    out.push(p.text);
  }
  return out.join("\n\n");
}

/**
 * DOCS_GEN_GROUNDING=sample — score a section's faithfulness from a sample of
 * its passages (see the module comment for why passages, not claims).
 *
 * The first draw round — extended, if short, to the text expected to hold
 * `minClaims` claims — is decomposed in one pass. While it has yielded fewer
 * than `minClaims` claims and passages remain, further passages are drawn —
 * enough, at the claim density seen so far, to reach the minimum — and
 * decomposed. Only the sampled claims go to the judge. The result always
 * carries its coverage; one that covers every passage (a section too small to
 * sample is scored whole by {@link scoreFaithfulness}) is a full check, and
 * {@link isPartialSample} says so.
 */
export async function scoreFaithfulnessSampled(
  section: string,
  sectionMarkdown: string,
  ctx: GroundingContext,
  deps: ScoreFaithfulnessDeps,
  options: { rate: number; minClaims: number },
): Promise<FaithfulnessResult> {
  const passages = splitSamplePassages(sectionMarkdown.trim());
  const rounds = sampleDrawOrder(passages, options.rate);
  if (ctx.isEmpty || passages.length === 0 || rounds[0].length >= passages.length) {
    const full = await scoreFaithfulness(section, sectionMarkdown, ctx, deps);
    return {
      ...full,
      sampled: coverage(
        passages,
        passages.map((p) => p.index),
        options.rate,
      ),
    };
  }

  const queue = rounds.slice(1).flat();
  const drawn: number[] = [];
  const claims: GroundedClaim[] = [];
  // Size the first draw to the claim minimum at the expected density, so a
  // small section does not pay a second decomposition call to top up.
  let draw = [...rounds[0]];
  const floorChars = options.minClaims * SAMPLE_CHARS_PER_CLAIM_ESTIMATE;
  let firstChars = draw.reduce((n, i) => n + passages[i].text.length, 0);
  while (queue.length > 0 && firstChars < floorChars) {
    const next = queue.shift()!;
    draw.push(next);
    firstChars += passages[next].text.length;
  }
  let decompositions = 0;
  for (;;) {
    drawn.push(...draw);
    decompositions += 1;
    const out = await deps.extractor.decompose(
      renderSampledPassages(passages, draw),
      ctx,
      deps.signal,
    );
    if (out.unparseable) {
      return {
        section,
        totalClaims: 0,
        supportedClaims: 0,
        faithfulness: 1,
        verified: false,
        unsupportedClaims: [],
        supportedAttributions: [],
        unparseable: "claims",
        ...(out.truncated ? { truncated: true as const } : {}),
        sampled: coverage(passages, drawn, options.rate),
      };
    }
    claims.push(...out.claims);
    if (claims.length >= options.minClaims || queue.length === 0) break;
    // Top up: enough further passages, at the density seen so far, to reach
    // the minimum (at least one).
    const charsSoFar = drawn.reduce((n, i) => n + passages[i].text.length, 0);
    const density = claims.length / Math.max(1, charsSoFar);
    const needChars =
      density > 0 ? (options.minClaims - claims.length) / density : Number.POSITIVE_INFINITY;
    draw = [];
    let chars = 0;
    while (queue.length > 0 && (draw.length === 0 || chars < needChars)) {
      const next = queue.shift()!;
      draw.push(next);
      chars += passages[next].text.length;
    }
  }

  const sample = coverage(passages, drawn, options.rate);
  log.info("Sampled faithfulness check", {
    section,
    passagesChecked: sample.passagesChecked,
    passagesTotal: sample.passagesTotal,
    claims: claims.length,
    decompositions,
  });
  const result = await judgeDecomposedClaims(section, claims, ctx, deps);
  // Coverage is always attached in sample mode, so pooled batch coverage adds
  // up; a draw that reached every passage is a full check (see isPartialSample).
  return { ...result, sampled: sample };
}

function coverage(
  passages: readonly SamplePassage[],
  drawn: readonly number[],
  rate: number,
): NonNullable<FaithfulnessResult["sampled"]> {
  const unique = [...new Set(drawn)];
  return {
    rate,
    passagesChecked: unique.length,
    passagesTotal: passages.length,
    charsChecked: unique.reduce((n, i) => n + passages[i].text.length, 0),
    charsTotal: passages.reduce((n, p) => n + p.text.length, 0),
  };
}

/**
 * Score one section (or batch reply) under `policy`. `on` is exactly
 * {@link scoreFaithfulness}; `sample` is {@link scoreFaithfulnessSampled} with
 * a per-call claim minimum; `off` never reaches here (callers skip scoring).
 */
export function scoreUnderPolicy(
  policy: GroundingPolicy,
  section: string,
  sectionMarkdown: string,
  ctx: GroundingContext,
  deps: ScoreFaithfulnessDeps,
  minClaims: number = policy.minClaims,
): Promise<FaithfulnessResult> {
  if (policy.mode === "sample") {
    return scoreFaithfulnessSampled(section, sectionMarkdown, ctx, deps, {
      rate: policy.sampleRate,
      minClaims,
    });
  }
  return scoreFaithfulness(section, sectionMarkdown, ctx, deps);
}

/**
 * The policy's contribution to a section's reuse (config) hash and to the
 * provenance manifest: `undefined` for `on`, so a full-check run hashes and
 * records exactly as before; the mode (and sample rate) otherwise, so a
 * section written under one mode is never reused as if checked under another.
 */
export function groundingPolicyRecord(
  policy: GroundingPolicy,
): { mode: "sample"; sampleRate: number; minClaims: number } | { mode: "off" } | undefined {
  if (policy.mode === "on") return undefined;
  if (policy.mode === "off") return { mode: "off" };
  return { mode: "sample", sampleRate: policy.sampleRate, minClaims: policy.minClaims };
}
