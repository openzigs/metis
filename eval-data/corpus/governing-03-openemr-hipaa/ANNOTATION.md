# How the real-text governing set was built and labelled (#2105)

## Why this set exists

`governing-01` and `governing-02` are synthetic. In each, one agent wrote the policy, the
requirements and the first labels. Before an analyst relies on a governing finding, we need
evidence from **real, published policies checked against real requirements on real code**.
The owner does not want to use their own company's policies, so this set uses only public
text whose licence allows it in a public repository:

- the **policy** quotes the HIPAA Security Rule (45 CFR 164.312 and 164.308(a)(5)) and NIST
  SP 800-63B-4;
- the **requirements** are quoted from 25 real issues of OpenEMR (`openemr/openemr`), a
  production electronic health record system.

**The policy and the requirements now have independent real authors**: the US Department of
Health and Human Services and NIST wrote the obligations, and OpenEMR's users and developers
wrote the requirements, years apart and with no knowledge of each other or of this set. That
removes `governing-01`'s limit that one annotator wrote both sides. The labels are still
AI labels (see "Limits to state plainly").

This set is **held out** (`purpose: "held-out"`), like `governing-02`.

**The tuning rule: never iterate a prompt against this set.** Iterate on `governing-01`.
Read this set only for a decision, and record every reading under "Readings" below, with the
date, the issue, the arms and the model. The manifest records a content hash (`contentHash`)
of the policy, the rules and the labelled requirements, and the loader refuses the set if
any of them changes without a new hash recorded here.

## Sources and licences

| Part | Source | Licence | Retrieved |
|---|---|---|---|
| Policy, Part A: TS-01 to TS-12 | 45 CFR 164.312, Technical safeguards. https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.312 | US federal regulation, public domain | 2026-11-09 |
| Policy, Part A: AS-01, AS-02 | 45 CFR 164.308(a)(5)(ii)(C) Log-in monitoring and (D) Password management. https://www.ecfr.gov/current/title-45/subtitle-A/subchapter-C/part-164/subpart-C/section-164.308 | US federal regulation, public domain | 2026-11-09 |
| Policy, Part B: PW-01 to SM-04 | NIST SP 800-63B-4, Digital Identity Guidelines: Authentication and Authenticator Management. https://pages.nist.gov/800-63-4/sp800-63b.html | A US government work, not subject to copyright in the United States | 2026-11-09 |
| Requirements OE-01 to OE-25 | `openemr/openemr` GitHub issues; each item's `source` is its issue URL | Short excerpts quoted with their source; OpenEMR is GPL-3.0 | 2026-11-09 |

The policy file carries the same attribution in its own header, so the attribution travels
with the text an arm reads. No PCI DSS or ISO 27001 text was used: neither may be
redistributed. No AICPA Trust Services Criteria text was used, and the loader's TSC-marker and
evaluation-leak checks pass.

## Who did what, and in order

Everything here was done in one session on 2026-11-09.

1. **Compiling the policy.** The compiler was the coding agent dispatched on #2105
   (`claude-opus-5-5`). It fetched the eCFR and NIST pages and copied the obligations word for
   word into `policy-v1.md`. Each obligation is one rule: the bold reference (`TS-01`, `PW-07`
   and so on) is added so a question can name it, and the source's own citation follows in
   square brackets. Text left out of a quotation is marked "…" (in AU-02 and AU-03, where a
   cross-reference was cut), and AU-04 drops a footnote marker. Nothing else in a quotation
   changed. The compiler also wrote two paragraphs that are not quotations: the attribution
   header, and "How Part B reads here", which maps NIST's federal roles (verifier, CSP, RP,
   subscriber) onto the system and its users and says that the AAL2 requirement is the one
   quoted where NIST sets one per level. Those two paragraphs carry no obligation.
2. **The 32 rules** are the 12 technical safeguards of 164.312, the two administrative
   safeguards of 164.308(a)(5)(ii) that bear on software (log-in monitoring, password
   management), and 18 normative ("SHALL") sentences of 800-63B-4 on passwords, authenticators
   and sessions. The compiler chose the NIST sentences for their bearing on an EHR's sign-in and
   session code. The set has **one revision**: no real revision of these texts was
   quoted, and a v2 written for the set would no longer be real text. Each rule's one-line
   `summary` is the compiler's.
