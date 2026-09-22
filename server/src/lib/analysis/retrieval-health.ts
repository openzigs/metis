/**
 * Code-retrieval health + the EVIDENCE THRESHOLD for an absence claim (Issue #773).
 *
 * ── The defect this exists to kill ──────────────────────────────────────────
 * The agentic code agent converts "I could not retrieve it" into "it does not
 * exist", and every downstream surface (finding titles, the #742 gap report, the
 * #736 coverage label, the #737 matrix) presents that as a CONFIRMED GAP. On the
 * reported run it told a user to build `computeSeverity` and commit-SHA
 * baselining that already existed in the indexed graph. #774 fixed the protocol
 * bug that broke retrieval on THAT run; retrieval can still degrade for other
 * reasons (wrong search vocabulary, turn-budget exhaustion, a thin graph), so the
 * INFERENCE itself has to be gated.
 *
 * ── THE EVIDENCE THRESHOLD (the crux) ───────────────────────────────────────
 * Absence is only ever confirmable RELATIVE TO A SEARCHED SCOPE, and the scope
 * that matters is the one bearing ON THE CLAIM — not a global quota over the
 * pass. The threshold therefore has two layers:
 *
 * (A) RUN-LEVEL — did retrieval WORK AT ALL? ({@link absenceIsConfirmable})
 *   1. NOT STARVED — retrieval itself did not fail wholesale. Nothing to trust in
 *      either direction when the pass could not search the codebase at all.
 *   2. RETRIEVAL FUNCTIONED — at least {@link MIN_SUCCESSFUL_SEARCHES} CODE-retrieval
 *      call returned usable, non-empty results, OR the pass was seeded with real
 *      fused code chunks (`seedGrounded`). Zero of either is the #773 incident
 *      exactly: the agent "knows" nothing about the codebase, and cannot tell "the
 *      code isn't there" from "my searches don't work".
 *   3. TOOLS WERE NOT MOSTLY BROKEN — the TOOL-ERROR rate is at or below
 *      {@link MAX_TOOL_ERROR_RATE}. A loop that spent its turns in an error/repair
 *      spiral investigated nothing.
 *
 * (B) PER-CLAIM — did the agent actually LOOK FOR THIS THING?
 *     ({@link absenceIsConfirmableForClaim}) At least one NON-ERRORED CODE-retrieval
 *     call whose query BEARS ON the REQUIREMENT (see the matcher notes below). A gap
 *     for REQ-7 is confirmable iff the agent ran a working code search bearing on
 *     REQ-7 — a requirement nobody searched for stays `could-not-verify`, which is
 *     both the honest outcome and exactly what budget starvation demands.
 *
 * ── EXHAUSTION IS NOT STARVATION (#1236) ───────────────────────────────────
 * Running out of TURNS/TOKENS says the investigation was cut short; it says nothing
 * about whether retrieval worked. Feeding it into `starved` made rule (A.1) fire on
 * a pass with 14 successful searches and zero tool errors, and one exhausted pass
 * then poisoned EVERY requirement in it — 13 of 22 findings on the measured run,
 * citing exact files and line numbers, retitled "Could not verify". Worse, the
 * better retrieval got the deeper the agent dug, so the labelling degraded as the
 * product improved. `exhausted` is therefore its own signal: it never short-circuits
 * layer (A), and layer (B) scopes it to the requirements the loop actually failed to
 * reach — no working search bearing on the requirement, or no surviving code
 * citation under the finding.
 *
 * ── CODE TOOLS ONLY (the scope has to be the scope) ─────────────────────────
 * The agent's tool set also contains `search_knowledge` — DOCUMENT RAG. A document
 * hit says nothing whatsoever about whether the code exists, so if it counted as
 * retrieval evidence a run whose CODE tools all errored could still be "healthy"
 * (4 code errors + 5 doc hits = a 0.44 error rate), and a doc query derived from the
 * requirement text would satisfy (B) — confirming a code gap on a run where not one
 * code search worked. That is the #773 inference, relaunched through a different
 * tool. Every counter, the searched scope, and the claim index here are therefore
 * computed over {@link CODE_RETRIEVAL_TOOLS} ONLY. (The #774 `ToolCallTelemetry`
 * still summarises EVERY tool — it answers a different question.)
 *
 * ── THE MATCHER (B) — only ONE operand may be model-authored ────────────────
 * The claim side is the REQUIREMENT TEXT, which is document-derived. The finding's
 * TITLE is deliberately NOT part of it: the model authors both the queries and the
 * titles, so if the title fed the matcher the model could license its own verdict —
 * search `authentication` for REQ-1, never search REQ-9, then title REQ-9's finding
 * "No tenant quota in the AUTHENTICATION layer" and the overlap test passes for a
 * requirement nobody investigated. A deterministic gate must not take the model's
 * own prose as one of its two inputs.
 *
 * One shared term is likewise too cheap: incidental collisions on `user`, `rate`,
 * `token` are everywhere. A query bears on a requirement when it shares
 * {@link MIN_SHARED_TERMS} significant terms, OR one RARE term — one carried by no
 * more than half the pass's requirements, i.e. actually discriminating between them.
 *
 * KNOWN BOUND (follow-up): this reconstructs "what was this search for?" LEXICALLY,
 * after the fact. The honest fix is to attribute a search to a requirement AT ISSUE
 * TIME (the agent knows which requirement it is investigating when it calls the
 * tool). Until then the matcher is deliberately biased: a vocabulary mismatch costs
 * RECALL (a real gap is demoted to `could-not-verify`, the user re-runs), never
 * PRECISION (an un-searched requirement can never be minted into a gap).
 *
 * ── Why (B) is per-claim and not a global quota ─────────────────────────────
 * The first cut of this module demanded `successfulSearches >= requirementCount`
 * for the WHOLE pass. That is unreachable at the incident's own scale: the turn
 * cap bounds the number of tool calls a pass can make, so at ~30 requirements a
 * confirmed gap became MATHEMATICALLY IMPOSSIBLE and the product silently
 * degraded into "could-not-verify everything" — honest and worthless, the exact
 * anti-regression bar this issue sets for itself. Evidence-local attribution has
 * no such cliff: it is SCALE-FREE. A pass that searched for 8 of 30 requirements
 * confirms gaps for (at most) those 8 and says "could not verify" about the rest,
 * instead of collapsing wholesale.
 *
 * ── ERROR ≠ EMPTY (the other half of the same mistake) ──────────────────────
 * A TOOL ERROR (the call failed) says retrieval is broken; it says nothing about
 * the codebase. A well-formed EMPTY result (the call worked, the code genuinely
 * is not there for that query) is EVIDENCE OF ABSENCE — it is precisely what a
 * CORRECT absence investigation returns. Only errors count toward degradation
 * (rule 3). Counting empties as brokenness inverted the product: the more genuine
 * gaps a codebase had, the more "degraded" its run looked, and the more of its
 * CORRECT gaps got downgraded.
 *
 * Empties still do not count as `successfulSearches` (rule 2 asks "did retrieval
 * physically work at least once?", for which a hit is the only proof), but they
 * DO satisfy the per-claim rule (B): searching for X, with a working tool, and
 * finding nothing is the evidence that X is absent.
 *
 * A run that fails (A) is `degraded`: no absence claim from it may be confirmed,
 * every absence-asserting finding is labelled `could-not-verify`, and it raises
 * the `code-retrieval-degraded` capability reason — whether or not a claim
 * happened to be downgraded, because on a degraded run the `implemented` claims
 * are just as untrustworthy as the absence ones.
 *
 * Pure + dependency-free: same tool calls in ⇒ same health out.
 */
