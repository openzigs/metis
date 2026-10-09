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
🚫 blocked (give the reason) · – n/a.

---

## Walkthrough results: run {{N}} ({{DATE}})

**Setup.** `miniflux/v2` @ `v2.3.3` (`c4d54f87`), METIS `main` @ `{{METIS_SHA}}`, DeepSeek
`deepseek-flash` via the Anthropic-compatible endpoint ({{PEAK_OR_OFF_PEAK}} prices), SQL-lineage
sidecar, project `{{PROJECT_ID}}` in workspace `{{WORKSPACE_ID}}`. Ledger: `token_usages` only
(since #792 and #854; never summed with `ai_token_usages`).

Phases removed since run 2: {{e.g. Phase 4 bug scan (#799); Phase 17 test coverage → "Tested by" (#812)}}.

### Fixes since the previous run, re-verified

From the run's `fixes.json` (`scripts/walkthrough/fixes-since.mjs`, scope posted on #706 before
wave A), with each verdict as recorded in `run.json`. **Confirmed {{n}} of {{m}}**; carried
forward from the previous run: {{n}}.

| Fix | PR | Wave / phase | Verdict | Evidence (step id) |
|---|---|---|---|---|
| #… | #… | | ✅ confirmed / ⚠️ partial / ❌ regressed / – not-exercised | |

### Journeys (wave F)

| Journey | Completed in the UI? | Where it broke | Data lost between steps | Time / budget | Cost / budget |
|---|---|---|---|---|---|
| 1 Business analyst (Priya) | | | | / 45 min | / $1.50 |
| 2 Developer (Dev) | | | | / 30 min | / $1.00 |

Steps the UI could not do (each a finding): {{J1.n: missing control · …}}.

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
| 14 Spec Kit (S1–S24) | | | | | | | | | |
| 15 PR review / change | | | | | | | | | |
| 16 Impact | | | | | | | | | |
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
- [ ] Spec Kit S1–S23 each have a verdict; every artifact and every `SPECKIT_COMMANDS` entry invoked
- [ ] `/specify` and `/plan` grounded with K > 0
- [ ] 8/8 BA questions; at least 6 correct with valid citations
- [ ] Journeys 1 and 2 each scored on completed, no data lost, and within budget
- [ ] 3/3 developer issues with impact, plan and sandbox draft; #4478 surfaces `MarkAllAsReadBeforeDate`
- [ ] Nothing published, commented or reviewed on `miniflux/v2` (`gh search issues/prs --repo miniflux/v2 --author <user>` → `[]`)
- [ ] Per-phase token/cost table posted; total within budget
- [ ] Every failure filed as its own issue

### Run-to-run comparison

| Measure | Run 2 baseline | Run {{N}} | Delta |
|---|---|---|---|
| Works: pass / partial / fail / blocked | 11 / 6 / 1 / 2 | | |
| Useful: pass / weak / fail / n/a | 5 / 4 / 9 / 2 | | |
| BA questions answered correctly | 8/8 (after #783) | | |
| Developer-issue impact | 0/3 (#791) | | |
| Total tokens | ≈ 11.2M (10.81M + 0.39M) | | |
| Total cost | ≈ $5.77 (557¢ + 19.7¢) | | |
| Docs-gen share of spend | 80% (8.86M tok / 485¢) | | |
| Lineage reads/writes edges | 1,436 | | |
| Repo connector Go files ingested | 421 / 421 | | |
| Docs-gen: largest document / longest section (chars) | – (run 3 BRD: 2.19 MB) | | |
| Docs-gen: any run stopped by a cost or token ceiling | – | | |
| Promoted requirements with zero acceptance criteria | – | | |
| Promoted requirements with no code link | – | | |
| API-only steps left in the briefs (no UI caller) | – | | |

Per phase (run 2 values from its re-run table; "ai ledger" = `ai_token_usages` only):

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
