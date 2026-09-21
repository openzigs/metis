/**
 * Issue #773 — the EVIDENCE THRESHOLD. These tests pin the exact rule that decides
 * whether a "the code does not do X" claim may be trusted, because that rule is the
 * whole difference between a useful tool and one that tells users to rebuild code
 * they already have.
 *
 * Four failure modes are pinned as hard as the original bug, because earlier cuts of
 * this module had all of them:
 *   - a threshold that is UNREACHABLE at real scale (a pass-wide quota that grows
 *     with the requirement count) — "could-not-verify everything" is honest and
 *     worthless;
 *   - counting well-formed EMPTY results as brokenness — which made a codebase's
 *     real gaps inversely correlated with our ability to report them;
 *   - letting a DOCUMENT search stand in for a code search — #773's own inference,
 *     relaunched through a different tool;
 *   - gating the per-claim rule on a TRUNCATED record, which made every search past
 *     the cut invisible and silently demoted the gaps it found.
 */
import { describe, expect, it } from "vitest";
import {
  absenceIsConfirmable,
  absenceIsConfirmableForClaim,
  extractTerms,
  isEmptyToolResult,
  isSuccessfulRetrieval,
  mergeRetrievalHealth,
  noRetrievalHealth,
  summarizeRetrieval,
  summarizeRetrievalEvidence,
  type ClaimAbsenceInput,
  type SummarizeRetrievalInput,
} from "./retrieval-health.js";

/** A call that returned results (the tool's own structured contract). */
const hit = (tool: string, args?: unknown) => ({
  tool,
  args,
  result: "function foo — src/foo.ts:1-9 [typescript]",
  resultPreview: "function foo",
  resultCount: 1,
});
/** A call whose TOOL FAILED — says retrieval is broken, says nothing about the code. */
const errored = (tool: string, args?: unknown) => ({
  tool,
  args,
  result: "Error: query is required and must be a non-empty string.",
  resultPreview: "Error: query is required",
  isError: true,
});
/** A call that WORKED and found nothing — evidence of absence, not of breakage. */
const empty = (tool: string, args?: unknown) => ({
  tool,
  args,
  result: "No matching code symbols found in this project's code graph.",
  resultPreview: "No matching code symbols",
  resultCount: 0,
});

/** Run the real summariser and ask the real per-claim gate — no hand-built records. */
function canConfirm(
  input: SummarizeRetrievalInput,
  requirementText: string,
  requirementCorpus?: readonly string[],
  hasGroundedCodeCitation?: boolean,
): boolean {
  const { health, claimIndex } = summarizeRetrievalEvidence(input);
  const args: ClaimAbsenceInput = {
    health,
    evidence: claimIndex,
    requirementText,
    ...(requirementCorpus ? { requirementCorpus } : {}),
    ...(hasGroundedCodeCitation === undefined ? {} : { hasGroundedCodeCitation }),
  };
  return absenceIsConfirmableForClaim(args);
}

describe("#773 — retrieval-call classification", () => {
  it("treats an Error result as a failed retrieval", () => {
    expect(isSuccessfulRetrieval(errored("search_code_symbols"))).toBe(false);
  });

  it("treats a well-formed EMPTY result as a failed retrieval, not as evidence of absence", () => {
    // The tool worked; the QUERY found nothing. On its own that establishes nothing
    // about the codebase — only about the query. (It DOES back an absence claim for
    // the thing it actually searched for — see the per-claim threshold below.)
    expect(isSuccessfulRetrieval(empty("search_code_symbols"))).toBe(false);
  });

  it("treats a result-bearing call as a successful retrieval", () => {
    expect(isSuccessfulRetrieval(hit("search_code_graph"))).toBe(true);
  });

  it("reads the tool's STRUCTURED outcome, not its prose", () => {
    // The prose sniff is the legacy fallback only. A tool that rewords its
    // no-results copy must not be able to flip a verdict (`resultCount` decides).
    expect(
      isSuccessfulRetrieval({
        tool: "search_code_graph",
        result: "Nothing matched that query.",
        resultCount: 0,
      }),
    ).toBe(false);
    // …and a legitimate result that merely STARTS with "No" is still a hit.
    expect(
      isSuccessfulRetrieval({
        tool: "search_code_symbols",
        result: "NoteService.send — src/notes.ts:4-8",
        resultCount: 1,
      }),
    ).toBe(true);
    // Legacy record (no structured fields) — prose fallback still applies.
    expect(isEmptyToolResult("No files matching pattern: **/*.rs")).toBe(true);
    expect(
      isSuccessfulRetrieval({ tool: "list_files", result: "No files matching pattern: **/*.rs" }),
    ).toBe(false);
  });
});

