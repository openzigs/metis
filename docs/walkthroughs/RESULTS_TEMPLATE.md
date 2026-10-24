# #706 walkthrough — results template

Copy this into the results comment for run N (on
[#706](https://github.com/openzigs/metis/issues/706) or a tracking issue that links back).
The runbook is the `e2e-walkthrough` skill (`.github/skills/e2e-walkthrough/SKILL.md`). The
run-2 baseline is pre-filled from #706 comments
[5964877354](https://github.com/openzigs/metis/issues/706#issuecomment-5964877354) and
[5965348586](https://github.com/openzigs/metis/issues/706#issuecomment-5965348586); keep
it unchanged so every run compares against the same reference. Run 3's results are in #706
comment [5983560251](https://github.com/openzigs/metis/issues/706#issuecomment-5983560251):

- Works 11/7/1/1, Useful 9/8/2/1
- BA 8/8; developer impact 3/3 (2/3 strict)
- 14.37M tokens, $9.84 (docs-gen 89%)

Add a "Run 3" column beside the baseline when the change since run 3 matters more than the
change since run 2.

The slideshow's report deck (skill section 7) takes its spend and new-issue list from the
evidence folder's `run.json` when there is one (#947). Fill it from the same ledger figures
and the same issue list as this comment, so the deck and the comment agree.

Legend for Works / Useful: ✅ pass · ⚠️ partial (Works) or weak (Useful) · ❌ fail ·
🚫 blocked (give the reason) · – n/a · ⏭ skipped (optional, #1177).

**Run shape (#1177, from run 10).** The analyst journey is the core of the run, so its results
come first. The developer side is a smoke test: the Spec Kit smoke set (S2, S4, S6, S7, S21),
two developer requests in wave E (#4478, #4386) and a conditional wave G. The run-to-run table
marks which numbers are no longer comparable with runs 1 to 9.

---

## Walkthrough results: run {{N}} ({{DATE}})

**Setup.** `miniflux/v2` @ `v2.3.3` (`c4d54f87`), METIS `main` @ `{{METIS_SHA}}`, DeepSeek
`deepseek-flash` via the Anthropic-compatible endpoint ({{PEAK_OR_OFF_PEAK}} prices), SQL-lineage
sidecar, project `{{PROJECT_ID}}` in workspace `{{WORKSPACE_ID}}`. Ledger: `token_usages` only
(since #792 and #854; never summed with `ai_token_usages`).

Phases removed since run 2: {{e.g. Phase 4 bug scan (#799); Phase 17 test coverage → "Tested by" (#812)}}.

### Analyst journey (wave F, journey 1): the core of the run

Second users ran as: {{operator-run / operator-approved / agent}} (reviewer `coordinator`,
second analyst `developer`; TEST_PLAN "Second-user steps").

| Step | Works | Useful | Handoff held? | Second user ran as | Key finding |
|---|---|---|---|---|---|
| J1.1 Import feature requests | | | | – | |
| J1.2 Analyse 5 imported items | | | | – | |
| J1.3 Clarifying questions | | | | – | |
| J1.4 Approve, request review, edit criteria | | | | – | |
| J1.4a Reviewer comments, @mentions, rejects with a note | | | | | |
| J1.4b Second analyst replies and discusses | | | | | |
| J1.4c Analyst responds; second review approved | | | | | |
| J1.5 Traceability | | | | – | |
| J1.6 Chat: which touch the database? | | | | – | |
| J1.7 Requirements-scoped BRD (sign-off, Word, PDF) | | | | – | |
| J1.8 Publish 2 issues to `openzigs/flux-v2` | | | | – | |
| J1.8a Publish to the sandbox Jira (#1176) | | | | – | {{or "skipped: no sandbox Jira (#1176)"}} |
| J1.9 Cost on the usage page | | | | – | |

**Completed in the UI:** {{yes / no, broke at J1.n}} · **Data lost between steps:**
{{which handoff, what}} · **Time:** {{min}} / 60 min, plus {{min}} of [2nd user] steps ·
**Cost:** {{$}} / $1.50.

**The BRD as a deliverable** (Phase 9 full-scope BRD and J1.7's requirements-scoped BRD):

| Document | Answer key (#1041) | Sign-off (#1175) | Markdown | Word (`.docx`) | PDF |
|---|---|---|---|---|---|
| Full-scope BRD (Phase 9) | coverage · accuracy · hallucinations · sections | SO1 · SO2 · SO3 · SO4 | | opened? headings match? | opened? headings match? |
| J1.7 BRD (5 requirements) | – (requirements-scoped) | SO1 · SO2 · SO3 · SO4 | | | |

### Journeys (wave F)

| Journey | Completed in the UI? | Where it broke | Data lost between steps | Time / budget | Cost / budget |
|---|---|---|---|---|---|
| 1 Business analyst (Priya) | | | | / 60 min (45 before #1177) | / $1.50 |
| 2 Developer (Dev) | | | | / 30 min | / $1.00 |

Steps the UI could not do (each a finding): {{J1.n: missing control · …}}.

### Developer smoke test

Spec Kit smoke set: S2 {{✅}} · S4 · S6 · S7 · S21. Optional S-steps run (because a fix named
them): {{S6b · …}}; the rest ⏭. Wave E requests: #4478 {{impact / chat / plan}}, #4386
{{…}}; optional requests run: {{none}}. Wave G: {{ran (#4478, builds yes/no) / skipped: no Spec
Kit or impact change since `<sha>`}}.

### Fixes since the previous run, re-verified

From the run's `fixes.json` (`scripts/walkthrough/fixes-since.mjs`, scope posted on #706 before
wave A), with each verdict as recorded in `run.json`. **Confirmed {{n}} of {{m}}**; carried
forward from the previous run: {{n}}.

| Fix | PR | Wave / phase | Verdict | Evidence (step id) |
|---|---|---|---|---|
| #… | #… | | ✅ confirmed / ⚠️ partial / ❌ regressed / – not-exercised | |

### Per-phase evidence

| Phase | Wall time | Input tok | Output tok | Cache-read tok | Cost | Console errors | Works | Useful | Key findings |
|---|---|---|---|---|---|---|---|---|---|
| Setup + 1 Project | | | | | | | | | |
| 2 Repo connector | | | | | | | | | |
| 3 Ingest / RAG | | | | | | | | | |
| 4 Overview / scan | | | | | | | | | |
| 5 DB + lineage | | | | | | | | | |
| 6 Import / Jira / TM | | | | | | | | | |
| 7 Analysis / agents | | | | | | | | | |
| 8 Requirements / trace | | | | | | | | | |
| 9 Docs | | | | | | | | | |
| 10 Chat | | | | | | | | | |
| 11 Discussions | | | | | | | | | |
| 12 Publishing | | | | | | | | | |
| 13 Drift / scheduler / tasks | | | | | | | | | |
| 14 Spec Kit (smoke set S2, S4, S6, S7, S21; was S1–S24 to run 9) | | | | | | | | | |
| 15 PR review / change | | | | | | | | | |
| 16 Impact (#4478, #4386; six requests in runs 7 to 9) | | | | | | | | | |
| 17 Tested by | | | | | | | | | |
| 18 Usage / cost | | | | | | | | | |
| 19 Settings | | | | | | | | | |
| 20 Admin | | | | | | | | | |
| BA re-ask (API) | | | | | | – | | | |
| F Journeys (UI only) | | | | | | | | | |

Mark a removed phase `removed (#…)` rather than deleting its row, so the comparison stays aligned.

**Total spend:** {{tokens}} / ${{usd}} — `token_usages` {{…}}, `ai_token_usages` {{…}}.
Exact cost = (in × 0.30 + out × 1.20 + cacheRead × 0.006) / 1e6 USD at peak prices.
Lineage edges (reads + writes): {{…}}.

### Tally

- **Works:** {{n}} pass · {{n}} partial · {{n}} fail · {{n}} blocked
- **Useful:** {{n}} pass · {{n}} weak · {{n}} fail · {{n}} n/a

### Acceptance criteria (from #706)

- [ ] Playwright headed and connected; `/dashboard` screenshot captured
- [ ] `deepseek-flash`, `jsonSchema:false`; no Unpriced usage at project scope
- [ ] Pinned at `v2.3.3` (`c4d54f87`) and fully ingested; embeddings are not the hash stub
- [ ] Phases 1–20 each run, with a verdict (blocked ones with reasons)
- [ ] Spec Kit smoke set (S2, S4, S6, S7, S21) each have a verdict; other S-steps have one or read ⏭
- [ ] `/specify` and `/plan` grounded with K > 0
- [ ] 8/8 BA questions; at least 6 correct with valid citations
- [ ] Journeys 1 and 2 each scored on completed, no data lost, and within budget
- [ ] J1.4a to J1.4c each have a verdict and say how the second user ran
- [ ] BRD Word and PDF fetched by URL and opened; sign-off lines for both BRDs; J1.8a run or skipped with #1176
- [ ] 2/2 developer requests (#4478, #4386) with impact, plan, sandbox draft and per-request ledger delta; #4478 surfaces `MarkAllAsReadBeforeDate`
- [ ] Wave G ran, or skipped with an empty Spec Kit / impact diff since the previous run
- [ ] Nothing published, commented or reviewed on `miniflux/v2` (`gh search issues/prs --repo miniflux/v2 --author <user>` → `[]`)
- [ ] Per-phase token/cost table posted; total within budget
- [ ] Every failure filed as its own issue

### Run-to-run comparison

**Comparable after the reshape?** (#1177, from run 10). "No" means the number moved because the
run's shape changed, not because METIS did: report it, but do not read its delta against runs 1
to 9 as a regression or an improvement. "Per request" means compare #4478 and #4386 with their
own earlier rows, never the totals.

| Measure | Run 2 baseline | Run {{N}} | Delta | Comparable with runs 1 to 9? |
|---|---|---|---|---|
| Works: pass / partial / fail / blocked | 11 / 6 / 1 / 2 | | | No: fewer Spec Kit and impact steps, new J1 steps |
| Useful: pass / weak / fail / n/a | 5 / 4 / 9 / 2 | | | No: as above |
| BA questions answered correctly | 8/8 (after #783) | | | Yes |
| Developer-issue impact | 0/3 (#791) | | | No as a total (N/2 from run 10, N/6 runs 7 to 9, N/3 before): per request only |
| Impact edit candidates: file precision / recall | – (runs 1 to 7 scored both lists together) | | | Per request (#4478, #4386) |
| Impact blast radius: file recall (recall only, #1073) | – | | | Per request |
| Impact blast radius: files / functions listed (`listed`: a count, not a score; `listed - tp` is the old rule's `fp`) | – | | | Per request |
| Total tokens | ≈ 11.2M (10.81M + 0.39M) | | | No: four fewer requests, most S-steps and often wave G skipped |
| Total cost | ≈ $5.77 (557¢ + 19.7¢) | | | No: as above |
| Docs-gen share of spend | 80% (8.86M tok / 485¢) | | | No: the denominator shrank |
| Lineage reads/writes edges | 1,436 | | | Yes |
| Repo connector Go files ingested | 421 / 421 | | | Yes |
| Docs-gen: largest document / longest section (chars) | – (run 3 BRD: 2.19 MB) | | | Yes |
| Docs-gen: BRD sign-off rubric SO1 / SO2 / SO3 / SO4, and main part / whole body (chars, `wc -m`) (TEST_PLAN Phase 9, #1175) | – (run 9: 247,171 chars, no main part) | | | Yes |
| J1.7 BRD sign-off rubric SO1 / SO2 / SO3 / SO4 | – | | | Yes (scored since #1175) |
| BRD Word / PDF open with matching headings (Phase 9 and J1.7) | – (never exercised before run 10) | | | New in run 10 |
| J1 two-user steps (J1.4a to J1.4c): pass / weak / fail / blocked, and how the second user ran | – (the classifier refused it in runs 8 and 9) | | | New in run 10 |
| J1 wall time / budget | – (run 8: 43 of 45 min) | | | No: budget 60 min from run 10, and the new steps add time |
| Docs-gen: any run stopped by a cost or token ceiling | – | | | Yes |
| Promoted requirements with zero acceptance criteria | – | | | Yes |
| Promoted requirements with no code link | – | | | Yes |
| API-only steps left in the briefs (no UI caller) | – | | | No: optional S-steps are not counted unless they ran |
| Wave G build proof | – | | | Only when it ran in both runs |

Per phase (run 2 values from its re-run table; "ai ledger" = `ai_token_usages` only). From run
10 (#1177):

- **Not comparable:** Phase 14 (the smoke set, not S1–S24) and Phase 16 (two requests, not six).
- **Comparable with a caveat:**
  - **Phase 9.** Its Works bar is stricter: "export downloads" became "each export answers 200,
    and the Word and PDF files open with the markdown's headings". A move from ✅ to ⚠️ can come
    from the new bar rather than from METIS: say which check caused it.
  - **Phase 11.** Its second-user checks (mentions, presence, no Edit on another user's message)
    may be recorded as covered by J1.4b and J1.4c, and run operator-side. Say where each was
    observed, and treat a Phase 11 verdict built on J1's evidence as not comparable with runs 1
    to 9 on its own.
- **Comparable:** every other phase.

| Phase | Run 2 Works / Useful | Run 2 tokens / cost | Run {{N}} Works / Useful | Run {{N}} tokens / cost | Delta |
|---|---|---|---|---|---|
| Setup + 1 Project | ✅ / ⚠️ | 0 / 0 | | | |
| 2 Repo connector | ✅ / ✅ | 0 / 0 | | | |
| 3 Ingest / RAG | ✅ / ❌ | 0 / 0 | | | |
| 4 Overview / scan | ❌ / ⚠️ | 276k / 18¢ | | | |
| 5 DB + lineage | ✅ / ❌ | 0 / 0 | | | |
| 6 Import / Jira / TM | 🚫 / – | 0 / 0 | | | |
| 7 Analysis / agents | ✅ / ❌ | 588k / ~33¢ | | | |
| 8 Requirements / trace | ✅ then data loss / ❌ | 131k / ~12¢ | | | |
| 9 Docs | ⚠️ / ⚠️ | 8.86M / 485¢ | | | |
| 10 Chat | ✅ / ❌ (2/6) | 773k / 10¢ | | | |
| 11 Discussions | ❌ / ❌ | ~7k (not in ledger) / ~0.9¢ | | | |
| 12 Publishing | ⚠️ / ✅ | 3k / 0 | | | |
| 13 Drift / scheduler / tasks | ✅ / ✅ | 0 / 0 | | | |
| 14 Spec Kit | ⚠️ / ⚠️ | 183k / 14¢ | | | |
| 15 PR review / change | 🚫 / – | 0 / 0 | | | |
| 16 Impact | ✅ / ❌ (0/3) | 50k (ai ledger) / 1.8¢ | | | |
| 17 Test coverage | ⚠️ / ❌ | 96k (ai ledger) / 6¢ | | | |
| 18 Usage / cost | ⚠️ / ❌ | 0 / 0 | | | |
| 19 Settings | ✅ / ✅ | 0 / 0 | | | |
| 20 Admin | ✅ / ❌ | 0 / 0 | | | |

### Sandbox publishes

Only `openzigs/flux-v2`, dry run first, at most 2: {{issue URLs}}

### Findings

New this run: {{#… · #…}}. Fixed since run 2 and confirmed: {{#…}}.
Fixed-but-open issues closed on this run's evidence (skill section 8): {{#…}}.

### Durable findings

{{Every `Durable finding:` line the wave agents returned, for the next run's runbook update.}}
