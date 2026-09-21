"use client";

/**
 * Epic #1107 (#1110 / A2) — **rendering the #1109 support panel.**
 *
 * Three things this component set exists to make true on screen:
 *
 * 1. **Low-confidence findings are visibly second-class — never hidden.** There
 *    is no filter here and no "hide low confidence" control anywhere in the
 *    findings list. A doubted finding is dimmed, given a rose border and sorted
 *    to the bottom; the reader decides what to trust. METIS is recall-first, and
 *    a finding the user cannot see is worse than one they distrust (#1101).
 *
 * 2. **`no-signal` renders distinctly from `low`.** Distinct hue, distinct label
 *    ("Not judged" vs "Low confidence"), distinct copy, and — through
 *    {@link findingConfidenceClasses} — no second-class styling at all. The
 *    panel failing to produce a verdict says nothing about the finding, and a
 *    surface that renders it as doubt turns the verifier's own failure into
 *    evidence against a user's requirement.
 *
 * 3. **The dissenting lens is surfaced with its reason, from data already in
 *    hand.** {@link SupportPanelDetails} renders every lens's verdict, its own
 *    words and its `file:line`, straight off the analysis snapshot — no second
 *    request, no database round-trip, and no "67%" standing in for a reason.
 *
 * Wording, ranking and the rollup all come from `@metis/shared`'s
 * `support-panel-view` seam, so this file decides only colour, layout and
 * disclosure. #1111 (absence claims) extends the seam, not this component.
 */
import {
  SUPPORT_PANEL_CAVEAT,
  describeSupportPanel,
  formatDissent,
  orderByPanelConfidence,
  type AbsenceClaimVerdict,
  type FindingSupportPanel,
  type RequirementSupportConfidence,
  type SupportPanelConfidence,
} from "@metis/shared";

interface ConfidenceCopy {
  /** Short badge label a non-technical reader can act on. */
  label: string;
  /** What it means, and what to do about it. */
  tooltip: string;
  /** Tailwind colour classes — one distinct hue per state. */
  className: string;
}

/**
 * Copy + colour per confidence state. Exported so the tests assert against the
 * same strings the user sees.
 *
 * `low` and `no-signal` are deliberately at opposite ends of the palette: rose
 * reads as a warning, slate reads as absent information. They must never be
 * mistaken for one another.
 */
export const SUPPORT_PANEL_COPY: Record<SupportPanelConfidence, ConfidenceCopy> = {
  high: {
    label: "High confidence",
    tooltip: `Every verification lens agreed the retrieved evidence backs this finding. ${SUPPORT_PANEL_CAVEAT}`,
    className: "border-emerald-700/50 bg-emerald-950/40 text-emerald-300",
  },
  medium: {
    label: "Mixed confidence",
    tooltip: `The verification lenses did not fully agree: at least one dissented or was uncertain, but the supporting lenses outnumbered them. Open "Why?" for the dissenting lens's reason. ${SUPPORT_PANEL_CAVEAT}`,
    className: "border-sky-700/50 bg-sky-950/40 text-sky-300",
  },
  low: {
    label: "Low confidence",
    tooltip: `More verification lenses doubted this finding than backed it. It is still shown in full and nothing was removed — open "Why?" to read each lens's reason and decide for yourself. ${SUPPORT_PANEL_CAVEAT}`,
    className: "border-rose-700/60 bg-rose-950/40 text-rose-300",
  },
  "no-signal": {
    label: "Not judged",
    tooltip:
      "The verification panel produced no usable verdict for this finding — it could not be checked either way. This is MISSING information, not doubt: treat the finding exactly as you would one the panel never looked at.",
    className: "border-slate-600/60 bg-slate-900/60 text-slate-300",
  },
};

/**
 * #1111 (A3) — colour per ABSENCE verdict, one distinct hue each.
 *
 * `supported` and `unexamined` sit at opposite ends of the palette on purpose:
 * amber reads as "check this", emerald as "checked". They are the two states
 * #773 conflated, and a reader must be able to tell them apart at a glance,
 * before reading a word. `contradicted` takes the same rose as `low` confidence
 * because it is the loudest thing this system says about a finding.
 */
export const ABSENCE_VERDICT_CLASSES: Record<AbsenceClaimVerdict | "no-signal", string> = {
  supported: "border-emerald-700/50 bg-emerald-950/40 text-emerald-300",
  contradicted: "border-rose-700/60 bg-rose-950/40 text-rose-300",
  unexamined: "border-amber-700/60 bg-amber-950/40 text-amber-300",
  "no-signal": "border-slate-600/60 bg-slate-900/60 text-slate-300",
};

