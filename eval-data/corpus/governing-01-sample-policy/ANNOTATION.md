# How the governing-rules set was written and labelled (#1867)

> **This is the tuning set (since #2024).** The applicability judge prompt was tuned on it in
> #1997 and #2005, so it is no longer held out (`purpose: "tuning"`). Iterate prompts here,
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
