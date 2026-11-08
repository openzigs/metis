# How the held-out governing-rules set was written and labelled (#2024)

## Why this set exists

`governing-01-sample-policy` is no longer held out. The applicability judge prompt was tuned
on it in #1997 and #2005, so a reading on it overstates how well the judge does. This set
was built from documents that no prompt has seen. It is the set #1878's flag decision is
read on. `governing-01` is now the **tuning** set (`purpose: "tuning"`), and this one is
the **held-out** set (`purpose: "held-out"`).

**The tuning rule: never iterate a prompt against this set.** Iterate on `governing-01`,
using DeepSeek. Read `governing-02` only for a decision. Record every reading of it under
"Readings" below, with the date, the issue, the arms and the model. The manifest records a
content hash (`contentHash`) of the policy, the rules and the labelled requirements. The
loader refuses the set if any of them changes without a new hash, so an edit made to fit a
prompt cannot pass unseen.

## Who wrote it, and in what order

**Everything here was written and labelled by AI agents (`claude-opus-5-5`), not by a
person.** No person has reviewed the labels (`annotation.reviewedBy` is `null`). Until
someone does, treat every number this set gives as a reading against two agreeing AI
labellers and an AI adjudicator. That is weaker evidence than human labels.

The steps ran in this order, in one session on 2026-11-08:

1. **Blind authoring.** The author was the coding agent dispatched on #2024. It did not open
   `server/src/lib/governing/**`, `server/src/lib/eval/governing/arms.ts`, any `baseline-*`
   file, or the #1867, #1997 and #2005 threads. Its dispatch rules said so. It read only the
   loader (`corpus.ts`), the runner and scorer, and `governing-01`'s `ANNOTATION.md`,
   which is the procedure. From `governing-01` it read the manifest's metadata, two rules,
   two requirements and the policy's first page, for the file format only.
2. **The policy was written for this set.** `policy-v1.md` is the patient records and
   clinical safety standard of Kestrel Vale Health Partners, a fictional network of
   community clinics. It has 40 atomic obligations in eight parts: knowing who the patient
   is, who may read a chart, consent and sharing, medicines, talking to patients, keeping
   records, incidents, and suppliers and devices. Harbor Lane, a retailer with a
   SOC 2-style information handling policy, differs in both domain and shape: this policy
   has a scope, defined terms and an exceptions clause, and most of its rules are clinical,
   not security controls. The wording is original. No AICPA Trust Services Criteria text was
   opened, read or copied. The loader's TSC-marker and evaluation-leak checks pass.
3. **`policy-v2.md` revises four clauses** of v1: MS-03 (repeat review from twelve months
   to six), CM-03 (reminders from forty-eight hours ahead to seventy-two), RK-04 (copy
   requests from thirty days to twenty-one) and IR-05 (information loss reports from four
   hours to two). **Every label is against v1** (`policy.scored`).
4. **Each rule got a one-line summary** (`rules[].summary`).
5. **36 requirements were written in business language.** 30 have at least one applicable
   rule, and 6 are negatives that change only the public website, the staff intranet or its
   look. None of them names a rule id or copies a five-word run from a clause.
6. **Labeller 1 (the author) labelled them** against v1. Its labels as first written are
   in `labelling/labeller-1.json`.
7. **Labeller 2 labelled them blind** (`labelling/labeller-2.json`). It was a separate
   `claude-opus-5-5` session, run through `claude -p` with every tool and every MCP server
   switched off, so it could read nothing but its prompt. That prompt
   (`labelling/labeller-2-prompt.txt`) held the policy, the 36 requirements, the three
   verdicts and the labelling rules. It held no label from labeller 1, no rule summary and
   no word about any arm or prompt. Cost: $0.13.
8. **Agreement was measured** (below). Every disagreement went to **a third pass**
   (`labelling/adjudication.json`, prompt in `labelling/adjudication-prompt.txt`). That
   pass was another tool-less `claude-opus-5-5` session. It was given the policy and each
   disputed pair, with the two labels shown as A and B in a seeded random order, and was
   not told who wrote which. It was told to favour neither and to answer "unsettled" rather
   than guess. It settled all nine pairs, each with a written reason, so none was dropped.
   Cost: $0.11.