import type { AnalysisRetrievalHealth, RequirementVerdict, SearchedQuery } from "@metis/shared";
import { deriveRequirementVerdict, type VerdictFindingInput } from "./requirement-verdict.js";
import { isErroredCall, type ToolCallRecord } from "./tool-telemetry.js";

/** Minimum retrieval calls that must return usable results before ANY absence claim is confirmable. */
export const MIN_SUCCESSFUL_SEARCHES = 1;

/**
 * Max share of tool calls that may ERROR before the loop counts as broken. The
 * numerator is errored calls ONLY — never well-formed empty results (see the
 * ERROR ≠ EMPTY note in the module doc).
 */
export const MAX_TOOL_ERROR_RATE = 0.5;

/**
 * The tools that retrieve CODE. `search_knowledge` (document RAG) is deliberately
 * ABSENT: a document hit is not evidence about the codebase, and letting it count
 * would let a doc search license a code gap (see the module doc). Names match the
 * registered `AgentTool.name`s assembled in `assembleAgenticCodeTools`.
 */
export const CODE_RETRIEVAL_TOOLS: ReadonlySet<string> = new Set([
  "search_code_graph",
  "search_code_symbols",
  "read_file_slice",
  "list_files",
]);

/** Is this tool call CODE retrieval (and therefore evidence about the codebase)? */
export function isCodeRetrievalCall(call: ToolCallRecord): boolean {
  return CODE_RETRIEVAL_TOOLS.has(call.tool);
}