/** How each per-lens outcome is labelled in the disclosure. */
export const VOTE_OUTCOME_LABEL = {
  supported: "supported",
  unsupported: "dissented",
  uncertain: "uncertain",
  "no-signal": "no verdict (not counted)",
  "missing-citation": "uncited (not counted)",
} as const;

// ── The finding badge ───────────────────────────────────────────────────────

/**
 * Compact confidence badge for one finding. Renders nothing when no panel ran,
 * so a flag-off run's findings list is unchanged.
 */
export function SupportPanelBadge({
  panel,
  className = "",
}: {
  panel: FindingSupportPanel | null | undefined;
  className?: string;
}): React.ReactElement | null {
  const summary = describeSupportPanel(panel);
  if (!summary) return null;
  const copy = SUPPORT_PANEL_COPY[summary.confidence];
  return (
    <span
      data-testid={`support-panel-badge-${summary.confidence}`}
      data-confidence={summary.confidence}
      role="status"
      aria-label={`Panel confidence: ${copy.label}. ${summary.headline}`}
      title={`${summary.headline} ${copy.tooltip}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${copy.className} ${className}`}
    >
      {copy.label}
    </span>
  );
}

/**
 * #1111 (A3) — the absence-claim verdict, rendered as its OWN badge beside the
 * confidence one.
 *
 * A separate badge rather than a fourth confidence state, because it answers a
 * different question. Confidence asks *"do the lenses back this claim?"*; this
 * asks *"was the thing said to be missing actually looked for?"* — and the
 * answer "nobody looked" has no place on a scale from high to low.
 *
 * Renders nothing for a finding that made no absence claim, which is most of
 * them, so the findings list is unchanged except where #773's hole actually was.
 */
