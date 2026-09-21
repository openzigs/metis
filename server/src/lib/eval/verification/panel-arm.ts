/**
 * Epic #1107 (#1109) — the PANEL arm of `pnpm eval:verification`, filling the
 * seam #1108 left at `PanelArmFactory`.
 *
 * ── WHAT THIS ARM ACTUALLY MEASURES ─────────────────────────────────────────
 *
 * Not the panel alone: **the shipped composition**. Production runs the free
 * deterministic gate first and then grades what survives, so measuring the panel
 * in isolation would price a configuration nobody runs — the #1016 defect in a
 * new costume. {@link composeArmStatus} therefore layers the two exactly as the
 * product does, and the harness's `deterministic` arm is the same first layer
 * with the second removed. The delta between the two arms is the panel's
 * contribution and nothing else.
 *
 * ── THE ONE PLACE THIS ARM DIFFERS FROM PRODUCTION, STATED LOUDLY ───────────
 *
 * In production the panel writes `supportPanel` and NEVER touches
 * `verificationStatus` — it is a grader, and A2 (#1110) decides how a `low`
 * label reaches a reader. This harness scores a single axis, "would a reader be
 * warned about this finding?", so the arm projects `low` onto the existing
 * `unverified` down-weight in order to be scoreable at all.
 *
 * That projection is a MEASUREMENT DEVICE, not a behaviour. It cannot leak into
 * production: nothing in `server/src/lib/analysis/` imports this module, and the
 * panel's own return type has no verdict field to write. What the projection
 * asserts is only this — *if* A2 surfaces `low` as a warning, these are the
 * precision/recall consequences.
 *
 * ── THE PANEL NEVER CLEARS A DETERMINISTIC FLAG ─────────────────────────────
 *
 * {@link composeArmStatus} can only ever ADD a warning. A finding the free gate
 * already flagged stays flagged however enthusiastically the panel defends it.
 * This mirrors `gateFindingVerdict`'s asymmetry — the gate can weaken a claim,
 * never strengthen one — and it is what stops a chatty model from buying a
 * hallucinated citation its way back to `confirmed`. It also means the panel arm
 * can only move recall UP and over-flagging UP, never recall down, so a reader of
 * the comparison knows exactly which direction each number can travel.
 *
 * ── MEASURED, 2026-07-28 ────────────────────────────────────────────────────
 *
 * `pnpm eval:verification --arm both`, corpus `verification-01-finding-verdicts`
 * (12 cases), live `anthropic` / `claude-sonnet-5`, 3 runs, `--panel-flag-at low`:
 *
 * ```
 *   arm             recall   precision  over-flag  tokens/finding  model calls
 *   deterministic   0.3333   0.5000     0.3333     0               0
 *   panel           1.0000   0.6667     0.5000     3270.5          33
 * ```
 *
 * Identical on all three runs (token spread 39,014–39,400 total; #1114
 * malformation rate 0.0% over 99 calls, no retries, no no-signal). The panel
 * converted ALL FOUR of the free gate's misses — VC-01, VC-03, VC-08, VC-10,
 * every one of which requires READING the evidence — and added exactly ONE new
 * over-flag, VC-02: a genuine absence claim whose supporting excerpt is 12 lines
 * of one router, which the panel judged too thin to prove absence. That is the
 * epic's stated limitation showing up in the numbers rather than in prose.
 *
 * `--panel-flag-at medium` was measured too and is WORSE: recall is already
 * 1.0000 so it buys nothing, and it costs a fourth over-flag (precision 0.6000,
 * over-flag 0.6667). Hence `low` is the default, on evidence rather than taste.
 *
 * NO regression floors are registered for this arm, keeping #1108's deliberate
 * choice: the panel's bar is `compareArms` against a baseline measured in
 * the same process, not an absolute number that would silently encode one
 * provider and model.
 */
