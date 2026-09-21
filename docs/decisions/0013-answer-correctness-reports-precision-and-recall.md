# 13. Answer-correctness reports recall and precision; F1 is not the headline

- **Status:** Accepted
- **Date:** 2026-09-02
- **Issue:** [#1342](https://github.com/openzigs/metis-private/issues/1342), epic
  [#1316](https://github.com/openzigs/metis-private/issues/1316)
- **Supersedes nothing.** It narrows how [#1319]'s metric is *reported*; the
  metric itself is unchanged.

## Context

The first real run of `pnpm eval:answer-correctness` — four human-authored gold
answers, live provider, real `gte-modernbert-base` embedder, envelope
`eval-results/answer-correctness/2026-08-30T14-57-51-691Z.json` at commit
`55293a91` — produced this:

| queryId | F1 | precision | recall |
|---|---|---|---|
| `dq-ops-04` | 0.250 | 0.143 | **1.000** |
| `dq-ops-06` | 0.167 | 0.091 | **1.000** |
| `dq-sec-01` | 0.909 | 0.833 | **1.000** |
| `dq-sec-02` | 0.800 | 0.667 | **1.000** |
| **mean** | **0.531** | 0.433 | **1.000** |

**Recall is 1.000 on every query.** Every claim of every human gold answer was
entailed by METIS's answer. On the question the metric exists to ask — *is the
answer right?* — METIS passed all four.

The 0.531 is entirely precision. On `dq-ops-06` the gold answer was one sentence
("Maximum tolerable data loss on failover is 5 minutes") and METIS returned
roughly eleven claims, one of which matched: precision 1/11. METIS is not wrong
there. It is **verbose relative to a terse reference**, and F1 counts every extra
*true* statement as a miss.

That creates a direct conflict with the corpus's own authoring rule.
`REFERENCE-AUTHORING.md` mandates **1–3 sentences** per gold answer (#1319
decision 4) while the production RAG answer path returns a paragraph. So a
*more complete* gold answer raises the score with no change to METIS, and a
conscientious author following the style rule lowers it. `mean=0.531` does not
mean "METIS is 53% correct"; it substantially measures the length gap between
gold and generated — and a number in that state gets quoted in a decision.

This is a **verbosity artefact**, the mirror of the verbosity bias #1320 is
chartered to probe. It surfaced on four answers, before any calibration work,
which is itself evidence that a partial reference set produces useful signal.

## Options considered

1. **Report precision and recall separately; stop leading with F1.** Cheapest and
   honest — recall answers "is it right?", precision answers "is it focused?",
   and blending them into one number hid both.
2. **Drop the 1–3 sentence rule** and let gold answers be as long as the question
   needs. Costs authoring effort on all 48 questions, and makes the guide's
   "state the fact, not its location" advice much harder to hold — a longer
   answer drifts toward summarising the document.
3. **Redefine precision so an extra TRUE claim is not a miss** — check unmatched
   generated claims against the *source document* rather than against the gold.
   Most faithful to intent, most work, and it needs a grounding pass the metric
   does not currently make. It also changes what the number means, so every
   figure recorded before it would be incomparable.

## Decision

**Option 1**, with one strengthening: the length sensitivity is *measured* and
carried in the artifact rather than left as prose in an issue.

1. **Recall and precision are the headline pair, in that order.** They are
   emitted ahead of the blend in `CorrectnessAggregate`, in the per-query rows,
   and in the console line.
2. **The blend is renamed.** `correctness` → `f1` per query, `mean` → `meanF1` in
   the aggregate. Those two keys were the ones a reader took for "percent
   correct"; the arithmetic behind them is untouched.
3. **Claim counts are recorded.** Each row carries `answerClaims` and
   `referenceClaims` — the decompositions the two judge directions already
   produced and then discarded. The gap between them *is* the effect that
   depresses precision, so it stops being an anecdote.
4. **Every reported envelope carries an `interpretation` string**, built by
   `interpretAggregate` from that run's own numbers. The nightly `cat`s the
   envelope into the GitHub job summary, so this is the wiring by which the
   caveat reaches where the metric is actually read. Two limits, stated because
   an overstated one would be the same failure as the metric's:
   - It is **latent today**. `interpretation` is attached only when `reported` is
     true, and `eval-domain-nightly.yml` deliberately sets neither provider
     credentials nor `EMBEDDINGS_MODEL_DOWNLOAD_TESTS`, so the nightly cannot
     score and cannot report. The three nightly envelopes committed so far
     (`08-31`, `09-01`, `09-02`) stop one gate earlier still, at
     `no-gold-answers`; once gold answers reach that job the code becomes
     `no-judge`, and it is still `reported: false`. The wiring is right and the
     caveat travels the moment a run scores — no nightly run has scored yet, so
     nothing but the local run of #1342 has exercised this path.
   - Only the **claim counts** are computed. "LENGTH-SENSITIVE" and "an extra
     TRUE claim is counted as a miss" are fixed prose that still print on a
     closed gap — `reporting.test.ts` pins a 2.0/2.0 run emitting both, on
     purpose: F1 over decomposed claims is length-sensitive whether or not a
     given run's gap happens to be wide. What cannot go stale is the pair of
     numbers in the middle of that sentence. They are this run's own means, so
     the artifact can never assert a verbosity gap wider than the one it
     measured; at 2.0 against 2.0 it says so, and the reader sees a closed gap
     rather than a warning inherited from #1342's 9.0 against 1.0.

**The 1–3 sentence rule stays.** Under option 1 the rule and the metric no longer
pull against each other: recall is the headline, and recall is what a terse,
crisply-scoped gold answer tests *best* — every claim in it is one METIS must
have got right. Precision against such a reference is a **focus** signal, read as
"how much more than the question did METIS say", not as an error rate.
`REFERENCE-AUTHORING.md` now says exactly that, so an author is not left guessing
whether terseness is costing the system marks.

`eval-reqmap` already reports `macroP` / `macroR` / `macroF1` side by side; this
brings answer-correctness into line with that precedent rather than inventing a
convention.

## Consequences

- **Nothing to re-measure.** The decision changes reporting only, so the effect
  is a pure function of the numbers already recorded. `reporting.test.ts` replays
  the committed provenance envelope through the new aggregate and asserts
  `meanF1` is bit-for-bit the recorded `mean` while the headline becomes
  recall 1.000 / precision 0.433. That test is also the **first programmatic
  reader** the envelope format has ever had.
- **Envelopes written before this change use the old keys** (`mean`,
  `correctness`) and carry no claim counts or interpretation. They are a record
  of what was reported at the time and are not rewritten. Anything comparing
  across the boundary has to map `mean` → `meanF1`, which the replay test does
  and documents.
- **Option 3 remains open and is not precluded.** If claim-level grounding
  against the source document is built later, precision can be redefined without
  disturbing recall or the reporting shape. The claim counts added here are the
  measurement that would tell us whether it is worth it.
- **Option 2 is rejected rather than deferred.** Loosening the length rule would
  make the metric agree with itself by making the gold answers longer, which
  costs 48 answers of authoring effort to fix a presentation problem.

[#1319]: https://github.com/openzigs/metis-private/issues/1319