/**
 * Max searched-scope entries retained (bounded persistence). This truncates the
 * DISPLAY/EXPORT provenance ONLY. No verdict may be gated on `searchedScope`: the
 * per-claim rule reads the untruncated {@link ClaimEvidenceIndex}, precisely so that
 * a search made late in a long pass (call #41+, reachable once the turn cap went to
 * 60) cannot be rendered INVISIBLE to the gate and silently demote a real gap.
 */
const MAX_SEARCHED_SCOPE = 40;
/** Max chars of a model-authored query string retained. */
const MAX_QUERY_CHARS = 120;
/** Min length of a term considered significant for claim/query relevance. */
const MIN_TERM_CHARS = 3;
/** Shared significant terms required for a query to BEAR ON a requirement (unless one is rare). */
export const MIN_SHARED_TERMS = 2;

/**
 * Args keys, in priority order, that carry the "what did you search for" value.
 * `search_code_symbols`/`search_knowledge` use `query`; `search_code_graph` may
 * filter by `query`/`kind`/`filePath`/`calledBy`/`calls`; `read_file_slice` reads
 * `filePath`; `list_files` globs a `pattern`.
 */
const QUERY_KEYS = ["query", "filePath", "pattern", "calledBy", "calls", "kind"] as const;

/**
 * Terms carried by essentially every requirement and every query, so matching on
 * them would make ANY search "relevant" to ANY claim and hollow out rule (B).
 */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "must",
  "should",
  "shall",
  "not",
  "from",
  "this",
  "that",
  "there",
  "any",
  "all",
  "are",
  "was",
  "were",
  "has",
  "have",
  "had",
  "can",
  "will",
  "when",
  "into",
  "onto",
  "per",
  "via",
  "its",
  "their",
  "system",
  "code",
  "codebase",
  "project",
  "requirement",
  "req",
  "src",
  "server",
  "app",
  "lib",
  "test",
  "tests",
  "file",
  "files",
  "function",
  "class",
  "method",
  "support",
  "supported",
  "implement",
  "implemented",
  "implementation",
  "evidence",
  "found",
  "missing",
  "absent",
  "verify",
  "confirmed",
]);

/**
 * A tool result is EMPTY (searched fine, found nothing) when the tool SAID SO:
 * `resultCount === 0`. That is a structured contract the tools now set on their
 * `ToolResult` — the loop forwards it onto the {@link ToolCallRecord}. It used to
 * be sniffed out of the tool's human-readable prose (`/^no\b/i`), which coupled
 * a load-bearing verdict input to copy-editing: rewording "No matching symbols"
 * to "Nothing matched" would silently flip a miss into a hit. The prose sniff
 * survives ONLY as a fallback for records that predate the structured field.
 */
export function isEmptyToolResult(content: string | undefined): boolean {
  return /^no\b/i.test((content ?? "").trimStart());
}

/**
 * Did this call come back EMPTY (the tool WORKED; it found nothing)? An ERRORED call
 * is never empty-in-this-sense, whatever its prose says: `search_code_graph`'s "No
 * code graph available for this project" sets `isError` and no `resultCount`, and the
 * legacy prose fallback would otherwise read it as a well-formed empty result — i.e.
 * as evidence of absence. That distinction is load-bearing for verdicts now, so the
 * error check comes first here and not just in every caller.
 */
export function isEmptyCall(call: ToolCallRecord): boolean {
  if (isErroredCall(call)) return false;
  if (typeof call.resultCount === "number") return call.resultCount === 0;
  return isEmptyToolResult(call.result ?? call.resultPreview);
}

