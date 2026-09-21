/**
 * Three-state requirement verdict + the deterministic gate that produces it
 * (Issue #773).
 *
 * The product's costliest error is telling a BA to BUILD something that already
 * exists. It happens when the code agent's retrieval fails and the pipeline
 * launders "I could not retrieve it" into "it does not exist". The cure is two
 * INDEPENDENT signals, and a verdict that requires BOTH:
 *
 *   (a) did retrieval actually work?     → `retrieval-health.ts` (the evidence threshold)
 *   (b) does the retrieved evidence show absence? → the agent's own claim
 *
 * Only (a) && (b) licenses `gap-confirmed`. This module is where they meet.
 *
 * ── The gate can only ever WEAKEN a claim ───────────────────────────────────
 * {@link gateFindingVerdict} takes the model's own per-finding verdict (the model
 * is the only party that knows what its investigation meant) and DOWNGRADES it
 * against deterministic evidence. RETRIEVAL HEALTH GATES BOTH DIRECTIONS —
 * symmetrically, because a confident verdict either way is a claim about the
 * codebase, and a run whose retrieval did not work is not entitled to one:
 *
 *   - `gap-confirmed`  requires the PER-CLAIM evidence threshold
 *                      (`absenceConfirmable` — retrieval worked AND the agent ran
 *                      a working search bearing on THIS requirement). It is NOT
 *                      enough that the finding cites code: on the agentic path the
 *                      citation provenance includes the PASSIVELY-SEEDED fused
 *                      symbol block (#729), so a finding can carry a "grounded"
 *                      citation on a run where not one search succeeded.
 *   - `implemented`    requires ≥1 CODE citation that survived the #734
 *                      provenance gate AND a run whose retrieval was not degraded
 *                      (`retrievalHealthy`). This is the FALSE-POSITIVE guard, and
 *                      it is the DANGEROUS direction once the system is made
 *                      reluctant to claim absence: the same #729 passive seed that
 *                      cannot license an absence claim cannot license a "you
 *                      already have this" one either — it would silently close a
 *                      real gap, with the user never told to look again.
 *   - anything else    → `could-not-verify`, the honest state.
 *
 * A model that omits `verdict` (legacy prompt, other code paths) falls back to a
 * text classifier ({@link assertsAbsence}), which can ONLY EVER DOWNGRADE: prose
 * that reads like an absence claim yields `could-not-verify`, NEVER `gap-confirmed`.
 * A regex over model prose must not be able to mint a confident verdict — only the
 * model's own explicit `verdict` field can claim one, and only the gate can keep it.
 * Nor does "the finding cites code" imply `implemented`: `grounded_in_code` means
 * "cited some code" (an ordinary observation about a file cites code too) — that
 * conflation is the #736 coverage bug, and it is not reintroduced here as a verdict.
 *
 * ── The bound of what #740 proves (acknowledged, not hidden) ────────────────
 * The #734/#740 grounding gate proves a cited file WAS RETRIEVED — not that it
 * SUPPORTS the claim (semantic support is explicitly deferred in
 * `finding-verification.ts`). So an `implemented` verdict citing a real file that
 * does not actually implement the requirement still passes this gate. Retrieval
 * health narrows that hole (a degraded run cannot claim `implemented` at all) but
 * does not close it; closing it needs the semantic critic #740 deferred.
 *
 * Pure + LLM-free: same inputs ⇒ same verdict, so the whole rule is unit-testable.
 */
import {
  isCodeCitation,
  type Citation,
  type RequirementVerdict,
  type SchemaReconciliation,
} from "@metis/shared";

