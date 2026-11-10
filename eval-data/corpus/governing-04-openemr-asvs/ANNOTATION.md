# How the real-text tuning set was built and labelled (#2108)

## Why this set exists

The first reading of `governing-03-openemr-hipaa` (#2105) failed three of its five bars on
real policy text and real OpenEMR issues. #2108 asks for a fix made **on `governing-01` or a
new tuning split**, with `governing-03` kept held out and read once more afterwards.

`governing-01` cannot show the defects that reading found. Its requirements are business
requests written for the set, and its policy is a retailer's. It has no defect report, no
password-composition rule and no sign-in flow. So this set is a **new tuning split of real
text**:

- the **policy** quotes 30 requirements of the OWASP Application Security Verification
  Standard 5.0.0: authentication, sessions, authorization, data protection and logging. It
  is not `governing-03`'s HIPAA and NIST text, so a prompt tuned here is not tuned on
  `governing-03`'s rules;
- the **requirements** are quoted from 25 real `openemr/openemr` issues, **none of them one
  of `governing-03`'s 25**.

This set is a **tuning** set (`purpose: "tuning"`): iterate prompts on it, and on
`governing-01`. `governing-03` stays held out: it is read only for a decision.

## Sources and licences

| Part | Source | Licence | Retrieved |
|---|---|---|---|
| Policy: PA-01 to LG-05 | OWASP ASVS 5.0.0, chapters V6, V7, V8, V14 and V16. https://github.com/OWASP/ASVS/tree/v5.0.0_release/5.0/en | CC BY-SA 4.0, OWASP Foundation. `policy-v1.md` stays under CC BY-SA 4.0 | 2026-11-09 |
| Requirements OS-01 to OS-25 | `openemr/openemr` GitHub issues; each item's `source` is its issue URL | Short excerpts quoted with their source; OpenEMR is GPL-3.0 | 2026-11-09 |

The policy file carries the attribution and the licence notice in its own header, so they
travel with the text an arm reads. `NOTICE` lists the file.

## Who did what, and in order

Everything here was done in one session on 2026-11-09.

1. **Compiling the policy.** The compiler was the coding agent dispatched on #2108
   (`claude-opus-5-5`). It fetched the ASVS 5.0.0 chapters from the OWASP repository at the
   `v5.0.0_release` tag and copied 30 requirements word for word into `policy-v1.md`. The
   bold reference (`PA-05` and so on) is added so a question can name the requirement, and
   the ASVS number follows in square brackets. Three requirements lose a sentence, marked
   "…": PA-10 and LG-03 drop the sentence that sets a stricter level, and SE-03 drops the
   sentence on self-contained tokens. Each rule's one-line `summary` is the compiler's.
2. **Choosing the requirements.** The same agent searched OpenEMR's issues on password,
   logout, session, audit, ACL, MFA, lockout, encryption, token and CSRF, and on topics no
   rule covers (the calendar, a report, the DICOM viewer, a login-page layout). It left out
   every issue `governing-03` uses. It chose 25 issues, from 2019 to 2026, and it
   **wrote no label**, then or later. Items are numbered OS-01 to OS-25 in issue-number order.
3. **Quoting rules.** The same as `governing-03`'s: the title is the issue's title, word
   for word; the text is a quotation from the body, with Markdown markup, images, code blocks
   and template headings removed, a cut marked "…", and a reference to another issue or pull
   request cut. That cut reaches one title: OS-24's "(PR … followup)". Two edits add
   punctuation only: the list items of OS-16 and OS-18 are joined with full stops, and OS-12,
   OS-15, OS-22 and OS-23 keep their "Expected behavior" or "Expected Result" heading as a
   label. The loader's checks pass: no item names a rule id or copies five words from a clause.
4. **Labeller 1 and labeller 2 labelled blind** (`labelling/labeller-1.json`,
   `labelling/labeller-2.json`). Neither is the agent that chose the requirements. Each was a
   separate `claude-opus-5-5` session run through `claude -p` with every tool switched off
   (`--tools ""`), no MCP server (`--strict-mcp-config` with an empty config), no settings
   sources and no session persistence, from an empty directory. Each prompt
   (`labelling/labeller-<n>-prompt.txt`) held `policy-v1.md`, the 25 requirements in a seeded
   order (seeds 21081 and 21082), the three verdicts and the labelling rules, which are
   `governing-03`'s, word for word. It held no label, no rule summary, no source URL and no
   word about any arm or prompt. Cost: $0.18 and $0.21.
5. **A third pass settled every disagreement** (`labelling/adjudication.json`, prompt in
   `labelling/adjudication-prompt.txt`): another tool-less `claude-opus-5-5` session, given
   the policy and each disputed pair with the two labels as A and B in a seeded order (seed
   21083), not told who wrote which, told to favour neither and to answer "unsettled" rather
   than guess. It settled all 11 pairs, each with a written reason. Cost: $0.12.
6. **No consistency pass was run.** `governing-03` ran one for five cross-cutting rules
   because it is held out. This set is for tuning, so a cell both labellers skipped was not
   re-checked.
7. **Business facts.** Each `needs-ba-input` pair's `businessFact` is labeller 1's question
   where both labellers gave the verdict, and the adjudicator's where it decided.
8. **`nonResembling` was computed**, as in `governing-03`: one pair, OS-24 → AZ-01, shares no
   stem with its rule.
9. **The thresholds are `governing-01`'s, unchanged.** No arm had run on this set when the
   labels were fixed.

## #2140: eight more requirements, and a consistency pass

#2108's re-read of `governing-03` lost recall on one kind of pair: a flow that sets or forces
a password, against a rule on every new or changed password. This set held none, so #2140
added them, and did so in two steps, on 2026-11-09 and 2026-11-10.

1. **Eight requirements, OS-26 to OS-33**, chosen and quoted by the agent dispatched on #2140
   (`claude-opus-5-5`), which **wrote no label**. They are real OpenEMR issues, none of them in
   `governing-03` or already here, numbered in issue-number order among themselves: a password
   chosen at setup (OS-26), a forced change at first login (OS-27), a portal password change
   (OS-28, OS-32), one-time login links (OS-29), portal credentials made by staff (OS-30),
   signing an encounter through Google single sign-on (OS-31) and an administrator's portal
   reset (OS-33). The quoting rules are the ones above. OS-26 joins its list items with full
   stops, and OS-33 keeps its "Actual Result" and "Expected Result" headings as labels.
2. **Labelled blind the same way, in `labelling/2140/`.** Two tool-less `claude -p` sessions
   (seeds 21401 and 21402), neither of them the agent that chose the requirements, were given
   `policy-v1.md` and only these eight requirements, with the first round's prompt text
   unchanged except for the count. A third pass (seed 21403) settled all five disagreements.
   Over 8 × 30 = 240 cells: applicability κ 0.86, four-way κ 0.83. No arm had run on these
   items when their labels were fixed. Cost: $0.12, $0.10 and $0.08.
3. **A consistency pass, which this set did not have.** The labellers left the blocklist rule
   (PA-04) off most password flows. `governing-03` holds its pairs of that kind (OE-11 → PW-07,
   OE-12 → PW-07) only because its consistency pass added them, after both of its labellers
   had left them off too. So `governing-03`'s procedure was run here, over all 33 items, on
   the counterparts of its cross-cutting rules: **PA-04** for PW-07, **PA-10** for TS-09 and
   **AZ-01** for TS-01. TS-06 (audit) has no single counterpart here, and AS-02 none. Two
   tool-less sessions per rule (`labelling/2140/consistency-prompt.txt` in id order, and
   `consistency-prompt-pass2.txt` in a seeded order, seed 21404) were each asked about one rule
   on every requirement. They saw no label, no rule summary and no arm. A label changed only
   where both passes agreed: 7 cells (OS-08, OS-27, OS-32 → PA-04; OS-17, OS-30 → PA-10;
   OS-20, OS-29 → AZ-01), and 3 split cells kept their label. The changes are in each round's
   `adjudication.json` under `consistencyPass`. Cost: $0.76. The prompt adds one thing to
   `governing-03`'s text: it asks for the business question on a `needs-ba-input` label, so
   the label can stand as a truth pair.

**This pass ran after arms had run on this set**, and its rules were picked knowing the kind of
pair #2140 is about. It is a tuning set, so that is allowed, and it is why
`annotation.groundTruthFixedBeforeAnyArmRan` is now `false`. The rules were chosen as the
counterparts of `governing-03`'s list, not from an arm's errors, and no arm output reached a
labeller. Even so, read this set's PA-04, PA-10 and AZ-01 labels as less independent than its
others.

## Agreement between the two labellers

For the first 25 items (#2108), over every (requirement, rule) cell: 25 × 30 = 750 cells. The
eight #2140 items are above.

| Measure | Value |
|---|---|
| Pairs listed by labeller 1 / labeller 2 | 25 / 25 |
| Pairs either listed (the union) | 28 |
| Listed by both | 22, of which 17 had the same verdict |
| Applies / does not apply, Cohen's κ | **0.88** |
| Four-way label, Cohen's κ | **0.77** |
| Same label on the union of listed pairs | 17 of 28 (0.61) |
| Negative items both left empty | 5; the adjudication emptied 3 more |

One disagreement is the question this set was built to tune: OS-16 reports that the CSRF
token travels in the URL. Labeller 1 read the report as the fix it asks for (compliant), and
labeller 2 read it as what is built (gap). The adjudicator decided compliant: "Resolving it
means removing the token" from the URL.

## What the set holds

- **30 rules**: 15 on authentication, 6 on sessions, 3 on authorization, 1 on data
  protection and 5 on logging. 22 apply to at least one requirement; the other 8 test precision.
- **33 requirements**: 26 positive and **7 negative**. OS-01 and OS-03 (where the user
  lands after a session has ended) are near misses that the adjudicator left empty. OS-20 was
  negative until the consistency pass gave it AZ-01.
- **47 truth pairs**: 6 `gap`, 31 `needs-ba-input` and 10 `compliant` (24 at #2108; #2140
  added 16 with its items and 7 with its consistency pass).
- **4 non-resembling pairs** (OS-20 → AZ-01, OS-24 → AZ-01, OS-30 → DP-01, OS-31 → PA-15) and
  **no short-answer pairs**.

## Limits to state plainly

- **AI labellers, not people**, as in `governing-03`; `annotation.reviewedBy` is `null`.
- **33 items is small**, and the readings below are one or two runs each.
- **The set was built after `governing-03`'s defects were known.** Its requirements were
  chosen to hold the same kinds of text (defect reports, requests that are a safeguard,
  sign-in and password flows), so that a fix for those kinds can be tuned somewhere other
  than the held-out set. No `governing-03` item, label or rule is in it.

## Readings

A reading of this set is a tuning reading: its numbers are not held-out evidence.

| Date | Issue | Arms | Model | Prompts | Runs | Recall | Precision | Verdict accuracy | Hard errors |
|---|---|---|---|---|---|---|---|---|---|
| 2026-11-09 | #2108 | A5 | `anthropic/claude-sonnet-5-5` | before #2108 | 2 (two `--runs 1` invocations) | 0.96 / 0.88 | 0.57 / 0.55 | 0.54 / 0.42 | 1 / 0 |
| 2026-11-09 | #2108 | A5 | `anthropic/claude-sonnet-5-5` | first draft of the three lines | 1 | 0.96 | 0.74 | 0.67 | 1 |
| 2026-11-09 | #2108 | A5 | `anthropic/claude-sonnet-5-5` | the three lines as committed | 2 | 0.94 | 0.68 | 0.79 | 0 |
| 2026-11-09 | #2108 | A5, commit `e452afb69` (clean tree) | `anthropic/claude-sonnet-5-5` | the three lines as committed | 2 | 0.92 / 0.83 | 0.71 / 0.71 | 0.75 / 0.71 | 0 / 0 |

The first three rows ran on an uncommitted tree, so they are recorded here and not as
readings. The last is the committed reading,
[`eval-data/readings/governing-04-openemr-asvs/baseline-A5-sonnet.md`](../../readings/governing-04-openemr-asvs/baseline-A5-sonnet.md)
($1.20). Precision rose from about 0.56 to 0.68–0.74 and verdict accuracy from about 0.48 to
0.71–0.79, with no hard error after the change. Recall moved from 0.96 / 0.88 to between
0.83 and 0.94: no measurable change at 24 truth pairs.

Every miss in the committed reading is `judged-does-not-apply`. In both runs OS-02 → PA-14
and OS-04 → PA-10 (single sign-on, and whether it keeps a second factor) were missed. The
second is the kind of miss `governing-03` showed on OE-14 → AU-01. The next change to the
judge is tuned here, on it.

### #2140 readings, on 33 items and 47 truth pairs

The #2108 rows above were scored on the first 25 items and their labels, so they do not
compare with these. The first five rows below ran before the consistency pass; they are
scored again here against the final labels (`--combine` on each saved run calls no model).
All ran on an uncommitted tree except the last, so only the last is a reading.

| Prompts | Runs | Recall | Precision | Verdict accuracy | Hard errors |
|---|---|---|---|---|---|
| #2108's, as shipped | 2 | 0.74 / 0.66 | 0.73 / 0.72 | 0.66 / 0.55 | 1 / 1 |
| draft 1: a rule on "every one of something" (every password set, every way of signing in) applies | 1 | 0.72 | 0.57 | 0.57 | 1 |
| draft 2: a rule on what each new password, or each sign-in, must be applies to a step that makes one; what surrounds the step does not | 2 | 0.79 / 0.77 | 0.70 / 0.67 | 0.55 / 0.60 | 2 / 1 |
| draft 3: a rule written for a step applies to every requirement that adds or changes it | 1 | 0.77 | 0.64 | 0.60 | 0 |
| draft 4: only a rule whose own words name the step | 1 | 0.72 | 0.68 | 0.57 | 1 |
| #2108's, as shipped; commit `c7cc77b20`, clean tree | 2 | 0.66 / 0.70 | 0.69 / 0.65 | 0.51 / 0.55 | 1 / 1 |

The last row is the committed reading,
[`eval-data/readings/governing-04-openemr-asvs/baseline-A5-sonnet-2140.md`](../../readings/governing-04-openemr-asvs/baseline-A5-sonnet-2140.md)
($1.72), and the baseline the next change is tuned against.

- **Draft 1** drew the authentication-logging rule (LG-02) onto most sign-in requirements:
  "every way of signing in" reads as "every authentication operation".
- **Draft 2** found the pairs #2140 is about that the shipped prompts miss: OS-08, OS-26,
  OS-27 and OS-32 → PA-04, and OS-04 and OS-30 → PA-10. It also brought in the length rule
  (PA-01) and the composition rule (PA-05) on most password flows, where no label has them.
  PA-01 and PA-05 had no consistency pass, so some of those extras may be labels missing, not
  errors. On `governing-01` (2 runs) it gave recall 0.97, precision 0.50 and verdict accuracy
  0.85, against 1.00, 0.52 and 0.85 at #2108: no measurable change.
- Draft 2 was the one read on `governing-03`, once, at commit `15b11e09e`. It raised recall
  there (0.75 → 0.83), but cut precision (0.76 → 0.65) and gave a wrong `compliant`, so it was
  **not shipped** (that set's `ANNOTATION.md`, "The #2140 attempt and re-read").
- At 47 truth pairs each miss moves a run's recall by about 0.02, and the shipped prompts
  range from 0.66 to 0.74 over four runs. Draft 2's gain over them (about 0.08) is at the edge
  of that noise, and its precision cost (about 0.04) is inside it.
