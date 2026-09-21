/**
 * Epic #1107 (#1111 / A3) — **measuring how many absence claims the detector
 * actually catches.**
 *
 * #1111 makes this measurement a requirement rather than a nicety:
 *
 * > report the detection rate, because a missed absence claim is silently
 * > unverified, exactly as today.
 *
 * That is the honest framing. The A3 verifier only runs on findings a detector
 * flags as asserting an absence, so every miss is a finding that keeps the
 * pre-#1111 behaviour with no trace — the failure is invisible by construction,
 * and the only defence against it is a number somebody has to look at.
 *
 * ## What this scores
 *
 * `assertsAbsence` (`server/src/lib/analysis/requirement-verdict.ts`) — the same
 * #773 classifier the deterministic gate uses, at BOTH of its tiers. It is
 * scored, not replaced: a second detector would let a finding be an absence
 * claim to one half of the pipeline and not the other.
 *
 * The two tiers are scored separately because they buy different things at
 * different prices. `gate` fires the #773 downgrade, which rewrites a finding's
 * title and drops it to `info` — destructive, so it stays narrow. `grader`
 * fires #1111's read-only verifier, which costs one call and can at worst cap
 * confidence at a neutral `medium` — so it takes the subordinate clauses too.
 * The default arm is `grader`, because that is the one #1111 ships.
 *
 * ## The labels are a judgement, and they are visible
 *
 * Each case below carries `absence: true|false` and a one-line `why`. The label
 * is what a READER of the finding would take it to assert — a finding whose
 * primary claim is positive is `false` even when a subordinate clause contains
 * absence-flavoured words (`AD-28` is exactly that case, and it is the
 * corpus's VC-12 in miniature). Anyone who disagrees with a label can see it and
 * argue with it; that is the point of writing them down.
 *
 * ## Precision matters here, but less than recall
 *
 * A false NEGATIVE is a high-stakes absence claim nobody verified. A false
 * POSITIVE costs one extra provider call and, at worst, an `unexamined` verdict
 * capping a positive finding at `medium` — a neutral rank, not a demotion. The
 * asymmetry is deliberate, and it is why the floors below are not symmetric.
 */
import { assertsAbsence } from "../../analysis/requirement-verdict.js";
import type { AbsenceDetectionTier } from "../../analysis/requirement-verdict.js";

/** One labelled finding, and why it carries the label it does. */
export interface AbsenceDetectionCase {
  id: string;
  title: string;
  body: string;
  /** Ground truth: would a reader take this finding to assert an absence? */
  absence: boolean;
  /** Why this label, in one line. Visible so it can be argued with. */
  why: string;
}

/**
 * The labelled set: 15 absence claims, 13 positive claims.
 *
 *   - `AD-01`, `AD-02`, `AD-04` — the phrasings #773 names verbatim;
 *   - `AD-03` — the `verification-01-finding-verdicts` corpus's VC-02, so the
 *     two harnesses agree about what they are looking at;
 *   - `AD-05` … `AD-12` — phrasings a code agent produces that the pre-#1111
 *     pattern list was never written for. This is where the widening came from.
 *   - `AD-26` … `AD-28` — absence claims with **no negation vocabulary at all**,
 *     labelled `true` and EXPECTED to be missed. They are the documented bound
 *     of a lexical detector, kept in the set so every report has to name them.
 *
 * **This set was used to DEVELOP the patterns, so its recall is an upper bound,
 * not a generalisation estimate.** Quote it with that caveat or not at all. The
 * positive half is not filler: half of it is deliberately adversarial —
 * findings that MENTION something being handled, guarded or checked, which is
 * where a generous absence pattern goes wrong.
 */