import type { FindingVerificationStatus, SupportPanelConfidence } from "@metis/shared";
import type { FindingSupportPanel } from "@metis/shared";
import { verifyFinding } from "../../analysis/finding-verification.js";
import { assertsAbsence } from "../../analysis/requirement-verdict.js";
import {
  scoreFindingFaithfulness,
  type FindingFaithfulnessOptions,
} from "../../analysis/finding-faithfulness.js";
import { runSupportPanel, type PanelEvidence } from "../../analysis/support-panel.js";
import type { StructuredVerdictMetrics } from "../../analysis/structured-verdict.js";
import type { AIProvider } from "../../ai/types.js";
import type { ArmUsage, VerifierArm } from "./arms.js";
import type { VerificationCase } from "./corpus.js";

/**
 * Confidence labels that down-weight a finding, by default `low` only.
 *
 * `medium` is deliberately NOT in the default set: it means "one lens dissented
 * and was outvoted", which is a nuance worth showing a reader, not a warning
 * worth spending their attention on. `--panel-flag-at medium` measures the other
 * choice rather than leaving it to opinion.
 */
export const DEFAULT_PANEL_FLAG_AT: readonly SupportPanelConfidence[] = ["low"];

export interface PanelArmOptions {
  provider: AIProvider;
  model?: string;
  /** Which confidence labels count as a warning. Defaults to {@link DEFAULT_PANEL_FLAG_AT}. */
  flagAt?: readonly SupportPanelConfidence[];
  /** #1114 reliability sink, so the harness can print malformation/retry rates. */
  metrics?: StructuredVerdictMetrics;
  signal?: AbortSignal;
  /**
   * Epic #1316 (#1318) — also compute the SHARED claim-level faithfulness metric
   * for each case, using production's own `scoreFindingFaithfulness`.
   *
   * OFF by default: it is a second decomposition + judge round-trip on top of the
   * three lens calls, and #1108's design is that a cost is MEASURED before it is
   * defaulted on. When off the arm reports `faithfulness: undefined`, which the
   * report renders `n/a` — distinct from a zero it never measured.
   */
  faithfulness?: boolean;
  /** Override the extractor/judge for the metric (tests / offline harnesses). */
  faithfulnessDeps?: Pick<FindingFaithfulnessOptions, "extractor" | "judge">;
}

/**
 * Layer the panel's confidence on top of the deterministic verdict. PURE.
 *
 * ```
 *   deterministic already warns  → keep it            (the panel cannot clear a flag)
 *   panel confidence ∈ flagAt    → "unverified"       (the projection described above)
 *   otherwise                    → deterministic      (unchanged, including null)
 * ```
 *
 * A `no-signal` panel changes nothing, by construction: it is not in the default
 * `flagAt` set and could not sensibly be added to it — a verifier that failed has
 * said nothing about the finding (#1114).
 */
export function composeArmStatus(
  deterministic: FindingVerificationStatus | null,
  panel: FindingSupportPanel | null,
  flagAt: readonly SupportPanelConfidence[] = DEFAULT_PANEL_FLAG_AT,
): FindingVerificationStatus | null {
  if (deterministic === "unverified" || deterministic === "could-not-verify") return deterministic;
  if (panel && flagAt.includes(panel.confidence)) return "unverified";
  return deterministic;
}

/** Map a corpus case's labelled excerpts into the panel's evidence shape. */
export function caseEvidence(c: VerificationCase): PanelEvidence[] {
  return c.evidence.map((e) => ({
    filePath: e.filePath,
    startLine: e.startLine,
    endLine: e.endLine,
    excerpt: e.excerpt,
  }));
}

/** Fold the metric's own extractor/judge round-trips into the arm's cost. */
const addUsage = (
  base: ArmUsage,
  extra:
    | { usage: { promptTokens: number; completionTokens: number }; llmCalls: number }
    | undefined,
): ArmUsage =>
  extra
    ? {
        promptTokens: base.promptTokens + extra.usage.promptTokens,
        completionTokens: base.completionTokens + extra.usage.completionTokens,
        // The real round-trip count, counted by the provider wrapper the metric
        // runs behind — not an estimate. The cost half of #1108's trade is only
        // usable if it is the measured number.
        llmCalls: base.llmCalls + extra.llmCalls,
      }
    : base;