describe("#773 — the RUN-LEVEL threshold (did retrieval work at all?)", () => {
  it("refuses any verdict when NOTHING was successfully retrieved (the #773 incident)", () => {
    const health = summarizeRetrieval({
      toolCalls: [errored("search_code_symbols"), errored("read_file_slice")],
      requirementCount: 3,
      starved: false,
    });
    expect(health.successfulSearches).toBe(0);
    expect(health.erroredCalls).toBe(2);
    expect(absenceIsConfirmable(health)).toBe(false);
    expect(health.degraded).toBe(true);
  });

  it("refuses absence claims when the investigation was STARVED, even with good searches", () => {
    // STARVED now means RETRIEVAL ITSELF FAILED (#1236). It is still a hard
    // run-level short-circuit — that half of #773 is correct and untouched.
    const health = summarizeRetrieval({
      toolCalls: [hit("search_code_graph"), hit("read_file_slice")],
      requirementCount: 1,
      starved: true,
    });
    expect(absenceIsConfirmable(health)).toBe(false);
  });

  /**
   * #1236 — EXHAUSTION IS NOT STARVATION, and this is the assertion that separates
   * them at the run level. Turn/token cut-off used to be fed into `starved`, so this
   * exact record — 2 successful searches, 0 tool errors — short-circuited layer (A)
   * and every finding in the pass, cited or not, was retitled "Could not verify".
   */
  it("does NOT short-circuit the whole pass when it merely ran out of turns/tokens", () => {
    const health = summarizeRetrieval({
      toolCalls: [hit("search_code_graph"), hit("read_file_slice")],
      requirementCount: 1,
      exhausted: true,
    });
    expect(health.exhausted).toBe(true);
    // Retrieval was never in question: it is not starved, and not degraded.
    expect(health.starved).toBe(false);
    expect(health.degraded).toBe(false);
    expect(absenceIsConfirmable(health)).toBe(true);
  });

  it("refuses absence claims when most tool calls ERRORED", () => {
    const health = summarizeRetrieval({
      toolCalls: [
        hit("search_code_graph"),
        errored("search_code_symbols"),
        errored("read_file_slice"),
        errored("list_files"),
      ],
      requirementCount: 1,
      starved: false,
    });
    // 3/4 ERROR rate — the loop spent its turns in a repair spiral.
    expect(absenceIsConfirmable(health)).toBe(false);
  });

  /**
   * THE REGRESSION THIS RULE USED TO HAVE. `errorRate` was computed over
   * `failedSearches`, which INCLUDES well-formed EMPTY results — and an empty result
   * is exactly what a CORRECT absence investigation returns. So the more genuine gaps
   * a codebase had, the more "degraded" its run looked, and the more of its CORRECT
   * gaps got downgraded. Real gaps and the ability to confirm them were inversely
   * correlated. That is backwards, and this is the test that says so.
   */
  it("does NOT count well-formed EMPTY results as breakage (a gap-heavy codebase is not a broken run)", () => {
    const input: SummarizeRetrievalInput = {
      // 12 searches over a codebase that genuinely lacks most of what was asked for:
      // 3 hits, 9 legitimate empties, ZERO errors.
      toolCalls: [
        hit("search_code_graph", { query: "login" }),
        hit("search_code_graph", { query: "session" }),
        hit("search_code_symbols", { query: "audit log" }),
        ...Array.from({ length: 9 }, (_, i) =>
          empty("search_code_symbols", { query: `absent feature ${i} ingest quota` }),
        ),
      ],
      requirementCount: 10,
      starved: false,
    };
    const health = summarizeRetrieval(input);
    expect(health.failedSearches).toBe(9);
    expect(health.erroredCalls).toBe(0);
    // Under the old rule this was a 75% "error rate" ⇒ degraded ⇒ every correct gap
    // downgraded. Nothing was broken: the code simply is not there.
    expect(health.degraded).toBe(false);
    expect(absenceIsConfirmable(health)).toBe(true);
    // …and the gaps it searched for ARE still confirmable.
    expect(canConfirm(input, "Each tenant must have an ingest quota")).toBe(true);
  });

  it("ALLOWS a verdict when retrieval worked", () => {
    const health = summarizeRetrieval({
      toolCalls: [hit("search_code_graph"), hit("search_code_symbols"), hit("read_file_slice")],
      requirementCount: 2,
      starved: false,
    });
    expect(absenceIsConfirmable(health)).toBe(true);
    expect(health.degraded).toBe(false);
  });
});