/**
 * Phrases with which a finding asserts that something is NOT in the codebase.
 * Used only as a fallback when the model emitted no explicit `verdict`, and as
 * the #740 verifier's "is this an absence claim?" test — the class of finding
 * that cites nothing, therefore has nothing to ground, and therefore sailed
 * through every existing gate unflagged.
 *
 * #1111 (epic #1107) WIDENED this list on a measurement rather than a hunch.
 * `server/src/lib/eval/verification/absence-detection.ts` scores it against a
 * labelled set, and the pre-#1111 list caught **5 of 15** absence claims —
 * missing, among others, the epic's own headline example (*"There is no
 * authorization check on X"*) and the phrasing of a case in the
 * `verification-01-finding-verdicts` corpus. Every miss is a high-stakes claim
 * that reaches a reader with nothing having verified it, so the widening is the
 * whole point: this classifier is the gate on whether #1111's verifier runs at
 * all.
 *
 * Two rules govern what may be added here:
 *
 *   1. **Downgrade-only, so generosity is cheap.** `assertsAbsence` can never
 *      mint a `gap-confirmed`; the worst an over-match costs is an honest
 *      `could-not-verify` and (under #1111) one extra provider call. Recall is
 *      therefore worth more than precision — but see the measured over-match in
 *      the harness before assuming it is free.
 *   2. **Static literals with no nested quantifiers.** These patterns run over
 *      MODEL-AUTHORED prose of unbounded shape; a nested quantifier is a ReDoS
 *      surface, and a pattern built from a variable is a SAST failure.
 */
const ABSENCE_PATTERNS: RegExp[] = [
  /\bno evidence\b/i,
  /\bnot? evidence (?:of|for)\b/i,
  /\bnot\s+(?:implemented|present|found|located|confirmed|verified|supported|handled|available|addressed)\b/i,
  /\bdoes not (?:exist|appear|implement|support|handle)\b/i,
  /\bcould not (?:find|locate|verify|confirm)\b/i,
  /\bunable to (?:find|locate|verify|confirm)\b/i,
  /\bno (?:implementation|support|handling|mechanism|logic|code|dedicated)\b/i,
  /\b(?:is|are|was|were)\s+(?:currently\s+)?(?:missing|absent)\b/i,
  /\bmissing\s+(?:from|in)\b/i,
  // ── #1111 additions, each pinned to a labelled case in absence-detection.ts ──
  /\bthere (?:is|are|was|were) no\b/i,
  /\b(?:has|have|had) no\b/i,
  /\b(?:absent|nonexistent|non-existent)\b/i,
  /\bnowhere\b/i,
  /\bnever\s+(?:implemented|added|written|enforced|validated|called|invoked|persisted|configured|wired|checked)\b/i,
  // "No SCIM 2.0 user-provisioning endpoint is implemented" — the noun phrase
  // between the negation and the verb is unbounded in practice, so the gap is
  // matched with ONE bounded character-class quantifier followed by a literal.
  // Deliberately not `(?:\w+\s+){0,4}`: adjacent quantifiers over overlapping
  // classes are the classic ReDoS shape, and this runs over model prose. The
  // class admits `.` because product names carry one ("SCIM 2.0"); the 60-char
  // bound is what stops it reaching across a sentence for a stray "no".
  /\bno\b[^!?\n]{0,60}\bis (?:implemented|present|supported|enforced|configured|available)\b/i,
];

/**
 * Absence markers matched by the GRADER tier only — see {@link assertsAbsence}.
 *
 * Each is a genuine way to assert an absence that also appears as a SUBORDINATE
 * clause inside a finding whose primary claim is positive: *"resetPassword
 * exists but **lacks** rate limiting"*, *"the router handles four routes and
 * **nothing** provisions users"*. Read as a whole-finding verdict they are
 * over-matches; read as "is there an absence claim in here worth checking?"
 * they are correct.
 *
 * That is exactly the tier split. They earn a read-only verifier call under
 * #1111 and they do NOT earn a `could-not-verify` downgrade under #773 — which
 * would retitle the finding and drop it to `info` on the strength of one
 * subordinate clause.
 */
const SUBCLAUSE_ABSENCE_PATTERNS: RegExp[] = [/\black(?:s|ed|ing)\b/i, /\bnothing\b/i];