3. **Choosing the requirements.** The same agent searched OpenEMR's issues (`gh issue list
   -R openemr/openemr --search …`) on session timeout, audit log, password, MFA, TOTP, login,
   encryption, emergency access, CSRF, export, fax, and on topics no rule covers (report
   columns, themes, charts, the fee sheet). It chose 25 issues, from 2018 to 2026, so that some
   touch ePHI access, audit, sign-in or transmission and some touch nothing a rule covers. It
   **wrote no label**, then or later. Items are numbered OE-01 to OE-25 in issue-number order.
4. **Quoting rules.** Each item's `title` is the issue's title, word for word. Its `text` is
   a quotation from the issue body, never a paraphrase: Markdown markup (headings, list
   markers, backticks, emphasis), images, code blocks and template headings ("Describe the
   bug") are removed, a cut is marked "…", and a reference to another issue or pull request
   ("#11560") is cut, because the loader refuses issue numbers in prompt text. Two edits add
   punctuation only: the change list of OE-19 is joined with full stops, and OE-10 gets
   "Expected behavior:". OE-12's issue has no body, so its text says so. The loader's checks
   pass: no item names a rule id or copies five words from a clause.
5. **What the compiler read.** It did not open `server/src/lib/governing/**` (the product's
   prompts), any arm's prompt in `server/src/lib/eval/governing/arms.ts` (it read one line
   there, which joins an item's title and text), or any judge prompt. It read the loader
   (`corpus.ts`), the eval CLI, `governing-02`'s `ANNOTATION.md` and labelling prompts (the
   procedure), and the summary table of one `governing-02` reading. None of that reached a
   labeller.
6. **Labeller 1 and labeller 2 labelled blind** (`labelling/labeller-1.json`,
   `labelling/labeller-2.json`). Neither is the agent that chose the requirements. Each was a
   separate `claude-opus-5-5` session run through `claude -p` with every tool switched off
   (`--tools ""`), no MCP server (`--strict-mcp-config` with an empty config), no settings
   sources and no session persistence, from an empty directory. Each prompt
   (`labelling/labeller-<n>-prompt.txt`) held `policy-v1.md`, the 25 requirements in a seeded
   order (seeds 21051 and 21052), the three verdicts and the labelling rules. It held no label,
   no rule summary, no source URL and no word about any arm or prompt. Cost: $0.18 and $0.24.
7. **Agreement was measured** (below), and every disagreement went to **a third pass**
   (`labelling/adjudication.json`, prompt in `labelling/adjudication-prompt.txt`): another
   tool-less `claude-opus-5-5` session, given the policy and each disputed pair with the two
   labels as A and B in a seeded random order (seed 21053), not told who wrote which, told to
   favour neither and to answer "unsettled" rather than guess. It settled all nine pairs, each
   with a written reason, so none was dropped. Cost: $0.12.
8. **A consistency pass ran for five cross-cutting rules**, as `governing-02`'s review asked
   for there: adjudication only sees cells the labellers disagreed on, so a rule both skipped
   on one requirement is never checked. For each of TS-06 (audit), TS-01 (access), AS-02
   (password procedures), PW-07 (blocklist on a new or changed password) and TS-09
   (authentication), two tool-less `claude-opus-5-5` sessions were each given the policy and
   all 25 requirements and asked about that one rule alone, on every requirement
   (`labelling/consistency-prompt.txt` in issue order; `labelling/consistency-prompt-pass2.txt`
   in seed 21054's order). They saw no label, no rule summary and no arm. **A standing label
   changes only when both passes agree on the new one**; a cell the passes split on keeps its
   label. Cost: $1.26 for 10 sessions. Each pass's labels are in `adjudication.json` under
   `consistencyPass`.
9. **Business facts.** Each `needs-ba-input` pair's `businessFact` is the labellers' own
   question: labeller 1's where both labellers gave the verdict, the adjudicator's where it
   decided. The consistency pass returns reasons, not questions, so the five facts of the
   pairs it added (OE-11, OE-12 and OE-16 → PW-07; OE-14 → AS-02 and TS-09) were written by the
   compiler from those reasons, after each label was fixed. No `baAnswer` was written: this set
   has no short-answer pairs, so the replay of BA answers has nothing to score here.
10. **`nonResembling` was computed, not judged**: a pair carries it when the loader's
    `sharedVocabulary` finds no shared stem between the requirement and the rule's clause and
    summary.
11. **The pass thresholds were copied unchanged from `governing-01`** (`proposedIn: "#1867"`,
    `changes: []`) and fixed with `recordedBeforeAnyArmRan: true`. The content hash was then
    recorded. **No arm had run on this set** when the labels and the thresholds were fixed.

## Agreement between the two labellers

Compared pair by pair over every (requirement, rule) cell: 25 × 32 = 800 cells.

| Measure | Value |
|---|---|
| Pairs listed by labeller 1 / labeller 2 | 22 / 22 |
| Pairs either listed (the union) | 25 |
| Listed by both | 19, of which 16 had the same verdict |
| Applies / does not apply, Cohen's κ | **0.86** (observed 0.9925, chance 0.9465) |
| Four-way label (none, compliant, gap, needs-ba-input), Cohen's κ | **0.79** (observed 0.9888, chance 0.9461) |
| Same label on the union of listed pairs | 16 of 25 (0.64) |
| Negative items both left empty | 8 of 8 |

κ is high partly because about 97% of the cells are "does not apply" for both labellers.
**The union figure, 16 of 25 listed pairs (0.64), is the stricter reading, and the one to
quote.** It is lower than `governing-02`'s 0.78: real requirements are terser and less
deliberate than ones written to be labelled, so more of them leave a rule's reach open.

## Adjudications

| Pair | Labeller 1 | Labeller 2 | Decision | Reason (from `adjudication.json`) |
|---|---|---|---|---|
| OE-01 → TS-01 | needs-ba-input | does not apply | does not apply | One user's own windows and tabs mixing patients they already work with is not a person without access rights reaching ePHI. |
| OE-01 → TS-07 | does not apply | needs-ba-input | needs-ba-input | "Cross patient data" between tabs could mean entries saved to the wrong chart; the report does not say whether writes are affected. |
| OE-09 → TS-10 | does not apply | needs-ba-input | needs-ba-input | Login over HTTP is transmission security; production is HTTPS-only, but the development option is left open. |
| OE-12 → PW-04 | needs-ba-input | compliant | compliant | An admin-triggered forced reset is the on-demand change PW-04 asks for, not a periodic one. |
| OE-15 → AS-02 | does not apply | gap | gap | Changing a forgotten password from the login screen is an unauthenticated password change. |
| OE-15 → PW-07 | needs-ba-input | does not apply | needs-ba-input | It is a password-change flow, and the text says nothing about checking the new password. |
| OE-15 → TS-09 | needs-ba-input | gap | gap | No step verifies that the person changing the password is the account holder. |
| OE-19 → TS-01 | needs-ba-input | does not apply | needs-ba-input | Sent faxes become viewable and forwardable, and the text does not say by whom. |
| OE-22 → AU-01 | compliant | needs-ba-input | needs-ba-input | MFA is required only "when enabled"; with the setting off, users still sign in with a password alone. |

The decisions went 2 to labeller 1 and 7 to labeller 2. No arm's answer was known to any
pass.

## Consistency pass changes

Each row is a cell both blind passes moved, with the same new label.

| Pair | Standing | Decision | Reason (from the second blind pass) |
|---|---|---|---|
| OE-12 → AS-02 | does not apply | compliant | Explicitly provides an admin-driven procedure to force a password change at next login. |
| OE-14 → AS-02 | does not apply | needs-ba-input | Moves credentials to an external IdP and is silent on whether that provider supplies the password creation, change and safeguarding procedures. |
| OE-16 → AS-02 | does not apply | compliant | Explicitly defines a stronger password-creation rule, a minimum length of 12. |
| OE-25 → AS-02 | does not apply | compliant | Describes and improves an explicit portal procedure for setting and changing credentials on first login or forced reset. |
| OE-11 → PW-07 | does not apply | needs-ba-input | Establishes a new user's password but is silent on whether the generated secret is checked against a blocklist. |
| OE-12 → PW-07 | does not apply | needs-ba-input | Forced reset drives a password change but is silent on blocklist comparison. |
| OE-16 → PW-07 | does not apply | needs-ba-input | Changes validation of user-set passwords but is silent on blocklist screening. |
| OE-14 → TS-09 | does not apply | needs-ba-input | Delegating login to an external identity provider is silent on how that provider verifies users and how OpenEMR trusts its assertions. |
| OE-22 → TS-09 | does not apply | compliant | Explicitly blocks practitioner login until MFA is enrolled, strengthening verification of claimed identity. |

Eight cells were split between the passes and **keep their standing label**: OE-05 → TS-06
(compliant), OE-15 → AS-02 (gap), and OE-06 → TS-06, OE-10 → TS-06, OE-14 → TS-01,
OE-09 → AS-02, OE-25 → PW-07 and OE-11 → TS-09 (does not apply). In OE-10 → TS-06 the second
pass left the item out of its answer; a missing answer never moves a label.

## What the set holds

- **32 rules**: 12 from 164.312, 2 from 164.308(a)(5), 18 from 800-63B-4. 18 apply to at
  least one requirement; the other 14 test precision.
- **25 requirements**: 17 positive and **8 negative**. Two negatives are near misses on
  purpose: OE-20 (the login page renders its headers twice) and OE-23 (the portal no longer
  redirects to sign-in when a session has ended) both touch sign-in code, and both labellers
  and every consistency pass found no rule they breach.
- **33 truth pairs**: 4 `gap`, 16 `needs-ba-input` and 13 `compliant`. That is far more
  `compliant` than `governing-02` (4 of 47): a real issue often *is* the safeguard (an audit
  log entry, an encryption option, a forced reset).
- **2 non-resembling pairs, on 2 items**: OE-01 → TS-07 and OE-22 → TS-09. The synthetic
  sets must hold at least eight such items, because their requirements were written to carry
  them; real requirements were quoted as filed, so the loader measures their number here and
  does not demand one. Each pair is half of the non-resembling bar, so that bar reads 0, 0.5 or
  1 per run on this set and is far noisier than on `governing-02`.
- **No short-answer pairs** (`baAnswer`), so the replay of BA answers reports no pairs.

## Limits to state plainly

- **AI labellers, not people.** No person has reviewed the labels (`annotation.reviewedBy`
  is `null`). Both labellers and the adjudicator are the same model, so they may share its
  blind spots. Their agreement is not independent human judgement. What is new here is that
  neither the policy nor the requirements were written by any of them, or by the agent that
  chose the requirements.
- **25 items is small.** Two arms must differ by well over 20 points before the difference is
  significant, and the non-resembling bar rests on two pairs.
- **The requirements are issue reports, not analysts' requirements.** Several are bug reports
  in a developer's words, with file paths and setting names. That is what a team pastes into
  an analysis, but it is not the business language of the synthetic sets. OE-21 even cites
  "HIPAA §164.312(b)" itself, which makes that pair easy.
- **Labels are against the quoted excerpt**, not the whole issue thread or OpenEMR's code.
  A rule a later comment settles is still labelled from the excerpt.
- **800-63B-4 is written for federal agencies.** "How Part B reads here" maps its roles onto
  the system; a reader who maps them differently could label some password pairs differently.

## Content hash history

The manifest's `contentHash` must appear here: the loader refuses a held-out set whose
recorded hash is missing from this file, so a re-hash cannot be made without a note.

| Date | Hash | Why |
|---|---|---|
| 2026-11-09 | `71c07441178945b2367af50c2848208b056b6a7a1b8f295011899dbba45c4135` | First recording (#2105), after the consistency pass and before any arm ran. |

## Readings

Record every run of an arm on this set here: the date, the issue, the arms, the model and
the report file. A reading is for a decision, never for tuning a prompt.

| Date | Issue | Arms | Model | Report |
|---|---|---|---|---|
| 2026-11-09 | #2105 | A5 (the shipped path), 3 runs as three `--runs 1` invocations, combined; commit `1a6766257` | `anthropic/claude-sonnet-5-5` | [`eval-data/readings/governing-03-openemr-hipaa/baseline-A5-sonnet.md`](../../readings/governing-03-openemr-hipaa/baseline-A5-sonnet.md) |
| 2026-11-09 | #2108 | A5, 3 runs as three `--runs 1` invocations, combined; commit `b7f9f8657`, after the fix tuned on `governing-04` | `anthropic/claude-sonnet-5-5` | [`eval-data/readings/governing-03-openemr-hipaa/baseline-A5-sonnet-2108.md`](../../readings/governing-03-openemr-hipaa/baseline-A5-sonnet-2108.md) |
| 2026-11-10 | #2140 | A5, 3 runs as three `--runs 1` invocations, combined; commit `15b11e09e`, with a sentence tuned on `governing-04` that was then **not shipped** | `anthropic/claude-sonnet-5-5` | [`eval-data/readings/governing-03-openemr-hipaa/baseline-A5-sonnet-2140.md`](../../readings/governing-03-openemr-hipaa/baseline-A5-sonnet-2140.md) |

### The #2105 reading

The first reading of this set, taken once, after the labels, the thresholds and the content
hash were fixed. No prompt was changed after it, and no label was changed after it. It cost
$1.95 in all ($0.65, $0.64 and $0.66 per run), against the owner's pre-approval of up to $20.
Each bar is the one #1867 fixed before any arm ran. It is set beside the latest reading of
`governing-02` (the #2066 to #2068 reading, the same arm and model):

| Bar | Required | This set: mean over 3 runs | Per run | Pass | `governing-02` |
|---|---|---|---|---|---|
| Overall recall | ≥ 0.90 | 0.80 | 0.82 / 0.76 / 0.82 | **no** | 0.95 |
| Non-resembling recall | ≥ 0.85 | 0.50 | 0.50 / 0.50 / 0.50 | **no** (2 pairs) | 0.92 |
| Precision | ≥ 0.60 | 0.52 | 0.50 / 0.52 / 0.54 | **no** | 0.62 |
| Citation accuracy | ≥ 0.95 | 1.00 | 1.00 / 1.00 / 1.00 | yes | 1.00 |
| No-evidence → compliant errors | 0 per run | 0 | 0 / 0 / 0 | yes | 0 |

Verdict accuracy was 0.31 (0.79 on `governing-02`). Each run left seven of the eight negatives
clean: OE-23 drew a session rule in runs 1 and 3, and OE-13 (showing the TOTP seed) drew the
notification rule AU-03 in run 2. **Three of the five bars fail on real text, and none is tuned away here**: this
set is held out, so the result stands as read. What the reading shows:

- **Recall (0.80).** Six truth pairs were never found in any run: OE-01 → TS-07 (the
  non-resembling one: tabs mixing two patients' data, against integrity), OE-09 → TS-10
  (HTTP sign-in, against transmission security), OE-14 → AS-02 and AU-01 (sign-in through an
  external provider), OE-16 → PW-07 (the blocklist on a password-length change) and
  OE-25 → PW-03, a plain `gap`: the portal makes new passwords "mix upper/lower case and
  digits", which is the composition rule 800-63B-4 forbids. That last miss is the clearest
  defect in the reading. The other non-resembling pair, OE-22 → TS-09, was found in all three
  runs, so that bar reads 0.50 on two pairs.
- **Precision (0.52).** The extra rules cluster on three requirements. On OE-15 (change a
  forgotten password from the sign-in screen) the path applied up to nine more of the password
  and session rules; on OE-19 (keep and show sent faxes) it added audit, integrity, encryption
  and transmission; on OE-11 (a random first password sent by email) it added composition,
  storage and transmission. Some of these are defensible readings that the labellers left off
  (for example OE-23 → SM-02, the portal session that ends without telling the patient, taken
  in two runs). That is a limit of AI labels on terse text, and it is not a reason to change a
  label after seeing an arm's answer.
- **Verdicts (0.31).** The path almost never says `compliant` on this set: of 39 pair-runs
  labelled `compliant`, it said `compliant` on 11, `needs-ba-input` on 23 and `gap` on 5. A real
  issue is often the safeguard itself ("encrypt backups", "audit logging of the merge tool"),
  and the labellers called that compliant; the path asks for confirmation instead. That is
  the cautious side, and it made no unsupported `compliant` (0 hard errors). It also called
  13 of 48 `needs-ba-input` pair-runs `gap`.
- **Citations held.** Every citation was a sentence of the quoted HIPAA or NIST text.

**Decision: none taken here.** #2105 asked for the reading, not for a flag change. The
feature stays as #1878 left it, and this reading is evidence for the owner's next decision:
on real policies and real issue text the shipped path finds fewer of the rules that apply,
and adds more that do not, than the synthetic held-out set showed. The labels are still AI
labels; a person's review of the 33 pairs (`annotation.reviewedBy`) would say how much of the
precision and verdict gap is the path and how much is the labels.

### The #2108 diagnosis of the #2105 reading

#2108 asked for each missed or wrong pair to be put down to its stage: applicability, the
findings call, or the label. **No person reviewed the labels** (the owner's decision of
2026-11-09), so a pair whose label looks doubtful is reported as **label doubtful**, with the
reason, and kept apart from the defects. No label was changed, then or after the re-read, and
the content hash stands.

The #2105 records hold the final findings only. So the stage is read from them as follows:

- a truth pair with no finding is **applicability**: its rule was not a candidate, or the
  judge ruled it out. The BM25 top 8 is deterministic and is recomputed without a model. A
  rule in it was a candidate, so the judge ruled it out. For a rule outside it, the record
  cannot say whether the screen or the judge dropped it;
- an extra rule is **applicability**: only a rule that applies, or may apply, gets a finding;
- a wrong verdict is the **findings call**, unless the finding cites the rule's whole clause.
  That is applicability's `uncertain`, which becomes Needs BA input without a findings call.

Since #2108, A5 records each candidate's stage (`stages`: the pass that found it, its
applicability, its finding), and every report prints "Where each error arose". The re-read
below was read that way.

**Misses** (a truth pair never found):

| Pair | Label | Runs missed | Stage | Defect or label doubtful |
|---|---|---|---|---|
| OE-25 → PW-03 | gap | 3 of 3 | applicability (outside the top 8) | **Defect.** The text says new portal passwords "must mix upper/lower case and digits". That is the composition rule PW-03 forbids, on the page the requirement changes. The judge's "judge what the requirement itself changes, not the systems it runs on" reads it as background. |
| OE-14 → AS-02, AU-01 | needs-ba-input | 3 of 3 | applicability (outside the top 8) | **Defect.** Moving sign-in to an outside identity provider moves password procedures and the second factor there. Whether the provider does both is the question to ask. |
| OE-09 → TS-10 | needs-ba-input | 3 of 3 | applicability: the judge (in the top 8) | **Defect.** A development install that logs in over HTTP serves the application, and the health information, over HTTP. |
| OE-01 → TS-07 | needs-ba-input | 3 of 3 | applicability (outside the top 8) | **Label doubtful.** Labeller 1 left it off. The adjudicator's reason is conditional ("could mean entries saved to the wrong chart"), and the report is about abrupt logouts with a suspected session mix-up. Attaching the integrity rule takes the stretch reading the judge is told to leave out. It is also one of the two non-resembling pairs, so it alone holds that bar at 0.50. |
| OE-16 → PW-07 | needs-ba-input | 3 of 3 | applicability: the judge (in the top 8) | **Label doubtful.** The consistency pass added it ("silent on blocklist screening") to a requirement about the minimum length. By that reading, every change to password validation brings in every password rule, and the labels do not do that for PW-03 or PW-08 on the same item. |

**Wrong verdicts** (wrong in at least two of three runs):

| Pair | Label | Said | Stage | Defect or label doubtful |
|---|---|---|---|---|
| OE-24 → TS-06 | compliant | gap ×3 | findings call | **Defect.** The requirement is a defect report: the log records the wrong patient. The call judged the defect it describes, not the fix it asks for. |
| OE-07 → AU-02 | gap | needs-ba-input ×3 | findings call | **Defect.** The text names the setting "0 for no maximum", which is a breach of "at most 100" as written. |
| OE-21 → TS-06, OE-03 → TS-05, OE-05 → TS-06, OE-16 → AS-02 | compliant | needs-ba-input (2–3 of 3) | findings call | **Defect.** Each requirement asks for the rule's safeguard (an audit entry, encrypted backups, a stronger length rule). The call asked about a part of the rule the requirement does not touch (examining the log, decrypting the backup). |
| OE-04 → TS-04, SM-02 | compliant | mixed | findings call | **Defect.** "Session timeout should force immediate logout" is the automatic logoff the rules ask for. |
| OE-15 → AS-02 | gap | needs-ba-input ×3 | findings call | **Defect.** Changing a password from the login screen with no check of who is asking is a gap as written (the adjudicator's reading). |
| OE-12 → AS-02, PW-04 | compliant | needs-ba-input ×3 | findings call | **Label doubtful.** The issue has a title and no body. PW-04 forbids periodic changes, and a title cannot say the forced reset is never periodic. The adjudicator chose compliant over labeller 1's needs-ba-input. AS-02 was added by the consistency pass. |
| OE-25 → AS-02 | compliant | needs-ba-input ×3 | findings call | **Label doubtful.** The consistency pass added it. A password procedure that enforces a rule PW-03 forbids (labelled a gap on the same item) sits oddly as compliant. |
| OE-11 → AS-02 | needs-ba-input | gap ×3 | findings call | **Label doubtful.** Emailing a new user's password is, on its face, a failure to safeguard it. |
| OE-15 → PW-07, OE-11 → PW-07 | needs-ba-input | gap (2–3 of 3) | findings call | **Label doubtful.** The labelling rules let silence be either gap or needs-ba-input. A new flow that sets passwords and says nothing of a blocklist is read either way. |
| OE-09 → PW-09 | needs-ba-input | gap (2 of 3) | findings call | **Label doubtful.** The requirement itself proposes letting the login screen work over HTTP in development, which asks for a password over an unencrypted channel. |

**Extra rules** (73 pair-runs in all; every one is **applicability**): OE-15 drew 24, OE-19
12, OE-11 7, OE-01 and OE-14 6 each. Some are **label doubtful**, because the labellers left
off a rule that the same reasoning brings in:

- OE-15 → PW-02, PW-03, PW-08 and PW-10: a new password-change flow, on the reasoning that
  put PW-07 on it;
- OE-01 → SM-02: abrupt logouts are session termination;
- OE-09 → SM-03: a session falling back to HTTP is that rule's subject;
- OE-23 → SM-02: as #2105 noted;
- OE-22 → AU-03: forced enrolment binds new authenticators;
- OE-14 → TS-02: unique user identification under an outside provider.

The rest are **defects of the judge**. It brings in the subject's neighbours: on OE-19 sent-fax
tracking, encryption, integrity and transmission; on OE-15, security questions, the
emergency-access procedure and CSRF.

**Defect classes.** Three account for most of the defects:

1. the judge brings in most of the rules that share a requirement's subject, and rules out a
   rule the requirement's text says the flow it changes breaks today;
2. the findings call judges a defect report as the defect, not the fix;
3. the findings call asks about a requested safeguard instead of finding it compliant.

Retrieval is not among them. In the re-read's stage trace, no miss arose as `not-a-candidate`.

### The #2108 fix and re-read

**Where the fix was tuned.** `governing-01` cannot show these defects: it has no defect
report, no password rule and no sign-in flow. So the fix was tuned on a **new tuning split of
real text**, `governing-04-openemr-asvs`: OWASP ASVS 5.0.0 against 25 OpenEMR issues that this
set does not use, labelled blind the same way (its `ANNOTATION.md`). Three prompt lines, each
with an example taken from `governing-04`, none from this set:

- `SAME_SUBJECT_LINE` in the applicability judge (class 1);
- `DEFECT_REPORT_LINE` (class 2) and `SAFEGUARD_REQUESTED_LINE` (class 3) in the findings
  call.

On `governing-04` (Sonnet; the committed reading at `e452afb69`): precision went from
0.57 / 0.55 to 0.71 / 0.71 and verdict accuracy from 0.54 / 0.42 to 0.75 / 0.71, with recall
0.96 / 0.88 before and 0.92 / 0.83 after. On
`governing-01` (Sonnet, two runs each): precision went from 0.42 to 0.52 and verdict accuracy
from 0.68 to 0.85, recall stayed at 1.00, and there were no hard errors before or after.

**Not independent of this set.** This set was read once, at #2105, before the fix. The defect
classes above were found here, and `governing-04`'s requirements were chosen to hold the same
kinds of text. No item, label or rule of this set reached a prompt. But this re-read is less
independent than the first for those kinds of pair, OE-25 above all.

**The re-read**: one reading, three runs, at commit `b7f9f8657` on a clean tree, $2.03.

| Bar | Required | #2105 | #2108: mean | Per run | Pass |
|---|---|---|---|---|---|
| Overall recall | ≥ 0.90 | 0.80 | 0.75 | 0.73 / 0.73 / 0.79 | **no** |
| Non-resembling recall | ≥ 0.85 | 0.50 | 0.50 | 0.50 / 0.50 / 0.50 | **no** (2 pairs) |
| Precision | ≥ 0.60 | 0.52 | **0.76** | 0.75 / 0.80 / 0.74 | yes |
| Citation accuracy | ≥ 0.95 | 1.00 | 1.00 | 1.00 ×3 | yes |
| No-evidence → compliant errors | 0 per run | 0 | 0 | 0 ×3 | yes |

Verdict accuracy went from 0.31 to 0.49. **Two of the five bars still fail, against three
before.** Pair by pair, over the three runs:

| Label | #2105: what the path said | #2108: what the path said |
|---|---|---|
| compliant (39 pair-runs) | compliant 11, needs-ba-input 23, gap 5 | compliant 20, needs-ba-input 19, gap 0 |
| gap (12) | gap 2, needs-ba-input 7, missed 3 | gap 9, needs-ba-input 3, missed 0 |
| needs-ba-input (48) | needs-ba-input 18, gap 13, missed 17 | needs-ba-input 20, gap 3, missed 25 |
| extra rules | 73 (24 on OE-15) | 23 (none on OE-15) |

- **Fixed:** OE-25 → PW-03, the named miss, is found as `gap` in 3 of 3 runs, against 0. The
  extra rules on OE-15 are gone. OE-24 → TS-06 is `compliant` in every run (the defect-report
  line), and so are OE-21 → TS-06 and OE-07 → AU-02 (`gap`).
- **Recall fell (0.80 → 0.75), all of it on `needs-ba-input` pairs.** Every miss of the
  re-read is `judged-does-not-apply`. The same-subject line now rules out a rule that governs
  every new or changed password, on a requirement that creates or forces one:
  - OE-11 → PW-07 (3 of 3) and PW-02 (2 of 3);
  - OE-12 → PW-07 (2 of 3);
  - OE-19 → TS-01 (2 of 3).

  PW-07 reads "When processing a request to establish or change a password", so OE-11 and
  OE-12 do engage it. That is a defect of the new line, not a doubtful label. `governing-04`
  holds no pair of that kind (a flow that sets a password, against a rule on every new
  password). There, recall moved within run-to-run noise (0.96 / 0.88 before, 0.83 to 0.94
  after), so the tuning did not show the loss.
- **Still wrong:** the misses of the first reading other than OE-25 (OE-01 → TS-07, OE-09 →
  TS-10, OE-14 → AS-02 and AU-01, OE-16 → PW-07), and OE-15 → AS-02, still asked about where
  the label is `gap` (3 of 3). Also 19 compliant pair-runs that are still
  asked about, most of them on the label-doubtful OE-12 and OE-25 → AS-02, and on OE-03 and
  OE-04.

**Decision.** The owner's decision of 2026-11-09 stands: governing checks stay on by default,
marked **Preview**, until this set passes its bars. It still fails two of the five, so the
Preview mark stays. The recall loss is a follow-up, to be tuned on a split that holds the
pair it missed. It is never tuned on this set.

### The #2140 attempt and re-read

**What was tried.** #2108's same-subject line ruled out the blocklist rule (PW-07) and the
length rule (PW-02) on OE-11 and OE-12. #2140 added a sentence inside that line, tuned with
Sonnet on `governing-04` and checked on `governing-01`. Its examples are `governing-04`'s
(OS-26, OS-31), and no item, label or rule of this set reached a prompt:

> But a rule on what each new or changed password must be (its length, a check against common
> passwords) applies to a requirement that adds or changes a step where a password is chosen or
> generated (the first administrator's password chosen at setup), and a rule on the strength
> every sign-in must have (a second factor, the strength checked from an identity provider)
> applies to a requirement that adds or changes a way of signing in (signing an encounter
> through single sign-on), even when the requirement says nothing of that rule's matter. Rules
> on what happens around those steps (logging them, notices, other sessions) still apply only
> as above.

Before it could be tuned, `governing-04` needed pairs of this kind with labels it could trust.
This set holds OE-11 → PW-07 and OE-12 → PW-07 only because its consistency pass added them
(both labellers had left them off). `governing-04` had no consistency pass, so #2140 ran one
there, on the counterparts of this set's cross-cutting rules (that set's `ANNOTATION.md`).

**The re-read**: one reading, three runs, at commit `15b11e09e` on a clean tree, $2.20.

| Bar | Required | #2108 | #2140: mean | Per run | Pass |
|---|---|---|---|---|---|
| Overall recall | ≥ 0.90 | 0.75 | 0.83 | 0.85 / 0.82 / 0.82 | **no** |
| Non-resembling recall | ≥ 0.85 | 0.50 | 0.50 | 0.50 / 0.50 / 0.50 | **no** (2 pairs) |
| Precision | ≥ 0.60 | 0.76 | 0.65 | 0.64 / 0.64 / 0.68 | yes |
| Citation accuracy | ≥ 0.95 | 1.00 | 1.00 | 1.00 ×3 | yes |
| No-evidence → compliant errors | 0 per run | 0 | 1 (worst run) | 1 / 1 / 0 | **no** |

| Label | #2108: what the path said | #2140: what the path said |
|---|---|---|
| compliant (39 pair-runs) | compliant 20, needs-ba-input 19, missed 0 | compliant 19, needs-ba-input 17, missed 3 |
| gap (12) | gap 9, needs-ba-input 3, compliant 0, missed 0 | gap 6, needs-ba-input 3, **compliant 2**, missed 1 |
| needs-ba-input (48) | needs-ba-input 20, gap 3, missed 25 | needs-ba-input 29, gap 6, missed 13 |
| extra rules | 23 (none on OE-15) | 44 (12 on OE-15) |

- **The pairs #2140 named are found:** OE-11 → PW-07 and PW-02, OE-12 → PW-07 and OE-16 →
  PW-07 in every run, and OE-14 → AU-01 is no longer missed.
- **The over-application #2108 removed came part of the way back.** OE-15, the password-change
  request, draws PW-01, PW-02, PW-03 and PW-10 again (12 extra pair-runs, against 0 at #2108
  and 24 at #2105); OE-12 draws PW-02, and OE-25 draws PW-02 and PW-07.
- **A wrong `compliant`:** OE-15 → AS-02, labelled `gap`, is `compliant` in 2 of 3 runs. With
  more password rules applying, the findings call reads the request's password procedure as
  meeting AS-02. That breaks the no-evidence bar, which had passed at #2105 and #2108.

**Decision: not shipped.** Three of the five bars would fail, against two now, and the new
failure is the bar that matters most to an analyst: a gap reported as `compliant`. So the
sentence was reverted in the same PR, and the shipped prompts are #2108's. This set has now
been read three times; the next change to the judge must be tuned elsewhere and read here once
more. The follow-up is filed from #2140.