const usageOf = (panel: FindingSupportPanel | null): ArmUsage =>
  panel
    ? {
        promptTokens: panel.usage.promptTokens,
        completionTokens: panel.usage.completionTokens,
        llmCalls: panel.usage.llmCalls,
      }
    : { promptTokens: 0, completionTokens: 0, llmCalls: 0 };

/**
 * The #1109 arm: deterministic gate, then the multi-lens panel over the same
 * evidence the case says the agent was given.
 *
 * Cost is reported per case (including #1114 re-prompts) so the harness's
 * tokens-per-finding number is the real one, not a per-lens estimate multiplied
 * by three.
 */
export function panelArm(opts: PanelArmOptions): VerifierArm {
  const flagAt = opts.flagAt ?? DEFAULT_PANEL_FLAG_AT;
  return {
    id: "panel",
    label: `PANEL — #1109 multi-lens support panel over the #740 gate (flags at: ${flagAt.join(", ")})`,
    usesLlm: true,
    verify: async (c: VerificationCase) => {
      const deterministic = verifyFinding({
        groundedCitations: c.groundedCitations,
        droppedCitations: c.droppedCitations,
        assertsAbsence: assertsAbsence({
          title: c.finding.title,
          body: c.finding.body,
          tags: c.finding.tags,
        }),
        absenceConfirmable: c.absenceConfirmable,
      });
      const panel = await runSupportPanel(
        opts.provider,
        {
          finding: { title: c.finding.title, body: c.finding.body },
          citations: c.groundedCitations,
          evidencePool: caseEvidence(c),
        },
        {
          enabled: true,
          ...(opts.model ? { model: opts.model } : {}),
          ...(opts.metrics ? { metrics: opts.metrics } : {}),
          ...(opts.signal ? { signal: opts.signal } : {}),
        },
      );
      // #1318 — the shared metric, over the SAME evidence the panel just read.
      // It is computed by production's `scoreFindingFaithfulness`, so what the
      // harness reports is the number the analysis pipeline would attach, not a
      // harness-local re-implementation of it.
      const scored = opts.faithfulness
        ? await scoreFindingFaithfulness(
            opts.provider,
            {
              finding: { title: c.finding.title, body: c.finding.body },
              citations: c.groundedCitations,
              evidencePool: caseEvidence(c),
            },
            {
              enabled: true,
              ...(opts.model ? { model: opts.model } : {}),
              ...(opts.signal ? { signal: opts.signal } : {}),
              ...(opts.faithfulnessDeps ?? {}),
            },
          )
        : undefined;
      return {
        status: composeArmStatus(deterministic, panel, flagAt),
        usage: addUsage(usageOf(panel), scored ?? undefined),
        // `undefined` when the metric was not asked for; `null` when it was asked
        // for and this case had nothing to judge. Never conflated.
        ...(opts.faithfulness ? { faithfulness: scored?.faithfulness ?? null } : {}),
      };
    },
  };
}

/**
 * Parse `--panel-flag-at <low|medium>`. `medium` widens the warning to include
 * outvoted dissent; anything else is rejected loudly rather than silently
 * falling back, so a typo cannot report one configuration under another's name.
 */
export function parsePanelFlagAt(argv: string[]): readonly SupportPanelConfidence[] {
  const i = argv.indexOf("--panel-flag-at");
  const next = i >= 0 ? argv[i + 1] : undefined;
  if (next === undefined || next.startsWith("--")) return DEFAULT_PANEL_FLAG_AT;
  if (next === "low") return ["low"];
  if (next === "medium") return ["low", "medium"];
  throw new Error(
    `unknown --panel-flag-at ${JSON.stringify(next)}. Expected "low" (default) or "medium".`,
  );
}