/**
 * Which consumer is asking, and therefore how generous the classifier may be.
 *
 *   - `gate`   — the #773 deterministic verdict gate. A hit here DOWNGRADES a
 *                finding: `retitleUnverifiableFinding` rewrites its headline and
 *                its severity drops to `info`. That is destructive and
 *                user-visible, so this tier stays conservative.
 *   - `grader` — the #1111 absence verifier. A hit here costs ONE read-only
 *                provider call and can, at worst, cap the panel's confidence at
 *                `medium` (a neutral rank). Cheap and non-destructive, so it can
 *                afford a wider net.
 *
 * **`grader` is a strict SUPERSET of `gate`.** There is no finding the gate
 * downgrades that the grader would decline to check — asserted in
 * `requirement-verdict.test.ts`. The two tiers cannot disagree about a finding,
 * only about whether a subordinate clause is worth one extra call.
 */
export type AbsenceDetectionTier = "gate" | "grader";

/** The text a finding exposes to the absence classifier. */
export interface AbsenceClaimInput {
  title: string;
  body: string;
  tags?: string[];
}

/**
 * Does this finding ASSERT AN ABSENCE — i.e. claim the codebase does not contain
 * something? Deliberately generous: over-matching here is safe, because an
 * absence claim is only ever DOWNGRADED (to `could-not-verify`) when retrieval
 * cannot back it. It can never upgrade a finding into a gap on its own — that
 * still requires the model's `gap-confirmed` claim (or its text saying so) AND a
 * passing evidence threshold.
 */
export function assertsAbsence(
  finding: AbsenceClaimInput,
  tier: AbsenceDetectionTier = "gate",
): boolean {
  const haystack = [finding.title, finding.body, ...(finding.tags ?? [])].join("\n");
  if (ABSENCE_PATTERNS.some((re) => re.test(haystack))) return true;
  return tier === "grader" && SUBCLAUSE_ABSENCE_PATTERNS.some((re) => re.test(haystack));
}

/**
 * #826 (Epic #820 Phase 1) — one affected-schema object's reconciliation
 * evidence, as the verdict gate sees it. Derived from the run's deterministic
 * AFFECTED SCHEMA rows (#823/#824). The schema gate reads it ONLY to DOWNGRADE a
 * confident verdict, never to mint one.
 */
export interface SchemaObjectEvidence {
  /** Physical/mapped table identity (may be schema-qualified, e.g. `public.orders`). */
  tableName: string;
  /** Column identity for a column-level object, else `null` (table-level). */
  columnName: string | null;
  /**
   * Reconciliation against the live schema (#822): `matched` — the live schema
   * has it; `null` — nothing to reconcile (came straight from live truth, or no
   * live index was consulted); `table-not-found`/`column-not-found` — the live
   * schema CANNOT support it.
   */
  reconciliation: SchemaReconciliation | null;
  /**
   * Cross-project canonical-identity resolution for a cross-project claim:
   * `false` — the identity did NOT resolve, so the cross-project portion is
   * unverifiable. `undefined` — not a cross-project claim (single-project run, or
   * no resolver ran); never a reason to downgrade on its own.
   */
  identityResolved?: boolean;
}

/**
 * Does the live schema FAIL TO SUPPORT this affected object — i.e. is it a reason
 * to doubt a confident verdict that relies on it? True when the object is absent
 * from the live schema (`table-not-found`/`column-not-found`) OR is a cross-project
 * claim whose canonical identity did not resolve. A `matched`/`null` reconciliation
 * (the live schema has it, or there was nothing to reconcile) is NOT a reason — so
 * a run that reconciled cleanly, or one with no live schema at all, never downgrades.
 */
export function schemaObjectUnsupported(o: SchemaObjectEvidence): boolean {
  if (o.reconciliation === "table-not-found" || o.reconciliation === "column-not-found") {
    return true;
  }
  return o.identityResolved === false;
}