/**
 * N1 — DOCUMENT RETRIEVAL MUST NOT LAUNDER A CODE GAP.
 *
 * `search_knowledge` is in the code agent's tool set, but it is document RAG: a hit
 * says nothing about whether the code exists. Counting it as retrieval evidence let a
 * run whose CODE tools ALL failed look healthy (the doc hits dilute the error rate and
 * satisfy "retrieval physically worked"), and a doc query derived from the requirement
 * text then satisfied the per-claim rule — confirming a code gap on a run where not one
 * code search worked. That is #773's own inference arriving through a different tool.
 */
describe("#773 — a DOCUMENT search is not code evidence", () => {
  /** 4 errored CODE searches + 5 successful DOC hits: healthy-looking, and blind. */
  const LAUNDERING_RUN: SummarizeRetrievalInput = {
    toolCalls: [
      ...Array.from({ length: 4 }, () =>
        errored("search_code_graph", { query: "tenant ingest quota" }),
      ),
      ...Array.from({ length: 5 }, () =>
        hit("search_knowledge", { query: "Each tenant must have an ingest quota" }),
      ),
    ],
    requirementCount: 6,
    starved: false,
  };

  it("does not let doc hits prove that CODE retrieval worked, or dilute the error rate", () => {
    const health = summarizeRetrieval(LAUNDERING_RUN);
    // Over ALL tool calls this was 5 successes and a 4/9 = 0.44 error rate ⇒ healthy.
    // Over the CODE tools — the only ones that say anything about the code — it is
    // 0 successes and a 4/4 = 1.0 error rate.
    expect(health.successfulSearches).toBe(0);
    expect(health.totalCalls).toBe(4);
    expect(health.erroredCalls).toBe(4);
    expect(health.degraded).toBe(true);
    expect(absenceIsConfirmable(health)).toBe(false);
  });

  it("does not let a doc query satisfy the per-claim rule (ZERO gap-confirmed)", () => {
    // The doc query is the requirement text verbatim, so it shares every term with it —
    // the per-claim rule passed on pure lexical overlap. It must not.
    expect(canConfirm(LAUNDERING_RUN, "Each tenant must have an ingest quota")).toBe(false);
  });

  it("keeps a doc search out of the searched-scope provenance entirely", () => {
    const health = summarizeRetrieval(LAUNDERING_RUN);
    expect(health.searchedScope.every((s) => s.tool !== "search_knowledge")).toBe(true);
  });

  it("still confirms the gap when the CODE search is the one that worked", () => {
    // The control: same shape, but the code tool ran a working (empty) search.
    expect(
      canConfirm(
        {
          toolCalls: [
            empty("search_code_graph", { query: "tenant ingest quota" }),
            hit("search_code_symbols", { query: "tenant billing" }),
            hit("search_knowledge", { query: "ingest quota policy" }),
          ],
          requirementCount: 6,
          starved: false,
        },
        "Each tenant must have an ingest quota",
      ),
    ).toBe(true);
  });
});

/**
 * THE CRUX. The first cut demanded `successfulSearches >= requirementCount` across the
 * WHOLE pass. The turn cap bounds how many tool calls a pass can make, so at ~30
 * requirements a confirmed gap became MATHEMATICALLY IMPOSSIBLE — the product silently
 * degraded into "could-not-verify everything", the exact anti-regression bar this issue
 * sets for itself. Evidence-local attribution has no cliff: it is SCALE-FREE.
 */