/** A retrieval call is SUCCESSFUL when it neither errored nor came back empty. */
export function isSuccessfulRetrieval(call: ToolCallRecord): boolean {
  const content = call.result ?? call.resultPreview;
  return !isErroredCall(call) && !isEmptyCall(call) && (content ?? "").length > 0;
}

/**
 * Strip control characters and truncate a model-authored query so it can be
 * persisted + rendered as inert text (it is untrusted model output).
 */
function sanitizeQuery(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  if (cleaned.length === 0) return undefined;
  return cleaned.slice(0, MAX_QUERY_CHARS);
}

/** Extract the searched-scope query string from a tool call's arguments. */
function extractQuery(args: unknown): string | undefined {
  if (!args || typeof args !== "object") return undefined;
  const record = args as Record<string, unknown>;
  for (const key of QUERY_KEYS) {
    const value = sanitizeQuery(record[key]);
    if (value) return value;
  }
  return undefined;
}

/**
 * Reduce text (a requirement, a finding title, a search query) to its significant
 * terms: lower-cased, split on non-alphanumerics AND camelCase boundaries (so a
 * search for `computeSeverity` bears on a requirement about "severity"),
 * de-pluralised, stopwords removed.
 */
export function extractTerms(text: string): Set<string> {
  const terms = new Set<string>();
  const words = text
    // camelCase / PascalCase → separate words, so `computeSeverity` → compute severity
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/);
  for (const word of words) {
    if (word.length < MIN_TERM_CHARS) continue;
    const stem = word.replace(/ies$/, "y").replace(/s$/, "");
    if (stem.length < MIN_TERM_CHARS) continue;
    if (STOPWORDS.has(word) || STOPWORDS.has(stem)) continue;
    terms.add(stem);
  }
  return terms;
}

export interface SummarizeRetrievalInput {
  /** Every tool call the pass executed (`AgentLoopResult.toolCalls`). */
  toolCalls: readonly (ToolCallRecord & { args?: unknown })[];
  /** How many requirements the pass was asked to investigate. */
  requirementCount: number;
  /**
   * RETRIEVAL ITSELF FAILED — nothing this pass says may stand. Defaults to false;
   * see {@link SummarizeRetrievalInput.exhausted} for the turn/token case, which is
   * a different condition and must not be routed here (#1236).
   */
  starved?: boolean;
  /** #1236 — the loop ran out of turns or tokens. Retrieval itself was fine. */
  exhausted?: boolean;
  /**
   * The pass was handed real, retrieved code context by the #729 passive fused
   * seed (chunks came back). Proof the code index is alive — see `seedGrounded`.
   */
  seedGrounded?: boolean;
  /**
   * Issue #777 — CODE tools this pass deliberately did NOT OFFER (today: the file
   * tools, when the repo has no clone on disk). Calls to them are SKIPPED ENTIRELY:
   * they neither prove retrieval worked, nor count toward the error rate, nor license
   * an absence claim.
   *
   * WHY THE EXCLUSION IS LOAD-BEARING: a model can still emit a call for a tool it was
   * never offered, which the loop answers with an "Unknown tool" repair error. That is
   * the model flailing against a KNOWN CAPABILITY LIMIT — it is not evidence that code
   * retrieval failed. Counted, three such calls against two perfectly good graph
   * searches would put the error rate at 0.6 > {@link MAX_TOOL_ERROR_RATE} and brand the
   * run degraded, resurrecting the blanket `could-not-verify` outcome #777 exists to
   * kill, through a different door. The calls remain fully visible in the #774
   * `ToolCallTelemetry` — they are hidden from the VERDICT, never from the operator.
   *
   * Note this does not weaken the threshold: a pass that spends every turn on withheld
   * tools and never runs a real search still has `successfulSearches === 0`, so rule (2)
   * fails and it is degraded — correctly, because it investigated nothing.
   */
  unavailableTools?: ReadonlySet<string>;
}

/**
 * The COMPLETE evidence a per-claim absence gate may read: the significant terms of
 * EVERY non-errored CODE search the pass ran. Deliberately NOT part of the persisted
 * {@link AnalysisRetrievalHealth}:
 *
 *   - it must be complete (a truncated gate input silently demotes the gaps whose
 *     search happened to land past the cut — the scale cliff, again), and
 *   - the persisted blob must stay bounded.
 *
 * Those two requirements are incompatible in one structure, so they are two
 * structures: this one is in-memory, lives exactly as long as the pass that produced
 * it, and is bounded anyway by the loop's own turn cap. `searchedScope` stays capped
 * for display/export.
 */