/** Is `ch` an identifier character (letter, digit, or `_`)? Static, regex-free. */
function isIdentifierChar(ch: string): boolean {
  return (
    (ch >= "A" && ch <= "Z") || (ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9") || ch === "_"
  );
}

/**
 * Whole-identifier, case-insensitive reference test: `orders` matches "the orders
 * table" but not "reorders" or "orders_audit". Identifier chars (letters, digits,
 * `_`) form the token boundary so physical names with underscores match exactly.
 *
 * Implemented as a linear `indexOf` scan rather than a dynamic `RegExp` built from
 * `name`: `name` is a physical schema identifier (never a trusted literal), and a
 * user/DB-controlled string compiled into a regex is a ReDoS vector. Plain string
 * search treats every character literally (no escaping needed) and cannot backtrack.
 */
function referencesIdentifier(haystack: string, name: string): boolean {
  if (name.length === 0) return false;
  const hay = haystack.toLowerCase();
  const needle = name.toLowerCase();
  for (let from = hay.indexOf(needle); from !== -1; from = hay.indexOf(needle, from + 1)) {
    const beforeOk = from === 0 || !isIdentifierChar(hay[from - 1]);
    const afterIdx = from + needle.length;
    const afterOk = afterIdx >= hay.length || !isIdentifierChar(hay[afterIdx]);
    if (beforeOk && afterOk) return true;
  }
  return false;
}

/**
 * The affected-schema objects a finding RELIES ON — the subset whose physical name
 * its text refers to. A table-level object is relied on when the finding mentions
 * the table (bare or schema-qualified); a column-level object additionally requires
 * the column name to appear. Deterministic + case-insensitive. Over-matching is
 * SAFE because the schema gate is downgrade-only: the worst case is an honest
 * `could-not-verify` on a finding that merely name-dropped an unreconciled table.
 */
export function findingReliesOnSchemaObjects(
  finding: AbsenceClaimInput,
  evidence: readonly SchemaObjectEvidence[],
): SchemaObjectEvidence[] {
  if (evidence.length === 0) return [];
  const haystack = [finding.title, finding.body, ...(finding.tags ?? [])].join("\n");
  return evidence.filter((o) => {
    const dot = o.tableName.lastIndexOf(".");
    const bare = dot === -1 ? o.tableName : o.tableName.slice(dot + 1);
    const tableHit =
      referencesIdentifier(haystack, o.tableName) || referencesIdentifier(haystack, bare);
    if (!tableHit) return false;
    return o.columnName ? referencesIdentifier(haystack, o.columnName) : true;
  });
}

/**
 * Project the run's deterministic AFFECTED SCHEMA rows (#823/#824 —
 * `AffectedTableInput`) down to the {@link SchemaObjectEvidence} the gate needs.
 * Accepts a structural subset so this module stays decoupled from the server-side
 * impact types. `identityResolved` is derived from the optional cross-project
 * identity id: `undefined` when no resolver ran (the common single-project case),
 * else `true`/`false` from whether the object's canonical identity resolved.
 */
export function schemaEvidenceFromAffectedRows(
  rows: ReadonlyArray<{
    tableName: string;
    columnName: string | null;
    reconciliation: SchemaReconciliation | null;
    schemaObjectIdentityId?: string | null;
  }>,
): SchemaObjectEvidence[] {
  return rows.map((r) => ({
    tableName: r.tableName,
    columnName: r.columnName,
    reconciliation: r.reconciliation,
    identityResolved:
      r.schemaObjectIdentityId === undefined ? undefined : r.schemaObjectIdentityId !== null,
  }));
}

export interface GateFindingVerdictInput {
  /** The model's own verdict for this finding, when it emitted one. */
  modelVerdict?: RequirementVerdict | null;
  /** The finding's citations AFTER the #734 grounding gate (drops removed). */
  groundedCitations: Citation[];
  /** The finding text (fallback classification when the model omitted a verdict). */
  finding: AbsenceClaimInput;
  /**
   * Did THIS CLAIM clear the per-claim evidence threshold
   * (`absenceIsConfirmableForClaim` — the run's retrieval worked AND the agent ran
   * a working search bearing on this requirement)? Undefined ⇒ this code path
   * performs no tool retrieval at all and therefore cannot confirm absence
   * (treated as false).
   */
  absenceConfirmable?: boolean;
  /**
   * Did the RUN's retrieval work at all (`absenceIsConfirmable`, i.e. `!degraded`)?
   * This gates the `implemented` direction. Undefined ⇒ inferred from
   * `absenceConfirmable` (which implies it by construction), so pre-existing
   * callers keep their behaviour.
   */
  retrievalHealthy?: boolean;
  /**
   * #826 — the run's AFFECTED SCHEMA reconciliation evidence (#823/#824). The
   * schema gate is DOWNGRADE-ONLY and per-finding: if the finding relies on a
   * schema object the live schema cannot support (`table-not-found`/`column-not-found`)
   * or a cross-project claim whose identity did not resolve, an otherwise-confident
   * verdict is capped at `could-not-verify`. Matched / live-truth / absent evidence
   * (e.g. the feature OFF ⇒ empty) leaves the verdict UNCHANGED — byte-identical to
   * pre-#826. Empty/undefined ⇒ the schema gate is a no-op.
   */
  schemaEvidence?: readonly SchemaObjectEvidence[];
}

/**
 * Apply the deterministic gate. Returns the verdict to persist on the finding, or
 * `null` when the finding makes no requirement claim at all (a generic
 * observation), in which case it is neither a gap nor an unverifiable one.
 */
export function gateFindingVerdict(input: GateFindingVerdictInput): RequirementVerdict | null {
  const hasGroundedCode = (input.groundedCitations ?? []).some(isCodeCitation);
  const absenceConfirmable = input.absenceConfirmable === true;
  // A per-claim confirmable absence implies the run's retrieval was healthy, so
  // it is a safe lower bound when the caller supplies only the older field.
  const retrievalHealthy = input.retrievalHealthy === true || absenceConfirmable;

  // What is the finding CLAIMING? The model's own verdict wins. With no explicit
  // verdict we may only infer a CONSERVATIVE claim: absence-flavoured prose is a
  // reason to doubt, never a reason to confirm (a regex over model prose must not
  // manufacture a gap), and a code citation means "cited some code", not
  // "implemented" (that conflation is the #736 coverage bug — see the module doc).
  const claimed: RequirementVerdict | null =
    input.modelVerdict ??
    (assertsAbsence(input.finding) ? "could-not-verify" : /* no claim to classify */ null);

  if (claimed === null) return null;

  // The base verdict from the retrieval-health gate (#773). Computed first; the
  // #826 schema gate below may only DOWNGRADE it further, never upgrade.
  const base: RequirementVerdict =
    // The model already said it could not verify — always honoured, never upgraded.
    claimed === "could-not-verify"
      ? "could-not-verify"
      : claimed === "gap-confirmed"
        ? // (a) && (b): the evidence shows absence AND retrieval actually looked for
          // THIS thing. Fail (a) ⇒ we do not know, and must say so.
          absenceConfirmable
          ? "gap-confirmed"
          : "could-not-verify"
        : // `implemented` — the SYMMETRIC gate. It must be backed by a code citation
          // that survived #734 AND come from a run whose retrieval was not degraded.
          // An unsupported "you already have this" silently closes a real gap and
          // warns nobody, which is the more expensive direction of the same error.
          hasGroundedCode && retrievalHealthy
          ? "implemented"
          : "could-not-verify";

  // #826 — the deterministic, DOWNGRADE-ONLY schema gate. A confident verdict (gap
  // OR implementation) that relies on a schema object the live schema cannot support
  // — or a cross-project claim whose canonical identity did not resolve — is not
  // entitled to stand: cap it at `could-not-verify`. Fully-reconciled / matched /
  // absent evidence leaves it UNCHANGED, so a run that reconciled cleanly (or the
  // feature OFF) is byte-identical (AC2 / #773 scenario 2 — capping everything is
  // honest and worthless).
  if (base === "could-not-verify") return base;
  const reliedOn = findingReliesOnSchemaObjects(input.finding, input.schemaEvidence ?? []);
  return reliedOn.some(schemaObjectUnsupported) ? "could-not-verify" : base;
}

/**
 * Rewrite an absence-flavoured title for a finding we could NOT verify, so the
 * headline a BA reads is never "No evidence found for X" when the truth is "our
 * search for X did not work". The finding BODY (which the #742 gap report renders
 * verbatim as the gap narrative) keeps the agent's own words; only the assertive
 * headline is corrected. Bounded to the 255-char column.
 */
export function retitleUnverifiableFinding(title: string): string {
  // #778 — strip absence-flavoured lead-ins AND any already-applied "Could not
  // verify:" prefixes (one or more, in any combination) before re-applying the
  // canonical one, so re-titling is IDEMPOTENT: the model is prompted to title
  // these "Could not verify: <requirement>" (prompts.ts), this runs on both the
  // agentic and passive paths, and an older persisted title may already carry it
  // — none may ever yield "Could not verify: Could not verify: …".
  const subject = title
    .trim()
    .replace(
      /^\s*(?:(?:could not verify|no evidence (?:found )?(?:of|for|that)?|no (?:implementation|support|code) (?:found )?(?:of|for)?)\s*[:\-–]?\s*)+/i,
      "",
    )
    .trim();
  const retitled = subject.length > 0 ? `Could not verify: ${subject}` : "Could not verify:";
  return retitled.slice(0, 255);
}

/** A finding as the requirement-level roll-up sees it. */
export interface VerdictFindingInput {
  /** Which specialist produced it — only the CODE agent can settle a code verdict. */
  agentKey: string;
  /**
   * The finding's GATED verdict (see {@link gateFindingVerdict}) — the ONLY input
   * to the roll-up. A finding's citations deliberately do NOT feed it: citing code
   * is not the same as implementing a requirement.
   */
  verdict: RequirementVerdict | null;
}

export interface DeriveRequirementVerdictInput {
  /** Did the code agent participate in this run at all? */
  codeAnalysisRan: boolean;
  /** The requirement's linked findings (its `evidenceFindingIndexes` resolved). */
  findings: VerdictFindingInput[];
}

/**
 * Roll a requirement's linked CODE findings up into ONE verdict.
 *
 * Precedence (first match wins):
 *   1. a gap-confirmed finding      → `gap-confirmed` (it cleared the threshold)
 *   2. a could-not-verify finding   → `could-not-verify`
 *   3. an implemented finding       → `implemented`
 *   4. otherwise                    → `could-not-verify`
 *
 * There is deliberately NO "has grounded code ⇒ implemented" rule. A code finding
 * that cites a file has CITED SOME CODE — it has not shown the requirement is met
 * (an ordinary observation like "the retry logic in foo.ts is hard to follow"
 * cites code and settles nothing). That conflation is exactly what #736's coverage
 * copy was corrected for; it is not smuggled back in as a verdict. `implemented`
 * requires the model to have SAID SO and the gate to have let it stand.
 *
 * Rule 4 is the BUDGET-STARVATION rule and the most important one: a requirement
 * the code agent never got to (turn/token budget exhausted, or it simply emitted
 * no finding for it) has NO linked code finding — and therefore no verdict. Before
 * #773 that requirement showed up with `no_evidence` coverage and read as a gap.
 * It is now explicitly "we did not check", never "it isn't there".
 *
 * Returns `null` when the code agent did not run at all: a document-only analysis
 * makes no claim about code, so it renders a neutral state rather than an alarming
 * "could not verify" on every requirement.
 */
export function deriveRequirementVerdict(
  input: DeriveRequirementVerdictInput,
): RequirementVerdict | null {
  if (!input.codeAnalysisRan) return null;
  const code = input.findings.filter((f) => f.agentKey === "code");
  if (code.some((f) => f.verdict === "gap-confirmed")) return "gap-confirmed";
  if (code.some((f) => f.verdict === "could-not-verify")) return "could-not-verify";
  if (code.some((f) => f.verdict === "implemented")) return "implemented";
  return "could-not-verify";
}

/** Compute the verdict for every synthesized requirement, index-aligned with `requirements`. */
export function computeVerdictsForRequirements(
  requirements: Array<{ evidenceFindingIndexes?: number[] }>,
  flatFindings: VerdictFindingInput[],
  codeAnalysisRan: boolean,
): Array<RequirementVerdict | null> {
  return requirements.map((r) => {
    const linked = (r.evidenceFindingIndexes ?? [])
      .map((i) => flatFindings[i])
      .filter((f): f is VerdictFindingInput => f != null);
    return deriveRequirementVerdict({ codeAnalysisRan, findings: linked });
  });
}