describe("#773 — the PER-CLAIM threshold (did the agent look for THIS thing?)", () => {
  const scaleRun = (n: number): SummarizeRetrievalInput => ({
    // A realistic large pass: it searched for SOME of its requirements, not all.
    toolCalls: [
      empty("search_code_graph", { query: "commit SHA baseline" }),
      empty("search_code_symbols", { query: "commit-sha baselining" }),
      hit("search_code_graph", { query: "drift severity" }),
      hit("read_file_slice", { filePath: "server/src/drift/severity.ts" }),
    ],
    requirementCount: n,
    starved: false,
  });
  const DRIFT_REQ = "Drift severity must be classified from a commit-SHA baseline.";

  it.each([1, 20, 30, 50])(
    "confirms a gap the agent DID search for, at requirementCount=%i (scale-free)",
    (n) => {
      expect(summarizeRetrieval(scaleRun(n)).degraded).toBe(false);
      expect(canConfirm(scaleRun(n), DRIFT_REQ)).toBe(true);
    },
  );

  it("refuses a gap for a requirement NOBODY SEARCHED FOR, however healthy the run", () => {
    // Nothing in the searched scope bears on rate limiting. The honest answer is
    // "we did not look", not "it is not there".
    expect(canConfirm(scaleRun(20), "The API must rate-limit unauthenticated calls")).toBe(false);
  });

  it("does not let an ERRORED call count as having searched for the thing", () => {
    const run: SummarizeRetrievalInput = {
      toolCalls: [
        hit("search_code_graph", { query: "drift severity" }),
        errored("search_code_symbols", { query: "rate limiting" }),
      ],
      requirementCount: 2,
      starved: false,
    };
    expect(canConfirm(run, "The public API must apply rate limiting")).toBe(false);
    expect(canConfirm(run, "Drift severity classification")).toBe(true);
  });

  it("counts a WORKING EMPTY search as having looked (that IS the evidence of absence)", () => {
    expect(
      canConfirm(
        {
          toolCalls: [
            hit("search_code_graph", { query: "drift severity" }),
            empty("search_code_symbols", { query: "rate limiter middleware" }),
          ],
          requirementCount: 2,
          starved: false,
        },
        "The API must have a rate limiter",
      ),
    ).toBe(true);
  });

  it("is gated by the run-level threshold too — a degraded run confirms nothing", () => {
    expect(
      canConfirm(
        {
          toolCalls: [errored("search_code_symbols", { query: "drift severity" })],
          requirementCount: 1,
          starved: false,
        },
        "Drift severity classification",
      ),
    ).toBe(false);
  });

  it("matches identifier vocabulary against prose (camelCase split, de-pluralised)", () => {
    expect([...extractTerms("computeSeverity")]).toContain("severity");
    expect([...extractTerms("baselines")]).toContain("baseline");
    // Stopwords alone cannot make any search "relevant" to any claim.
    expect(extractTerms("the system must support this requirement").size).toBe(0);
  });
});

/**
 * N2 — THE GATE MUST NOT BE BLINDED BY TRUNCATION.
 *
 * `searchedScope` is capped for persistence. When the per-claim rule read it, every
 * search past the cap was INVISIBLE to the gate — so at N ≥ 21 (where the 60-turn cap
 * allows 41+ tool calls) a pass that dutifully searched for every requirement had the
 * evidence for its last third thrown away BEFORE the gate read it, and reported
 * `could-not-verify` for gaps it had correctly found. The scale cliff, wearing a
 * different constant. The gate now reads the COMPLETE claim index instead.
 */
describe("#773 — the per-claim gate sees searches past the persistence cap", () => {
  /** 44 unrelated searches, then the one that matters, then 5 more. */
  const LONG_RUN: SummarizeRetrievalInput = {
    toolCalls: [
      ...Array.from({ length: 44 }, (_, i) =>
        hit("search_code_symbols", { query: `unrelated subsystem ${i} handler` }),
      ),
      empty("search_code_graph", { query: "tenant ingest quota" }), // the 45th call
      ...Array.from({ length: 5 }, (_, i) =>
        hit("search_code_symbols", { query: `later subsystem ${i} handler` }),
      ),
    ],
    requirementCount: 25,
    starved: false,
  };

  it("confirms a gap whose only search was the 45th tool call", () => {
    expect(canConfirm(LONG_RUN, "Each tenant must have an ingest quota")).toBe(true);
  });

  it("still bounds what is PERSISTED (display provenance is truncated, the gate is not)", () => {
    const health = summarizeRetrieval(LONG_RUN);
    expect(health.totalCalls).toBe(50);
    expect(health.searchedScope).toHaveLength(40);
  });
});