export interface ClaimEvidenceIndex {
  /** Significant terms of every non-errored code search's query. */
  terms: ReadonlySet<string>;
}

export interface RetrievalEvidence {
  /** Bounded, persisted, display-facing. */
  health: AnalysisRetrievalHealth;
  /** Complete, in-memory, verdict-facing. */
  claimIndex: ClaimEvidenceIndex;
}

/**
 * Reduce a pass's tool calls to its {@link AnalysisRetrievalHealth} (bounded, for
 * persistence) AND its {@link ClaimEvidenceIndex} (complete, for the per-claim gate).
 * NON-CODE tool calls (`search_knowledge`) are skipped entirely: they are not
 * evidence about the codebase, so they neither prove retrieval worked, nor dilute
 * the error rate, nor license an absence claim.
 */
export function summarizeRetrievalEvidence(input: SummarizeRetrievalInput): RetrievalEvidence {
  let successfulSearches = 0;
  let failedSearches = 0;
  let erroredCalls = 0;
  let totalCalls = 0;
  const searchedScope: SearchedQuery[] = [];
  const terms = new Set<string>();

  for (const call of input.toolCalls) {
    if (!isCodeRetrievalCall(call)) continue; // a document search is not code evidence
    // #777 — a call to a tool this pass never offered is a capability limit, not a
    // retrieval outcome. It proves nothing in either direction, so it is not counted.
    if (input.unavailableTools?.has(call.tool)) continue;
    totalCalls += 1;
    const errored = isErroredCall(call);
    const hit = isSuccessfulRetrieval(call);
    if (hit) successfulSearches += 1;
    else failedSearches += 1;
    if (errored) erroredCalls += 1;
    const query = extractQuery(call.args);
    // An ERRORED call establishes nothing — not even that we looked.
    if (query && !errored) {
      for (const term of extractTerms(query)) terms.add(term);
    }
    if (searchedScope.length < MAX_SEARCHED_SCOPE) {
      searchedScope.push({
        tool: call.tool,
        ...(query ? { query } : {}),
        hit,
        ...(errored ? { errored: true } : {}),
      });
    }
  }

  const health: AnalysisRetrievalHealth = {
    successfulSearches,
    failedSearches,
    erroredCalls,
    totalCalls,
    requirementCount: Math.max(0, input.requirementCount),
    starved: input.starved === true,
    ...(input.exhausted ? { exhausted: true } : {}),
    ...(input.seedGrounded ? { seedGrounded: true } : {}),
    // Set below — `degraded` is exactly the negation of the run-level threshold.
    degraded: false,
    searchedScope,
  };
  health.degraded = !absenceIsConfirmable(health);
  return { health, claimIndex: { terms } };
}

/** {@link summarizeRetrievalEvidence}, when only the persisted record is wanted. */
export function summarizeRetrieval(input: SummarizeRetrievalInput): AnalysisRetrievalHealth {
  return summarizeRetrievalEvidence(input).health;
}

/**
 * THE RUN-LEVEL EVIDENCE THRESHOLD (layer A). True when this run's retrieval
 * worked well enough for ANY verdict from it — in EITHER direction — to be
 * trusted. Its negation is `degraded`, which drives the `code-retrieval-degraded`
 * banner and downgrades `implemented` claims as well as absence ones: on a run
 * where retrieval is broken, "you already have this" is exactly as unfounded as
 * "you do not have this" (and more expensive, since it silently closes a real gap).
 *
 * NOTE this is necessary but NOT sufficient for a gap: an absence claim must also
 * clear {@link absenceIsConfirmableForClaim}, which asks whether the agent looked
 * for THAT PARTICULAR thing.
 *
 * #1236 — TURN/TOKEN EXHAUSTION IS DELIBERATELY NOT READ HERE. It is not a
 * statement about retrieval, and applying it run-wide downgraded fully-investigated,
 * fully-cited requirements alongside the unreached ones. It is handled per-claim.
 */
