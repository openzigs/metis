/**
 * Epic #1107 (#1110 / A2) — **the presentation seam for the #1109 support panel.**
 *
 * #1109 produces the signal (`FindingSupportPanel`: a confidence label, the per-lens
 * votes, and the counts a pure tally derived them from). Nothing consumed it. This
 * module is the single place that decides what that signal MEANS to a reader —
 * how it ranks a finding, how it is worded, and what crosses the boundary into a
 * published GitHub issue.
 *
 * It is deliberately in `@metis/shared` and deliberately PURE: the synthesis
 * ranker (`server/src/lib/analysis/synthesis.ts`), the analysis snapshot
 * (`analysis-service.ts`), the issue-draft generator
 * (`server/src/lib/publishing/draft-generator.ts`) and the React badge
 * (`ui/src/components/analysis/SupportPanelBadge.tsx`) all read the SAME rules.
 * A wording or ranking change lands once, everywhere, and is unit-testable with
 * no provider, no DOM and no database.
 *
 * ## The two #1109 invariants this module is built to preserve
 *
 * **(1) `no-signal` is not `low`.** "The panel learned nothing" and "the panel
 * doubts this" are different facts about a finding. They are kept apart in three
 * separate places here — {@link supportPanelRankWeight} gives `no-signal` the
 * same NEUTRAL rank as "no panel ran" (so a verifier failure can never demote a
 * user's finding), {@link describeSupportPanel} words them with disjoint
 * sentences, and {@link summarizeSupportPanels} refuses to let a `no-signal`
 * finding outweigh a judged sibling in a requirement rollup.
 *
 * **(2) Nothing removes a finding.** There is no filter, no predicate and no
 * threshold in this file. {@link orderByPanelConfidence} is a SORT — its output
 * is a permutation of its input, asserted as such by its tests. Down-weight,
 * never drop: METIS is recall-first, and #1101 is what a silent drop costs.
 *
 * ## The caveat that travels with every label
 *
 * The panel reads only what the agent retrieved, so `high` means *"supported by
 * what we retrieved"*, never *"true"*. {@link SUPPORT_PANEL_CAVEAT} is attached
 * to every summary — including the confident ones — precisely so no surface can
 * present the label as a truth claim.
 *
 * ## Extending this (A3 / #1111 and after)
 *
 * Add new derived facts to {@link SupportPanelSummary} rather than re-reading
 * `FindingSupportPanel` at each call site: every consumer already renders a
 * summary, so a new field reaches all of them at once. Absence-claim
 * verification (#1111) plugs in here — its verdict becomes another summary field
 * and another optional line in the published note, not a second badge component.
 */
import type { FindingAbsenceCheck, FindingSupportPanel, SupportPanelVote } from "./analysis.js";
import type {
  AbsenceClaimVerdict,
  SupportPanelConfidence,
  SupportPanelDiscardReason,
  SupportPanelLens,
} from "./constants.js";

/**
 * The sentence that must accompany any rendering of a panel label. The panel
 * grades a claim against the evidence THIS RUN retrieved; if retrieval missed
 * something the panel cannot know. Stated on `high` as loudly as on `low`.
 */
export const SUPPORT_PANEL_CAVEAT =
  "Panel confidence reflects only the evidence this run retrieved — it is not a claim that the finding is true.";

// ── Ranking ─────────────────────────────────────────────────────────────────

/** The neutral rank: "we learned nothing either way". */
const NEUTRAL_RANK = 1;

/**
 * The weight a panel label contributes to ORDERING. Higher sorts earlier.
 *
 * ```
 *   high                                   → 2   promote
 *   medium | no-signal | (no panel ran)    → 1   neutral
 *   low                                    → 0   demote
 * ```
 *
 * `no-signal` and "no panel ran" share the neutral rank ON PURPOSE. A lens that
 * degraded (#1114) produced no verdict, so treating it as a demotion would let
 * the verifier's OWN failure silently push a user's finding to the bottom of
 * synthesis — a recall failure dressed as a confidence signal. `medium` sits at
 * neutral for the mirror-image reason: it means dissent existed and was
 * outvoted, which is not grounds to promote OR demote.
 *
 * The consequence that makes the flag-off guarantee trivial: with
 * `ANALYSIS_LLM_SUPPORT_PANEL` off no finding has a panel, every weight is
 * `NEUTRAL_RANK`, and a stable sort is the identity function.
 */