/**
 * M1 — THE MATCHER'S TWO FAILURE MODES. The dangerous direction (the model licensing
 * its own gap) is closed; the safe direction (a vocabulary variant) is exercised so the
 * gate is not merely refusing everything.
 */
describe("#773 — the per-claim matcher cannot be steered by the model", () => {
  /** The agent searched for REQ-1 (authentication). It never searched for tenant quota. */
  const AUTH_ONLY: SummarizeRetrievalInput = {
    toolCalls: [hit("search_code_symbols", { query: "authentication" })],
    requirementCount: 9,
    starved: false,
  };
  const CORPUS = [
    "The API must require authentication on every route.",
    "Each tenant must have an ingest quota enforced at write time.",
  ];

  it("refuses the gap when only the model's own FINDING TITLE bears on the search", () => {
    // The exploit: the model titles REQ-9's finding "No tenant quota in the
    // AUTHENTICATION layer", borrowing vocabulary from a search it ran for REQ-1.
    // The title is model-authored — it is not an input to this gate. Only the
    // (document-derived) requirement text is.
    expect(canConfirm(AUTH_ONLY, CORPUS[1] as string, CORPUS)).toBe(false);
    // …and passing that title as if it were the claim would be the bug: assert the
    // requirement text — and ONLY the requirement text — is what the caller supplies.
    expect(canConfirm(AUTH_ONLY, "No tenant quota in the authentication layer", CORPUS)).toBe(true);
  });

  it("refuses a gap licensed by ONE incidental common term", () => {
    // "user" collides across most requirement sets; a single such overlap must not
    // license a gap for a feature nobody looked for.
    const run: SummarizeRetrievalInput = {
      toolCalls: [hit("search_code_symbols", { query: "user login session" })],
      requirementCount: 4,
      starved: false,
    };
    const corpus = [
      "A user must be able to log in with a password.",
      "A user must be able to export their data as CSV.",
      "A user must be able to delete their account.",
      "A user must receive an email on password reset.",
    ];
    expect(canConfirm(run, "A user must be able to export their data as CSV", corpus)).toBe(false);
  });

  it("confirms on ONE shared term when that term actually discriminates (rare)", () => {
    const run: SummarizeRetrievalInput = {
      toolCalls: [
        hit("search_code_symbols", { query: "password login" }),
        empty("search_code_graph", { query: "webhook signing" }),
      ],
      requirementCount: 4,
      starved: false,
    };
    const corpus = [
      "A user must be able to log in with a password.",
      "Outbound webhooks must be signed.",
      "A user must be able to delete their account.",
      "Drift severity must be classified.",
    ];
    // Only "webhook" is shared ("signing" ≠ "signed"), but it appears in 1 of 4
    // requirements — it is exactly the term that identifies this one.
    expect(canConfirm(run, "Outbound webhooks must be signed.", corpus)).toBe(true);
  });

  it("still matches a reasonable VOCABULARY VARIANT of the requirement", () => {
    // The agent searched by symbol name, the requirement is written in prose. The
    // camelCase split bridges them — a correct gap is not demoted just because the
    // agent typed the identifier instead of the sentence.
    expect(
      canConfirm(
        {
          toolCalls: [
            hit("search_code_graph", { query: "ingest pipeline" }),
            empty("search_code_symbols", { query: "computeDriftSeverity" }),
          ],
          requirementCount: 3,
          starved: false,
        },
        "Drift severity must be classified from a commit-SHA baseline.",
        ["Drift severity must be classified from a commit-SHA baseline."],
      ),
    ).toBe(true);
  });

  it("refuses a gap for a finding with no resolvable requirement (empty claim text)", () => {
    expect(canConfirm(AUTH_ONLY, "", CORPUS)).toBe(false);
  });

  it("requires TWO shared terms when no requirement corpus is available to judge rarity", () => {
    // With no corpus we cannot tell a discriminating term from boilerplate, so the
    // conservative rule applies: one term is not enough.
    expect(canConfirm(AUTH_ONLY, "The API must require authentication on every route.")).toBe(
      false,
    );
  });
});

