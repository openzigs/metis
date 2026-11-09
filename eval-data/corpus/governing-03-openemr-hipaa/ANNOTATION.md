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
