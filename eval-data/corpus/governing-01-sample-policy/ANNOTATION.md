# How the governing-rules set was written and labelled (#1867)

> **This is the tuning set (since #2024).** The applicability judge prompt was tuned on it in
> #1997, #2005 and #2050, so it is no longer held out (`purpose: "tuning"`). Iterate prompts here,
> with DeepSeek. Decisions are read on the held-out set,
> `governing-02-clinic-records`, which no prompt has been tuned on. Its `ANNOTATION.md`
> holds the rule and the log of its readings.

## Who wrote it, and in what order

**The policy, the requirements and the labels were all written by an AI coding agent
(`claude-opus-5-5`) dispatched on issue #1867, not by a person.** No person has reviewed
the labels yet (`annotation.reviewedBy` is `null` in `manifest.json`). Until someone does,
treat every number this set produces as a reading against one annotator's judgement.

The steps ran in this order, in one session on 2026-11-06:

1. **The policy was written for this fixture.** `policy-v1.md` is the information handling
   policy of Harbor Lane Outfitters, a fictional retailer: 40 atomic obligations across
   access control, audit logging, data retention, encryption, change management, vendor
   management and privacy. They are SOC 2-*style* in subject only. The wording is
   original. No AICPA Trust Services Criteria text was opened, read or copied: the TSC is
   copyrighted. The loader fails on a TSC criterion id (`CC6.1`, `PI1.2`, …) or the
   criteria's recurring phrase "the entity's objectives" in any policy revision
   (`trustServicesCriteriaMarkers`, `server/src/lib/eval/governing/corpus.ts`).
2. **`policy-v2.md` revises four clauses** of v1 (AC-05 quarterly → monthly access
   review, AL-04 monthly → weekly alert review, DR-04 twelve → six months for call
   recordings, VM-04 seventy-two → forty-eight hours for supplier incident notice). The
   loader checks that v2 changes exactly the clauses `changedRules` lists. **Every label
   is against v1** (`policy.scored`). v2 is there for the revision work later in epic
   #1866.
3. **Each rule got a one-line summary** (`rules[].summary`): the summary an extraction
   step would produce. Arms A1 and A2 read these summaries.
4. **36 requirements were written in business language**, then labelled against v1:
   30 where at least one rule applies, and 6 negative items where none does. A
   requirement names no rule id and copies no five-word run from any clause. The loader
   enforces both.
5. **The pass thresholds were written into the manifest** (`thresholds`).
6. **Only then was any arm run.** The ground truth and the thresholds were fixed before
   the A0 baseline (`baseline-A0.{json,md}`) was measured. Neither was changed after it.

One change was made to the policy after the first A0 runs, and it is recorded here. The
first version of the policy opened with a sentence saying it was a synthetic fixture for
this evaluation, and the model quoted that sentence back in its notes. The policy reaches
every arm's prompt, so it must read as the company's own document. The sentence was
replaced with plain policy prose in both revisions; no clause, label or threshold changed.
Those runs were discarded and the baseline was measured again. The loader now refuses a
policy revision that says "fixture", "synthetic", "evaluation", "METIS" or an issue
number (`evaluationLeaks`).

## Verdicts

Each (requirement, rule) pair in `applies` carries one verdict:

| Verdict | When |
|---|---|
| `compliant` | The requirement, as written, explicitly provides what the rule asks (GR-17 asks for an authenticator code on back-office sign-in, which is what AC-02 asks for). |
| `gap` | The requirement, built as written, would breach the rule (GR-15 keeps call recordings for two years; DR-04 allows twelve months). |
| `needs-ba-input` | The rule applies, the requirement is silent or ambiguous on it, and one business fact settles it. The fact is recorded as the question a BA would answer (`businessFact`). |

Silence is never `compliant`. The scorer counts a `compliant` answer on a `gap` or
`needs-ba-input` pair as a **hard error**, not a near miss.

## Labelling conventions

- **A rule is labelled only when an independent reader would agree it applies.** Rules a
  stretch reading could attach (least privilege on almost any new screen, for example)
  are left off, so precision is not punished for a label nobody would defend.
- **New supplier receiving personal information:** VM-01 (review and agreement) and
  VM-05 (the supplier register) are labelled together wherever an outside company
  starts receiving personal information (GR-06, GR-09; VM-01 only on GR-30, where the
  file is payroll and the register question did not arise in the text).
- **Negative items** (GR-31 to GR-36) change only how the shop looks or what product
  information it shows. None touches personal, payment or financial data, access, or a
  production change process.

## Short-answer pairs (#2033)

Seven `needs-ba-input` pairs carry the short answer a BA would give to their
`businessFact` (`baAnswer`) and the verdict that answer leads to (`answeredVerdict`).
`pnpm eval:governing` replays each answer into the findings arm and scores the finding
after it against `answeredVerdict`, in its own row of the report. The pair's own verdict
stays `needs-ba-input`: the answer is what a BA would supply, not what the requirement says.

| Pair | Answer | Verdict once answered |
|---|---|---|
| GR-06 → VM-01 | "Yes, it has." | `compliant` |
| GR-08 → PR-05 | "No." | `gap` |
| GR-09 → EN-01 | "Yes, it is." | `compliant` |
| GR-11 → DR-06 | "No." | `compliant` |
| GR-14 → AL-06 | "No." | `gap` |
| GR-20 → CM-02 | "No." | `gap` |
| GR-21 → CM-03 | "Yes, there is." | `compliant` |

**GR-11 is the polarity case.** Its question asks whether the purge will ever delete an
email under a legal hold, so "No." *meets* DR-06.

#2041 reworded the question. It used to read "Are any of those emails part of a dispute or
lawsuit the legal team has asked us to preserve?". Against that wording the `compliant`
label was contestable. GR-11 is a purge that recurs every January, and DR-06 binds
whenever a hold exists, "until the hold is lifted". A "No." in the present tense says only
that nothing is held today. So two readings were open:
- `compliant`: nothing is held, so this purge destroys nothing DR-06 protects;
- `gap` or `needs-ba-input`: the requirement purges *every* email older than two years,
  with no check for a hold, so a hold raised before a later January would be breached.

The new wording asks about every purge, and "No." now rules out the second reading.
Polarity stays as before: "No." meets the rule. This is the only polarity case that #2038
tunes on, so the label had to be settled before #2038 iterates. Every other question here asks whether the rule is
met, so "Yes" meets it. A prompt line about answer polarity is iterated against
this row, on this set only, never on `governing-02` (#2033). The answers and their verdicts were written in #2033 by
a `claude-opus-5-5` session that had read the findings prompt, so they are not blind to
it. This set is the tuning set, so that matters less here than it would on `governing-02`.

### #2038: a polarity line, tried and dropped

Read on 2026-11-08 with arm A4 on `anthropic/deepseek-flash` (DeepSeek's
Anthropic-compatible endpoint), after #2041's GR-11 rewording. Each condition is three
`--runs 1` invocations at `--concurrency 14`: one three-run invocation takes longer than a
ten-minute command allows.

The candidate line, added to the findings prompt (`SYSTEM` in
`server/src/lib/governing/findings.ts`) after "Silence is never compliant":

> A short answer means what it says about its question: read the question first. "No." to
> a question about a risk the rule forbids can show the rule is met, and "Yes." can show
> it is not.

| Reading | Short-answer accuracy | Given a verdict | Compliant against the label | Main verdict accuracy | Main hard errors | Precision | Recall | Failures | Spend |
|---|---|---|---|---|---|---|---|---|---|
| Baseline (no line) | 4/7, 4/7, 4/7 | 4/4/4 | 0 | 0.54 / 0.51 / 0.49 | 0/0/0 | 0.50 / 0.54 / 0.51 | 0.90 / 0.90 / 0.90 | 0/0/0 | $1.45 |
| With the line | 4/7, 4/7, 4/7 | 4/4/4 | 0 | 0.56 / 0.56 / 0.46 | 0/0/1 | 0.59 / 0.54 / 0.56 | 0.90 / 0.90 / 0.85 | 0/0/1 | $1.53 |

**Dropped.** The short-answer row did not move, and one run gained a hard error in the
main row (GR-06 → VM-03 `compliant`). The run that failed GR-30 failed in applicability
("the judging reply could not be read twice"), which the line does not reach.

The row could not move on this set through the findings prompt. Every pair that reaches
the findings call was already right in all six runs, GR-11's "No." → `compliant`
included: 12 of 12 per condition, none read the wrong way round. The three misses
(GR-09 → EN-01, GR-20 → CM-02, GR-21 → CM-03) were misses in every run of both
conditions because applicability never listed the rule as applying or possibly applying.
So no question was asked and no answer reached the findings call. Raising this row
is an applicability-recall problem, not a polarity one.

### #2050: the applicability judge, not the screen, dropped EN-01, CM-02 and CM-03

Read on 2026-11-08 with arm A4 on `anthropic/deepseek-flash`, the same setup as #2038.

**The cause was the judging prompt.** The rule summaries, the requirement text and the
top-k cut-off were not the cause. A probe ran production applicability on each
requirement and printed every candidate with how it was found. It showed that the
summary screen put EN-01, CM-02 and CM-03 in front of the judge in every run. The judge
then decided `does-not-apply` each time, for these reasons:

- GR-09 → EN-01: "General encryption in transit is a platform baseline rather than the
  subject of this courier handover requirement." The platform-wide line excepted "a new
  copy handed to an outside party, a new supplier". The judge did not read a new
  booking-system connection as either one.
- GR-20 → CM-02: "The requirement changes deployment approval, not whether changes are
  tested outside production."
- GR-21 → CM-03: "The requirement does not call for a documented undo path for a
  production change."

The same judge applied CM-01 to CM-03 to a button recolour (GR-31) and a menu rename
(GR-36), because each is "a change going live". So the change rules were read the wrong
way round in both directions. GR-06 → VM-05 was lost the same way ("a standing
vendor-management obligation"). Two changes were made to `JUDGE_SYSTEM` in
`server/src/lib/governing/applicability.ts`:

1. The platform-wide line now names which new thing brings in which rule. A new place
   the data is kept brings in the storage rules. A new connection or copy that sends
   personal information to an outside company brings in encryption in transit. A new
   supplier brings in that supplier's review and its register entry.
2. A new line covers change management. Every requirement is a change that will reach
   production, and that alone does not bring in the change rules. They apply when the
   requirement itself sets how, when or by whom changes reach production. Then each of
   them applies, including the ones the requirement does not mention.

A first candidate tried a general line instead ("never decide does-not-apply only
because the requirement does not ask for what the rule requires"). In one probe it
missed four rules again, as the baseline did, and added change rules to a third negative
item. It was not kept.

Each condition below is three `--runs 1` invocations at `--concurrency 14`. The baseline
is `main`'s prompt at 003c8c028:

| Reading | Short-answer accuracy | Given a verdict | Compliant against the label | Main verdict accuracy | Main hard errors | Precision | Recall | Non-resembling recall | Clean negatives | Failures | Spend |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Baseline | 3/7, 4/7, 4/7 | 4/4/4 | 0 | 0.56 / 0.49 / 0.46 | 0/0/0 | 0.53 / 0.51 / 0.55 | 0.90 / 0.87 / 0.87 | 0.87 ×3 | 4/3/4 of 6 | 0/0/0 | $1.42 |
| Both changes | 7/7, 7/7, 6/7 | 7/7/6 | 0 | 0.51 / 0.44 / 0.49 | 0/0/0 | 0.60 / 0.56 / 0.62 | 1.00 / 0.95 / 0.92 | 1.00 / 0.93 / 0.80 | 6/6/6 of 6 | 0/0/1 | $1.50 |

**Kept.** EN-01, CM-02 and CM-03 now reach the findings call in every run. The main row
gains recall and precision, every negative item is clean, and hard errors stay at 0.
Main verdict accuracy is within run-to-run noise: means 0.48 against 0.50, on 36 items
whose bootstrap intervals span about 30 points. Most of the wrong verdicts in both
conditions are the findings call answering `gap` where the label is `needs-ba-input`,
which this change does not reach.

The one failure is GR-06 in the third run: "the judging reply could not be read twice
running for 25 candidate rule(s)". It cost that run its three GR-06 pairs, which is why
that run's non-resembling recall is 0.80. A probe repeated GR-06's applicability eight
times. One judging reply stopped at `max_tokens` after 16,384 output tokens, most of
them DeepSeek's reasoning, and was cut off mid-JSON. The others used 7,800 to 13,000 of
the same budget. The same failure came up once in #2038's readings, on GR-30, with this
prompt unchanged. So it predates this change.

**Polarity is still unexercised.** Every pair that reached the findings call was read
the right way round, 20 of 20. That includes GR-20's "No." → `gap`, newly reached, and
GR-11's "No." → `compliant`. No short answer was misread, so #2038's polarity line was
not re-tried.

### #2053: a judging reply cut off at the output cap

The GR-06 and GR-30 failures above were judging replies stopped at `max_tokens`. A judging
batch whose reply is cut off at the output cap is now judged again in halves, down to one rule,
instead of being re-asked whole into the same cap. A reply that ends normally is handled as
before, so nothing else in this set's readings can move.

No DeepSeek key was available, so the failure was reproduced on `claude-sonnet-5-5` with the
judging call's output cap forced down to 700 tokens. Uncapped, Sonnet judges GR-06's and
GR-30's 13 candidates in 938 and 1,239 tokens. The probe ran `decideApplicability` with the
whole rule set, the screen on and top-k off, twice per requirement, on 2026-11-09:

| | GR-06 | GR-30 |
|---|---|---|
| Before | failed 2 of 2: both asks `max_tokens` at 700 | failed 2 of 2, the same way |
| After | decided 2 of 2: 12 rules cut off, then 6 + (6 cut off → 3 + 3) | decided 2 of 2: 14 rules cut off, then 7 + (7 cut off → 4 + 3) |

GR-06's `applies` set after the split was the uncapped one: AL-02, EN-01, EN-05, VM-01, VM-03
and VM-05. A DeepSeek A4 reading on this set is still owed. It would confirm that DeepSeek's
cut-off replies are now decided, and that the main row's hard errors stay at 0.

### #2059: the shipped path asks a Needs BA input finding on a rule that applies

Read on 2026-11-09 with arm **A5** (the shipped path) on `anthropic/deepseek-flash`. There
were three `--runs 1` invocations at `--concurrency 14` at `150488f1a`, which has #2059's
routing. There was also one baseline invocation at `main`'s `054dc036e`, without it. The
first reading, before any answer, runs the same code in both, so only the dialog can differ.

| Reading | Short-answer accuracy | Answer reached the findings call | Questions asked | From a finding on a rule that applies | Main verdict accuracy | Hard errors | Precision | Recall | Failures | Spend |
|---|---|---|---|---|---|---|---|---|---|---|
| Baseline (`main`) | 3/7 | 0 of 7 | 2 | (not asked) | 0.41 | 0 | 0.63 | 0.95 | 0 | $0.50 |
| #2059 | 3/7, 3/7, 3/7 | 0 of 21 | 3 / 3 / 3 | 2 / 2 / 2 | 0.54 / 0.49 / 0.51 | 0/0/0 | 0.62 / 0.60 / 0.62 | 0.97 / 0.95 / 0.92 | 0/0/1 | $1.48 |

**The route works here, but this set cannot score it.** In every run, both questions about
GR-09's VM-01 and VM-05 came from Needs BA input findings on rules that apply. Neither
pair has a recorded answer, so both went unanswered. The short-answer row did not move,
and could not on this model. Before any answer, DeepSeek's findings call read all seven
short-answer pairs `gap`, in 20 of 20 verdicts (GR-06 failed once in applicability). The
label before the answer is `needs-ba-input`, so no question was owed and no answer
reached the findings call. That is the findings call's `gap`-for-`needs-ba-input` habit
recorded under #2050. Routing does not reach it.

The one failure, GR-06 in the third run, is #2050's: "the judging reply could not be read
twice running for 32 candidate rule(s)". The main-row differences are within run-to-run
noise; the first reading is the same code in both conditions.

So whether #2059 moves the short-answer row could only be read where the findings call
gives `needs-ba-input` on these pairs. That is `claude-sonnet-5-5` on `governing-02`, where
the gap was measured. That reading is recorded in that set's `ANNOTATION.md`.

### #2066: a question the merge leaves alone keeps its own words

Read on 2026-11-09 with arm **A5** on `anthropic/deepseek-flash`: one `--runs 1`
invocation at `--concurrency 14` at `17d31716d`, clean tree, $0.45. `mergeFacts` now
keeps a single-member group's own question text; only a group of two or more takes the
model's wording.

| Reading | Short-answer accuracy | Answer reached the findings call | Questions asked | Main verdict accuracy | Hard errors | Precision | Recall | Non-resembling recall | Failures |
|---|---|---|---|---|---|---|---|---|---|
| #2066 | 3/7 | 0 of 7 | 6 | 0.51 | 0 | 0.59 | 0.97 | 0.93 | 0 |

One requirement had two distinct facts and so went through the merge: GR-20's CM-04
and CM-06 questions stayed apart and each was asked in its own fact's words. As under #2059, DeepSeek's
findings call read all seven short-answer pairs `gap` before any answer, so no question
linked a pair with a recorded answer and the row could not move. The main row is the
first reading, before any answer, which this change does not reach; it is within
run-to-run noise of #2059's.

No Sonnet reading of `governing-02` was taken. The pass bars are read on the findings
before any answer, which question wording cannot change, so the change cannot move
#1878's decision.

### #2067: the settle judge is told that a safeguard in place still applies

The re-judging of an answered question now carries `ANSWER_NOTE`. An answer that a rule's
safeguard is in place means the rule applies, and the findings call decides compliance. Only
an answer that the rule's subject is absent means `does-not-apply`. The first judging is
unchanged. The defect was seen on `governing-02` (KV-02 → TP-01, #2065). Per #2033 the
prompt was not tuned there, and no wording from that set was used.

**A probe of the settle call alone, on this set's rules**, run 2026-11-09. Each line is one
requirement, one linked rule, the question and the answer, judged with and without the note.
It covers the three short-answer pairs answered "yes" (with their own `businessFact`) and
three harder wordings that frame the safeguard as already covering the requirement:

| Case | Model | Without the note | With it |
|---|---|---|---|
| GR-06 → VM-01, GR-09 → EN-01, GR-21 → CM-03, own question, "yes" | `deepseek-flash` | 12 of 12 `applies` | 12 of 12 `applies` |
| the same | `claude-sonnet-5-5` | 9 of 9 `applies` | 9 of 9 `applies` |
| the three "already covered" wordings, "Yes, we do." / "Yes, they handle that." | `claude-sonnet-5-5` | 9 of 9 `applies` | 9 of 9 `applies` |
| a synthetic receipt requirement, VM-01, "No, the receipt is generated and shown by our own checkout." | both | 6 of 6 `does-not-apply` | 6 of 6 `does-not-apply` |
| GR-06 → VM-01, "No, we send the questionnaire ourselves; nothing leaves our systems." | `deepseek-flash` / `claude-sonnet-5-5` | 1 of 4 / 0 of 3 `does-not-apply` | 4 of 4 / 3 of 3 `does-not-apply` |

So on this set the defect does not reproduce. Neither model rules out a rule on a "safeguard
in place" answer without the note, and the note costs no `applies`. The one change is the
last row, where the answer contradicts the requirement (GR-06 does send the list to
SurveyCo). With the note, the judge follows the answer. Production settles only `uncertain`
pairs, where the requirement leaves the fact open, so a contradiction like this should be
rare. It is the case to watch.

**A5 on `anthropic/deepseek-flash`**: one `--runs 1` invocation at `--concurrency 14` at
`afaa7a768`, clean tree, $0.47.

| Reading | Short-answer accuracy | Settled by the judge | Recorded on a rule that applies | Main verdict accuracy | Hard errors | Precision | Recall | Non-resembling recall | Failures |
|---|---|---|---|---|---|---|---|---|---|
| #2067 | 4/7 | 0 | 1 | 0.56 | 0 | 0.66 | 0.97 | 0.93 | 0 |

The changed call did not run in this reading. The one answer given (GR-06 → VM-01, "Yes, it
has.") went to a finding on a rule that applies, was recorded without a judging call, and
the finding became `compliant`. That is why the row reads 4/7 against #2059's 3/7. In
#2059's runs, DeepSeek's findings call read that pair `gap` before any answer, so it was
never asked. No `uncertain` pair with a recorded answer was asked, so the settle judge was
never called. The main row is the first judging, which this change does not touch, and it
is within run-to-run noise.

### #2078: an answer that contradicts the requirement's text

The settle judge's note now says that the requirement's own text wins over an answer that
denies it: the rule applies, and the reason names the contradiction. `does-not-apply` needs the
rule's subject absent from the text as well as from the answer. The note also moved before the
reply-format line, which stays last.

**A probe of the settle call alone** (`rejudgeAnswered`, the production path) on this set's
VM-01, run 2026-11-09. Each row is one requirement, the question and the answer, judged with
the prompt before and after the change:

| Case | Model | Before | After |
|---|---|---|---|
| GR-06, "Will SurveyCo receive any of the buyers' personal details?", "No, we send the questionnaire ourselves; nothing leaves our systems." | `claude-sonnet-5-5` / `deepseek-flash` | 3 of 3 / 4 of 4 `does-not-apply` | 3 of 3 / 4 of 4 `applies`, each reason naming the contradiction |
| a synthetic receipt requirement, "Will an outside company produce or send the receipt?", "No, the receipt is generated and shown by our own checkout." | both | 7 of 7 `does-not-apply` | 7 of 7 `does-not-apply` |
| GR-06, its own question, "Yes, it has." | both | 7 of 7 `applies` | 7 of 7 `applies` |

The note's example is this set's GR-06 case, so the first row is a reading on the case the
wording was written for and is optimistic. The question in it is not one of the manifest's
`businessFact`s. No A5 reading has been taken since the change.

## The non-resembling subset

A pair labelled `nonResembling` is one where the rule applies although the requirement
shares no vocabulary with it: "download last month's invoices" (GR-01) and the audit
rule on bulk extraction of financial records (AL-02). 11 items carry at least one such
pair (the issue asks for at least 8). The loader checks each one: the requirement's title
and text may share no word stem with the rule's clause **or** its summary
(`sharedVocabulary`: words of four letters or more, stop words removed, cut to their
first five letters, so "records" meets "recorded" and "finance" meets "financial"). It is
a surface check. A synonym ("download" for "extraction") still passes, which is the
point of the subset.

## Limits to state plainly

- One annotator, and it wrote both sides: the same agent wrote the policy and the
  requirements, so its labels may follow its own reading of each clause more closely
  than an outside reader's would.
- 36 items is small. At this size a gap between two arms needs roughly 20 points or
  more to be significant; the report states the bar with every comparison.
- The thresholds are a **proposal** (`thresholds.status`). A later issue may change them
  only by appending to `thresholds.changes` with the issue, the date and the reason; the
  loader refuses a manifest whose values do not follow from the proposal and those
  recorded changes.