/**
 * #1236 — TURN/TOKEN EXHAUSTION, SCOPED TO THE REQUIREMENTS IT ACTUALLY APPLIES TO.
 *
 * The #773 design intent stands: a requirement the loop never reached is UNKNOWN, not
 * absent. The defect was the blast radius. Because exhaustion was routed through
 * `starved`, it short-circuited layer (A) and condemned the whole pass — so on a run
 * with 17 requirements, 14 successful searches and zero tool errors, 13 of 22 findings
 * that named exact files, methods and line numbers were retitled "Could not verify".
 * The perverse consequence: the better retrieval got, the deeper the agent dug, the
 * more turns it burned, and the more of its BEST work was thrown away.
 *
 * The line is drawn per requirement: reached (a working search bearing on it AND a
 * surviving code citation) keeps its verdict; everything else is still unknown.
 */
describe("#1236 — exhaustion downgrades only the requirements the loop never reached", () => {
  /**
   * The measured incident, to scale: a long, PRODUCTIVE investigation that simply ran
   * out of turns. 14 successful code searches, zero tool errors, 17 requirements.
   */
  const EXHAUSTED_PRODUCTIVE_RUN: SummarizeRetrievalInput = {
    toolCalls: [
      hit("search_code_graph", { query: "job reconciliation" }),
      hit("search_code_symbols", { query: "performBidReconciliation" }),
      hit("read_file_slice", { filePath: "src/WMSReconciliationManagerBean.java" }),
      ...Array.from({ length: 11 }, (_, i) =>
        hit("search_code_graph", { query: `invoice charge type ${i}` }),
      ),
    ],
    requirementCount: 17,
    exhausted: true,
  };
  const CORPUS = [
    "Shipment reconciliation must cover every invoice charge type.",
    "Operators must be notified when a dispute window closes.",
  ];

  it("keeps the verdict for a requirement that was searched AND cited", () => {
    expect(canConfirm(EXHAUSTED_PRODUCTIVE_RUN, CORPUS[0] as string, CORPUS, true)).toBe(true);
  });

  it("still refuses a requirement the loop never searched for (the #773 protection)", () => {
    // Nobody searched for the dispute window — exhaustion or not, that is unknown.
    // A citation alone cannot buy it: absence needs a search that bore on the claim.
    expect(canConfirm(EXHAUSTED_PRODUCTIVE_RUN, CORPUS[1] as string, CORPUS, true)).toBe(false);
  });

  it("refuses a searched requirement whose finding produced NO grounded code citation", () => {
    // Searched, but nothing survived #734 grounding to show for it — indistinguishable
    // from "the loop was on its way there when the budget ran out".
    expect(canConfirm(EXHAUSTED_PRODUCTIVE_RUN, CORPUS[0] as string, CORPUS, false)).toBe(false);
  });

  it("does not read the citation flag at all when the pass was NOT exhausted", () => {
    // The citation requirement is exhaustion-specific. On a normal pass, a searched
    // absence claim is confirmable exactly as it was before #1236 — an absence claim
    // routinely has nothing to cite, because the thing is not there.
    const healthy: SummarizeRetrievalInput = { ...EXHAUSTED_PRODUCTIVE_RUN, exhausted: false };
    expect(canConfirm(healthy, CORPUS[0] as string, CORPUS, false)).toBe(true);
  });

  it("STARVATION still overrides everything, citation or not", () => {
    // Retrieval broke. No per-requirement evidence can rescue that, and #1236 must
    // not have opened a hole in the #773 short-circuit.
    const starved: SummarizeRetrievalInput = {
      ...EXHAUSTED_PRODUCTIVE_RUN,
      starved: true,
      exhausted: true,
    };
    expect(canConfirm(starved, CORPUS[0] as string, CORPUS, true)).toBe(false);
  });

  it("carries `exhausted` through the run-level merge without contaminating `starved`", () => {
    const exhaustedPass = summarizeRetrieval(EXHAUSTED_PRODUCTIVE_RUN);
    const cleanPass = summarizeRetrieval({
      toolCalls: [hit("search_code_graph", { query: "audit log" })],
      requirementCount: 2,
      starved: false,
    });
    const merged = mergeRetrievalHealth([cleanPass, exhaustedPass]);
    expect(merged?.exhausted).toBe(true);
    expect(merged?.starved).toBe(false);
    expect(merged?.degraded).toBe(false);
  });

  it("defaults `exhausted` to absent so pre-#1236 records read as not-exhausted", () => {
    const health = summarizeRetrieval({
      toolCalls: [hit("search_code_graph", { query: "audit log" })],
      requirementCount: 1,
      starved: false,
    });
    expect(health.exhausted).toBeUndefined();
  });
});