export function absenceIsConfirmable(health: AnalysisRetrievalHealth): boolean {
  if (health.starved) return false;
  // "Did retrieval PHYSICALLY WORK?" — a code search that returned results proves
  // it; so does the #729 fused seed coming back with real chunks, which is the very
  // same evidence the single-shot requirement-grounded path trusts (`retrievalHealthy:
  // true` there). Treating identical evidence as healthy on one path and degraded on
  // the other only produced banner noise, and a banner on every run trains users to
  // ignore the one that matters. The seed is not a SEARCH, so it never satisfies the
  // per-claim rule below — presence needs a citation, absence needs a search.
  if (health.successfulSearches < MIN_SUCCESSFUL_SEARCHES && health.seedGrounded !== true) {
    return false;
  }
  if (health.totalCalls > 0) {
    // ERRORS only — an empty result is a working tool reporting that the code is
    // not there, which is evidence OF the gap, not evidence against the run.
    const errorRate = health.erroredCalls / health.totalCalls;
    if (errorRate > MAX_TOOL_ERROR_RATE) return false;
  }
  return true;
}

export interface ClaimAbsenceInput {
  /** The pass's run-level health (layer A). */
  health: AnalysisRetrievalHealth;
  /** The pass's COMPLETE search-term index (layer B) — never the truncated scope. */
  evidence: ClaimEvidenceIndex;
  /**
   * The REQUIREMENT's text — document-derived, and the ONLY claim-side input. The
   * finding's model-authored title is excluded on purpose (see the module doc): if
   * it counted, the model could license a gap for a requirement it never searched
   * for simply by echoing an earlier query's vocabulary in the headline.
   */
  requirementText: string;
  /**
   * Every requirement text the pass investigated. Used to tell a RARE term (one that
   * actually discriminates this requirement from its neighbours) from boilerplate
   * shared across the set. Omitted ⇒ no term counts as rare, so
   * {@link MIN_SHARED_TERMS} shared terms are required — the safe default.
   */
  requirementCorpus?: readonly string[];
  /**
   * #1236 — does the finding carry a CODE citation (resolved `filePath` + `startLine`)
   * that survived the #734 grounding gate? Read ONLY when the pass was `exhausted`,
   * as the second half of "did the loop actually reach this requirement?". A pass cut
   * short by its turn cap did finish whatever it cited; it is the uncited requirements
   * that were left unreached.
   */
  hasGroundedCodeCitation?: boolean;
}

/**
 * THE PER-CLAIM EVIDENCE THRESHOLD (layer A && layer B). True when this run may
 * confirm THAT THIS PARTICULAR THING IS ABSENT: retrieval worked at all, AND the
 * agent ran at least one working (non-errored) CODE search bearing on the
 * requirement.
 *
 * A search that hit and a search that came back empty both count: an empty result
 * from a working tool is the evidence of absence. Only an ERRORED call is worthless,
 * because it tells us nothing at all.
 *
 * Deliberately conservative in ONE direction only: it can refuse to confirm a real
 * gap (the user is told "could not verify" and can re-run), but it can never
 * manufacture a gap out of an investigation that never looked.
 *
 * #1236 — when the pass was EXHAUSTED (out of turns/tokens, retrieval otherwise
 * healthy) a bearing search is necessary but no longer sufficient: the claim must
 * ALSO be backed by a surviving code citation. That is the line between "reached and
 * evidenced" and "planned but never got there" — and it is drawn per requirement,
 * because drawing it pass-wide is what retitled 13 cited findings out of existence.
 */
export function absenceIsConfirmableForClaim(input: ClaimAbsenceInput): boolean {
  if (!absenceIsConfirmable(input.health)) return false;
  if (input.health.exhausted === true && input.hasGroundedCodeCitation !== true) return false;
  const claimTerms = extractTerms(input.requirementText);
  if (claimTerms.size === 0) return false;

  const shared: string[] = [];
  for (const term of claimTerms) {
    if (input.evidence.terms.has(term)) shared.push(term);
  }
  if (shared.length >= MIN_SHARED_TERMS) return true;
  if (shared.length === 0) return false;
  // Exactly one shared term: it licenses the gap only if it is RARE — carried by no
  // more than half the pass's requirements. `user`, `rate`, `token` collide by
  // accident across a requirement set; `webhook` or `computeSeverity` do not.
  return isRareTerm(shared[0] as string, input.requirementCorpus);
}

