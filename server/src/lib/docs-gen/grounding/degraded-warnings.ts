/**
 * Degraded-output warnings (Epic #204 / Issue #225).
 *
 * Previously, section-generation failures were silently buried as HTML comments
 * inside the document body (`<!-- Section "X" failed: ... -->`) while the
 * document was still marked `ready` — hiding degraded output from the user.
 *
 * This module models explicit, surfaceable warnings and derives the document
 * status from them so a doc with failed or ungrounded sections is NEVER reported
 * as a clean `ready`. Warnings are persisted (JSON) and surfaced in the UI.
 */

/** What kind of degradation occurred. */
export type DocWarningKind =
  | "section-failed"
  | "section-ungrounded"
  | "no-modules"
  | "source-unavailable"
  | "facts-truncated"
  /** #1226 — the model's OUTPUT was cut off by the max-tokens cap. */
  | "section-truncated"
  /** #1226 — a declared section group produced nothing in the final document. */
  | "section-missing"
  /** DOCS_GEN_GROUNDING=off — the section was never fact-checked. */
  | "grounding-skipped"
  /** DOCS_GEN_GROUNDING=sample — only a sample of the section was fact-checked. */
  | "grounding-sampled";

export type DocWarningSeverity = "warning" | "error";

/**
 * The faithfulness TIER a `section-ungrounded` warning was gated at. This is a
 * clean discriminator the UI can switch on WITHOUT re-deriving thresholds:
 *
 *  - `"narrative"` — inherently-abstractive narrative section (Overview & Domain,
 *    Core Business Capabilities), gated at {@link NARRATIVE_FAITHFULNESS_THRESHOLD}.
 *    A below-bar result is expected (the gap is general domain knowledge, not a
 *    defect). Always paired with `domainContext: true` for back-compat.
 *  - `"reconstruction"` — inference-mandating section (Key Workflows, Data &
 *    Domain Model), gated at {@link RECONSTRUCTION_FAITHFULNESS_THRESHOLD}. A
 *    below-bar result means the mandated structural inference ran ahead of what
 *    the code substantiates — treat unsupported details as inferred and verify.
 *  - `"literal"` — code-derived section (Business Rules, Calculations,
 *    Integrations), gated at the strict {@link DEFAULT_FAITHFULNESS_THRESHOLD}.
 *    A below-bar result genuinely signals possible fabrication and is worth a
 *    direct review.
 *
 * Absent on `section-failed` / `no-modules` / legacy `sectionUngroundedWarning`
 * outputs, which are not tier-gated faithfulness warnings.
 */
export type DocWarningTier = "narrative" | "reconstruction" | "literal";

/** A single, user-surfaceable degraded-output warning. */
export interface DocWarning {
  kind: DocWarningKind;
  /** The section group label this warning concerns. */
  section: string;
  /** Human-readable message safe to show in the UI. */
  message: string;
  severity: DocWarningSeverity;
  /**
   * #273 — the section's numeric faithfulness ratio (supported/total) in [0,1].
   * Present on `section-ungrounded` warnings produced by the entailment-based
   * scorer; the numeric ratio was previously computed and dropped. Surfaced in
   * the UI banner so users see HOW unfaithful a section is, not just that it is.
   */
  ratio?: number;
  /** #273 — the faithfulness threshold the ratio was compared against. */
  threshold?: number;
  /**
   * #283 — true when this `section-ungrounded` warning concerns an inherently
   * ABSTRACTIVE narrative section (Overview & Domain, Core Business Capabilities)
   * gated at the lower narrative bar. Signals the UI to render the honest
   * "X% grounded; remainder is domain context" framing instead of the alarming
   * "may be unreliable" copy. Absent/false on code-derived sections.
   *
   * Retained for back-compat; new code should switch on the richer {@link tier}
   * discriminator, which also distinguishes `reconstruction` from `literal`.
   */
  domainContext?: boolean;
  /**
   * The faithfulness {@link DocWarningTier} this `section-ungrounded` warning was
   * gated at (`narrative` | `reconstruction` | `literal`). An explicit, additive
   * discriminator so the UI can pick severity-appropriate framing per section
   * WITHOUT re-deriving thresholds from `ratio`/`threshold`. Absent on
   * `section-failed` / `no-modules` and on the legacy count-based
   * {@link sectionUngroundedWarning}.
   */
  tier?: DocWarningTier;
  /**
   * #67 — true when this `section-failed` warning's detail is METIS-authored
   * text (a fixed `generationFailureMessage` string, or prose this codebase
   * wrote), rather than an exception's own message.
   *
   * It exists so the READ path can tell a post-#67 warning from one persisted
   * before it. A `section-failed` warning without this flag may still carry up
   * to 300 characters of raw `String(err)` — provider response bodies, absolute
   * paths, SQL text — so `publicDocWarnings` re-derives its detail through the
   * fixed vocabulary before any of it reaches a client. Absent on every other
   * warning kind, none of which is ever built from an exception.
   */
  detailSafe?: boolean;
  /**
   * DOCS_GEN_GROUNDING=sample — true when the `ratio` on this warning was
   * computed from a SAMPLE of the section's statements, never from all of
   * them. Set on every faithfulness warning a sampled check produces, so a
   * sampled score can never be read as a full verification.
   */
  sampled?: boolean;
}

/**
 * #273 — default faithfulness threshold (RAGAS-style supported/total). A section
 * stays `ready` when its faithfulness is ≥ this; below it the section is
 * `degraded`. This replaces the old binary "any single ungrounded claim →
 * degraded" rule, which structurally false-flagged accurate abstractive
 * synthesis. Override at runtime with `DOCS_FAITHFULNESS_THRESHOLD` (a float in
 * [0,1]); an out-of-range or non-numeric value falls back to this default.
 */
export const DEFAULT_FAITHFULNESS_THRESHOLD = 0.8;