export function AbsenceVerdictBadge({
  panel,
  className = "",
}: {
  panel: FindingSupportPanel | null | undefined;
  className?: string;
}): React.ReactElement | null {
  const absence = describeSupportPanel(panel)?.absence;
  if (!absence) return null;
  const key = absence.verdict ?? "no-signal";
  return (
    <span
      data-testid={`absence-verdict-${key}`}
      data-absence-verdict={key}
      role="status"
      aria-label={`Absence claim: ${absence.label}. ${absence.sentence}`}
      title={`${absence.sentence}${absence.citation ? ` (${absence.citation})` : ""}`}
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${ABSENCE_VERDICT_CLASSES[key]} ${className}`}
    >
      {absence.label}
    </span>
  );
}

/**
 * The audit trail: every lens's verdict, its own words, and the `file:line` it
 * cited — rendered from the snapshot the page already fetched.
 *
 * Collapsed by default (it is detail, not the headline) but present in the DOM,
 * so "why is this low-confidence?" is one click away rather than one request
 * away. Discarded votes are shown too, labelled as not counted, because a lens
 * that produced nothing is part of the audit trail and hiding it would make the
 * tally look more decisive than it was.
 */
export function SupportPanelDetails({
  panel,
}: {
  panel: FindingSupportPanel | null | undefined;
}): React.ReactElement | null {
  const summary = describeSupportPanel(panel);
  if (!summary || !panel) return null;
  return (
    <details
      className="mt-2 text-xs"
      data-testid="support-panel-details"
      data-confidence={summary.confidence}
    >
      <summary className="cursor-pointer text-zinc-400 hover:text-zinc-200">
        Why? {summary.headline}
      </summary>
      {/*
        #1111 — the absence verdict leads the disclosure, above the lens votes.
        On an absence claim it is the load-bearing line: the lenses graded "does
        the evidence back this claim?", which for a claim about what is NOT
        there cannot be answered, and this row is the answer to the question
        that can.
      */}
      {summary.absence ? (
        <p
          data-testid={`absence-verdict-detail-${summary.absence.verdict ?? "no-signal"}`}
          className="mt-1 border-l-2 border-zinc-600 pl-3 text-zinc-300"
        >
          <span className="font-semibold">{summary.absence.label}</span> —{" "}
          {summary.absence.sentence}
          {summary.absence.reasoning ? (
            <span className="text-zinc-400"> {summary.absence.reasoning}</span>
          ) : null}
          {summary.absence.citation ? (
            <code className="ml-1 rounded bg-zinc-800 px-1 text-[10px] text-zinc-300">
              {summary.absence.citation}
            </code>
          ) : null}
        </p>
      ) : null}
      <ul className="mt-1 space-y-1 border-l border-zinc-700 pl-3">
        {panel.votes.map((v) => {
          const outcome = v.counted
            ? VOTE_OUTCOME_LABEL[v.judgement ?? "uncertain"]
            : VOTE_OUTCOME_LABEL[v.discardReason ?? "no-signal"];
          return (
            <li key={v.lens} data-testid={`support-panel-vote-${v.lens}`} className="text-zinc-400">
              <span
                className={
                  v.counted && v.judgement === "unsupported"
                    ? "font-semibold text-rose-300"
                    : "font-semibold text-zinc-300"
                }
              >
                {v.lens} lens — {outcome}
              </span>
              {v.reasoning ? <span className="text-zinc-400">: {v.reasoning}</span> : null}
              {v.citation ? (
                <code className="ml-1 rounded bg-zinc-800 px-1 text-[10px] text-zinc-300">
                  {v.citation}
                </code>
              ) : null}
            </li>
          );
        })}
      </ul>
      <ul className="mt-1 space-y-0.5 pl-3 text-[11px] text-zinc-500">
        {summary.caveats.map((c) => (
          <li key={c}>{c}</li>
        ))}
      </ul>
    </details>
  );
}

// ── Second-class treatment ──────────────────────────────────────────────────

/**
 * Extra classes for a finding CARD, so a low-confidence finding is legible as
 * second-class at a glance — dimmed, dashed rose border — without being hidden
 * or filtered.
 *
 * Returns `""` for `no-signal` on purpose: an unjudged finding is presented
 * exactly as one with no panel at all, plus its badge. Also `""` for `high` and
 * `medium`, so a flag-off run's cards are byte-identical.
 */
export function findingConfidenceClasses(panel: FindingSupportPanel | null | undefined): string {
  return describeSupportPanel(panel)?.secondClass
    ? "border-dashed border-rose-800/50 bg-rose-950/10 opacity-75"
    : "";
}

/**
 * Sort findings for display, best-supported first. A SORT, never a filter: the
 * returned array is a permutation of the input, so a low-confidence finding is
 * ranked last and still shown. Matches the order synthesis ranks them in.
 */
export function orderFindingsByConfidence<T extends { supportPanel?: FindingSupportPanel | null }>(
  findings: readonly T[],
): T[] {
  return orderByPanelConfidence(findings, (f) => f.supportPanel);
}

// ── The requirement rollup ──────────────────────────────────────────────────

/**
 * A requirement's rolled-up confidence, with the dissenting lenses' reasons.
 *
 * Uses the SAME palette and the same wording rules as the per-finding badge, so
 * a reader moving between the Requirements and Findings tabs is reading one
 * signal, not two. Renders nothing when no linked finding carried a panel.
 */
export function RequirementConfidenceNote({
  confidence,
}: {
  confidence: RequirementSupportConfidence | null | undefined;
}): React.ReactElement | null {
  if (!confidence) return null;
  const copy = SUPPORT_PANEL_COPY[confidence.confidence];
  const unjudgedNote =
    confidence.noSignalFindings > 0
      ? `${confidence.noSignalFindings} of its ${confidence.findingsWithPanel} findings could not be judged.`
      : "";
  return (
    <div
      className="mt-2 text-xs"
      data-testid="requirement-confidence"
      data-confidence={confidence.confidence}
    >
      <span
        role="status"
        aria-label={`Evidence confidence: ${copy.label}`}
        title={`${copy.tooltip}${unjudgedNote ? ` ${unjudgedNote}` : ""}`}
        className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-semibold ${copy.className}`}
      >
        Evidence: {copy.label}
      </span>
      {unjudgedNote ? <span className="ml-2 text-zinc-500">{unjudgedNote}</span> : null}
      {/*
        #1111 — an absence caution on a REQUIREMENT is where it matters most: a
        requirement synthesised from "X is not implemented" is an instruction to
        build X, and this is the surface where that work gets scheduled.
      */}
      {(confidence.absenceCautions ?? []).length > 0 ? (
        <ul
          className="mt-1 space-y-0.5 border-l-2 border-amber-700/60 pl-3 text-amber-200"
          data-testid="requirement-absence-cautions"
        >
          {(confidence.absenceCautions ?? []).map((c) => (
            <li key={`${c.verdict}-${c.findingTitle}`} data-absence-verdict={c.verdict}>
              {c.verdict === "contradicted"
                ? `This may already exist — the evidence check found what "${c.findingTitle}" says is missing.`
                : `Not confirmed missing — nothing retrieved covers what "${c.findingTitle}" says is missing.`}
              {c.citation ? (
                <code className="ml-1 rounded bg-zinc-800 px-1 text-[10px] text-zinc-300">
                  {c.citation}
                </code>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      {confidence.dissent.length > 0 ? (
        <ul
          className="mt-1 space-y-0.5 border-l border-zinc-700 pl-3 text-zinc-400"
          data-testid="requirement-confidence-dissent"
        >
          {confidence.dissent.map((d) => (
            <li key={`${d.findingTitle ?? ""}-${d.lens}`}>{formatDissent(d)}</li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