export function supportPanelRankWeight(
  confidence: SupportPanelConfidence | null | undefined,
): number {
  switch (confidence) {
    case "high":
      return 2;
    case "low":
      return 0;
    default:
      return NEUTRAL_RANK;
  }
}

/**
 * Order items by panel confidence, best first. **A sort, never a filter.**
 *
 * Stable within a rank (`Array.prototype.sort` is stable per ES2019), so
 * equal-confidence items keep whatever order the caller established — severity,
 * agent, insertion. That is what makes this safe to apply to a list whose
 * indexes are load-bearing: reorder the SOURCE list once and derive every
 * index-aligned array from the result (see `runSynthesisAndPersist`).
 */
export function orderByPanelConfidence<T>(
  items: readonly T[],
  getPanel: (item: T) => FindingSupportPanel | null | undefined,
): T[] {
  return [...items].sort(
    (a, b) =>
      supportPanelRankWeight(getPanel(b)?.confidence) -
      supportPanelRankWeight(getPanel(a)?.confidence),
  );
}

// ── Describing an absence claim's verdict (#1111 / A3) ──────────────────────

/**
 * The four states an absence claim can be in, as a reader meets them.
 *
 * `label` is the badge. `sentence` is the one line that must never let
 * `unexamined` read as `supported` — the two share NO vocabulary, deliberately,
 * because #773's whole cost was that "we looked and found nothing" and "we never
 * looked" produced identical text.
 */
export interface AbsenceCheckSummary {
  /** `null` when the verifier itself produced nothing (#1114). */
  verdict: AbsenceClaimVerdict | null;
  label: string;
  sentence: string;
  /** The grounded `file:line`. Always present for `contradicted`. */
  citation: string | null;
  /** The verifier's own words. */
  reasoning: string;
  /** The claim is WRONG — the thing is present in the retrieved evidence. */
  contradicted: boolean;
  /** The evidence needed to judge was never retrieved. NOT the same as `supported`. */
  unexamined: boolean;
  /** Set when a raw verdict was deterministically downgraded for want of a locator. */
  downgradedFrom: AbsenceClaimVerdict | null;
}

/**
 * Reader-facing copy per absence verdict. Exported so every surface — badge,
 * tooltip, published issue, synthesis prompt — says the same thing, and so tests
 * assert against the strings a user actually sees.
 */
export const ABSENCE_CHECK_COPY: Record<
  AbsenceClaimVerdict | "no-signal",
  { label: string; sentence: string }
> = {
  supported: {
    label: "Absence checked",
    sentence:
      "This finding says something is missing, and the evidence check looked at the retrieved code covering it and did not find it there.",
  },
  contradicted: {
    label: "Absence contradicted",
    sentence:
      "This finding says something is missing, but the evidence check FOUND IT in what this run retrieved. Treat the claim as wrong until you have checked the cited location yourself.",
  },
  unexamined: {
    label: "Absence unexamined",
    sentence:
      "This finding says something is missing, but nothing this run retrieved covers where it would live — so nobody looked. This is NOT a confirmed gap: check for yourself before building anything.",
  },
  "no-signal": {
    label: "Absence not checked",
    sentence:
      "This finding says something is missing. The absence check produced no usable result, so the claim is neither confirmed nor disproved.",
  },
};

/**
 * Turn a raw absence check into the facts a reader needs. Returns `null` when
 * the finding is not an absence claim (or predates #1111), which every surface
 * renders as "nothing to show".
 */
export function describeAbsenceCheck(
  check: FindingAbsenceCheck | null | undefined,
): AbsenceCheckSummary | null {
  if (!check) return null;
  const copy = ABSENCE_CHECK_COPY[check.verdict ?? "no-signal"];
  return {
    verdict: check.verdict,
    label: copy.label,
    sentence: copy.sentence,
    citation: check.citation,
    reasoning: check.reasoning,
    contradicted: check.verdict === "contradicted",
    unexamined: check.verdict === "unexamined",
    downgradedFrom: check.downgradedFrom,
  };
}

// ── Describing one finding's panel ──────────────────────────────────────────

/**
 * One lens that did NOT back the claim, with the reason and locator it gave.
 *
 * This is the shape the epic singles out as the most valuable thing to get
 * right: *"2 of 3 lenses supported this; the scope lens dissented because…"*
 * beats *"67%"*. The reasoning and citation are the lens's own words and its own
 * grounded locator — never a paraphrase.
 */