/** Resolve the active faithfulness threshold (env override → default). */
export function faithfulnessThreshold(): number {
  const raw = process.env.DOCS_FAITHFULNESS_THRESHOLD;
  if (!raw) return DEFAULT_FAITHFULNESS_THRESHOLD;
  const n = Number.parseFloat(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return DEFAULT_FAITHFULNESS_THRESHOLD;
  return n;
}

/**
 * #283 — lower faithfulness bar for INHERENTLY-ABSTRACTIVE narrative sections
 * (Overview & Domain, Core Business Capabilities). These sections are MANDATED
 * by their prompts to supply business/domain narrative (e.g. Acme Freight network, DOT
 * mitigation) that the source code legitimately does not contain, so the
 * entailment judge correctly marks those domain claims unsupported. Holding
 * them to the same 0.80 code-fidelity bar as code-derived sections (Business
 * Rules, Workflows, Calculations, Data Model) structurally false-flagged
 * accurate domain synthesis as "unreliable" (the SAS `risk-calc` Overview 20%
 * case, post-#277).
 *
 * 0.4 is a defensible floor: it still catches a section that is mostly
 * hallucinated (≥60% unsupported) while tolerating the expected ~half of
 * domain-context claims that no code chunk can entail. Code-derived sections
 * keep {@link DEFAULT_FAITHFULNESS_THRESHOLD}, because for them an unsupported
 * claim genuinely signals fabrication. With opt-in web-research domain grounding
 * (#283 part c) present, even narrative sections clear the bar honestly.
 */
export const NARRATIVE_FAITHFULNESS_THRESHOLD = 0.4;

/**
 * MODERATE faithfulness bar for RECONSTRUCTION sections — Key Workflows and
 * Data & Domain Model.
 *
 * These sections sit BETWEEN the two existing tiers. Unlike Business Rules or
 * Integrations (literal, code-derived — every claim should trace to a fact, so
 * they keep the strict {@link DEFAULT_FAITHFULNESS_THRESHOLD} of 0.80), and
 * unlike Overview & Domain or Core Business Capabilities (inherently abstractive
 * domain narrative gated at {@link NARRATIVE_FAITHFULNESS_THRESHOLD} of 0.40),
 * the Workflows and Data-Model prompts MANDATE structural RECONSTRUCTION the
 * source rarely states verbatim: explicit Trigger / Preconditions /
 * Postconditions / Error Paths for each workflow, and a reconstruction-grade
 * per-field data dictionary (Type / Constraint / Default / Range) for each
 * entity. Much of that is legitimately INFERRED from the code rather than quoted,
 * so the faithfulness judge correctly marks the inferred scaffolding unsupported
 * even when the section is accurate — which held these sections to an impossible
 * 0.80 bar (the SAS `risk` Key Workflows 0/7 and Data & Domain Model 26% cases).
 *
 * 0.6 is the principled middle: it still flags a genuinely-bad section (the
 * 0%/26% cases — mostly hallucination or meta-commentary) while tolerating the
 * expected minority of inferred-structure claims that no code chunk can entail.
 * We deliberately do NOT mark these sections `narrative`: for a TypeScript/Java
 * project their Workflows/Data-Model content SHOULD be strongly code-grounded, so
 * an explicit moderate threshold is more honest than relaxing them to the 0.40
 * narrative floor (which would under-police well-sourced languages). The
 * {@link DOCS_FAITHFULNESS_THRESHOLD} env override still wins via
 * {@link resolveSectionFaithfulnessThreshold} when an operator sets it.
 */
export const RECONSTRUCTION_FAITHFULNESS_THRESHOLD = 0.6;

/**
 * #283 — resolve the faithfulness threshold for a single section. An explicit
 * per-section override (carried on the section group definition) wins; otherwise
 * the global {@link faithfulnessThreshold} (env-overridable) applies. An
 * out-of-range override is ignored in favour of the global default, mirroring
 * the env-parsing guard so a typo can never disable gating.
 */
export function resolveSectionFaithfulnessThreshold(override?: number): number {
  if (typeof override === "number" && Number.isFinite(override) && override >= 0 && override <= 1) {
    return override;
  }
  return faithfulnessThreshold();
}

/**
 * The minimal tier-carrying shape of a section-group definition. A structural
 * subset of `SectionGroup` (holistic-synthesizer.ts) deliberately declared here
 * so {@link tierForSection} — the single source of truth for the tier mapping —
 * lives next to the tier constants without importing the synthesizer (which
 * would create a cycle: the synthesizer already imports this module).
 */
export interface SectionTierSignal {
  /** True for inherently-abstractive narrative sections (Overview, Capabilities). */
  narrative?: boolean;
  /** True for inference-mandating reconstruction sections (Workflows, Data Model). */
  reconstruction?: boolean;
  /**
   * Optional explicit per-section faithfulness override. Used only as a
   * secondary discriminator when the boolean flags are absent (a group that set
   * exactly {@link RECONSTRUCTION_FAITHFULNESS_THRESHOLD} is treated as
   * reconstruction; {@link NARRATIVE_FAITHFULNESS_THRESHOLD} as narrative).
   */
  faithfulnessThreshold?: number;
}

/**
 * #333 — map a section group to its faithfulness {@link DocWarningTier} from the
 * SAME flags/thresholds that already gate it. This is the single source of truth
 * for the tier of a section; hybrid per-section provider routing
 * (holistic-synthesizer.ts) and the judge-gated escalation to follow (#334)
 * both consume it, so the routing decision can never drift from the gating
 * decision.
 *
 * Precedence mirrors how `sectionGroupsFor` sets the flags:
 *   1. `narrative === true`        → `"narrative"`   (0.4 bar)
 *   2. `reconstruction === true`   → `"reconstruction"` (0.6 bar)
 *   3. an explicit threshold equal to a tier constant → that tier
 *   4. otherwise                   → `"literal"`     (0.8 bar)
 *
 * The boolean flags are mutually exclusive by construction (a group is at most
 * one of narrative/reconstruction), and `narrative` wins if both were somehow
 * set, matching the gating order in `validateSectionGrounding`.
 */
export function tierForSection(group: SectionTierSignal): DocWarningTier {
  if (group.narrative) return "narrative";
  if (group.reconstruction) return "reconstruction";
  if (group.faithfulnessThreshold === RECONSTRUCTION_FAITHFULNESS_THRESHOLD) {
    return "reconstruction";
  }
  if (group.faithfulnessThreshold === NARRATIVE_FAITHFULNESS_THRESHOLD) {
    return "narrative";
  }
  return "literal";
}

/** Document status reflecting grounding/generation health. */
export type DocHealthStatus = "ready" | "degraded";

/**
 * Build a warning for a section whose generation threw/failed.
 *
 * `detail` is a contract: it must be METIS-AUTHORED text — a fixed
 * {@link import("../generation-failure-message.js").generationFailureMessage}
 * string, or prose this codebase wrote. It must NEVER be `String(err)` or an
 * exception's `message` (#67): this message is persisted in the `warnings`
 * column, returned by `GET /projects/:projectId/docs/:docId` and rendered in
 * the UI banner, so a raw exception here puts provider response bodies, server
 * paths and SQL text in front of a user. A caller holding an exception maps it
 * through `generationFailureMessage` first.
 * `docs-gen-warning-detail.enumeration.test.ts` fails on a call site that does
 * not, so the contract is checked rather than merely documented.
 */
export function sectionFailedWarning(section: string, detail: string): DocWarning {
  const trimmed = detail.trim().slice(0, 300);
  // The fixed vocabulary strings are whole sentences and end in their own full
  // stop; appending another produced "… try again..".
  const stop = /[.!?]$/.test(trimmed) ? "" : ".";
  return {
    kind: "section-failed",
    section,
    message: `Section "${section}" could not be generated${trimmed ? `: ${trimmed}${stop}` : "."}`,
    severity: "error",
    detailSafe: true,
  };
}

/** Build a warning for a section that contains ungrounded/stripped claims. */
export function sectionUngroundedWarning(
  section: string,
  ungroundedCount: number,
  totalClaims: number,
): DocWarning {
  return {
    kind: "section-ungrounded",
    section,
    message:
      `Section "${section}" contains ${ungroundedCount} of ${totalClaims} statement(s) ` +
      `that could not be automatically verified against the retrieved source — review them ` +
      `against the code before relying on them. (Not auto-verified does not necessarily mean ` +
      `incorrect: the supporting source may simply not have been retrieved.)`,
    severity: "warning",
  };
}

/**
 * #273 — build a warning for a section whose entailment-based FAITHFULNESS fell
 * below the threshold (supported/total < threshold). Unlike
 * {@link sectionUngroundedWarning}, this carries the numeric `ratio` and
 * `threshold` so they can be persisted and rendered. Same `section-ungrounded`
 * kind/severity for UI back-compat (the banner already groups these), but the
 * message is faithfulness-framed.
 */
export function sectionUnfaithfulWarning(
  section: string,
  result: {
    supportedClaims: number;
    totalClaims: number;
    faithfulness: number;
    threshold: number;
  },
): DocWarning {
  const pct = Math.round(result.faithfulness * 100);
  const thresholdPct = Math.round(result.threshold * 100);
  return {
    kind: "section-ungrounded",
    section,
    message:
      `Section "${section}": ${pct}% of statements (${result.supportedClaims} of ` +
      `${result.totalClaims}) were automatically verified against the retrieved source, below ` +
      `the ${thresholdPct}% bar for this code-derived section. Review the unverified statements ` +
      `against the code before relying on them. (Not auto-verified does not necessarily mean ` +
      `incorrect — the supporting source may not have been retrieved — but for a code-derived ` +
      `section it is the most important place to check.)`,
    severity: "warning",
    ratio: result.faithfulness,
    threshold: result.threshold,
    // Literal code-derived section: an unverified claim is the most likely place
    // a real error would hide, so this is the "review recommended" tier.
    tier: "literal",
  };
}

/**
 * #283 — build an HONEST, non-alarming warning for an inherently-abstractive
 * NARRATIVE section (Overview & Domain, Core Business Capabilities) that fell
 * below its (lower) per-section threshold. Unlike {@link sectionUnfaithfulWarning}
 * — which frames a code-derived section as "unreliable", appropriate when an
 * unsupported claim signals fabrication — this message frames the gap as
 * expected domain/business context rather than a defect: the grounded fraction
 * is reported as a positive, and the remainder is attributed to general domain
 * knowledge, not error. Same `section-ungrounded` kind/severity for UI
 * back-compat (the banner already groups + renders these), and it still carries
 * `ratio`/`threshold` so {@link deriveDocStatus} marks the doc `degraded` and the
 * UI can render the numeric breakdown.
 */
export function sectionPartlyGroundedWarning(
  section: string,
  result: {
    supportedClaims: number;
    totalClaims: number;
    faithfulness: number;
    threshold: number;
  },
): DocWarning {
  const pct = Math.round(result.faithfulness * 100);
  return {
    kind: "section-ungrounded",
    section,
    message:
      `Section "${section}": ${pct}% of claims (${result.supportedClaims} of ` +
      `${result.totalClaims}) are grounded in source code; the remaining claims provide ` +
      `domain/business context from general knowledge rather than the codebase.`,
    severity: "warning",
    ratio: result.faithfulness,
    threshold: result.threshold,
    domainContext: true,
    // Narrative tier: the gap is expected domain context, not a defect. Kept in
    // lock-step with `domainContext: true` (the legacy boolean) above.
    tier: "narrative",
  };
}

/**
 * Build a warning for a RECONSTRUCTION section (Key Workflows, Data & Domain
 * Model) whose faithfulness fell below its moderate
 * {@link RECONSTRUCTION_FAITHFULNESS_THRESHOLD} bar. The copy is framed
 * accurately for these sections: their prompts MANDATE inferred structure
 * (Trigger/Preconditions/Postconditions/Error Paths; per-field data dictionary),
 * so a below-bar result means the inferred scaffolding ran well AHEAD of what the
 * code substantiates — not that the section is fabricated (the
 * {@link sectionUnfaithfulWarning} "may be unreliable" framing, reserved for
 * literal code-derived sections) nor that the gap is general-knowledge domain
 * context (the {@link sectionPartlyGroundedWarning} framing, reserved for
 * abstractive narrative sections). Same `section-ungrounded` kind/severity for UI
 * back-compat, and carries `ratio`/`threshold` so {@link deriveDocStatus} marks
 * the doc `degraded` and the UI can render the numeric breakdown.
 */
export function sectionUnderReconstructedWarning(
  section: string,
  result: {
    supportedClaims: number;
    totalClaims: number;
    faithfulness: number;
    threshold: number;
  },
): DocWarning {
  const pct = Math.round(result.faithfulness * 100);
  const thresholdPct = Math.round(result.threshold * 100);
  return {
    kind: "section-ungrounded",
    section,
    message:
      `Section "${section}": only ${pct}% of claims (${result.supportedClaims} of ` +
      `${result.totalClaims}) trace to the source code, below the ${thresholdPct}% bar for ` +
      `reconstructed sections. This section reconstructs structure (workflow steps, ` +
      `data-dictionary fields) that the code does not fully spell out, so treat the ` +
      `unsupported details as inferred and verify them against the source.`,
    severity: "warning",
    ratio: result.faithfulness,
    threshold: result.threshold,
    // Reconstruction tier: mandated structural inference, not fabrication and not
    // general-knowledge domain context — distinct from both other tiers.
    tier: "reconstruction",
  };
}

/**
 * #117 — the grounding model's reply could not be parsed, so the section was
 * not (or not fully) checked against the source. Before #117 an unparseable
 * claim list returned zero claims and the section passed as a clean `ready`
 * with no faithfulness check at all — silently. Same `section-ungrounded`
 * kind as the other "not auto-verified" warnings (the UI banner and the
 * section-reuse schema already handle it); no `tier`, because no score exists,
 * so the UI treats it as worth a review.
 *
 * #152 — `cause: "truncated"` is a reply stopped at the output cap. The remedy
 * is then the cap, never the structured-output mode: telling the operator to
 * set `json_object` for a cut-off reply was wrong, and circular when the reply
 * had already been retried in `json_object` mode. The non-truncated remedy is
 * worded conditionally for the same reason — by the time this warning exists a
 * `json_schema` reply has already been retried in `json_object` mode.
 */
export function groundingUnparseableWarning(
  section: string,
  stage: "claims" | "verdicts",
  cause?: "truncated",
): DocWarning {
  let what: string;
  let remedy: string;
  if (cause === "truncated") {
    what =
      stage === "claims"
        ? "the grounding model's claim list exceeded its output cap even after the section was split into smaller passages, so none of its statements were checked"
        : "some of the grounding model's verdict lists exceeded its output cap, so those statements were not checked";
    remedy =
      stage === "claims"
        ? "To verify it, raise DOCS_GEN_CLAIM_MAX_OUTPUT_TOKENS (a model that reasons by default spends part of that cap on reasoning) and regenerate."
        : "To verify them, raise DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS, which also caps the faithfulness judge, and regenerate.";
  } else {
    what =
      stage === "claims"
        ? "the grounding model's claim list could not be parsed, so none of its statements were checked"
        : "some of the grounding model's verdicts could not be parsed, so those statements were not checked";
    remedy =
      "If DOCS_GEN_LOCAL_STRUCTURED_OUTPUT is off, a local model that answers in prose may " +
      "follow JSON mode: set DOCS_GEN_LOCAL_STRUCTURED_OUTPUT=json_object.";
  }
  return {
    kind: "section-ungrounded",
    section,
    message:
      `Section "${section}" was not fully verified against the source: ${what}. Review it ` +
      `against the code before relying on it. ${remedy}`,
    severity: "warning",
  };
}

/** How much of a section a sampled fact-check covered (DOCS_GEN_GROUNDING=sample). */
export interface GroundingSampleCoverage {
  /** The configured sample rate in (0, 1]. */
  rate: number;
  /** Passages (paragraphs, list blocks, tables) whose statements were checked. */
  passagesChecked: number;
  /** Passages in the section. */
  passagesTotal: number;
  /** Characters of the section those passages hold. */
  charsChecked: number;
  /** Characters of the section's passages in total. */
  charsTotal: number;
}

/** "checked N of M passages (about P% of its text)" — shared sample wording. */
function describeSample(sample: GroundingSampleCoverage): string {
  const pct =
    sample.charsTotal > 0 ? Math.round((sample.charsChecked / sample.charsTotal) * 100) : 0;
  return `${sample.passagesChecked} of its ${sample.passagesTotal} passages (about ${pct}% of its text)`;
}

/**
 * DOCS_GEN_GROUNDING=off — the section was written but never fact-checked: no
 * claim extraction and no faithfulness judge ran. A warning (so the document is
 * `degraded`, never a clean `ready`) because an unchecked section must not look
 * verified. No `ratio`: no score exists.
 */
export function groundingSkippedWarning(section: string): DocWarning {
  return {
    kind: "grounding-skipped",
    section,
    message:
      `Section "${section}" was NOT fact-checked: grounding verification was switched off for ` +
      `this run (DOCS_GEN_GROUNDING=off), so none of its statements were checked against the ` +
      `source. Review it against the code before relying on it, or regenerate with ` +
      `DOCS_GEN_GROUNDING=on for a full check.`,
    severity: "warning",
  };
}

/**
 * DOCS_GEN_GROUNDING=sample — a section whose SAMPLED faithfulness met its bar.
 * Still a warning: a sample is an estimate, not a verification, so the section
 * must not read as fully checked. Carries the sampled `ratio`, flagged
 * `sampled: true`.
 */
export function groundingSampledWarning(
  section: string,
  result: {
    supportedClaims: number;
    totalClaims: number;
    faithfulness: number;
    threshold: number;
    unparseable?: boolean;
  },
  sample: GroundingSampleCoverage,
): DocWarning {
  const pct = Math.round(result.faithfulness * 100);
  const thresholdPct = Math.round(result.threshold * 100);
  return {
    kind: "grounding-sampled",
    section,
    message:
      `Section "${section}" was only SPOT-CHECKED (DOCS_GEN_GROUNDING=sample): statements from ` +
      `${describeSample(sample)} were checked against the source, and ${pct}% of those ` +
      `(${result.supportedClaims} of ${result.totalClaims}) were supported (bar ${thresholdPct}%). ` +
      `This is an estimate from a sample, not a full verification — the rest of the section was ` +
      `not checked.` +
      (result.unparseable
        ? " Some of the grounding model's replies could not be parsed, so part of the sample went unchecked too."
        : ""),
    severity: "warning",
    ratio: result.faithfulness,
    threshold: result.threshold,
    sampled: true,
  };
}

/**
 * DOCS_GEN_GROUNDING=sample — relabel a below-bar faithfulness warning whose
 * score came from a sample: the message says so up front and the warning is
 * flagged `sampled: true`. Kind, tier and ratio are unchanged, so the UI's
 * tier framing still applies.
 */
export function markWarningSampled(
  warning: DocWarning,
  sample: GroundingSampleCoverage,
): DocWarning {
  return {
    ...warning,
    message:
      `[Spot-check only (DOCS_GEN_GROUNDING=sample): statements from ${describeSample(sample)} ` +
      `were checked; the figures below are an estimate from that sample, not a full ` +
      `verification.] ${warning.message}`,
    sampled: true,
  };
}

/**
 * Build a warning for the case where the project HAS indexed code symbols but
 * none of them survived the documentable-module filter, so synthesis produced an
 * empty document. Previously this returned a clean `ready` with zero warnings,
 * silently hiding the failure (e.g. SAS-only projects whose `function`-only
 * symbols were dropped by the class/interface-oriented filter). Surfacing a
 * warning forces {@link deriveDocStatus} to report `degraded`.
 */
export function noModulesWarning(symbolCount: number): DocWarning {
  return {
    kind: "no-modules",
    section: "Document",
    message:
      `The project has ${symbolCount} indexed code symbol(s) but none qualified as a ` +
      `documentable module, so an empty document was produced. This can happen when ` +
      `the code is composed entirely of small units (e.g. SAS macros/steps) or lives ` +
      `under excluded test/generated/build directories.`,
    severity: "warning",
  };
}

/**
 * Issue #330 — build a LOUD warning for modules whose source files could not be
 * read during Phase-1 fact extraction. When a module HAS indexed code symbols
 * (methods/classes) but ZERO of its source files were readable — e.g. the
 * connector's clone/extract directory is missing or was purged, or a cache-key
 * change forced a rebuild against files that are no longer on disk — fact
 * extraction silently produced empty facts and the section was generated at ~0%
 * grounding with no clear cause (the SAS `risk` Business Rules 78%→0% regression).
 *
 * This is an `error`-severity warning (not a soft `section-ungrounded` "needs
 * review") because the document is fundamentally untrustworthy: it was not
 * generated from source at all. The message tells the user the concrete remedy
 * (re-ingest / re-clone) rather than implying the content merely needs a
 * second look. {@link deriveDocStatus} marks the doc `degraded` from it.
 *
 * @param affectedModules - count of modules that read zero source files.
 * @param totalModules - count of modules with documentable code symbols.
 */
export function sourceUnavailableWarning(
  affectedModules: number,
  totalModules: number,
): DocWarning {
  return {
    kind: "source-unavailable",
    section: "Document",
    message:
      `${affectedModules} of ${totalModules} code module(s) could not be read from the ` +
      `project's source on disk, so their facts were extracted from little or no source ` +
      `code — any documentation generated for them is unreliable (effectively 0% grounded). ` +
      `This usually means the connector's clone or uploaded-archive directory is missing or ` +
      `was purged. Re-ingest (re-clone or re-upload) the project, then regenerate.`,
    severity: "error",
  };
}

/**
 * Issue #337 — a section whose relevance-selected module facts did NOT all fit
 * the provider's per-section `factsCharCap` (`DOCS_GEN_LOCAL_FACTS_CHAR_CAP` on
 * the local path), so lower-ranked modules were omitted from the facts blob.
 *
 * On the LOCAL provider this is a genuine grounding-degradation signal, not a
 * cosmetic note: the local model's context window is small (~32K), and if the
 * assembled facts + system prompt + output would exceed it, the runtime
 * context-shifts and can SILENTLY drop the instructions, yielding an empty or
 * fabricated section. Surfacing a warning (which forces {@link deriveDocStatus}
 * to report `degraded`) makes an oversized-context local run OBSERVABLE rather
 * than silent, and tells the operator the concrete remedy: raise
 * `DOCS_GEN_LOCAL_FACTS_CHAR_CAP` in lock-step with the served model's real
 * context window (`OLLAMA_CONTEXT_LENGTH` / vLLM `--max-model-len`), or narrow
 * retrieval so each section's facts blob fits.
 *
 * It is `warning` severity, not `error`: unlike `source-unavailable` (the doc
 * was never built from source) the section WAS generated from real facts — just
 * a relevance-ranked subset. Callers raise this whenever omission actually
 * occurred, on EVERY provider (#175): a large-window provider (Bedrock,
 * Anthropic ~200K) that leaves modules out of a section has still left them out,
 * and the document must say so rather than only a server log.
 *
 * @param section - the section-group label whose facts were truncated.
 * @param omittedModules - count of modules dropped to fit the cap.
 * @param includedModules - count of modules that fit and were sent.
 * @param factsCharCap - the per-section char cap the selection was capped to.
 * @param provider - which provider's cap applied; picks the env knob and remedy
 *   the message names. Defaults to `local` (the original, pre-#175 shape).
 */
export function factsTruncatedWarning(
  section: string,
  omittedModules: number,
  includedModules: number,
  factsCharCap: number,
  provider: FactsCapProvider = "local",
): DocWarning {
  const omitted =
    `so ${omittedModules} of ${omittedModules + includedModules} relevant module(s) ` +
    `were omitted from what the model read.`;
  if (provider !== "local") {
    const knob =
      provider === "anthropic"
        ? "DOCS_GEN_ANTHROPIC_FACTS_CHAR_CAP"
        : "DOCS_GEN_BEDROCK_FACTS_CHAR_CAP";
    return {
      kind: "facts-truncated",
      section,
      message:
        `The "${section}" section's source facts exceeded the ${provider} facts budget ` +
        `(${knob}=${factsCharCap} chars), ${omitted} The section was written from the ` +
        `highest-ranked modules only and may miss content from the rest. Raise ${knob} ` +
        `or narrow retrieval so each section's facts fit.`,
      severity: "warning",
    };
  }
  return {
    kind: "facts-truncated",
    section,
    message:
      `The "${section}" section's source facts exceeded the local model's context budget ` +
      `(DOCS_GEN_LOCAL_FACTS_CHAR_CAP=${factsCharCap} chars), ${omitted} ` +
      `On a small (~32K) local window this risks context-shift and degraded or ` +
      `empty output. Raise DOCS_GEN_LOCAL_FACTS_CHAR_CAP to fit the served model's real ` +
      `context window (in lock-step with OLLAMA_CONTEXT_LENGTH / vLLM --max-model-len), ` +
      `or narrow retrieval so each section's facts fit.`,
    severity: "warning",
  };
}

/** The provider kinds whose per-section facts cap can raise `facts-truncated`. */
export type FactsCapProvider = "local" | "bedrock" | "anthropic";

/** The section label {@link phase1FactsTruncatedWarning} uses. */
const PHASE1_FACTS_SECTION = "Phase 1 facts";

/** The per-provider facts-cap knobs a {@link factsTruncatedWarning} message names. */
const FACTS_CAP_KNOB = /DOCS_GEN_(?:LOCAL|BEDROCK|ANTHROPIC)_FACTS_CHAR_CAP/g;

/** How many module names {@link phase1FactsTruncatedWarning} lists before summarising. */
const TRUNCATED_MODULES_LISTED = 10;

/**
 * #156 — Phase-1 fact extraction for one or more modules was cut off by the
 * OUTPUT-token cap, even after the cut-off part was split down as far as it
 * goes (Phase 1 splits instead of retrying with a larger cap). Their facts are
 * incomplete (used for this run, never cached), so every section that reads
 * them may miss rules, workflows or formulas. Names the modules so an operator
 * knows where to look, and the knob that fixes it.
 */
export function phase1FactsTruncatedWarning(moduleNames: readonly string[]): DocWarning {
  const listed = moduleNames.slice(0, TRUNCATED_MODULES_LISTED).join(", ");
  const more =
    moduleNames.length > TRUNCATED_MODULES_LISTED
      ? ` and ${moduleNames.length - TRUNCATED_MODULES_LISTED} more`
      : "";
  return {
    kind: "facts-truncated",
    section: PHASE1_FACTS_SECTION,
    message:
      `Fact extraction for ${moduleNames.length} module(s) was cut off by the model's output ` +
      `limit even after their code was split into the smallest parts that could explain it, so their facts are incomplete: ${listed}${more}. ` +
      `Raise DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS or use a model with a larger output limit, then regenerate.`,
    severity: "warning",
  };
}

/**
 * Phase 1 reads a large module in several calls. When some or all of those
 * calls fail — or the module's extraction throws — its facts are incomplete or
 * missing; any parts that succeeded are cached, so a regeneration retries only
 * the failed ones. Names the modules.
 */
export function phase1ChunksFailedWarning(moduleNames: readonly string[]): DocWarning {
  const listed = moduleNames.slice(0, TRUNCATED_MODULES_LISTED).join(", ");
  const more =
    moduleNames.length > TRUNCATED_MODULES_LISTED
      ? ` and ${moduleNames.length - TRUNCATED_MODULES_LISTED} more`
      : "";
  return {
    kind: "section-failed",
    section: "Phase 1 facts",
    message:
      `Fact extraction failed for all or part of ${moduleNames.length} module(s), so their facts are incomplete or missing: ${listed}${more}. ` +
      `Any parts that succeeded are cached; regenerate to retry only the failed parts.`,
    severity: "warning",
  };
}

/**
 * #1226 — build a warning for a section whose generation hit the model's OUTPUT
 * token cap. Distinct from {@link factsTruncatedWarning}, which is about the
 * INPUT facts blob: this one means the model started writing the section and
 * was cut off mid-answer, so the persisted section is incomplete even though
 * the call "succeeded" (HTTP 200, no exception).
 *
 * `error` severity: unlike an unverified-but-plausible claim, a truncated
 * section is definitely missing content the document claims to cover.
 *
 * @param section - the section-group label that was cut off.
 * @param detail - which signal(s) fired (see `describeTruncation`).
 * @param maxTokens - the output cap that was in force, so the operator has the
 *   concrete remedy (raise `DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS`).
 * @param configKey - #1228: which cap key actually governs this call site.
 *   Defaults to the Phase-2 section key. The DB-schema synthesizer reads a
 *   DIFFERENT key, and naming the wrong one sends the operator to a knob that
 *   has no effect on the truncation they are looking at.
 */
export function sectionTruncatedWarning(
  section: string,
  detail: string,
  maxTokens?: number,
  configKey = "DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS",
): DocWarning {
  const capNote =
    typeof maxTokens === "number"
      ? ` The output cap in force was ${maxTokens} tokens — raise ` +
        `${configKey} (or narrow the section) and regenerate.`
      : ` Raise ${configKey} (or narrow the section) and regenerate.`;
  return {
    kind: "section-truncated",
    section,
    message:
      `Section "${section}" was CUT OFF by the model's output-token cap (${detail}), so its ` +
      `content is incomplete and later sub-sections may be missing entirely.${capNote}`,
    severity: "error",
  };
}

/** At most this many module names are spelled out in one warning. */
const MAX_NAMED_MODULES = 10;

function nameModules(modules: readonly string[]): string {
  const named = modules.slice(0, MAX_NAMED_MODULES).map((m) => `"${m}"`);
  const more = modules.length - named.length;
  return more > 0 ? `${named.join(", ")} and ${more} more` : named.join(", ");
}

/**
 * #157 — a BATCHED section (Rules, Workflows, Calculations, Data Model) is
 * written in several calls, so a cut-off reply leaves a hole for specific
 * modules rather than for "the rest of the section". This names them, and says
 * which of three cases it is:
 *   - `singleModules`: a module that alone writes more than one call can hold
 *     (splitting cannot help — only a larger cap can);
 *   - `allowanceSpent`: a multi-module batch that COULD have been split, but
 *     the section's re-split allowance (one per planned batch, shared) had
 *     already been used by earlier batches (PR #169 review);
 *   - `runaway`: a batch cut off although its facts were estimated to need far
 *     less than the cap, so splitting it would only have bought more full-cap
 *     calls (#165's repetition shape).
 *
 * `error` severity, like {@link sectionTruncatedWarning}: the section is
 * definitely missing content for these modules.
 */
export function batchTruncatedWarning(
  section: string,
  cutOff: {
    singleModules: readonly string[];
    /** One entry per batch, each listing its modules. */
    allowanceSpent: readonly (readonly string[])[];
    /** One entry per batch, each listing its modules. */
    runaway: readonly (readonly string[])[];
  },
  maxTokens: number,
): DocWarning {
  const parts: string[] = [];
  if (cutOff.singleModules.length > 0) {
    const one = cutOff.singleModules.length === 1;
    parts.push(
      `module${one ? "" : "s"} ${nameModules(cutOff.singleModules)} alone write${one ? "s" : ""} ` +
        `more than one call can hold`,
    );
  }
  if (cutOff.allowanceSpent.length > 0) {
    const one = cutOff.allowanceSpent.length === 1;
    parts.push(
      `the batch${one ? "" : "es"} covering ${nameModules(cutOff.allowanceSpent.flat())} ` +
        `${one ? "was" : "were"} not split again because the section's re-split allowance ` +
        `(one per planned batch) had been used up`,
    );
  }
  if (cutOff.runaway.length > 0) {
    const one = cutOff.runaway.length === 1;
    parts.push(
      `the batch${one ? "" : "es"} covering ${nameModules(cutOff.runaway.flat())} ` +
        `${one ? "was" : "were"} cut off although ${one ? "its" : "their"} facts were estimated ` +
        `to need far less than the cap — the model was likely repeating itself, so ` +
        `${one ? "it was" : "they were"} not split`,
    );
  }
  return {
    kind: "section-truncated",
    section,
    message:
      `Section "${section}" is incomplete: the output-token cap (${maxTokens} tokens) CUT OFF ` +
      `the part written from specific modules — ${parts.join("; ")}. Raise ` +
      `DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS and regenerate.`,
    severity: "error",
  };
}

/**
 * #157 — some batches of a BATCHED section failed while others succeeded. The
 * section keeps what the successful batches wrote; this names the modules that
 * are missing from it. `detail` MUST already be through the fixed failure
 * vocabulary (`generationFailureMessage`), never an exception's own text (#67).
 */
export function batchFailedWarning(
  section: string,
  modules: readonly string[],
  detail: string,
): DocWarning {
  const trimmed = detail.trim().slice(0, 300);
  const stop = /[.!?]$/.test(trimmed) ? "" : ".";
  return {
    kind: "section-failed",
    section,
    message:
      `Section "${section}" is incomplete: the part written from ${nameModules(modules)} could ` +
      `not be generated${trimmed ? `: ${trimmed}${stop}` : "."}`,
    severity: "error",
    detailSafe: true,
  };
}

/**
 * #157 — some batches of a BATCHED section were graded and others were not
 * (their faithfulness came back unverified, or scoring threw). The pooled
 * section score covers only the graded parts, so without this the score reads
 * as if the whole section had been checked (PR #169 review). `warning`
 * severity: unchecked is not the same as wrong.
 */
export function batchUnverifiedWarning(
  section: string,
  modules: readonly string[],
  checkedParts: number,
  totalParts: number,
): DocWarning {
  return {
    kind: "section-ungrounded",
    section,
    message:
      `Section "${section}": the part written from ${nameModules(modules)} could not be ` +
      `checked against the source, so the section's faithfulness score covers only ` +
      `${checkedParts} of its ${totalParts} parts. Review that part against the code before ` +
      `relying on it.`,
    severity: "warning",
  };
}

/**
 * #1226 — build a warning for a declared section group that contributed nothing
 * to the final document. Previously such a group was simply absent from the
 * assembled markdown with no trace, so a BRD could ship missing whole sections
 * while still reporting `ready`.
 *
 * @param section - the section-group label that is missing.
 * @param reason - why it is missing (no content generated, or dropped during
 *   assembly), so the operator can tell a model failure from an assembler one.
 */
export function sectionMissingWarning(section: string, reason: string): DocWarning {
  return {
    kind: "section-missing",
    section,
    message:
      `Section "${section}" is MISSING from the generated document (${reason}). The document ` +
      `does not cover everything its structure claims — regenerate before relying on it.`,
    severity: "error",
  };
}

/**
 * Derive the document health status from its warnings. Any warning at all means
 * the document is `degraded`, never a clean `ready`.
 */
export function deriveDocStatus(warnings: DocWarning[]): DocHealthStatus {
  return warnings.length > 0 ? "degraded" : "ready";
}

/**
 * Serialise warnings for persistence (e.g. into `errorMessage`/a JSON column).
 * Returns `null` when there are no warnings so the field stays clean.
 */
export function serializeWarnings(warnings: DocWarning[]): string | null {
  return warnings.length > 0 ? JSON.stringify(warnings) : null;
}

/**
 * A one-line banner summarising the document's review state for logs/UI headers.
 *
 * Framing is calibrated to what each warning actually means (see the per-warning
 * builders): a `section-ungrounded` warning is "statements not auto-verified
 * against the retrieved source — review", NOT "wrong" (the dominant causes are
 * retrieval gaps and inferred/reconstructed structure, not fabrication), whereas
 * `section-failed` / `no-modules` are genuine generation problems. The prefix is
 * the neutral "Needs review" rather than the alarming "Degraded output" so users
 * don't discard an accurate document over unverified-but-correct content.
 */
export function summarizeWarnings(warnings: DocWarning[]): string {
  if (warnings.length === 0) return "";
  const failed = warnings.filter((w) => w.kind === "section-failed").length;
  const ungrounded = warnings.filter((w) => w.kind === "section-ungrounded").length;
  const noModules = warnings.filter((w) => w.kind === "no-modules").length;
  const sourceUnavailable = warnings.filter((w) => w.kind === "source-unavailable").length;
  // Two different facts-truncated causes share the kind: an INPUT facts cap per
  // section (factsTruncatedWarning, any provider) and Phase-1 OUTPUT truncation
  // (phase1FactsTruncatedWarning). Each gets its own remedy, and the input-cap
  // remedy names the knob(s) the warnings themselves named (PR #187 review).
  const factsCapWarnings = warnings.filter(
    (w) => w.kind === "facts-truncated" && w.section !== PHASE1_FACTS_SECTION,
  );
  const factsTruncated = factsCapWarnings.length;
  const phase1Truncated = warnings.some(
    (w) => w.kind === "facts-truncated" && w.section === PHASE1_FACTS_SECTION,
  );
  const factsCapKnobs = [
    ...new Set(factsCapWarnings.flatMap((w) => w.message.match(FACTS_CAP_KNOB) ?? [])),
  ].sort();
  const outputTruncated = warnings.filter((w) => w.kind === "section-truncated").length;
  const missing = warnings.filter((w) => w.kind === "section-missing").length;
  const notChecked = warnings.filter((w) => w.kind === "grounding-skipped").length;
  const spotChecked = warnings.filter((w) => w.kind === "grounding-sampled").length;
  const parts: string[] = [];
  if (failed > 0) parts.push(`${failed} section(s) failed to generate`);
  if (ungrounded > 0)
    parts.push(`${ungrounded} section(s) include statements not auto-verified against the source`);
  if (noModules > 0) parts.push("no documentable modules were found despite indexed code");
  if (sourceUnavailable > 0)
    parts.push("source code could not be read — re-ingest the project and regenerate");
  if (factsTruncated > 0)
    parts.push(
      `${factsTruncated} section(s) exceeded the facts budget — raise ` +
        `${factsCapKnobs.length > 0 ? factsCapKnobs.join(" / ") : "the provider's *_FACTS_CHAR_CAP"} ` +
        `or narrow retrieval`,
    );
  if (phase1Truncated)
    parts.push(
      "fact extraction was cut off for some modules — raise DOCS_GEN_FACTS_MAX_OUTPUT_TOKENS",
    );
  if (outputTruncated > 0)
    parts.push(
      `${outputTruncated} section(s) were cut off by the output-token cap — raise ` +
        `DOCS_GEN_SECTION_MAX_OUTPUT_TOKENS and regenerate`,
    );
  if (missing > 0) parts.push(`${missing} declared section(s) are missing from the document`);
  if (notChecked > 0)
    parts.push(`${notChecked} section(s) were not fact-checked (DOCS_GEN_GROUNDING=off)`);
  if (spotChecked > 0)
    parts.push(`${spotChecked} section(s) were only spot-checked (DOCS_GEN_GROUNDING=sample)`);
  // #330 — a source-unavailable warning is a hard problem (the doc wasn't built
  // from source), so use the alarming "Degraded output" prefix rather than the
  // soft "Needs review" reserved for unverified-but-likely-correct content.
  // #1226 — a truncated or missing section is the same class of hard problem:
  // the document is objectively incomplete, not merely unverified.
  const prefix =
    sourceUnavailable > 0 || outputTruncated > 0 || missing > 0
      ? "Degraded output"
      : "Needs review";
  return `${prefix} — ${parts.join("; ")}.`;
}

/**
 * The scan for SQL-only directories (whose `.sql` constraints, triggers and
 * views are mined) could not look at part of a repository: it stopped at its
 * directory safety bound, or some directories could not be listed. Those
 * directories' rules are missing from the document; this names how many.
 */
export function sqlScanIncompleteWarning(
  repository: string,
  stats: { visited: number; truncated: boolean; unreadable: readonly string[] },
): DocWarning {
  const parts: string[] = [];
  if (stats.truncated) {
    parts.push(`the scan stopped after ${stats.visited.toLocaleString("en-US")} directories`);
  }
  if (stats.unreadable.length > 0) {
    const listed = stats.unreadable.slice(0, 5).join(", ");
    const more = stats.unreadable.length > 5 ? ` and ${stats.unreadable.length - 5} more` : "";
    parts.push(
      `${stats.unreadable.length} director${stats.unreadable.length === 1 ? "y" : "ies"} could not be read (${listed}${more})`,
    );
  }
  return {
    kind: "source-unavailable",
    section: `SQL schema scan (${repository})`,
    message: `Some SQL-only directories were not mined for rules: ${parts.join("; ")}. Their constraints, triggers and views are missing from this document.`,
    severity: "warning",
  };
}

/**
 * `.sql` files in a module's directory that could not be read or mined. Their
 * constraints, triggers and views are missing from the document; never skipped
 * silently.
 */
export function sqlFilesSkippedWarning(files: readonly string[]): DocWarning {
  const listed = files.slice(0, 10).join(", ");
  const more = files.length > 10 ? ` and ${files.length - 10} more` : "";
  return {
    kind: "source-unavailable",
    section: "Phase 1 facts",
    message: `${files.length} SQL file(s) could not be read or mined, so their rules are missing: ${listed}${more}.`,
    severity: "warning",
  };
}

/**
 * Formula extraction was not run on lines longer than `limitChars` (generated
 * or minified code), in the named modules. Their rules were still mined; only
 * the pre-extracted formulas of those lines are missing.
 */
export function formulaLinesSkippedWarning(
  modules: ReadonlyArray<{ module: string; lines: number }>,
  limitChars: number,
): DocWarning {
  const total = modules.reduce((n, m) => n + m.lines, 0);
  const listed = modules
    .slice(0, 10)
    .map((m) => `${m.module} (${m.lines})`)
    .join(", ");
  const more = modules.length > 10 ? ` and ${modules.length - 10} more` : "";
  return {
    kind: "facts-truncated",
    section: "Phase 1 facts",
    message: `Formulas were not extracted from ${total} line(s) longer than ${limitChars.toLocaleString("en-US")} characters (generated or minified code): ${listed}${more}. Their rules were still mined.`,
    severity: "warning",
  };
}