export const ABSENCE_DETECTION_CASES: readonly AbsenceDetectionCase[] = [
  // ── Absence claims ────────────────────────────────────────────────────────
  {
    id: "AD-01",
    title: "No evidence found for commit-SHA baselining (REQ-2)",
    body: "The code agent's searches returned nothing bearing on commit-SHA baselining.",
    absence: true,
    why: "#773's headline phrasing — the exact shape the issue was filed about.",
  },
  {
    id: "AD-02",
    title: "Requirement drift severity classification is not implemented",
    body: "No severity computation was located anywhere in the indexed code graph.",
    absence: true,
    why: '#773 names "X is not implemented" as the second canonical shape.',
  },
  {
    id: "AD-03",
    title: "No SCIM 2.0 user-provisioning endpoint is implemented (REQ-3)",
    body: "The auth router enumerates login, logout, callback and refresh; nothing provisions users.",
    absence: true,
    why: "Corpus VC-02 — a correct absence claim, the class this verifier must not over-flag.",
  },
  {
    id: "AD-04",
    title: "Evidence-snapshot persistence not confirmed (REQ-1)",
    body: "Could not verify that evidence snapshots are persisted with file paths and line numbers.",
    absence: true,
    why: '#773 lists this verbatim as a wrong "gap" from the dogfood run.',
  },
  {
    id: "AD-05",
    title: "Cross-project schema reconciliation is missing from the ingest path",
    body: "Reconciliation is absent in the ingest path; only single-project runs are handled.",
    absence: true,
    why: '"is missing from" / "is absent" — an unambiguous absence assertion.',
  },
  {
    id: "AD-06",
    title: "There is no authorization check on the analysis export endpoint",
    body: "The route handler reads the projectId from params and returns the export.",
    absence: true,
    why: "The epic's OWN example of a high-stakes absence claim (#1111 body).",
  },
  {
    id: "AD-07",
    title: "The codebase lacks any rate-limiting middleware on the public API",
    body: "Requests reach the handlers with no throttling layer between them.",
    absence: true,
    why: '"lacks" is one of the commonest ways a code agent phrases an absence — GRADER tier only, because the same word appears in "resetPassword exists but lacks rate limiting".',
  },
  {
    id: "AD-08",
    title: "REQ-4 has no corresponding implementation in the server package",
    body: "Nothing in server/src maps onto the requirement's described behaviour.",
    absence: true,
    why: '"has no corresponding implementation" — the intervening adjective is the trap.',
  },
  {
    id: "AD-09",
    title: "Audit logging appears to be entirely absent from the publishing path",
    body: "Draft approval and publication happen without an audit record being written.",
    absence: true,
    why: "Hedged ('appears to be') but still read by a BA as a confirmed gap.",
  },
  {
    id: "AD-10",
    title: "Webhook signature verification was never implemented",
    body: "The inbound handler parses the body and dispatches without validating a signature.",
    absence: true,
    why: '"never implemented" — past-tense phrasing outside the present-tense patterns.',
  },
  {
    id: "AD-11",
    title: "Retention policy enforcement is nowhere to be found in the scheduler",
    body: "The scheduler registers export and digest jobs only.",
    absence: true,
    why: "Idiomatic phrasing a model reaches for; still an unambiguous absence claim.",
  },
  {
    id: "AD-12",
    title: "The system does not support per-tenant encryption keys",
    body: "Key material is resolved once at boot from a single environment variable.",
    absence: true,
    why: '"does not support" — a capability absence, and #773\'s pattern list covers it.',
  },

  // ── Absence claims a LEXICAL detector structurally cannot catch ───────────
  // These are labelled `true` and are EXPECTED to be missed. They are in the
  // set so the report has to name them: each asserts an absence with no
  // negation vocabulary at all, which no pattern list can reach. The honest
  // options are an LLM classifier on EVERY finding (a call per finding, against
  // the epic's cheap-signal-first rule) or naming the bound. #1111 names it.
  {
    id: "AD-26",
    title: "Only 3 of the 5 required export formats are produced (REQ-9)",
    body: "The exporter writes markdown, CSV and JSON.",
    absence: true,
    why: "KNOWN MISS: asserts two formats are missing purely by arithmetic — no negation word appears.",
  },
  {
    id: "AD-27",
    title: "REQ-7 remains open after the code review pass",
    body: "The reviewer found that tracing spans stop at the ingest boundary.",
    absence: true,
    why: "KNOWN MISS: 'remains open' asserts a gap through status vocabulary, not negation.",
  },
  {
    id: "AD-28",
    title: "Coverage for the retention requirement stops at the scheduler boundary",
    body: "Downstream deletion is left to a manual runbook step.",
    absence: true,
    why: "KNOWN MISS: 'stops at' asserts an absence beyond that boundary with no negation word.",
  },

  // ── Positive claims (must NOT be detected) ────────────────────────────────
  {
    id: "AD-13",
    title: "Cache-aware cost estimation is implemented for prompt-cache traffic",
    body: "estimateUsageCostUsd prices cache reads at 0.1x and writes at 1.25x.",
    absence: false,
    why: "A plain positive claim — corpus VC-04.",
  },
  {
    id: "AD-14",
    title: "Change impact scoring weights change type",
    body: "computeImpactScore multiplies the base score by a per-change-type weight.",
    absence: false,
    why: "A plain positive claim — corpus VC-09.",
  },
  {
    id: "AD-15",
    title: "The BRD requires dual approval for refunds above 500 USD",
    body: "The requirements document states a second approver must sign off.",
    absence: false,
    why: "A document restatement — corpus VC-07.",
  },
  {
    id: "AD-16",
    title: "Nightly exports run under a leader-elected scheduler",
    body: "A lease-based elector gates the cluster-singleton scheduler jobs.",
    absence: false,
    why: "A plain positive claim — corpus VC-11.",
  },
  {
    id: "AD-17",
    title: "Authorization is enforced by requireProjectAccess on every project route",
    body: "The middleware resolves the project and 404s when the caller cannot see it.",
    absence: false,
    why: "ADVERSARIAL: mentions authorization enforcement, the topic of AD-06's absence.",
  },
  {
    id: "AD-18",
    title: "Rate limiting is applied per conversation on the inbound Teams path",
    body: "A shared RateLimitStore caps inbound messages and fails open on backend errors.",
    absence: false,
    why: "ADVERSARIAL: same topic as AD-07, opposite polarity.",
  },
  {
    id: "AD-19",
    title: "Retries use capped exponential backoff with jitter",
    body: "The delay doubles per attempt and is clamped at the configured ceiling.",
    absence: false,
    why: "ADVERSARIAL: a positive claim about a behaviour often reported as missing.",
  },
  {
    id: "AD-20",
    title: "Uploaded archives are staged under data/ rather than a temp directory",
    body: "The extractor writes to a persistent path so re-ingest can find the source.",
    absence: false,
    why: "A plain positive claim with no absence vocabulary at all.",
  },
  {
    id: "AD-21",
    title: "The synthesis prompt marks unverified findings for down-weighting",
    body: "formatFindingsTable prefixes them so the model can rank them lower.",
    absence: false,
    why: "ADVERSARIAL: 'unverified' appears, but nothing is claimed to be missing.",
  },
  {
    id: "AD-22",
    title: "Requirement coverage is derived from finding citations",
    body: "Coverage grades whether a requirement's evidence cites code, docs, or neither.",
    absence: false,
    why: "ADVERSARIAL: 'neither' is a negative word in a purely descriptive sentence.",
  },
  {
    id: "AD-23",
    title: "Schema reconciliation downgrades a verdict it cannot support",
    body: "table-not-found and column-not-found cap the verdict at could-not-verify.",
    absence: false,
    why: "ADVERSARIAL: contains 'not-found' twice as an ENUM VALUE, not as a claim.",
  },
  {
    id: "AD-24",
    title: "Findings are ordered by panel confidence, best first",
    body: "orderByPanelConfidence is a stable sort and never filters.",
    absence: false,
    why: "A plain positive claim about behaviour.",
  },
  {
    id: "AD-25",
    title: "Outbound webhook retries use capped exponential backoff (REQ-4)",
    body: "Backoff is computed inline in the dispatcher; there is no dedicated retry module.",
    absence: false,
    why: "THE OVER-MATCH CASE (corpus VC-12): the primary claim is POSITIVE and the absence-flavoured clause is subordinate. A reader takes this as 'retries work', not as a gap.",
  },
];