/**
 * Is `term` DISCRIMINATING within this pass's requirement set — i.e. carried by no
 * more than half of it? With no corpus we cannot tell, so nothing is rare (callers
 * then need {@link MIN_SHARED_TERMS} shared terms).
 */
function isRareTerm(term: string, corpus: readonly string[] | undefined): boolean {
  if (!corpus || corpus.length === 0) return false;
  let documentFrequency = 0;
  for (const text of corpus) {
    if (extractTerms(text).has(term)) documentFrequency += 1;
  }
  return documentFrequency <= Math.max(1, Math.floor(corpus.length / 2));
}

/**
 * Merge the per-pass health records of one run (the #739 escalation policy can
 * split a run into a deep pass + a standard pass) into ONE run-level record.
 * Conservative: the run is starved/degraded if ANY pass was, because a verdict is
 * only as good as the pass that produced it.
 *
 * DISPLAY ONLY — verdicts are gated on the per-pass record, never on this one. The
 * merged `searchedScope` fills ROUND-ROBIN across passes so a long first pass cannot
 * consume the whole budget and erase the second pass's provenance from the artifact
 * a BA circulates.
 */
export function mergeRetrievalHealth(
  passes: readonly AnalysisRetrievalHealth[],
): AnalysisRetrievalHealth | null {
  if (passes.length === 0) return null;
  const searchedScope: SearchedQuery[] = [];
  const longest = Math.max(...passes.map((p) => p.searchedScope.length));
  for (let i = 0; i < longest && searchedScope.length < MAX_SEARCHED_SCOPE; i += 1) {
    for (const pass of passes) {
      if (searchedScope.length >= MAX_SEARCHED_SCOPE) break;
      const entry = pass.searchedScope[i];
      if (entry) searchedScope.push(entry);
    }
  }
  return {
    successfulSearches: passes.reduce((n, p) => n + p.successfulSearches, 0),
    failedSearches: passes.reduce((n, p) => n + p.failedSearches, 0),
    erroredCalls: passes.reduce((n, p) => n + p.erroredCalls, 0),
    totalCalls: passes.reduce((n, p) => n + p.totalCalls, 0),
    requirementCount: passes.reduce((n, p) => n + p.requirementCount, 0),
    starved: passes.some((p) => p.starved),
    ...(passes.some((p) => p.exhausted === true) ? { exhausted: true } : {}),
    ...(passes.some((p) => p.seedGrounded === true) ? { seedGrounded: true } : {}),
    // #19 — summed only when some pass recorded one, so a clean run is unchanged.
    ...(passes.some((p) => p.unverifiedRequirements !== undefined)
      ? {
          unverifiedRequirements: passes.reduce((n, p) => n + (p.unverifiedRequirements ?? 0), 0),
        }
      : {}),
    degraded: passes.some((p) => p.degraded),
    searchedScope,
  };
}

/**
 * #19 — the fewest CODE-retrieval calls per requirement a pass may make before its
 * health REPORT calls it starved: one search for every four requirements. Far below
 * what a funded pass makes (the turn cap scales at two turns per requirement), and
 * far above the reported incident (one call for 16 requirements).
 *
 * Deliberately NOT part of {@link absenceIsConfirmable}: a pass-wide quota in the
 * VERDICT gate made a confirmed gap mathematically impossible at scale (see the
 * module doc). This floor only decides what the run REPORTS, after verdicts are set.
 */
export const MIN_SEARCHES_PER_REQUIREMENT = 0.25;

/**
 * #19 — the largest share of a pass's requirements that may come back
 * `could-not-verify` before the report calls the pass degraded. "Most" means MORE
 * than this share, so a pass that verified exactly half of its requirements is not
 * flagged.
 */
export const MAX_UNVERIFIED_REQUIREMENT_SHARE = 0.5;

/** The two fields of a finding {@link countUnverifiedRequirements} reads. */
export interface VerdictBearingFinding {
  requirementId?: string | null;
  verdict?: string | null;
}

/**
 * #19 — how many of a pass's requirements the analysis page shows as
 * `could-not-verify`. Computed with the page's OWN roll-up,
 * {@link deriveRequirementVerdict}, so the report and the page cannot disagree:
 * a requirement the agent reported NOTHING for is could-not-verify (the
 * budget-starvation rule), `could-not-verify` beats `implemented`, and
 * `gap-confirmed` beats both. A finding bound to a requirement outside this
 * pass, or to none, is ignored; a verdict the page does not know counts as none.
 */