9. **A consistency pass ran for each cross-cutting rule** (added after #2028's review). The
   adjudication only saw cells where the two labellers disagreed, so a rule both of them
   skipped on the same requirement was never checked. IR-04 is the clear case: it sat on
   KV-05, KV-31 and KV-34, whose adjudication reason is that the change alters what
   clinicians see, yet not on KV-15 (a one-click skip of the allergy screen) or KV-12 (a
   suppressed interaction pop-up), which fit the same wording. For each of IR-04, TP-04,
   CM-04, CM-02, CM-01 and RA-02, a tool-less `claude-opus-5-5` session was given the policy
   and all 36 requirements and asked about that one rule alone, on every requirement
   (`labelling/consistency-prompt.txt`). It saw no label, no rule summary and no arm.
   IR-04, CM-04 and TP-04, where the first pass disagreed with a standing label, were run
   twice. **A standing label changes only when both passes agree on the new one**; a cell
   the passes split on keeps its label. Cost: $0.69 for 9 sessions. Details, with each
   pass's labels, are in `adjudication.json` under `consistencyPass`.
10. **The business facts for the pairs added after the adjudication** (KV-05 and KV-34 under
    IR-04, and the eight pairs of the consistency pass) were written after each was decided.
11. **The pass thresholds were copied unchanged from `governing-01`**
    (`proposedIn: "#1867"`, `changes: []`) and fixed with `recordedBeforeAnyArmRan: true`.
    The content hash was then recorded, and re-recorded after the consistency pass (see
    "Content hash history").
12. **No arm has run on this set.** The labels and the thresholds were fixed first. The
    first reading belongs to #1878.

## Agreement between the two labellers

The two labellers were compared pair by pair, over every (requirement, rule) cell: 36 × 40
= 1,440 cells.

| Measure | Value |
|---|---|
| Pairs listed by labeller 1 / labeller 2 | 38 / 37 |
| Pairs either listed (the union) | 40 |
| Listed by both | 35, of which 31 had the same verdict |
| Applies / does not apply, Cohen's κ (before the consistency pass) | **0.93** (observed 0.9965, chance 0.9493) |
| Four-way label (none, compliant, gap, needs-ba-input), Cohen's κ | **0.88** (observed 0.9938, chance 0.9489) |
| Same label on the union of listed pairs | 31 of 40 (0.78) |
| Negative items both left empty | 6 of 6 |

κ is high partly because about 97% of the 1,440 cells are "does not apply" for both
labellers. **The union figure, 31 of 40 listed pairs (0.78), is the stricter reading, and
the one to quote.** Both labellers are the same model as the author, so neither figure is
independent human agreement. The figures describe the two labellers before the consistency
pass; the adjudication and that pass then changed the labels (below).

## Adjudications

| Pair | Labeller 1 | Labeller 2 | Decision | Reason (abridged from `adjudication.json`) |
|---|---|---|---|---|
| KV-01 → RA-01 | needs-ba-input | gap | needs-ba-input | A caller "ringing in" makes a care relationship; the text does not say whether wider access is limited to that or gated by RA-02. |
| KV-01 → RA-02 | needs-ba-input | gap | needs-ba-input | It opens "anyone registered" to covering doctors and is silent on the typed reason and the review. |
| KV-05 → IR-04 | does not apply | needs-ba-input | needs-ba-input | A screen that suggests a dose changes what clinicians see, and the text says nothing about a safety assessment. |
| KV-14 → CM-01 | needs-ba-input | does not apply | needs-ba-input | The app lists every test outcome, and the text does not say whether they wait for the clinician's review. |
| KV-19 → CM-02 | needs-ba-input | gap | gap | The reason for the visit is clinical content, sent to everyone, with no opt-in condition. |
| KV-22 → TP-04 | needs-ba-input | does not apply | does not apply | The requirement is about ordering a replacement and says nothing about the device's encryption or wipe. |
| KV-28 → TP-04 | needs-ba-input | does not apply | needs-ba-input | The visit list is opened on the van's laptop, which is used for clinical work. |
| KV-33 → CM-02 | needs-ba-input | gap | gap | An emailed referral letter carries clinical detail, with no opt-in condition. |
| KV-34 → IR-04 | does not apply | needs-ba-input | needs-ba-input | A new button on the prescribing screen changes what clinicians see. |

KV-22 → TP-04 was settled as "does not apply" because the requirement says nothing about
encryption or wipe. The adjudication prompt treats silence as `needs-ba-input`, and the
consistency pass reversed this decision (below).

The decisions went 4 to labeller 1 and 5 to labeller 2. Each decision rests on the policy's
wording and the requirement's wording. No arm's answer was known to any pass, so none of
them could lean toward one.

## Consistency pass changes

Each row is a pair the blind passes added. Both passes agreed, the standing label was "does
not apply", and the new label is `needs-ba-input`. The wording each rule turns on:

| Pair | Standing | Decision | Reason (from the second blind pass) |
|---|---|---|---|
| KV-12 → IR-04 | does not apply | needs-ba-input | Suppressing interaction pop-ups changes what prescribers see, but the requirement is silent on a clinical safety officer assessment and hazard log entry. |
| KV-15 → IR-04 | does not apply | needs-ba-input | Letting prescribers skip the allergy screen changes the order of steps in prescribing, but the requirement is silent on a clinical safety officer assessment before release. |
| KV-18 → IR-04 | does not apply | needs-ba-input | Adding a mandatory reason prompt before a chart opens changes clinician screens and steps, but the requirement is silent on a clinical safety officer assessment and hazard log entry. |
| KV-25 → IR-04 | does not apply | needs-ba-input | The note-correction workflow adds a reason prompt and shows version history, but the requirement is silent on a clinical safety officer assessment and hazard log entry. |
| KV-26 → IR-04 | does not apply | needs-ba-input | ECG traces appearing on the chart change what clinicians see, but the requirement does not say whether the clinical safety officer assesses it before release. |
| KV-22 → TP-04 | does not apply | needs-ba-input | Covers a lost clinical work phone but does not say whether the phone's storage is encrypted and can be wiped remotely. |
| KV-11 → CM-04 | does not apply | needs-ba-input | A booking confirmation is sent to the patient, but it is not stated whether a copy is kept on the chart. |
| KV-19 → CM-04 | does not apply | needs-ba-input | An SMS reminder is sent to the patient, but it is not stated whether a copy is kept on the chart. |

Two cells were split between the passes and **keep "does not apply"**: KV-33 → IR-04 (one pass
called the emailed letter a change to the referral steps, the other a communication change
only) and KV-32 → CM-04. CM-02, CM-01 and RA-02 were run once each and matched the
standing labels on every requirement.

## What the set holds

- 40 rules. 33 apply to at least one requirement; the other 7 are there to test precision.
- 36 requirements: 30 positive and 6 negative. They hold 47 truth pairs: 21 `gap`,
  22 `needs-ba-input` and 4 `compliant`.
- **10 items carry a non-resembling pair** (12 pairs in all). The loader checks that each
  one shares no word stem with its rule's clause or summary.
- **7 short-answer pairs.** These are `needs-ba-input` pairs whose `businessFact` a BA
  would answer in a word or two. The answer is recorded as `baAnswer`: "Yes, we do." on
  KV-02, KV-26 and KV-31; "Yes, they are." on KV-14; "No." on KV-05, KV-28 and KV-33.
  They exercise #2017 and #2022, where a short answer has to be quoted with its question.
  The verdict stays `needs-ba-input` whatever the answer. The answer is what a BA would
  supply, not what the requirement already says.

Verdicts and conventions follow `governing-01`'s `ANNOTATION.md`. Silence is never
`compliant`, and a rule is listed only when an independent reader would agree it applies.

## Limits to state plainly

- AI labellers, not people. Labeller 2 and the adjudicator are the same model as the
  author, so they may share its blind spots. Agreement between them is not independent
  human judgement.
- 36 items is small. At this size, two arms must differ by roughly 20 points before the
  difference is significant.
- Only 4 pairs are `compliant`, so verdict accuracy on `compliant` rests on few pairs.

## Content hash history

The manifest's `contentHash` must appear here: the loader refuses a held-out set whose
recorded hash is missing from this file, so a re-hash cannot be made without a note.

| Date | Hash | Why |
|---|---|---|
| 2026-11-08 | `0fef56be8454b3b54e04237f9bc4547f88c251ff38fcd87fb8dfa760d7002672` | First recording (#2024), before any arm ran. Superseded. |
| 2026-11-08 | `c18f31b2539ae742e21c788b3b3c09cd5caacd7e6cd66a8b1faeece6bc39c60d` | The consistency pass (#2028 review): eight `needs-ba-input` pairs added under IR-04, CM-04 and TP-04. Still before any arm ran. |

## Readings

Record every run of an arm on this set here: the date, the issue, the arms, the model and
the report file. A reading is for a decision, never for tuning a prompt.

| Date | Issue | Arms | Model | Report |
|---|---|---|---|---|
| (none yet) | | | | |