/** What a detector got right and wrong on {@link ABSENCE_DETECTION_CASES}. */
export interface AbsenceDetectionScore {
  total: number;
  absenceCases: number;
  truePositives: number;
  falsePositives: number;
  falseNegatives: number;
  /** Of the real absence claims, the share the detector caught. */
  recall: number;
  /** Of everything the detector flagged, the share that really was an absence claim. */
  precision: number;
  /** The MISSES, listed rather than hidden — #1111's explicit requirement. */
  misses: AbsenceDetectionCase[];
  /** The over-matches, listed for the same reason. */
  overMatches: AbsenceDetectionCase[];
}

/** The production detector at one tier, as a scoreable function. */
export const tierDetector =
  (tier: AbsenceDetectionTier) =>
  (c: AbsenceDetectionCase): boolean =>
    assertsAbsence({ title: c.title, body: c.body }, tier);

/** Score a detector against the labelled set. Pure — no provider, no I/O. */
export function scoreAbsenceDetection(
  detect: (c: AbsenceDetectionCase) => boolean = tierDetector("grader"),
  cases: readonly AbsenceDetectionCase[] = ABSENCE_DETECTION_CASES,
): AbsenceDetectionScore {
  const misses: AbsenceDetectionCase[] = [];
  const overMatches: AbsenceDetectionCase[] = [];
  let tp = 0;
  for (const c of cases) {
    const flagged = detect(c);
    if (c.absence && flagged) tp += 1;
    else if (c.absence && !flagged) misses.push(c);
    else if (!c.absence && flagged) overMatches.push(c);
  }
  const absenceCases = cases.filter((c) => c.absence).length;
  const flaggedTotal = tp + overMatches.length;
  return {
    total: cases.length,
    absenceCases,
    truePositives: tp,
    falsePositives: overMatches.length,
    falseNegatives: misses.length,
    recall: absenceCases === 0 ? 0 : tp / absenceCases,
    precision: flaggedTotal === 0 ? 0 : tp / flaggedTotal,
    misses,
    overMatches,
  };
}