export function countUnverifiedRequirements(
  findings: readonly VerdictBearingFinding[],
  requirementIds: Iterable<string>,
): number {
  const byRequirement = new Map<string, VerdictFindingInput[]>();
  for (const id of requirementIds) byRequirement.set(id, []);
  for (const finding of findings) {
    const linked = finding.requirementId ? byRequirement.get(finding.requirementId) : undefined;
    if (!linked) continue;
    const verdict = REQUIREMENT_VERDICTS.has(finding.verdict ?? "")
      ? (finding.verdict as RequirementVerdict)
      : null;
    // Every finding of the agentic code pass is a CODE finding.
    linked.push({ agentKey: "code", verdict });
  }
  let unverified = 0;
  for (const linked of byRequirement.values()) {
    const verdict = deriveRequirementVerdict({ codeAnalysisRan: true, findings: linked });
    if (verdict === "could-not-verify") unverified += 1;
  }
  return unverified;
}

const REQUIREMENT_VERDICTS: ReadonlySet<string> = new Set<RequirementVerdict>([
  "implemented",
  "gap-confirmed",
  "could-not-verify",
]);

export interface InvestigationCoverageInput {
  /** {@link countUnverifiedRequirements} over the pass's GATED findings. */
  unverifiedRequirements: number;
}

/**
 * #19 — the REPORT-SIDE coverage check. The #773 run-level threshold asks only
 * "did retrieval physically work at least once?", so a pass that made ONE working
 * search and then verified none of its 16 requirements was persisted as
 * `starved: false, degraded: false` and raised no capability reason — the analysis
 * page told the user nothing. This check runs AFTER the pass's verdicts are gated,
 * over the record that is persisted and drives the `code-retrieval-degraded`
 * banner, and never over the record the verdicts read:
 *
 *   - STARVED when the pass made fewer than {@link MIN_SEARCHES_PER_REQUIREMENT}
 *     code-retrieval calls per requirement;
 *   - DEGRADED when it is starved, or when more than
 *     {@link MAX_UNVERIFIED_REQUIREMENT_SHARE} of its requirements came back
 *     `could-not-verify`.
 *
 * #1236 — a pass cut short by its turn/token budget is never branded STARVED:
 * it is `exhausted`, which is how the record already reports it, and exhaustion
 * is not retrieval failure. The unverified share still applies — it is what the
 * page shows, whatever cut the run short. Returns a NEW record; never clears a
 * degradation the threshold found.
 */
export function assessInvestigationCoverage(
  health: AnalysisRetrievalHealth,
  input: InvestigationCoverageInput,
): AnalysisRetrievalHealth {
  const unverified = Math.min(
    Math.max(0, Math.floor(input.unverifiedRequirements)),
    health.requirementCount,
  );
  const assessed: AnalysisRetrievalHealth = {
    ...health,
    ...(unverified > 0 ? { unverifiedRequirements: unverified } : {}),
  };
  if (health.requirementCount === 0) return assessed;
  const searchStarved =
    health.exhausted !== true &&
    health.totalCalls < health.requirementCount * MIN_SEARCHES_PER_REQUIREMENT;
  const mostlyUnverified = unverified > health.requirementCount * MAX_UNVERIFIED_REQUIREMENT_SHARE;
  if (searchStarved) assessed.starved = true;
  if (searchStarved || mostlyUnverified) assessed.degraded = true;
  return assessed;
}

/**
 * The health record for a code path that performed NO tool retrieval at all (the
 * requirement-grounded single-shot path, which runs when the project has no code
 * graph). It cannot confirm absence — there is no searched scope — so it is
 * degraded by construction. Kept explicit rather than implicit so the honest
 * "we never looked at code" case cannot be mistaken for "we looked and found
 * nothing".
 */
export function noRetrievalHealth(requirementCount: number): AnalysisRetrievalHealth {
  return {
    successfulSearches: 0,
    failedSearches: 0,
    erroredCalls: 0,
    totalCalls: 0,
    requirementCount: Math.max(0, requirementCount),
    starved: false,
    degraded: true,
    searchedScope: [],
  };
}