/**
 * M2 — the #729 PASSIVE SEED is real, retrieved, un-failed code. The single-shot
 * requirement-grounded path already trusts exactly that evidence for a cited
 * `implemented` claim. An agentic pass satisfied by the same seed must not be called
 * degraded on the same evidence — a banner on every run trains users to ignore the one
 * that matters. It is still not a SEARCH, so it licenses no absence claim.
 */
describe("#773 — the fused seed proves retrieval works, but never that something is absent", () => {
  it("is not degraded when the seed grounded the pass and no search failed", () => {
    const health = summarizeRetrieval({
      toolCalls: [],
      requirementCount: 3,
      starved: false,
      seedGrounded: true,
    });
    expect(health.degraded).toBe(false);
    expect(absenceIsConfirmable(health)).toBe(true);
  });

  it("is degraded with no seed and no search (we never looked at code at all)", () => {
    const health = summarizeRetrieval({ toolCalls: [], requirementCount: 3, starved: false });
    expect(health.degraded).toBe(true);
  });

  it("never lets the seed license an absence claim (a seed is not a search)", () => {
    expect(
      canConfirm(
        { toolCalls: [], requirementCount: 3, starved: false, seedGrounded: true },
        "Each tenant must have an ingest quota",
      ),
    ).toBe(false);
  });

  it("does NOT rescue the #773 incident run — a seeded run whose searches all errored is degraded", () => {
    const health = summarizeRetrieval({
      toolCalls: [errored("search_code_symbols"), errored("read_file_slice")],
      requirementCount: 3,
      starved: false,
      seedGrounded: true,
    });
    expect(health.degraded).toBe(true);
  });
});

describe("#773 — searched-scope provenance", () => {
  it("records WHICH queries ran, whether they hit, and whether they errored", () => {
    const health = summarizeRetrieval({
      toolCalls: [
        hit("search_code_symbols", { query: "computeSeverity" }),
        empty("search_code_graph", { query: "drift baseline" }),
        errored("read_file_slice", { filePath: "src/foo.ts", startLine: 1 }),
      ],
      requirementCount: 1,
      starved: false,
    });
    expect(health.searchedScope).toEqual([
      { tool: "search_code_symbols", query: "computeSeverity", hit: true },
      { tool: "search_code_graph", query: "drift baseline", hit: false },
      { tool: "read_file_slice", query: "src/foo.ts", hit: false, errored: true },
    ]);
  });

  it("sanitizes and truncates the model-authored query (untrusted text)", () => {
    const health = summarizeRetrieval({
      toolCalls: [hit("search_code_symbols", { query: `bad \ninput ${"x".repeat(200)}` })],
      requirementCount: 1,
      starved: false,
    });
    const query = health.searchedScope[0]?.query ?? "";
    expect(query).not.toContain("\n");
    expect(query.length).toBeLessThanOrEqual(120);
  });
});

describe("#773 — merging passes + the no-retrieval path", () => {
  it("is conservative: one degraded pass degrades the run", () => {
    const good = summarizeRetrieval({
      toolCalls: [hit("search_code_graph")],
      requirementCount: 1,
      starved: false,
    });
    const bad = summarizeRetrieval({
      toolCalls: [errored("search_code_symbols")],
      requirementCount: 1,
      starved: false,
    });
    const merged = mergeRetrievalHealth([good, bad]);
    expect(merged?.degraded).toBe(true);
    expect(merged?.totalCalls).toBe(2);
    expect(merged?.successfulSearches).toBe(1);
    expect(merged?.erroredCalls).toBe(1);
  });

  it("keeps every pass represented in the merged (display) provenance", () => {
    // A long first pass used to consume the whole scope budget, erasing the second
    // pass's provenance from the artifact a BA circulates.
    const deep = summarizeRetrieval({
      toolCalls: Array.from({ length: 40 }, (_, i) =>
        hit("search_code_symbols", { query: `deep ${i}` }),
      ),
      requirementCount: 20,
      starved: false,
    });
    const standard = summarizeRetrieval({
      toolCalls: [hit("search_code_graph", { query: "standard pass query" })],
      requirementCount: 1,
      starved: false,
    });
    const merged = mergeRetrievalHealth([deep, standard]);
    expect(merged?.searchedScope).toHaveLength(40);
    expect(merged?.searchedScope.some((s) => s.query === "standard pass query")).toBe(true);
  });

  it("returns null when no code pass ran (nothing to report)", () => {
    expect(mergeRetrievalHealth([])).toBeNull();
  });

  it("cannot confirm absence when no code retrieval happened at all", () => {
    const health = noRetrievalHealth(4);
    expect(absenceIsConfirmable(health)).toBe(false);
    expect(
      absenceIsConfirmableForClaim({
        health,
        evidence: { terms: new Set() },
        requirementText: "anything at all",
      }),
    ).toBe(false);
    expect(health.degraded).toBe(true);
  });
});