export interface SupportPanelDissent {
  lens: SupportPanelLens;
  /** `supported` is excluded by construction — a supporting vote is not dissent. */
  judgement: "unsupported" | "uncertain";
  /** The grounded `file:line` the lens cited. Counted votes always have one. */
  citation: string;
  reasoning: string;
  /** Set only when the dissent was collected across findings (a rollup). */
  findingTitle?: string;
}

/** A vote that never entered the tally, kept so the panel stays auditable. */
export interface SupportPanelDiscarded {
  lens: SupportPanelLens;
  reason: SupportPanelDiscardReason;
  /** The lens's own words, or the degradation detail. */
  detail: string;
}

/** Everything a surface needs to render one finding's panel. */
export interface SupportPanelSummary {
  confidence: SupportPanelConfidence;
  /** One sentence a non-technical reader can act on. Never a bare percentage. */
  headline: string;
  /**
   * Should this finding be presented as SECOND-CLASS (dimmed, sorted last)?
   * True only for `low`. Never true for `no-signal` — invariant (1).
   */
  secondClass: boolean;
  /** True only for `no-signal`: the panel learned nothing. Distinct from `low`. */
  noSignal: boolean;
  countedVotes: number;
  supportedVotes: number;
  /** Every vote the panel cast, counted or not. */
  totalVotes: number;
  /** The lenses that did not back the claim, with their reasons. */
  dissent: SupportPanelDissent[];
  /** The lenses whose votes were thrown away, and why. */
  discarded: SupportPanelDiscarded[];
  /**
   * #1111 — the absence-claim verdict, when this finding asserts an absence.
   * `null` for every other finding, which is most of them.
   */
  absence: AbsenceCheckSummary | null;
  /** Sentences that must be shown with the label. Always includes the caveat. */
  caveats: string[];
}

const isDissent = (v: SupportPanelVote): boolean =>
  v.counted && (v.judgement === "unsupported" || v.judgement === "uncertain");

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

const listLenses = (lenses: readonly SupportPanelLens[]): string =>
  lenses.length <= 1
    ? (lenses[0] ?? "")
    : `${lenses.slice(0, -1).join(", ")} and ${lenses[lenses.length - 1]}`;

/**
 * Turn a raw panel into the facts a reader needs. Returns `null` when no panel
 * ran, which every surface renders as "nothing to show" — identical to a
 * pre-#1109 run.
 */
export function describeSupportPanel(
  panel: FindingSupportPanel | null | undefined,
): SupportPanelSummary | null {
  if (!panel) return null;

  const dissent: SupportPanelDissent[] = [
    ...panel.votes.filter((v) => isDissent(v) && v.judgement === "unsupported"),
    ...panel.votes.filter((v) => isDissent(v) && v.judgement === "uncertain"),
  ].map((v) => ({
    lens: v.lens,
    judgement: v.judgement as "unsupported" | "uncertain",
    citation: v.citation ?? "",
    reasoning: v.reasoning,
  }));

  const discarded: SupportPanelDiscarded[] = panel.votes
    .filter((v) => !v.counted && v.discardReason !== null)
    .map((v) => ({
      lens: v.lens,
      reason: v.discardReason as SupportPanelDiscardReason,
      detail: v.reasoning,
    }));

  // #1111 — the absence verdict leads the caveats, ahead of the panel's own
  // bookkeeping. On an absence claim it is the MOST load-bearing sentence on the
  // finding: "we never looked" and "we looked and it is not there" drive
  // completely different next actions, and #773 is what conflating them costs.
  const absence = describeAbsenceCheck(panel.absenceCheck);
  const caveats: string[] = [];
  if (absence) {
    caveats.push(absence.citation ? `${absence.sentence} (${absence.citation})` : absence.sentence);
  }
  if (panel.noSignalVotes > 0) {
    caveats.push(
      `${panel.noSignalVotes} ${plural(panel.noSignalVotes, "lens", "lenses")} returned no usable verdict and ${plural(panel.noSignalVotes, "was", "were")} not counted — that is missing information, not a vote against this finding.`,
    );
  }
  if (panel.uncitedVotes > 0) {
    caveats.push(
      `${panel.uncitedVotes} ${plural(panel.uncitedVotes, "lens", "lenses")} judged without citing the evidence it used, so its verdict was discarded in either direction.`,
    );
  }
  caveats.push(SUPPORT_PANEL_CAVEAT);

  return {
    confidence: panel.confidence,
    headline: buildHeadline(panel, dissent, absence),
    // Invariant (1), enforced here rather than at each call site: only `low` is
    // second-class. A `no-signal` finding is presented exactly as a finding with
    // no panel at all, plus an explanation of why it was not judged.
    secondClass: panel.confidence === "low",
    noSignal: panel.confidence === "no-signal",
    countedVotes: panel.countedVotes,
    supportedVotes: panel.supportedVotes,
    totalVotes: panel.votes.length,
    dissent,
    discarded,
    absence,
    caveats,
  };
}

