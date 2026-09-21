/**
 * Epic #1107 / Issue #1108 — the verifier ARM seam.
 *
 * An "arm" is one way of deciding whether a finding should be down-weighted. The
 * harness runs arms over IDENTICAL corpus inputs and reports them side by side,
 * so the question the epic actually asks — *"is the panel better than free?"* —
 * is answered by a difference, not by a level.
 *
 * ── THE TWO ARMS ────────────────────────────────────────────────────────────
 *
 * `deterministic` (this file) is the shipped baseline: the REAL production
 * functions, `assertsAbsence` + `verifyFinding`, called exactly as
 * `orchestrator.ts` calls them. It reads only the #734 gate's output — grounded
 * citations, dropped citations, absence-evidence health — and CANNOT read the
 * `evidence` excerpts on the case. That is not an oversight in the harness: it is
 * the actual limitation the epic exists to price. It costs zero tokens and cannot
 * fail the run.
 *
 * `panel` (#1109) does not exist yet. {@link resolvePanelArm} therefore throws a
 * named error rather than silently degrading to the baseline — a mis-configured
 * run that quietly reported baseline numbers under a "panel" label would be the
 * #1016 defect all over again, and this harness is the thing gating a default-on
 * decision.
 *
 * ── WIRING #1109 IS A ONE-FUNCTION CHANGE ───────────────────────────────────
 *
 * Implement a factory of type {@link PanelArmFactory} that closes over an
 * `AIProvider`, and pass it to the runner as `panelArmFactory`. Everything else —
 * corpus, scoring, cost accounting, thresholds, reports, the arm comparison — is
 * already arm-agnostic. The panel implementation must:
 *
 *   • return `null` (NO SIGNAL) when it cannot produce a parseable verdict, never
 *     a negative one (#1114 — recall-first applies to the verifier's own failures);
 *   • report its token usage in {@link ArmVerdict.usage}, or the cost half of this
 *     harness silently reads zero and the quality-per-token trade cannot be made;
 *   • never delete a finding — votes produce a confidence signal, not a gate
 *     (the epic's central design decision).
 */
import type { FindingFaithfulness, FindingVerificationStatus } from "@metis/shared";
import { verifyFinding } from "../../analysis/finding-verification.js";
import { assertsAbsence } from "../../analysis/requirement-verdict.js";
import type { VerificationCase } from "./corpus.js";

/** Registered arm ids. `--arm <id>` and `--arm both` resolve against these. */
export const VERIFIER_ARM_IDS = ["deterministic", "panel"] as const;
export type VerifierArmId = (typeof VERIFIER_ARM_IDS)[number];

/** Token + call cost of producing ONE verdict. Absent ⇒ free (the baseline). */
export interface ArmUsage {
  promptTokens: number;
  completionTokens: number;
  /** Number of model round-trips. A three-lens panel makes 3 per finding. */
  llmCalls: number;
}

/** One arm's verdict on one case. */
export interface ArmVerdict {
  /**
   * The verdict. `null` means NO SIGNAL — the arm declined or failed to judge.
   * It is never a negative verdict; see the scorer's module doc.
   */
  status: FindingVerificationStatus | null;
  usage?: ArmUsage;
  /**
   * Epic #1316 (#1318) — the arm's claim-level FAITHFULNESS for this case, on
   * the SAME [0,1] scale docs-gen reports, produced by the SAME shared substrate
   * the analysis pipeline now uses.
   *
   * Three states, three meanings, and keeping them apart is the point:
   *   - a metric with a number   -> the arm judged the claims; this is supported/total;
   *   - a metric with `score: null`, or `null` itself
   *                              -> the arm tried and could not verify. EXCLUDED
   *                                 from the mean, never counted as a pass;
   *   - `undefined`              -> this arm does not compute the metric AT ALL.
   *
   * The deterministic baseline is the third case BY CONSTRUCTION: it reads only
   * whether a locator was retrieved and spends zero tokens, so it has nothing
   * from which to compute entailment. Reporting `0` for it would read as "the
   * free gate scores badly on faithfulness" when the truth is that the question
   * is not one it can be asked — so the report renders it `n/a`.
   */
  faithfulness?: FindingFaithfulness | null;
}

/** A pluggable verification strategy. */
export interface VerifierArm {
  id: VerifierArmId;
  /** Human label carried into every report, e.g. "BASELINE (deterministic, free)". */
  label: string;
  /** True ⇒ this leg makes live model calls and is separately reportable (#1108). */
  usesLlm: boolean;
  verify(c: VerificationCase): Promise<ArmVerdict>;
}

/** Factory for the #1109 panel arm, injected by the CLI once it exists. */
export type PanelArmFactory = () => VerifierArm;

/**
 * The shipped, free, deterministic gate — production's `verifyFinding` fed from
 * the corpus exactly as `orchestrator.ts` feeds it.
 *
 * `assertsAbsence` is CALLED, not labelled in the corpus, on purpose: the absence
 * classifier is part of the thing under test (it is "deliberately generous", and
 * VC-12 exists to price that generosity). Labelling its output in the manifest
 * would measure a re-implementation instead of the shipped path.
 */
export function deterministicArm(): VerifierArm {
  return {
    id: "deterministic",
    label: "BASELINE — deterministic citation gate (#740, free, LLM-free)",
    usesLlm: false,
    verify: async (c: VerificationCase): Promise<ArmVerdict> => {
      const claimsAbsence = assertsAbsence({
        title: c.finding.title,
        body: c.finding.body,
        tags: c.finding.tags,
      });
      return {
        status: verifyFinding({
          groundedCitations: c.groundedCitations,
          droppedCitations: c.droppedCitations,
          assertsAbsence: claimsAbsence,
          absenceConfirmable: c.absenceConfirmable,
        }),
      };
    },
  };
}

/**
 * Resolve the #1109 panel arm. Throws a named error when no factory is injected,
 * mirroring `resolveSearcher`'s LLM guard in the impact-recall runner: a
 * mis-configured run must fail loud rather than report baseline numbers under a
 * panel label.
 */
export function resolvePanelArm(factory?: PanelArmFactory): VerifierArm {
  if (!factory) {
    throw new Error(
      "The multi-lens LLM panel arm is not wired yet (#1109). Run `pnpm eval:verification` " +
        "with its default `--arm deterministic` to measure the free baseline, or inject a " +
        "panelArmFactory to measure the panel. This harness will NOT fall back to the " +
        "baseline under a panel label — that is how a measurement lies.",
    );
  }
  return factory();
}

/** Resolve an arm id to an arm, injecting the panel factory when one exists. */
export function resolveArm(id: VerifierArmId, panelArmFactory?: PanelArmFactory): VerifierArm {
  return id === "deterministic" ? deterministicArm() : resolvePanelArm(panelArmFactory);
}

/**
 * Parse `--arm <deterministic|panel|both>`. Defaults to `deterministic`: the panel
 * does not exist until #1109, so the default must be the arm that runs offline.
 */
export function parseArmSelection(argv: string[]): VerifierArmId[] {
  const i = argv.indexOf("--arm");
  const next = i >= 0 ? argv[i + 1] : undefined;
  if (next === "both") return ["deterministic", "panel"];
  if (next === "panel") return ["panel"];
  if (next === "deterministic") return ["deterministic"];
  if (next !== undefined && !next.startsWith("--")) {
    throw new Error(
      `unknown --arm ${JSON.stringify(next)}. Expected one of: deterministic, panel, both.`,
    );
  }
  return ["deterministic"];
}