/**
 * Issue #777 — A TOOL WE NEVER OFFERED CANNOT BE EVIDENCE THAT RETRIEVAL BROKE.
 *
 * When a project is indexed but has no clone on disk, the file tools are withheld
 * (`assembleAgenticCodeTools`). A model can still emit a call for one, which the loop
 * answers with an "Unknown tool" repair error. Counting those toward the error rate
 * would let a KNOWN CAPABILITY LIMIT masquerade as broken retrieval: 3 such calls
 * against 2 perfectly good graph searches is an 0.6 error rate — past
 * MAX_TOOL_ERROR_RATE — and the run collapses to `could-not-verify` again, which is
 * exactly the outcome #777 exists to kill.
 */
describe("#777 — withheld tools are excluded from the retrieval-health signal", () => {
  const WITHHELD = new Set(["read_file_slice", "list_files"]);

  /** The live incident's shape: 2 working graph searches, 3 calls to withheld file tools. */
  const CLONELESS_RUN: SummarizeRetrievalInput = {
    toolCalls: [
      hit("search_code_graph", { query: "drift severity" }),
      errored("read_file_slice", { filePath: "src/a.ts" }),
      errored("list_files", { pattern: "**/*.ts" }),
      errored("read_file_slice", { filePath: "src/b.ts" }),
      empty("search_code_graph", { query: "tenant ingest quota" }),
    ],
    requirementCount: 2,
    starved: false,
  };

  it("counts ONLY the tools the pass actually offered", () => {
    const health = summarizeRetrieval({ ...CLONELESS_RUN, unavailableTools: WITHHELD });

    expect(health.totalCalls).toBe(2); // the 2 code searches, not all 5 calls
    expect(health.erroredCalls).toBe(0);
    expect(health.successfulSearches).toBe(1);
    expect(health.failedSearches).toBe(1); // the legitimate empty
    expect(health.degraded).toBe(false);
    expect(health.searchedScope.every((s) => !WITHHELD.has(s.tool))).toBe(true);
  });

  it("WITHOUT the exclusion the very same run is (wrongly) branded degraded", () => {
    // The main-branch behaviour, and the reason the exclusion is load-bearing.
    const health = summarizeRetrieval(CLONELESS_RUN);

    expect(health.erroredCalls).toBe(3);
    expect(health.totalCalls).toBe(5); // 0.6 error rate > MAX_TOOL_ERROR_RATE
    expect(health.degraded).toBe(true);
  });

  it("still lets a clone-less run confirm the gap it searched for", () => {
    const { health, claimIndex } = summarizeRetrievalEvidence({
      ...CLONELESS_RUN,
      unavailableTools: WITHHELD,
    });

    expect(
      absenceIsConfirmableForClaim({
        health,
        evidence: claimIndex,
        requirementText: "Each tenant must have an ingest quota enforced at write time.",
      }),
    ).toBe(true);
  });

  it("does NOT weaken the threshold: a pass that ONLY called withheld tools investigated nothing", () => {
    // No real search ever ran, so `successfulSearches` is 0 and there is no seed —
    // rule (2) fails and the pass is degraded. Correctly: it looked at nothing.
    const health = summarizeRetrieval({
      toolCalls: [errored("read_file_slice", { filePath: "src/a.ts" }), errored("list_files", {})],
      requirementCount: 1,
      starved: false,
      unavailableTools: WITHHELD,
    });

    expect(health.totalCalls).toBe(0);
    expect(health.successfulSearches).toBe(0);
    expect(absenceIsConfirmable(health)).toBe(false);
    expect(health.degraded).toBe(true);
  });
});