function buildHeadline(
  panel: FindingSupportPanel,
  dissent: SupportPanelDissent[],
  absence: AbsenceCheckSummary | null,
): string {
  // #1111 — on a contradicted or unexamined absence claim the absence verdict IS
  // the headline. A vote tally ("2 of 3 lenses supported this") is the wrong
  // first sentence when the substantive fact is "the thing you were told to
  // build already exists, at this line" or "nobody actually looked". A
  // `supported` verdict is NOT promoted here: it agrees with the finding, so the
  // ordinary tally headline remains the more informative one.
  if (absence && (absence.contradicted || absence.unexamined)) {
    return absence.citation ? `${absence.sentence} (${absence.citation})` : absence.sentence;
  }
  if (panel.countedVotes === 0) {
    // Deliberately shares NO vocabulary with the dissent sentence below: a
    // reader must not be able to mistake "we could not check" for "we checked
    // and it looked weak".
    return "The verification panel could not judge this finding — no lens returned a usable verdict.";
  }
  const clauses = [
    `${panel.supportedVotes} of ${panel.countedVotes} ${plural(panel.countedVotes, "lens", "lenses")} supported this claim`,
  ];
  const unsupported = dissent.filter((d) => d.judgement === "unsupported").map((d) => d.lens);
  const uncertain = dissent.filter((d) => d.judgement === "uncertain").map((d) => d.lens);
  if (unsupported.length > 0) {
    clauses.push(
      `the ${listLenses(unsupported)} ${plural(unsupported.length, "lens", "lenses")} dissented`,
    );
  }
  if (uncertain.length > 0) {
    clauses.push(
      `the ${listLenses(uncertain)} ${plural(uncertain.length, "lens", "lenses")} ${plural(uncertain.length, "was", "were")} uncertain`,
    );
  }
  return `${clauses.join("; ")}.`;
}

/** One dissent as a single line — used in tooltips, aria-labels and reports. */
export function formatDissent(d: SupportPanelDissent): string {
  const where = d.findingTitle ? ` on "${d.findingTitle}"` : "";
  return `${d.lens} lens${where}: ${d.reasoning}${d.citation ? ` (${d.citation})` : ""}`;
}

// ── Rolling up to one requirement ───────────────────────────────────────────

/** How bad a judged label is. Lower wins a rollup. `no-signal` is NOT in here. */
const JUDGED_SEVERITY: Record<"low" | "medium" | "high", number> = { low: 0, medium: 1, high: 2 };

/** Most dissent entries carried on a rollup, so one requirement cannot flood a view. */
export const MAX_ROLLUP_DISSENT = 6;

/**
 * #1111 — one absence claim on a requirement whose verdict a reader must act on,
 * carried up to the requirement so it survives into the published issue.
 *
 * `contradicted` and `unexamined` are collected; `supported` is not. A supported
 * absence claim agrees with the finding and needs no warning — the whole value
 * of this rollup is that the two claims a reader must NOT act on blindly reach
 * them at the requirement level, where the work actually gets scheduled.
 */
export interface RequirementAbsenceCaution {
  verdict: "contradicted" | "unexamined";
  findingTitle: string;
  citation: string | null;
  reasoning: string;
}

/** Most absence cautions carried on a rollup. */
export const MAX_ROLLUP_ABSENCE_CAUTIONS = 4;

/**
 * A requirement's confidence, rolled up from the panels of the findings it was
 * synthesised from. Derived at read time from data already on the snapshot —
 * no column, no migration.
 */
export interface RequirementSupportConfidence {
  confidence: SupportPanelConfidence;
  /** How many of the requirement's evidence findings carried a panel at all. */
  findingsWithPanel: number;
  lowConfidenceFindings: number;
  /** Findings the panel could not judge. Reported, never counted as doubt. */
  noSignalFindings: number;
  /** Dissent gathered across those findings, each tagged with its origin. */
  dissent: SupportPanelDissent[];
  /**
   * #1111 — absence claims among those findings whose verdict a reader must not
   * act on blindly: `contradicted` (the thing exists) and `unexamined` (nobody
   * looked). Empty when the requirement has no absence claims, or when every one
   * of them checked out.
   */
  absenceCautions: RequirementAbsenceCaution[];
}