/**
 * Render the score, misses first.
 *
 * The misses lead because they are the finding that this whole feature silently
 * does nothing for. A report that leads with "recall 0.92" and buries the case
 * it missed is the same kind of clean-looking output #1111 exists to stop.
 */
export function formatAbsenceDetectionReport(
  score: AbsenceDetectionScore,
  label = "grader tier (#1111 — what ships)",
): string {
  const pct = (n: number): string => n.toFixed(4);
  const lines = [
    `ABSENCE-CLAIM DETECTION (#1111 / A3) — ${label}`,
    `  cases            ${score.total} (${score.absenceCases} absence, ${score.total - score.absenceCases} positive)`,
    `  recall           ${pct(score.recall)}  (${score.truePositives}/${score.absenceCases} absence claims detected)`,
    `  precision        ${pct(score.precision)}  (${score.falsePositives} over-match${score.falsePositives === 1 ? "" : "es"})`,
  ];
  lines.push(
    score.misses.length === 0
      ? "  KNOWN MISSES     none"
      : `  KNOWN MISSES     ${score.misses.length} — each of these is an absence claim NO verifier will see:`,
  );
  for (const m of score.misses) lines.push(`    - ${m.id}  "${m.title}"  (${m.why})`);
  if (score.overMatches.length > 0) {
    lines.push(`  OVER-MATCHES     ${score.overMatches.length} — cost one extra call each:`);
    for (const o of score.overMatches) lines.push(`    - ${o.id}  "${o.title}"  (${o.why})`);
  }
  return lines.join("\n");
}