/**
 * Roll a requirement's linked findings up to one label.
 *
 * The rollup takes the WORST **judged** label, and `no-signal` is excluded from
 * that comparison entirely — invariant (1) again. A requirement with one `high`
 * finding and one the panel could not judge is `high` with a "1 finding could
 * not be judged" note; it is NOT downgraded, because a verifier failure is not
 * evidence. Only when EVERY panel learned nothing does the requirement itself
 * read `no-signal`.
 *
 * Returns `null` when not one linked finding carried a panel, so a flag-off run
 * produces a snapshot field of `null` and every surface renders as before.
 */
export function summarizeSupportPanels(
  findings: ReadonlyArray<{ title?: string; supportPanel?: FindingSupportPanel | null }>,
): RequirementSupportConfidence | null {
  const withPanel = findings.filter(
    (f): f is { title?: string; supportPanel: FindingSupportPanel } => Boolean(f.supportPanel),
  );
  if (withPanel.length === 0) return null;

  let worst: "low" | "medium" | "high" | null = null;
  let lowCount = 0;
  let noSignalCount = 0;
  const dissent: SupportPanelDissent[] = [];
  const absenceCautions: RequirementAbsenceCaution[] = [];

  for (const f of withPanel) {
    const c = f.supportPanel.confidence;
    if (c === "no-signal") {
      noSignalCount += 1;
    } else {
      if (c === "low") lowCount += 1;
      if (worst === null || JUDGED_SEVERITY[c] < JUDGED_SEVERITY[worst]) worst = c;
    }
    const summary = describeSupportPanel(f.supportPanel);
    for (const d of summary?.dissent ?? []) {
      dissent.push(f.title ? { ...d, findingTitle: f.title } : d);
    }
    const absence = summary?.absence;
    if (absence && (absence.contradicted || absence.unexamined)) {
      absenceCautions.push({
        verdict: absence.contradicted ? "contradicted" : "unexamined",
        findingTitle: f.title ?? "",
        citation: absence.citation,
        reasoning: absence.reasoning,
      });
    }
  }

  return {
    confidence: worst ?? "no-signal",
    findingsWithPanel: withPanel.length,
    lowConfidenceFindings: lowCount,
    noSignalFindings: noSignalCount,
    dissent: dissent.slice(0, MAX_ROLLUP_DISSENT),
    absenceCautions: absenceCautions.slice(0, MAX_ROLLUP_ABSENCE_CAUTIONS),
  };
}

// ── The boundary into a published GitHub issue ──────────────────────────────

/** Longest model-authored fragment embedded in a published issue body. */
const MAX_PUBLISHED_TEXT = 300;

/**
 * Neutralise model-authored prose before it is embedded in markdown.
 *
 * The reasoning is written by an LLM that just read UNTRUSTED evidence (a source
 * comment or an uploaded document can contain markdown, HTML, or an instruction
 * aimed at whatever reads it next — OWASP LLM01/LLM02). Collapsing whitespace
 * keeps it inside the list item it is rendered in; stripping backticks and angle
 * brackets stops it opening a code fence or an HTML tag in a GitHub issue body.
 */
export function sanitizePanelText(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/[`<>]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_PUBLISHED_TEXT)
    .trim();
}

/** Heading the published confidence note is filed under. */
export const PUBLISHED_CONFIDENCE_HEADING = "## Confidence";

/**
 * **The decision (#1110's open question): confidence DOES cross into published
 * GitHub issues — but only doubt, and only in plain language.**
 *
 * Returns `null` for `high`, for `medium`, and for a requirement whose findings
 * carried no panel. So a confident requirement's issue body is byte-identical to
 * what METIS published before this change, and a flag-off run publishes nothing
 * new at all — no machinery leaks when there is nothing to warn about.
 *
 * Why publish the doubt at all: the reader of a GitHub issue is the person
 * FURTHEST from the evidence and least able to judge it, and silence at that
 * boundary is not neutrality — it reads as "this was checked". That is exactly
 * the July failure this epic cites, where placeholder acceptance criteria
 * presented as authoritative output. METIS already made this trade once, in
 * `NO_ACCEPTANCE_CRITERIA_NOTE`: saying "we derived nothing here" beats saying
 * nothing. The asymmetry decides it — publishing doubt costs a sentence a
 * developer can skim; withholding it costs work built on evidence nobody
 * checked.
 *
 * Why only the doubt: a "high confidence" badge on an issue would over-claim
 * (see {@link SUPPORT_PANEL_CAVEAT} — the panel grades retrieval, not truth) and
 * would be the version of this that genuinely IS internal machinery in a
 * work-tracking artefact. The note names the disagreeing check, its reason and
 * its `file:line` — evidence a reader can follow — and never the vote tallies,
 * lens taxonomy or token cost.
 *
 * **#1111 widens the one gap in that rule, and only that one.** An absence
 * caution publishes even at `high` or `medium`. A requirement synthesised from
 * "X is not implemented" IS an instruction to build X, and the two verdicts
 * carried in {@link RequirementSupportConfidence.absenceCautions} say either
 * *"X already exists, here"* or *"nobody actually looked"*. Withholding that
 * from the person scheduling the work is the precise cost #773 measured — three
 * verifiably-wrong "build this" issues in one run — and no vote tally can
 * substitute for it, because an absence claim has no citations to tally.
 */
export function renderPublishedConfidenceNote(
  rollup: RequirementSupportConfidence | null | undefined,
): string | null {
  if (!rollup) return null;
  const absenceLines = renderAbsenceCautionLines(rollup.absenceCautions ?? []);
  if (rollup.confidence === "high" || rollup.confidence === "medium") {
    // Confident, but built on an absence claim that is wrong or unchecked. Only
    // the caution publishes — no label, no tally: the panel's own grade agrees
    // with the finding and has nothing to warn about.
    return absenceLines.length > 0
      ? [PUBLISHED_CONFIDENCE_HEADING, "", ...absenceLines, "", SUPPORT_PANEL_CAVEAT].join("\n")
      : null;
  }

  if (rollup.confidence === "no-signal") {
    return [
      PUBLISHED_CONFIDENCE_HEADING,
      "",
      "METIS could not verify the evidence behind this requirement — its automated evidence check returned no usable result. Treat the description as unconfirmed and check the evidence before implementing.",
      ...(absenceLines.length > 0 ? ["", ...absenceLines] : []),
      "",
      SUPPORT_PANEL_CAVEAT,
    ].join("\n");
  }

  const reasons = rollup.dissent.map(
    (d) =>
      `- **${d.lens} check** — ${sanitizePanelText(d.reasoning) || "no reason given"}` +
      (d.citation ? ` (\`${sanitizePanelText(d.citation)}\`)` : ""),
  );
  return [
    PUBLISHED_CONFIDENCE_HEADING,
    "",
    "METIS graded the evidence behind this requirement **low confidence**: its automated evidence checks did not agree that the analysis evidence supports it.",
    ...(reasons.length > 0 ? ["", ...reasons] : []),
    ...(absenceLines.length > 0 ? ["", ...absenceLines] : []),
    "",
    `${SUPPORT_PANEL_CAVEAT} Confirm the evidence before implementing.`,
  ].join("\n");
}

/**
 * The published lines for a requirement's absence cautions.
 *
 * `contradicted` is worded as a blocking correction and `unexamined` as an
 * unchecked assumption — never the same sentence, and never a shared verb.
 * Returns `[]` when there is nothing to warn about, which is what keeps a
 * requirement with no absence claims byte-identical to a pre-#1111 publish.
 */
function renderAbsenceCautionLines(cautions: readonly RequirementAbsenceCaution[]): string[] {
  if (cautions.length === 0) return [];
  const lines = cautions.map((c) => {
    const where = c.citation ? ` (\`${sanitizePanelText(c.citation)}\`)` : "";
    const why = sanitizePanelText(c.reasoning);
    return c.verdict === "contradicted"
      ? `- **This may already exist.** METIS's evidence check found what "${sanitizePanelText(c.findingTitle)}" says is missing${where}.${why ? ` ${why}` : ""}`
      : `- **Not confirmed missing.** Nothing this analysis retrieved covers what "${sanitizePanelText(c.findingTitle)}" says is missing, so its absence was never checked.${why ? ` ${why}` : ""}`;
  });
  return [
    "This requirement rests on a claim that something is MISSING. Before building it:",
    "",
    ...lines,
  ];
}
