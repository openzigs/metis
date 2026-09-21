/**
 * Pure decision logic for the adversarial review panel (Issue #1113, epic #1107).
 *
 * ## Why this exists
 *
 * `.claude/agents/adversarial-reviewer.md` dispatches three independent voters over one
 * change, each on a distinct lens, each told to *disprove* it. The value of that structure
 * collapses if the panel then grades itself: a model asked "how did the panel do?" can
 * launder an uncited hunch into a blocking objection, and can quietly forget that a lens
 * never reported. So the arithmetic is done here, outside every model — the same property
 * that makes Claude Security's three-voter panel trustworthy.
 *
 * Three rules do all the work:
 *
 *   1. **An objection with no `file:line` citation is not actionable.** The issue's wording
 *      is the specification: an unsupported objection cannot be acted on, so it must not
 *      reach the implementer's to-do list. It is *counted and reported* rather than deleted,
 *      so a voter that produces nothing but hunches is visible instead of invisible.
 *   2. **A missing lens is a defect in the run, not a clean result.** Three voters that
 *      answer and one that never did looks identical to a clean panel unless something
 *      counts the lenses. `INCOMPLETE` is therefore its own outcome, distinct from `CLEAR`.
 *   3. **Input we could not parse is not evidence of anything.** A panel has three states,
 *      not two: objections found, no objections found, and *we could not read the
 *      objections*. Issues #1167 and #1170 are both the third state collapsing into the
 *      second — a citation shape the pattern rejected and a severity word the vocabulary did
 *      not know, each degrading the run toward clean. Anything the tally drops or cannot
 *      interpret is recorded as `unparsed`, and `unparsed` feeds `outcome`.
 *
 * Rule 3 reuses `INCOMPLETE` rather than adding a fourth outcome. `INCOMPLETE` already means
 * "the panel did not actually grade what it looked at", already exits 1, and already
 * prescribes the same response — correct the input and re-run. A fourth state would widen the
 * vocabulary every reader, skill table and PR body must carry without changing what anyone
 * does about it.
 *
 * ## Not the product engine's semantics
 *
 * Epic #1107 is explicit that METIS's *finding* verification stays recall-first and never
 * silently drops. That rule is about findings in a generated document, where a lost
 * requirement is invisible to the reader. This module grades *objections against a diff*,
 * where the cost runs the other way: a plausible-but-uncited objection spends an
 * implementer's afternoon and teaches them to discount the next one. Precision-first here,
 * recall-first there, and the two must not be confused.
 */

/**
 * The three lenses. Distinct questions, not three passes of the same question — a second
 * agreeable reviewer adds nothing, which is the whole reason this is not just "run
 * `code-review` twice".
 */
export const LENSES = Object.freeze([
  "over-blocking",
  "test-falsifiability",
  "instruction-correctness",
]);

/**
 * @typedef {object} Objection
 * @property {string} claim what is wrong, in one sentence
 * @property {"blocking"|"advisory"|"unrecognised"} severity `unrecognised` when the voter used
 *   a word outside {@link SEVERITIES}; the tally will not guess which of the two it meant
 * @property {string[]} citations everything the voter offered as evidence
 * @property {string[]} codeCitations the subset that actually points at a file and line
 * @property {boolean} actionable true only with a claim and at least one code citation
 */

/**
 * @typedef {Objection & { lens: string|null }} TaggedObjection
 */

/**
 * @typedef {object} LensVerdict
 * @property {string|null} lens null when the voter named a lens we do not recognise
 * @property {"SOUND"|"OBJECTION"|"INVALID"} verdict recomputed, never taken on trust
 * @property {Objection[]} objections
 * @property {string} notes the audit trail; required even on a clean verdict
 * @property {string[]} errors structural complaints about this voter's output
 * @property {string[]} unparsed the subset of `errors` where input was dropped or could not
 *   be interpreted, as opposed to merely noted
 */

/**
 * @typedef {object} Tally
 * @property {LensVerdict[]} lenses
 * @property {string[]} missingLenses
 * @property {string[]} duplicateLenses
 * @property {boolean} panelComplete
 * @property {TaggedObjection[]} actionable
 * @property {TaggedObjection[]} unsupported
 * @property {number} blockingCount
 * @property {number} advisoryCount
 * @property {number} unrecognisedSeverityCount actionable objections whose severity the tally
 *   refused to guess at, so they count as neither blocking nor advisory
 * @property {number} unsupportedCount
 * @property {string[]} errors
 * @property {string[]} unparsed
 * @property {number} unparsedCount
 * @property {"BLOCKED"|"ADVISORY"|"CLEAR"|"INCOMPLETE"} outcome
 */

/**
 * Severities an objection may carry, in descending order of consequence.
 *
 * Deliberately **two**, and deliberately not widened in response to #1170. `blocking` and
 * `advisory` are a *decision* vocabulary — each answers "may this ship?", which is the only
 * question the tally exists to answer. `major`/`minor`, `critical`/`high`/`low`, `P0`/`P1`
 * are *magnitude* vocabularies, and mapping magnitude onto a decision is precisely the
 * judgement this module was built to keep out of a model's hands: the #1169 voter's `major`
 * ("the headline fix had no test that could fail") is arguable either way, and a tally that
 * guessed would either demote a real blocker or invent one the voter never claimed.
 *
 * Widening the list would also only move the boundary, not remove it — the next hand-written
 * dispatch offers a vocabulary the wider list still does not know. The defect is a prompt that
 * did not copy the contract in `.claude/agents/adversarial-reviewer.md`, and rejecting loudly
 * is what makes that visible at its source.
 */
export const SEVERITIES = Object.freeze(["blocking", "advisory"]);

/**
 * A citation the tally will accept as evidence: `path/to/file.ext:123`, optionally a range
 * (`:123-140`), optionally followed by a short human-readable description
 * (`scripts/x.mjs:66 — the fs.existsSync filter`). The extension requirement is what stops
 * `#1099` or `see the router:42` from counting as code evidence — an issue number is a fine
 * *supporting* citation but it is not a line of code, and this gate exists to require one.
 *
 * The pattern is a **prefix** match, not a whole-string match (#1167). The original `^…$`
 * anchor discarded every citation carrying a trailing description as *uncited*, which is a
 * silent degradation toward `CLEAR` — the one direction a precision-first gate must not fail
 * in. It measurably threw away three confirmed-correct objections on #1163.
 *
 * Three properties keep the loosened form from accepting everything:
 *
 *   - `^` is retained, so the citation must *begin* the string. Prose that merely contains a
 *     colon and a number (`see the router:42`, `the guard fails at line:42`) has a first token
 *     with no `.ext`, and cannot match.
 *   - **`/` is absent from the trailing delimiter set**, which is what rejects
 *     `example.com:8080/api/analysis` — a scheme-less host:port with a path. That is the only
 *     rejection the delimiter set itself buys. An earlier draft of this comment also credited
 *     it with rejecting `next@16.2.11`; that is wrong, and the mistake mattered enough to
 *     record — `next@16.2.11` contains no colon at all and fails the `:[1-9]` requirement
 *     regardless of the lookahead. `.` **is** in the set, deliberately: excluding it bought
 *     nothing (no test depended on it) and cost `server/src/a.ts:42.` — a citation ending a
 *     sentence, discarded as *uncited*, which is #1167's failure direction exactly.
 *   - `(` and `)` are **in** the character class, because Next.js route groups put them in real
 *     paths: 93 tracked files live under `ui/src/app/(authed)/`, and a citation to any of them
 *     was discarded as *uncited* — on paths `shouldRunAdversarialPass` itself declares require a
 *     panel. They cannot let prose in, since the first token must still carry a `.ext`.
 *   - the extension must **start with a letter**. That is what rejects `12.5:30 elapsed`,
 *     `v1.2:34 minutes in` and `10.0.0.1:8080` — durations, version strings and IP:port pairs
 *     whose last dotted segment is numeric. Measured against `git ls-files`: **no file in this
 *     repository has an extension beginning with a digit**, so this costs no real citation.
 *
 * Deliberately a module-level literal: the SAST rule bans `new RegExp(<variable>)`, and a
 * static pattern is also the only version that cannot be widened by a caller.
 */
const CODE_CITATION_PATTERN =
  /^[A-Za-z0-9._\-/@[\]()]+\.[A-Za-z][A-Za-z0-9]*:[1-9][0-9]*(?:-[1-9][0-9]*)?(?=$|[\s,;:)\]}.—–`'"])/;

/**
 * Wrappers a voter is likely to put around a path, stripped before the pattern is applied.
 *
 * Backtick-wrapping a path is close to reflex for a model writing about code, and a rejected
 * citation is discarded *silently* as uncited — the #1167 failure direction. The markdown-link
 * form `[a.ts:42](x)` already passed because `[` is in the character class, so accepting the
 * other two wrappers is consistency, not new licence: stripping a leading quote cannot make
 * prose match, since the first token still needs a `.ext`. The closing wrappers are handled by
 * the delimiter lookahead. `.claude/agents/adversarial-reviewer.md` states the contract too —
 * the tally is the last line of defence, not the first.
 */
const CITATION_WRAPPER_PREFIX = /^[`'"]+/;

/**
 * @param {unknown} citation
 * @returns {boolean} true when the string points at a specific file and line
 */
export function isCodeCitation(citation) {
  if (typeof citation !== "string") return false;
  return CODE_CITATION_PATTERN.test(citation.trim().replace(CITATION_WRAPPER_PREFIX, ""));
}

/**
 * Split a path into the words a human would read in it, so a signal can match a *word*
 * rather than a substring.
 *
 * Substring matching is what #1172 is: `sso` occurs inside `cache-cro`**`sso`**`ver.ts` and
 * `plsql-prepr`**`oce`**`ss`**`o`**`r.ts`, and both fired a three-voter panel. Splitting on
 * `/`, `.`, `-`, `_` and camelCase boundaries removes that entire class at once.
 *
 * The camelCase pass runs in two steps because one is not enough: `([a-z0-9])([A-Z])` alone
 * turns `JWTVerifier` into the single word `jwtverifier`, which then matches no identity
 * term — a silent *under*-fire, the one direction this module must not fail in. The
 * acronym-boundary pass (`([A-Z]+)([A-Z][a-z])`) splits it to `jwt` + `verifier` first.
 *
 * Both patterns are module-level literals with no nested quantifier over an alternation, so
 * neither can backtrack catastrophically; the SAST rule banning `new RegExp(<variable>)` is
 * satisfied by construction.
 *
 * @param {string} path
 * @returns {string[]} lowercase words, in order, with separators and punctuation removed
 */
function pathWords(path) {
  return path
    .replace(ACRONYM_BOUNDARY, "$1 $2")
    .replace(CAMEL_BOUNDARY, "$1 $2")
    .toLowerCase()
    .split(NON_WORD_RUN)
    .filter(Boolean);
}

const ACRONYM_BOUNDARY = /([A-Z]+)([A-Z][a-z])/g;
const CAMEL_BOUNDARY = /([a-z0-9])([A-Z])/g;
const NON_WORD_RUN = /[^a-z0-9]+/;

/**
 * A version number stuck to the end of a word: the `2` in `saml2`, `oauth2`, `session2`.
 *
 * {@link NON_WORD_RUN} treats digits as word characters, so `saml2-binding.ts` splits to
 * `saml2` — a word in no vocabulary here, firing nothing. That is a class the *substring*
 * rule this change replaced caught and this one dropped: `saml2`, `oauth2` and `oidc3` are
 * not exotic, they are how these protocols are conventionally written. It was found in
 * review, not by the suite, because no corpus entry used the convention; four now do.
 *
 * The de-versioned form is *added* to the word list rather than replacing it, so a real
 * word ending in digits keeps its own identity as well.
 *
 * **It feeds only the three checks that can fire, never the disqualifier check** — the
 * qualifier test in {@link matchesIdentitySignal} reads the raw words. Stripping is an
 * inference about what a name means, and this module's standing rule is that a disqualifier
 * may resolve an ambiguity but never overrule an explicit statement (see
 * {@link IDENTITY_ANCHORS}); an inferred word silencing the gate would be exactly that.
 * Measured over all 3,912 tracked paths the stricter form is indistinguishable from the
 * permissive one — identity 98, gate 590 either way — so the caution is free today and only
 * decides the case of a future `ai/token-budget2.ts`, which fires rather than going dark.
 */
const TRAILING_DIGITS = /\d+$/;

/**
 * The words a signal may fire on: every word in the path, plus a de-versioned copy of any
 * word ending in digits.
 *
 * Every arm that can *fire* reads this; the one check that can **silence** the gate — the
 * qualifier test in {@link matchesIdentitySignal} — reads {@link pathWords} directly. See
 * {@link TRAILING_DIGITS} for why that asymmetry is deliberate.
 *
 * @param {string} path a path, or (since #1190) a label — both are `/`- and `:`-separated
 *   word lists as far as {@link pathWords} is concerned
 * @returns {string[]}
 */
function signalWords(path) {
  const raw = pathWords(path);
  return [...raw, ...raw.map((w) => w.replace(TRAILING_DIGITS, "")).filter(Boolean)];
}

/**
 * Words that require a panel unconditionally, wherever they appear in a path.
 *
 * `jwt`, `sso`, `saml`, `oidc`, `ldap` and `oauth` are here for the obvious reason: as
 * *whole words* they have no benign homograph. (As substrings they very much do — `sso`
 * lives inside `crossover` and `preprocessor` — which is what {@link pathWords} handles.)
 * `oauth` is the one term added rather than kept (#1172), and the only *widening* in a
 * change that otherwise only narrows: it costs two tracked paths, `server/src/lib/slack/`
 * `oauth.ts` and its test, an OAuth token-exchange module that got no panel before, and
 * leaving it out while listing `sso`, `saml` and `oidc` would have been an arbitrary hole.
 *
 * **`session` is here for a different and harder-won reason.** It *does* have benign
 * homographs — this repository is full of AI, sandbox and agent conversation sessions — and
 * an earlier draft of this change disqualified them with the same qualifier mechanism
 * `token` uses. The adversarial panel on that draft rejected it, with two independent
 * lenses citing `server/src/lib/library/session-runtime.ts`, whose "runtime" reads like a
 * conversation session and which in fact scopes a lookup by `userId` and throws a 403
 * `PROJECT_SKILL_NOT_ALLOWED`. Checking the rest of the set the same way, **three of the
 * nine paths that mechanism de-gated turned out to do per-user data access** — a third of
 * them. One is worse than merely per-user: `server/src/lib/ai/session-snapshot.ts` reads
 * `findUnique({ where: { id: sessionId } })` at both `:52` and `:129` with **no `userId`
 * scoping at all**, so the qualifier `snapshot` would have de-gated a module whose lookups
 * are unscoped. The lesson generalises past the one file: in a server codebase a "session" is a
 * per-user row whatever adjective precedes it, so *no* adjective is safe evidence that it
 * is not. Disqualifying `session` was a judgement made from file names, and it was wrong at
 * a rate no security gate should accept. It now fires unconditionally, which costs nine
 * paths of over-fire — the cheap direction, and the one this issue asks to be wrong in.
 *
 * ## The words promoted here by #1190
 *
 * `login`, `logout`, `signin`, `signout`, `credential(s)`, `revocation` and `mfa` used to
 * live *only* in {@link IDENTITY_ANCHORS} — trusted enough to overrule a disqualifier and
 * keep `server/src/lib/auth/token-budget.ts` firing, yet too weak to fire on their own.
 * That is not a position a security gate can hold: **a word strong enough to overrule an
 * explicit silencing is strong enough to be a signal.** Measured, the incoherence was
 * costing real coverage — `ui/src/app/login/page.tsx`, `e2e/pages/login.page.ts` and
 * `ui/tests/login-form.test.tsx` (the login surface itself) matched **no signal at all**,
 * and `server/tests/revocation-store.test.ts` and `server/tests/require-mfa.test.ts` went
 * dark while the modules they test fired. {@link IDENTITY_ANCHORS} is now *derived* from
 * this set rather than extending it, so the two cannot drift apart again.
 *
 * `totp`, `webauthn`, `passkey` and `fido` close a hole of a different kind, and one that
 * no corpus of tracked paths could have shown: the vocabulary listed four *federation*
 * protocols and zero *authentication factors*. They match **0 of 3,984 tracked paths**, so
 * they cost nothing today and only decide the first time someone adds passwordless login —
 * exactly the "blind to the naming you have not adopted" class #1190's thread describes.
 *
 * @type {ReadonlySet<string>}
 */
const IDENTITY_TERMS = new Set([
  // federation and session protocols
  "jwt",
  "sso",
  "saml",
  "oidc",
  "ldap",
  "oauth",
  "session",
  "sessions",
  // promoted from IDENTITY_ANCHORS (#1190): able to rescue, unable to fire
  "login",
  "logout",
  "signin",
  "signout",
  "credential",
  "credentials",
  "revocation",
  "mfa",
  // authentication factors (#1190): 0 tracked paths, so free today
  "totp",
  "webauthn",
  "passkey",
  "fido",
]);

/**
 * Words naming an authentication or authorization module outright.
 *
 * Split out of the `(^|\/)(auth|authz|authn)([./-]|$)/i` pattern this arm used to be
 * (#1190). That pattern matched a segment that *begins* with the token, so `auth` at the
 * end of a compound matched nothing: `ui/src/lib/edge-auth.ts` and
 * `e2e/pages/admin-auth.page.ts` — auth modules by name and by content — hit **no signal
 * whatsoever**, and so did **twelve of the fourteen** suffixed `*-authz.*` / `*.authz.*`
 * modules and tests; the remaining two were carried by the `routes/` arm alone. (Measured
 * over all 3,984 tracked paths: 22 contain `authz`, 5 of them `.claude/agent-memory/` notes
 * and 17 code, of which 3 *begin* the segment and so already matched the old pattern. The
 * "sixteen" this docblock used to claim counted neither exclusion — a stale number reading
 * as a stale audit, in the module that makes that its own convention.)
 *
 * The naive repair is to drop the anchor, and it is measurably wrong: a plain substring
 * `auth` fires on **93 more tracked paths that nothing else covers**: 89 Next.js route-group
 * pages under `ui/src/app/(authed)/` that merely sit behind a login, 2 more `authed` tests
 * under `ui/tests/`, and `ui/src/components/custom-agents/AgentAuthoringWizard.tsx` with its
 * test — auth**oring**, the exact
 * `sso`-inside-`crossover` accident #1172 removed. Word-splitting takes all 24 of the real
 * misses and **none** of the 93: measured over all 3,984 tracked paths, the word arm is a
 * strict subset of the substring arm with zero paths lost.
 *
 * `authed` is deliberately **not** here. It is not a synonym for auth work — it is Next.js
 * for "behind a login" — and adding it would fire on **91 paths: 89 files under the
 * `ui/src/app/(authed)/` route group and 2 `ui/tests/authed-*` tests** — whose subject is
 * dashboards, settings and documents. The test corpus pins that as a must-not-fire so the
 * next widening has to argue with a measurement rather than a hunch.
 *
 * @type {ReadonlySet<string>}
 */
const AUTH_TERMS = new Set(["auth", "authn", "authz"]);

/**
 * `token` — the one word genuinely ambiguous enough to disambiguate rather than just fire on.
 *
 * Measured over `git ls-files` (3,911 paths) it names LLM token accounting
 * (`token-tracker`, `token-budget`, `TOKEN_OPTIMIZATION.md`) and design tokens
 * (`contrast-tokens`) far more often than it names a credential. Word-anchoring alone does
 * not help: these are genuine homographs, not substrings, so `docs/TOKEN_OPTIMIZATION.md`
 * splits to the clean word `token` and would still fire.
 *
 * Unlike `session`, the non-credential uses here are a *closed, purpose-built vocabulary* —
 * an LLM cost-accounting subsystem whose files are named after what they measure — rather
 * than an open set of adjectives in front of a per-user noun. That is what makes
 * disambiguating this one defensible and disambiguating `session` not.
 *
 * @type {ReadonlySet<string>}
 */
const AMBIGUOUS_IDENTITY_TERMS = new Set(["token", "tokens"]);

/**
 * Words that, appearing anywhere in the same path, say a `token` is not a credential:
 * **LLM token accounting**, plus design tokens. Enumerated from real tracked paths.
 *
 * This is a denylist and not an allowlist, deliberately and asymmetrically. An allowlist of
 * credential compounds (`access-token`, `api-token`, …) would stop firing the first time
 * someone named a credential module something the list has not seen — and a signal that
 * stops firing reports nothing while doing so. A denylist fails the other way: an
 * unclassified compound fires, spending three voters. That is the cheap direction, and it
 * is the one #1172 asks to be wrong in.
 *
 * The argument is stronger than "someone invents a new name", which can always be answered
 * with "then add it to the list". An allowlist also loses to **inflection**: substituting a
 * generous seven-word allowlist that *contains* `invite` still drops
 * `ui/src/app/invites/[token]/page.tsx` — a real tracked path holding a real invitation
 * token — because the directory is named `invites`. No amount of diligence in populating an
 * allowlist fixes that; only the default direction does.
 *
 * ## What these qualifiers were checked against, and the criterion that matters
 *
 * Review asked the obvious question: the panel rescued `session` because de-gated paths did
 * per-user data access, so does anything this list de-gates do the same? **Two of the 35 do**,
 * and both were read rather than judged by name:
 *
 *   - `server/src/lib/ai/token-budget-controller.ts` — `findMany({ where: { userId } })` at
 *     `:77`, `findFirst({ where: { userId, projectId: null } })` at `:116` and `:177`.
 *   - `server/src/lib/ai/token-tracker.ts` — `dailyRollup(userId)` reading
 *     `findMany({ where: { userId, dayBucket } })` at `:253`, and a per-user row written at
 *     `:321`.
 *
 * Both stay de-gated, and the reason is a **sharper criterion than "touches per-user data"**.
 * What made `session-runtime.ts` a genuine loss was not that it read a user's row; it was
 * that it *decided the authorization itself* — a 403 thrown in that file — while **no other
 * signal covered the file**. Neither module here decides anything: both contain zero 4xx
 * throws, and every non-test consumer that does decide is a `routes/` path that fires.
 * `getUserBudgets` is reachable only from `server/src/routes/usage.ts` (`:143`, `:150`,
 * `requireAuth, requireRole("admin")`), and `dailyRollup` only from
 * `server/src/routes/ai.ts:797` (`requireAuth`, self-scoped through `userIdOrThrow`).
 *
 * So the test a qualifier must survive is: **does it de-gate a file that makes an
 * authorization decision no firing path covers?** Per-user data access is the symptom that
 * sends you to read the file; coverage of the decision is what settles it. That premise is
 * not left to this comment — `adversarial-tally-core.test.mjs` asserts both covering routes
 * still fire, so if the `routes/` signal is ever narrowed, the pin fails with it.
 *
 * @type {ReadonlySet<string>}
 */
const NON_CREDENTIAL_QUALIFIERS = new Set([
  // LLM token accounting
  "budget",
  "usage",
  "cost",
  "count",
  "tracker",
  "tracking",
  "categorizer",
  "category",
  "optimization",
  "breakdown",
  "telemetry",
  // design tokens
  "contrast",
]);

/**
 * Words that re-assert identity and so outrank any qualifier above.
 *
 * Without this, one unlucky path segment could switch the signal off for a module that
 * names authentication outright — `server/src/lib/auth/token-budget.ts` must still fire.
 * A disqualifier is allowed to resolve an ambiguity; it is not allowed to overrule an
 * explicit statement.
 *
 * **Derived, not enumerated (#1190).** This used to be `IDENTITY_TERMS` plus eleven
 * hand-written words, and those eleven were the defect: a word that can overrule a
 * disqualifier but cannot fire on its own is a gate that trusts a word exactly as far as
 * silencing it is expensive. It is now precisely the union of the two firing vocabularies,
 * which makes "every anchor fires on its own" true by construction — and the test **iterates
 * this exported set** to assert it, so a hand-added word fails rather than reintroducing the
 * asymmetry. It is exported for that reason and no other: the first draft of the test
 * hardcoded a 23-word mirror, which made the invariant vacuous, and the #1190 panel proved it
 * by adding `principal` here and watching all 368 tests then in the suite pass.
 *
 * Deriving the loop closes *addition*, and it cannot close *deletion or rename*: a loop over
 * this set tests whatever this set says, so a word that leaves it also leaves the loop. Each
 * word is therefore pinned by name in `PATHS_MUST_FIRE_SPEC` — a hardcoded path carrying that
 * word and no other. Review measured what that is worth: renaming `totp`, `fido`, `authn`,
 * `signout`, `credential` or `credentials` in place — cardinality unchanged, so the loop's
 * `>= 23` guard cannot see it — left the whole suite green while
 * `server/src/lib/identity/totp-verify.ts` and two others flipped from firing to dark.
 *
 * @type {ReadonlySet<string>}
 */
export const IDENTITY_ANCHORS = new Set([...IDENTITY_TERMS, ...AUTH_TERMS]);

/**
 * Does this path handle identity, sessions or token credentials?
 *
 * Measured over all 3,912 tracked paths: 131 fired before, 98 after — 35 dropped, 2 gained
 * (the `oauth` widening above). Every one of the 35 is an LLM-token-accounting file, a
 * design-token file, or a substring accident; none is identity work. Thirteen over-fires
 * deliberately survive, all of them a bare `session` — see {@link IDENTITY_TERMS} for why
 * that word is no longer disqualified at all, and the `ACCEPTED_OVER_FIRE` corpus in the
 * test file, which pins each one so a later narrowing has to argue the point.
 *
 * @param {string} path
 * @returns {boolean}
 */
function matchesIdentitySignal(path) {
  const words = signalWords(path);
  if (words.some((w) => IDENTITY_TERMS.has(w))) return true;
  if (!words.some((w) => AMBIGUOUS_IDENTITY_TERMS.has(w))) return false;
  if (words.some((w) => IDENTITY_ANCHORS.has(w))) return true;
  // `pathWords`, not `signalWords` — see TRAILING_DIGITS: a de-versioned word may fire,
  // never silence.
  return !pathWords(path).some((w) => NON_CREDENTIAL_QUALIFIERS.has(w));
}

/**
 * Does this path name an authentication or authorization module?
 *
 * Measured over all 3,984 tracked paths, **arm-level**: this predicate fires on 78 paths
 * before and **106** after — **28 gained, none lost**. The **gate-level** figure is
 * different and smaller: `shouldRunAdversarialPass` as a whole goes 595 → 624, **+29**,
 * because 4 of this arm's 28 gains were already required by the `routes/`, `secret` or
 * `scope` arms (and 5 of the gate's 29 come from the identity arm, not this one). Quoting
 * one number against the other's baseline produces 102, which is no measurement at all —
 * the panel on #1190 caught exactly that here, so both figures are labelled.
 *
 * See {@link AUTH_TERMS} for why this is a word test rather than the loosened regex, and
 * what the loosened regex would have cost.
 *
 * @param {string} path
 * @returns {boolean}
 */
function matchesAuthSignal(path) {
  return signalWords(path).some((w) => AUTH_TERMS.has(w));
}

/**
 * Wrap a literal pattern as a path predicate, so {@link PATH_SIGNALS} can hold regex-backed
 * and computed signals side by side without a second dispatch mechanism.
 *
 * @param {RegExp} pattern
 * @returns {(path: string) => boolean}
 */
function byPattern(pattern) {
  return (path) => pattern.test(path);
}

/**
 * Dependency manifests and lockfiles — the supply-chain arm (#1249).
 *
 * ## Why a filename set and not a word signal
 *
 * Every other arm asks "does this path contain this *word*", because a path is a name someone
 * chose and the hazard is a homograph. A manifest is the opposite: the filename is fixed by
 * the toolchain, so the strongest possible form of #1172's word rule is available here — an
 * **exact basename match**, which cannot have a substring accident *or* a homograph. It is
 * deliberately not `byPattern(/package\.json/)`: that would fire on
 * `server/src/lib/package-json-reader.ts`, which is #1172 in a new word.
 *
 * ## The lockfile decision, measured rather than argued
 *
 * #1249 asks explicitly whether a **lockfile-only** change should require a panel, warning
 * that getting it wrong permissively "makes every dependabot PR a three-voter panel". Both
 * halves of that were measured against this repository rather than reasoned about:
 *
 *   - Over the **last 300 commits on `main`**: 12 touched `pnpm-lock.yaml`, 22 touched
 *     `package.json` or `pnpm-workspace.yaml`, and **0 touched the lockfile without also
 *     touching a manifest**. So including lockfiles costs *zero* additional panels over that
 *     window — the feared class does not exist here, it is not merely rare.
 *   - `.github/dependabot.yml` groups npm minor/patch bumps into one **monthly** PR per
 *     ecosystem, and every npm bump edits `package.json` too. A dependabot PR therefore fires
 *     on the manifest half whatever this arm decides about lockfiles; excluding lockfiles
 *     would not have spared a single one.
 *
 * What excluding them *would* cost is the one case a manifest rule structurally cannot see:
 * `pnpm update` moving a **transitive** dependency, which rewrites only the lockfile. That is
 * a real change to what ships, with no change to the declared set — precisely the
 * supply-chain shape #1240 was, and the one an "only the declared dependencies count" rule
 * would report nothing about while missing.
 *
 * So lockfiles are **in**, on a measurement rather than a preference. The measurement is the
 * part that expires: if `pnpm-lock.yaml` ever starts moving on its own — a bot that runs
 * `pnpm update` on a schedule would do it — re-run the count above before assuming this is
 * still free.
 *
 * ## Over-fire cost
 *
 * **Arm 14, all 14 new to the gate** (of 4,077 tracked paths; the gate as a whole moves
 * 630 → 736 across all four arms #1249 adds). Ten are `package.json` across the workspace,
 * plus `pnpm-lock.yaml`, `pnpm-workspace.yaml`, and the Python sidecar's `requirements.txt`
 * and `pyproject.toml`. There is no over-fire to accept: every one of the 14 *is* a
 * dependency manifest.
 *
 * Entries for ecosystems this repo does not use (`go.mod`, `Cargo.lock`, `pom.xml`, …) match
 * **0 tracked paths**, so they cost nothing today. That is the same bet {@link IDENTITY_TERMS}
 * makes with `totp`/`webauthn`/`passkey`/`fido`, and for the same reason: a corpus of paths
 * this repo already has is structurally incapable of noticing a naming it has not adopted yet.
 *
 * Compared case-insensitively because a manifest's case is the toolchain's business and not
 * something this gate should be the first to discover a platform difference in.
 *
 * @type {ReadonlySet<string>}
 */
export const DEPENDENCY_MANIFEST_FILES = new Set([
  // npm / pnpm / yarn — the ecosystems this repo actually ships
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  ".npmrc",
  // Python — `metis-sql-lineage/` is a FastAPI sidecar
  "requirements.txt",
  "pipfile.lock",
  "poetry.lock",
  "pyproject.toml",
  // ecosystems not adopted here: 0 tracked paths, free today, decide the first bump
  "go.mod",
  "go.sum",
  "cargo.toml",
  "cargo.lock",
  "gemfile.lock",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
]);

/**
 * Does this path declare or pin a dependency?
 *
 * @param {string} path
 * @returns {boolean}
 */
function matchesSupplyChainSignal(path) {
  const basename = path.split("/").pop() ?? "";
  return DEPENDENCY_MANIFEST_FILES.has(basename.toLowerCase());
}

/**
 * Words naming a **security or verification gate** — the recursion arm (#1249).
 *
 * A change that weakens a gate is strictly worse than a change the gate would have caught,
 * because the gate goes on reporting green afterwards. #1215 found eight fail-opens in
 * exactly these files. And the recursion #1249 names is real and was live until this change:
 * **`scripts/lib/adversarial-tally-core.mjs` matched no signal**, so a PR narrowing
 * `PATH_SIGNALS` — this very edit — required no panel. `adversarial` is what closes that, and
 * this file now fires on itself.
 *
 * ## Over-fire cost
 *
 * **Arm 26, of which 25 are new to the gate** (of 4,077 tracked paths). The genuine
 * gates among them are `.github/workflows/sast.yml`, `.gitleaks.toml`,
 * `.github/dependabot.yml`, `scripts/lib/sast-waiver-gate.test.mjs`,
 * `scripts/lib/adversarial-tally-core.mjs` and its test, `scripts/adversarial-tally.mjs`,
 * `scripts/lib/agent-frontmatter-core.mjs` and its runner and test,
 * `scripts/verify-agent-frontmatter.mjs`, and the agent and skill files that define the
 * panel's contract.
 *
 * Two classes of over-fire are accepted rather than suppressed:
 *
 *   - **Prose about a gate** — 8 of the 25 are `.claude/agent-memory/` notes and `.changes/`
 *     fragments carrying `sast`, `semgrep`, `waiver`, `advisory` or `adversarial` (a ninth,
 *     `.changes/unreleased/1190-adversarial-auth-under-fire.md`, is the one arm hit that
 *     already fired, which is why the arm is 26 and the gain 25). This is the identical
 *     trade #1190 made and documented in its `ACCEPTED_OVER_FIRE`: suppressing it means a
 *     path-prefix disqualifier over `.claude/agent-memory/`, and a prefix rule that silences a
 *     whole subtree is the mechanism the #1172 panel rejected. It is also an **open class** —
 *     `CLAUDE.md` requires every `code-issue` PR to commit its memory files, so a future note
 *     named `*waiver*` joins it without a decision.
 *   - **`server/src/lib/library/frontmatter.ts`** and its test, which are not a gate at all.
 *     They are a markdown front-matter parser over **uploaded** project files, so they are
 *     squarely inside {@link matchesUntrustedParserSignal}'s class and would fire on their own
 *     merits if that arm had named them. Firing here is early, not wrong.
 *
 * ## What is deliberately NOT here: `.github/workflows/` wholesale
 *
 * Twelve tracked paths, so the count would look cheap. The frequency does not: dependabot's
 * `github-actions` ecosystem bumps the SHA-pinned `uses:` refs in **every** workflow on a
 * monthly grouped PR, and `ci.yml`, `build-images.yml` and the two `eval-*-nightly.yml`
 * files are not security gates. `sast` reaches `sast.yml`, which is the workflow #1215 and
 * #1240 both actually moved, and `dependabot` reaches the config that decides the cadence.
 * The gap this leaves is a change that disables a job in `ci.yml`; that is real, and the
 * honest answer is that it is a *CI* gate rather than a security gate and no word in a
 * filename can tell the two apart. Named here so a later widening argues with this paragraph
 * rather than rediscovering it.
 *
 * @type {ReadonlySet<string>}
 */
export const SECURITY_GATE_TERMS = new Set([
  // scanners and their configuration
  "sast",
  "semgrep",
  "codeql",
  "gitleaks",
  "trivy",
  "snyk",
  "osv",
  // the vocabulary of suppressing or accepting a finding — the fail-open surface itself
  "waiver",
  "waivers",
  "advisory",
  "advisories",
  "cve",
  // the bots and gates that decide what reaches the tree
  "dependabot",
  "adversarial",
  "frontmatter",
]);

/**
 * Does this path implement, configure or suppress a security gate?
 *
 * @param {string} path
 * @returns {boolean}
 */
function matchesSecurityGateSignal(path) {
  return signalWords(path).some((w) => SECURITY_GATE_TERMS.has(w));
}

/**
 * Words naming a **parser over untrusted input** (#1249).
 *
 * Three ReDoS fixes landed in one session — #1220, #1244 and #1253 — all three in code that
 * reads raw model output, and a fourth (#1260) was open while this was written. None required
 * a panel. Model output is untrusted input in the ordinary sense: it is attacker-influenceable
 * through the documents and repositories a user uploads, and #1220 was measured at 10.5 s of
 * event-loop stall.
 *
 * ## Two clauses, because a filename vocabulary alone misses the two modules that matter
 *
 * The parse vocabulary reaches `ai/providers/tool-tag-parser.ts`, `documents/parsers.ts`,
 * `code-graph/parsers*.ts`, `spec-kit/parser.ts` and the rest — but **not**
 * `analysis/agent-loop.ts` or `analysis/agent-runner.ts`, which is where all three ReDoS
 * defects actually were. Those two are named by a compound: a path carrying `agent` **and**
 * `loop` or `runner`. A compound is what keeps this from being `agent` on its own: measured
 * against `git ls-files`, `agent` is **268 tracked paths** and `agent`-or-`agents` is **335**,
 * and adding either to the vocabulary takes this arm from 35 to 290. (An earlier draft of this
 * line claimed 539, which reproduces under no measure — word, substring or occurrence count —
 * and the #1249 panel caught it on two independent lenses. It is recorded rather than quietly
 * corrected because an unreproducible figure in a docblock whose stated convention is
 * "measured against `git ls-files`" is exactly the stale-audit-reading-as-audit failure the
 * `AUTH_TERMS` docblock already had to correct once.)
 *
 * ## Over-fire cost
 *
 * **Arm 35, all 35 new to the gate** (of 4,077 tracked paths) — 24 from the parse vocabulary
 * and 11 from the agent-transcript compound. Per word, `parser` carries 12, `parsers` 7,
 * `redos` 6 and `parse` 3; `parsing`, `lexer`, `unescape` and `deserialize`/`deserialise`
 * carry **0 tracked paths each** and are the same free bet {@link IDENTITY_TERMS} makes with
 * `webauthn`.
 *
 * ## `tokenizer` is deliberately absent, and the existing corpus is why
 *
 * The first draft of this set carried `tokenizer` and `tokenize`. They broke a pinned
 * must-not-fire: `.claude/agent-memory/code-issue/project_bm25-tokenizer-snake-split.md` sits
 * in #1172's `MUST_NOT_FIRE` under "design tokens, and a BM25 *tokenizer*", asserting
 * `{ required: false, reasons: [] }` outright.
 *
 * The pin is right and the draft was wrong. In this repository a "tokenizer" is BM25 lexical
 * search — the same homograph `token` already is, one derivation further on — not a parser
 * over anything hostile. The two words contributed **1 tracked path between them, that memory
 * note, and 0 code paths**, so removing them costs no coverage at all. `lexer` stays and
 * carries the genuine "hand-written scanner over untrusted text" class at zero cost today.
 *
 * Recorded at length because the temptation was to widen the corpus instead: a gate whose
 * author edits a must-not-fire pin to make his own addition pass has removed the only
 * mechanism that could have told him the addition was wrong.
 *
 * `redos` earns its place rather than being decorative, which is worth recording because the
 * first draft of this comment claimed the opposite: **it uniquely contributes 5 paths**,
 * including `.changes/unreleased/1253-extract-json-object-fence-redos.md`, whose other words
 * are `extract`, `json`, `object` and `fence` — none of them in any vocabulary here.
 *
 * The judgement call is `code-graph/parsers*.ts` and `documents/parsers.ts` — 10 or so paths
 * that parse **uploaded source files**, which is a broader reading of "untrusted" than model
 * output. It is the correct reading: those parsers run over whatever repository a user
 * imports, which is the least trusted input this product accepts.
 *
 * The one clear over-fire is `scripts/lib/verify-agent-frontmatter-runner.test.mjs`, which
 * the compound reaches through `agent` + `runner` while being a *test runner*, not a
 * transcript reader. It is already required by the gate arm ({@link SECURITY_GATE_TERMS}
 * `frontmatter`), so it costs no panel that was not already owed.
 *
 * `extract`/`extractor` was measured and **rejected**: 53 new paths — half again the whole
 * arm — of which 21 are `*-extractor.ts` (16 of them under `server/src/lib/code-graph/`) ORM
 * lineage extractors doing schema analysis rather than parsing a hostile string, and the rest
 * are their tests and eval fixtures. (An earlier draft said "~45 code-graph extractors"; the
 * #1249 panel measured 16 and let it pass as hedged. It is corrected rather than left, because
 * a tilde is not a licence in a docblock whose convention is `git ls-files`.)
 * `extractJsonObject` (the #1253 defect) lives in `agent-runner.ts`
 * and is reached by the compound clause instead, so the vocabulary buys nothing the compound
 * does not already have — at four times the cost.
 *
 * @type {ReadonlySet<string>}
 */
export const UNTRUSTED_PARSER_TERMS = new Set([
  "parse",
  "parser",
  "parsers",
  "parsing",
  // `tokenizer`/`tokenize` are deliberately ABSENT — see the docblock's homograph paragraph.
  "lexer",
  "unescape",
  "deserialize",
  "deserialise",
  "redos",
]);

/**
 * The second clause of {@link matchesUntrustedParserSignal}: the modules that read a raw
 * agent transcript. A compound, so neither half fires alone.
 *
 * @type {ReadonlySet<string>}
 */
export const AGENT_TRANSCRIPT_READERS = new Set(["loop", "runner"]);

/**
 * Does this path parse input the product does not control?
 *
 * @param {string} path
 * @returns {boolean}
 */
function matchesUntrustedParserSignal(path) {
  const words = signalWords(path);
  if (words.some((w) => UNTRUSTED_PARSER_TERMS.has(w))) return true;
  return (
    words.some((w) => w === "agent" || w === "agents") &&
    words.some((w) => AGENT_TRANSCRIPT_READERS.has(w))
  );
}

/**
 * Words that, next to `ai`, name **provider or model configuration** (#1249).
 *
 * #1219's `Object.assign` prototype-pollution sink is in `server/src/lib/ai/config.ts`, and
 * `loadAIConfig` is reachable from four request-path callers — so this is request-path code
 * that merges attacker-influenceable keys, and it required no panel. Provider modules are the
 * same surface one layer out: they build the request and read the response.
 *
 * ## A compound, because neither half is a signal alone
 *
 * `config` on its own fires on 54 new paths — every `vitest.config.ts`, `eslint.config.mjs`
 * and `playwright.config.ts` in the tree. `ai` on its own is the whole `server/src/lib/ai/`
 * subtree at **85 new paths**, most of it cost accounting, caching and telemetry that no
 * argument in #1249 covers. The conjunction is 36, and every one of them is configuration or
 * provider code.
 *
 * ## Over-fire cost
 *
 * **Arm 40, of which 36 are new to the gate** (of 4,077 tracked paths). The 4 already required
 * are named individually, because an earlier draft of this paragraph got two of them wrong and
 * the #1249 panel caught it on two independent lenses — this module's own convention is that a
 * figure here is audited, so an unaudited attribution is a defect and not a rounding:
 *
 *   - `server/prisma/migrations/20260425202100_add_project_ai_provider/migration.sql` and
 *     `…_add_project_ai_model/migration.sql` — the **migration** arm.
 *   - `server/tests/ai-config-vault-precedence.test.ts` — the **secrets** arm, on `vault`.
 *   - `server/tests/ai-session-project-provider.test.ts` — the **identity** arm, on `session`.
 *
 * The draft credited the last two to the parser arm, which cannot be right for a reason worth
 * keeping: the parser arm is *also* new in this change, so nothing it reaches can be in the
 * "already required" set at all. `server/src/lib/ai/providers/tool-tag-parser.ts` and its test
 * are inside the 36, not outside them.
 *
 * The looser whole-subtree alternative was measured at 85 new and rejected on that number: an
 * arm that fires on `ai/cost-estimator.ts` teaches readers that this gate does not mean
 * anything.
 *
 * `ai` is matched as a **word**, not as a path segment, which is a deliberate widening of the
 * first draft and worth naming because it is where four of the 36 come from:
 * `ui/src/components/projects/ai-model-picker.tsx`, `ai-provider-picker.tsx` and their tests
 * pick the model and provider a project runs on, and a segment rule (`server/src/lib/ai/`)
 * would have called that configuration surface out of scope for being in the UI.
 *
 * `models` and `configuration` carry **0 tracked paths** and are here for the same reason
 * `webauthn` is: {@link signalWords} does not stem, so `model-router.ts` and a future
 * `models.ts` are the same subject to a reader and different words to this set.
 *
 * @type {ReadonlySet<string>}
 */
export const AI_CONFIG_TERMS = new Set([
  "config",
  "configuration",
  "provider",
  "providers",
  "model",
  "models",
]);

/**
 * Does this path configure an AI provider or model?
 *
 * @param {string} path
 * @returns {boolean}
 */
function matchesAiConfigSignal(path) {
  const words = signalWords(path);
  return words.some((w) => w === "ai") && words.some((w) => AI_CONFIG_TERMS.has(w));
}

/**
 * Words naming a **redaction, audit or logging sink** — the arm for code that *implements* a
 * security control rather than being named after one (#1275).
 *
 * ## The hole, stated exactly
 *
 * The secrets arm is `secret|vault|credential|passphrase|cipher|crypto`. The files that decide
 * what counts as a secret are `server/src/lib/logger.ts`,
 * `server/src/lib/sandbox/audit/redact.ts`, `server/src/lib/audit/audit-service.ts`,
 * `server/src/lib/custom-agents/invocation-audit.ts` and
 * `server/src/lib/connectors/pii-redactor.ts`. **None of them contains any of those six
 * words.** So the vocabulary indexed on the *name* of the control is blind to the
 * *implementation* of it — the same shape as #1249's four missing categories, one level over.
 *
 * Measured against PR #1271's real `gh pr view 1271 --json files` list, which narrows exactly
 * this logic on a *persisted* sink: the gate returned `required: true` — but on **one reason**,
 * `.claude/agent-memory/code-issue/project_logger-redacts-any-token-key.md`, a memory note whose
 * *filename* carries `token`. Strip the two prose classes every `code-issue` PR carries by
 * policy and **all nine code paths were dark**, `{ required: false, reasons: [] }`. That is
 * #1249's "the arms were doing another arm's work by coincidence, and a coincidence is not
 * coverage", reproduced verbatim in the arm #1249 itself added the coverage test for.
 *
 * ## Why a word vocabulary, and not the exact-path registry the issue leans toward
 *
 * #1275 offers three mechanisms and prefers a small exact-path registry of known security
 * controls, mirroring {@link DEPENDENCY_MANIFEST_FILES}, which measured at zero over-fire. It
 * was rejected **on a measurement, not a preference**: a registry seeded from the files #1271
 * touched is a corpus of one PR, and `git ls-files` says that corpus is missing most of the
 * class. **Eleven sink implementations are tracked today; #1271 touches four**, so a registry
 * seeded from it leaves **seven** silent. Six of the seven fired *no signal at all* before this
 * change — `server/src/lib/audit/mcp-audit.ts`,
 * `server/src/lib/sandbox/audit/audit-emitter.ts`,
 * `server/src/lib/sandbox/repos/sandbox-audit-event.repo.ts`,
 * `server/src/lib/mcp/provisioners/log-streamer.ts`, `.github/hooks/scripts/terminal-audit.mjs`
 * and — the one that settles it — **`server/src/lib/connectors/pii-redactor.ts`**, a fifth
 * redaction implementation named in no issue in this thread. (The seventh,
 * `server/src/middleware/request-logger.ts`, already fired on the middleware arm.)
 *
 * The first draft of this paragraph said "six sinks exist, #1271 touches four" while listing
 * six *further* files below it — 4 + 6 = 10 by its own enumeration, and 11 once
 * `request-logger.ts` is counted. **All three panel lenses caught it independently**, and it is
 * corrected in place rather than quietly, because this module's stated convention is that a
 * figure here is measured against `git ls-files` and an unaudited figure reads as an audited one.
 *
 * The exact-basename rule is right for a *manifest* because the toolchain fixes the filename,
 * so the set is closed by something outside this repository. Nothing closes the set of security
 * controls; a registry of them is a snapshot that goes stale the first time someone writes a
 * twelfth sink, and goes stale **silently**, which is the direction {@link SECURITY_GATE_TERMS}
 * exists to argue against. Measured the other way: every one of the eleven is named `*audit*`,
 * `*log*` or `*redact*` — **11 of 11** — so a word vocabulary covers today's registry *and* the
 * convention that produced it.
 *
 * The marker-comment mechanism (#1275's option 3) is rejected for the reason the issue itself
 * gives: a new file written without the marker fires nothing, which is fail-open. It is also
 * unavailable here — every arm in this module reads a *path*, and `shouldRunAdversarialPass`
 * is given changed paths, never file contents.
 *
 * ## `log` as a word costs 5 paths, not 85 — the issue's premise was a substring intuition
 *
 * #1275 warns that "`log` alone would be worse than any of those", against #1249's rejected
 * signals (`server/src/lib/ai/` at 85, `config` at 54, `extract|extractor` at 52). That is true
 * of a substring rule and **false of a word rule**, and the gap is the whole point of #1172.
 * Measured over all 4,093 tracked paths: `/log/i` as a substring is **57 paths**; `log` as a
 * word is **5**, and the whole logging sub-vocabulary (`log`, `logs`, `logger`, `logging`) is
 * **10**. The remaining **47** are pure substring accidents: `dialog` (22), `changelog` (8),
 * `login` (8), `logical` (7), `tautology` (1) and `logout` (1) — every one of them
 * `sso`-inside-`crossover` in a different word, and `login`/`logout` already fire on the
 * identity and auth arms anyway. (An earlier draft called these "the 52 casualties", subtracting
 * the 5 `log` word-hits from 57 while the arm also matches 5 `logger` paths — one of which is
 * `server/src/lib/logger.ts`, this issue's headline file, so it is the opposite of a casualty.
 * Two lenses caught the arithmetic.) Recorded at length because the number that would have
 * killed the cheapest correct mechanism was an estimate, not a measurement.
 *
 * A compound (#1275's option 1 — `redact` **and** a `server/src/lib/` prefix) was measured and
 * is unnecessary rather than wrong: the bare words cost 5 and 8 paths, so a compound buys
 * nothing and would cost `.github/hooks/scripts/terminal-audit.mjs` and the two UI audit-log
 * surfaces, which are in class. A compound earns its complexity when a half costs 268 paths
 * ({@link AGENT_TRANSCRIPT_READERS}) or 85 ({@link AI_CONFIG_TERMS}); at 5 it is ceremony.
 *
 * ## Over-fire cost, per signal
 *
 * **Arm 43, of which 37 are new to the gate** (of 4,093 tracked paths; the gate moves
 * **740 → 777**). Per word, in isolation, arm-level: `audit` **32**, `logger` **5**, `log`
 * **5**, `redact` **2**, `redactor` **2**, `pii` **2**, `redaction` **1**, `redacts` **1**.
 * `redacted`, `redactors`, `audits`, `auditing`, `logs`, `logging`, `scrub`, `scrubber` and
 * `scrubbing` carry **0 tracked paths each** — the same free bet {@link IDENTITY_TERMS} makes
 * with `webauthn`, and for the same reason: {@link signalWords} does not stem, so `audit-*.ts`
 * and a future `auditing.ts` are one subject to a reader and two words to this set.
 *
 * By sub-vocabulary: redaction **6 paths / 5 new**, audit **32 / 28**, logging **10 / 8**.
 * `audit` is where nearly all the cost is, and it is the word that reaches
 * `audit-service.ts`, `invocation-audit.ts`, `mcp-audit.ts`, `audit-emitter.ts` and
 * `sandbox-audit-event.repo.ts`, so it is not severable.
 *
 * Four classes of over-fire are accepted rather than suppressed:
 *
 *   - **Prose about an audit** — 7 of the 37 are `.claude/agent-memory/` notes and `.changes/`
 *     fragments. The identical trade #1190 and #1249 both made and pinned; suppressing it means
 *     a path-prefix disqualifier over a whole subtree, the mechanism the #1172 panel rejected.
 *     An **open class**: `CLAUDE.md` requires every `code-issue` PR to commit memory files.
 *   - **`docs/accessibility/SR_AUDIT.md`** — a screen-reader audit, and the purest homograph in
 *     the set. One path, and no word-level rule can tell it from a security audit.
 *   - **`server/src/lib/agents/pr-reviewer/pr-audit.{ts,test.ts}`** — a PR-review agent, which
 *     audits a diff rather than recording a security event. Adjacent to
 *     {@link SECURITY_GATE_TERMS}'s class rather than inside this one; two paths.
 *   - **`eval-data/corpus/docretrieval-02-metis-docs-wide/docs/security/2026-q2-mcp-audit.md`**
 *     — a fixture copy of a real security document, in the same accepted class as #1190's
 *     `eval-data/corpus/prd-01-auth-portal/`.
 *
 * ## What is deliberately NOT here
 *
 * `mask`/`masking`: `mask` is 0 tracked paths and a strong homograph (bitmask, CSS mask, input
 * mask), so it is a bad free bet rather than a free one; `masking` is 1 path,
 * `server/tests/admin-auth-secret-masking.test.ts`, which already fires on `secret` and `auth`.
 * `anonymize`/`anonymise`: 0 paths, but they name a data-lifecycle operation over stored
 * records rather than a guard on a sink, so they belong to a retention arm nobody has needed
 * yet. `sanitize` is already carried by the existing `sanitiz` arm and adding it here would
 * double-count. Named so a later widening argues with this paragraph.
 *
 * @type {ReadonlySet<string>}
 */
export const REDACTION_SINK_TERMS = new Set([
  // the redaction guard itself
  "redact",
  "redacts",
  "redacted",
  "redaction",
  "redactor",
  "redactors",
  "pii",
  // the conventional synonym, 0 tracked paths: free today, decides the first `log-scrubber.ts`
  "scrub",
  "scrubber",
  "scrubbing",
  // the persisted security record
  "audit",
  "audits",
  "auditing",
  // the sink a secret leaks through when the guard is narrowed
  "log",
  "logs",
  "logger",
  "logging",
]);

/**
 * Does this path implement a sink that must not emit a secret?
 *
 * @param {string} path
 * @returns {boolean}
 */
function matchesRedactionSinkSignal(path) {
  return signalWords(path).some((w) => REDACTION_SINK_TERMS.has(w));
}

/**
 * Path signals that make a change security-relevant enough to be worth a panel. Issue #1113
 * scopes the pilot to "security-relevant or authorization-touching changes first, where the
 * cost is most justified", and this is that predicate written down rather than left to each
 * agent's judgement.
 *
 * Route and middleware paths are included on purpose: in this repository every router is an
 * authorization surface (epic #1051 found five unguarded ones and baselined twenty-three
 * more), so "it is only a route change" has not been a safe assumption here.
 *
 * ## The substring audit (#1172)
 *
 * Every other entry below was run against all 3,911 tracked paths looking for the hazard the
 * identity signal had. The result, recorded so nobody re-derives it:
 *
 *   - `permission|rbac|role` — 13 hits, all genuine. #1172 predicted `role` would match
 *     `rollback`; it does not (`rollback` has no `role` in it), and neither does `controller`
 *     (`rolle`, not `role`). **Acceptable as-is.**
 *   - `secret|vault|credential|passphrase|cipher|crypto` — 43 hits, all genuine. No
 *     cryptocurrency file exists here, and `cipher` matched only `vault-key-cipher`.
 *     **Acceptable as-is.**
 *   - `scope|tenant|…` — 42 hits; two are non-authz uses of "scope"
 *     (`docs-gen/message-cache-scope`, `impact-analysis/impact-llm-scope`). `telescope`
 *     matches nothing here. **Acceptable**: two paths, and both are adjacent enough to
 *     visibility rules that a panel is not absurd.
 *   - `middleware`, `routes?/`, `rate-?limit`, `ssrf|safe-fetch|allow-?list|sanitiz`,
 *     `prisma/schema|migrations?/` — no false positive found. **Acceptable as-is.**
 *
 * The one *under*-fire #1172 found and deliberately left — the auth pattern anchoring on
 * `(^|\/)`, so `ui/src/lib/edge-auth.ts` and `e2e/pages/admin-auth.page.ts` matched no
 * signal at all — is fixed in #1190, by extending #1172's word split to that arm rather
 * than by loosening the anchor. See {@link AUTH_TERMS}.
 *
 * ## The shape of the hole #1249 closed, and what it says about this list
 *
 * Every arm above `matchesSupplyChainSignal` is a **classic web-app authorization surface**:
 * auth, middleware, routes, permissions, sessions, secrets, SSRF, rate limits, tenancy,
 * migrations. That is a coherent list and it was correct on everything it covered — #1249 is
 * explicit that this is *not* the fail-open class of #1215, since nothing is swallowed and no
 * default reads as clean. It simply had no opinion about supply chain, about the gates
 * themselves, about parsers, or about model configuration, which is what this repository
 * actually ships defects in.
 *
 * Measured over every PR merged in the session that filed #1249 — sixteen, against their real
 * `gh pr view --json files` lists, not approximations — the ten security-relevant ones
 * returned `required: false`. Three of the four that returned `true` did so by accident, on a
 * `.claude/agent-memory/` note whose *filename* happened to carry `token` or `scope`, not on
 * anything the PR changed. The `session`/`scope` arms were doing the work of a supply-chain
 * arm by coincidence, and a coincidence is not coverage.
 *
 * The generalisable lesson, recorded because the next hole will not be one of these four: a
 * vocabulary drawn from *one* threat model covers that threat model and reports silence
 * everywhere else. The four arms added here were derived from what this repo's own merged
 * security PRs touched — which is a corpus, not a taxonomy, and is the only kind of evidence
 * that could have found them.
 *
 * ## The hole #1275 closed, which is the same lesson one level further in
 *
 * #1249 widened by *category* and the gate still had no opinion about the files that
 * **implement** a control, as opposed to the files named after one. `logger.ts`, `redact.ts`
 * and `audit-service.ts` decide what counts as a secret and carry none of the six words in the
 * secrets arm, so PR #1271 — which narrows exactly that logic on a persisted sink — fired only
 * on a memory note's filename. Restated for the next hole: **an arm indexed on the name of a
 * threat is blind to the code that answers it.** See {@link REDACTION_SINK_TERMS}.
 *
 * @type {ReadonlyArray<{ match: (path: string) => boolean, reason: string }>}
 */
const PATH_SIGNALS = Object.freeze([
  { match: matchesAuthSignal, reason: "authentication/authorization module" },
  { match: byPattern(/middleware/i), reason: "middleware (a request-path chokepoint)" },
  {
    match: byPattern(/(^|\/)routes?\//i),
    reason: "route handler (every router here is an authz surface)",
  },
  { match: byPattern(/permission|rbac|role/i), reason: "permission or role logic" },
  { match: matchesIdentitySignal, reason: "identity or session handling" },
  {
    match: byPattern(/secret|vault|credential|passphrase|cipher|crypto/i),
    reason: "secret or cryptographic material",
  },
  {
    match: byPattern(/ssrf|safe-fetch|allow-?list|sanitiz/i),
    reason: "request-forgery or input-sanitisation guard",
  },
  { match: byPattern(/rate-?limit/i), reason: "rate limiting" },
  {
    match: byPattern(/scope|tenant|workspace-access|project-access/i),
    reason: "tenant or project scoping",
  },
  { match: byPattern(/prisma\/schema|migrations?\//i), reason: "database schema or migration" },
  // --- #1249: four categories the list above had no opinion about at all ---
  {
    match: matchesSupplyChainSignal,
    reason: "dependency manifest or lockfile (supply chain)",
  },
  {
    match: matchesSecurityGateSignal,
    reason: "a security or verification gate — weakening one reports green afterwards",
  },
  {
    match: matchesUntrustedParserSignal,
    reason: "parser over untrusted input (model output or uploaded source)",
  },
  { match: matchesAiConfigSignal, reason: "AI provider or model configuration" },
  // --- #1275: the implementation of a security control, invisible to the control's name ---
  {
    match: matchesRedactionSinkSignal,
    reason: "redaction, audit or logging sink — a secret leaks here by omission",
  },
]);

/**
 * Words in a label that make a panel required regardless of which files moved.
 *
 * ## Why this is a word set and not the `/security|vuln|owasp|authz/i` it replaced (#1190)
 *
 * That pattern matched exactly `security`, `type:security` and `area:security` out of the
 * ~99 labels defined on this repository — and **not `auth` or `area:auth`, which is what
 * this repo actually labels authentication work with.** An authentication PR labelled
 * `area:auth` that touched no matching path got no panel at all, and reported nothing while
 * not getting one.
 *
 * A label is a `:`- and `-`-separated word list, so {@link pathWords} reads it exactly as it
 * reads a path — which means the label arm gets the substring safety of #1172's word split
 * for free, instead of relying on a controlled vocabulary staying controlled. #1172 audited
 * the unanchored form as *acceptable today*; that audit expires the moment someone adds a
 * label, and "acceptable until the vocabulary changes" is not a property worth keeping when
 * the alternative costs one function call.
 *
 * ## The vocabulary is derived, not invented
 *
 * It is {@link IDENTITY_ANCHORS} — every word the path arms already fire on — plus the
 * vulnerability classes {@link SECURITY_TITLE_PATTERN} already recognises. Three arms
 * disagreeing about whether `auth` means security work is how #1190 happened; deriving the
 * third from the other two is what stops it recurring. Two consequences worth naming:
 *
 *   - `token` is **excluded automatically**, because it lives in
 *     {@link AMBIGUOUS_IDENTITY_TERMS} rather than {@link IDENTITY_TERMS}. That is load
 *     bearing: this repo has a `token-optimization` label, and it must not fire.
 *   - `vulnerability` and `vulnerabilities` are spelled out alongside `vuln`. The old
 *     pattern got those by prefix; a word set does not, and silently dropping them would be
 *     a narrowing smuggled inside a widening.
 *
 * Measured over all 99 labels: 3 fired before, 5 after — `auth` and `area:auth` gained,
 * none lost.
 *
 * @type {ReadonlySet<string>}
 */
export const SECURITY_LABEL_WORDS = new Set([
  ...IDENTITY_ANCHORS,
  "security",
  "vuln",
  "vulnerability",
  "vulnerabilities",
  "owasp",
  // The vulnerability classes SECURITY_TITLE_PATTERN already names. Parity is pinned by a
  // test that *parses the live pattern* rather than copying it, so adding a word there and
  // not here fails; writing that test is what caught `authorization` missing from this list,
  // and the #1190 panel is what caught the first version copying the pattern instead.
  // Words below that neither arm derives (`rbac`, `permission`, `secret`, `crypto`,
  // `authentication`) are pinned individually in LABELS_MUST_FIRE_SPEC — a derived loop
  // cannot catch its own deletion, which a mutation sweep confirmed.
  "authorization",
  "authentication",
  "idor",
  "bola",
  "ssrf",
  "xss",
  "csrf",
  "injection",
  // authorization vocabulary the path arms fire on
  "rbac",
  "permission",
  "permissions",
  "secret",
  "secrets",
  "crypto",
]);

/**
 * @param {string} label
 * @returns {boolean}
 */
function matchesSecurityLabel(label) {
  return signalWords(label).some((w) => SECURITY_LABEL_WORDS.has(w));
}

/**
 * Title conventions this repo uses for security work, e.g. `Security: ...`, `fix(authz): ...`.
 *
 * Already word-anchored, and measured clean (#1172): over the last 383 commit subjects it
 * fired 34 times, every one of them genuine security work. The plausible hazard was
 * `\binjection\b` catching "dependency injection"; no such title exists in this history.
 */
export const SECURITY_TITLE_PATTERN =
  /\b(security|authz|authorization|idor|bola|ssrf|xss|injection|csrf)\b/i;

/**
 * Decide whether a change warrants the adversarial panel.
 *
 * Returns reasons rather than a bare boolean so the answer explains itself in the PR body —
 * "required because it touched a route handler" is auditable; `true` is not.
 *
 * @param {{ changedPaths?: string[], labels?: string[], title?: string }} input
 * @returns {{ required: boolean, reasons: string[] }}
 */
export function shouldRunAdversarialPass(input = {}) {
  // The absent/wrong-type distinction this module turns on everywhere else — see
  // `isPresent` below, which names `typeof x === "string" ? … : ""` as "#1170's defect
  // one level deeper". This function committed exactly that collapse, in the one place
  // where the consequence is that a security change gets NO panel at all. Measured:
  // `{ changedPaths: "server/src/middleware/auth.ts" }` — a single path passed as a
  // string rather than a one-element array, which is how a caller that just did
  // `paths.join("\n")` would supply it — returned `{ required: false }` for an
  // authentication middleware file. The array form returns `required: true` with two
  // reasons (#1215).
  //
  // Absent and `null` stay defaults: a caller with no labels to offer is not an error,
  // and that is the shape most call sites have. Only a value with content that cannot
  // be read throws — the same line `verifyChangelogFragments` draws on `baseFragments`,
  // and for the same reason: silence here is indistinguishable from a clean answer.
  for (const field of /** @type {const} */ (["changedPaths", "labels"])) {
    const value = /** @type {unknown} */ (input[field]);
    if (value !== undefined && value !== null && !Array.isArray(value)) {
      throw new TypeError(
        // No `Array.isArray` arm here: this branch is only reached when the value is
        // NOT an array, so describing one would be dead code.
        `shouldRunAdversarialPass: \`${field}\` must be an array of strings, got ` +
          `${typeof value}. It was previously coerced to [], ` +
          `so a single path passed as a string reported "no panel required" for an auth module ` +
          `(#1215). Pass [] to mean "none".`,
      );
    }
  }
  if (input.title !== undefined && input.title !== null && typeof input.title !== "string") {
    throw new TypeError(
      `shouldRunAdversarialPass: \`title\` must be a string, got ${typeof input.title}.`,
    );
  }

  const changedPaths = Array.isArray(input.changedPaths) ? input.changedPaths : [];
  const labels = Array.isArray(input.labels) ? input.labels : [];
  const title = typeof input.title === "string" ? input.title : "";

  /** @type {string[]} */
  const reasons = [];

  for (const signal of PATH_SIGNALS) {
    const hit = changedPaths.find((p) => typeof p === "string" && signal.match(p));
    if (hit) reasons.push(`${hit} — ${signal.reason}`);
  }

  const securityLabel = labels.find((l) => typeof l === "string" && matchesSecurityLabel(l));
  if (securityLabel) reasons.push(`label \`${securityLabel}\` — declared security work`);

  if (SECURITY_TITLE_PATTERN.test(title)) reasons.push(`title names security work: "${title}"`);

  return { required: reasons.length > 0, reasons };
}

/**
 * Did the voter supply a value for this field at all?
 *
 * The distinction every rule below turns on, and the one the module got wrong for a whole class
 * of input: an *absent* field is a choice the voter did not make, while a field of the wrong
 * *type* is a choice the voter made and the tally cannot read. `typeof x === "string" ? … : ""`
 * collapses the two, and that collapse is #1170's defect one level deeper — the value is
 * silently replaced by the default rather than failing the panel.
 *
 * `null` counts as absent, not as a wrong type. In JSON it is how a template with nothing to
 * put in a field is serialised, so treating it as an uninterpretable choice would fire the gate
 * on input that says, quite clearly, that no choice was made.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isPresent(value) {
  return value !== undefined && value !== null;
}

/**
 * Was a value supplied where a string was expected, in a type the tally cannot read?
 *
 * A *blank* string is deliberately not one of these: `"  "` is a present-but-empty value that
 * says nothing, so it takes the same path as an absent field. Only a non-string carries content
 * the tally is throwing away.
 *
 * @param {unknown} value
 * @returns {boolean}
 */
function isUnreadableString(value) {
  return isPresent(value) && typeof value !== "string";
}

/**
 * The JSON type of a value, for an error message that tells a voter what to change.
 *
 * `undefined` and `null` are named as themselves rather than run through `typeof`, which would
 * print "a undefined" and — wrongly — "a object" for `null`. Most call sites cannot reach them,
 * because {@link isPresent} has already excluded them; the two that can are the fields that are
 * fatal even when *absent* (`objections`, and the panel input itself), and sending a voter to
 * look for a field they never wrote is the opposite of what these messages are for.
 *
 * @param {unknown} value
 * @returns {string}
 */
function describeType(value) {
  if (value === undefined) return "absent";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  return `${type === "object" ? "an" : "a"} ${type}`;
}

/** The only keys the verdict contract defines. Anything else is content nothing reads. */
const VERDICT_KEYS = Object.freeze(["lens", "verdict", "objections", "notes"]);

/** The only keys an objection may carry. `citations` is PLURAL and is an array. */
const OBJECTION_KEYS = Object.freeze(["claim", "severity", "citations"]);

/**
 * Complain about any key with content that the contract does not define (#1215).
 *
 * ## Why an unknown key is fatal and not a shrug
 *
 * This module already treats "the voter offered evidence in a container the tally cannot
 * read" as *lost*, not merely unsupported — that is the argument written above
 * `citations`, and it is why a non-array `citations` fires the gate. A key the tally does
 * not read is the same loss arriving through the field's **name** instead of its type,
 * and it is the likelier of the two: the contract's example shows `"citations": [...]`,
 * and a voter with exactly one citation writing `"citation": "path:12"` is an ordinary
 * LLM near-miss.
 *
 * Measured, on the real runner: a panel of three lenses, every `notes` present, every
 * declared verdict consistent, carrying one **blocking** objection whose evidence is
 * `server/src/routes/x.ts:42` under the singular key, prints `CLEAR` and exits **0**.
 * Respell that one key `citations` and the identical panel prints `BLOCKED` and exits 1.
 * No "Malformed input" section appears in the first case, so nothing warns the reader
 * either — the objection is simply reported as uncited, which is the one classification
 * the "discarded objections cannot block" rule is explicitly *not* defended for.
 *
 * Absent, `null` and blank-string values are ignored, exactly as everywhere else in this
 * module: a key that carries nothing lost nothing. So a voter that emits `"citation":
 * null` alongside a good `citations` array is not punished for it.
 *
 * @param {Record<string, unknown>} source
 * @param {readonly string[]} known
 * @param {string} where prefix for the message, e.g. `objection #2 `
 * @param {string[]} errors mutated
 * @param {string[]} unparsed mutated
 */
function checkUnknownKeys(source, known, where, errors, unparsed) {
  const unknown = Object.keys(source).filter((key) => {
    if (known.includes(key)) return false;
    const value = source[key];
    if (!isPresent(value)) return false;
    if (typeof value === "string" && value.trim() === "") return false;
    if (Array.isArray(value) && value.length === 0) return false;
    return true;
  });
  if (unknown.length === 0) return;

  const message =
    `${where}has ${unknown.length} unrecognised key(s) with content ` +
    `(${unknown.map((k) => JSON.stringify(k)).join(", ")}) — the tally reads only ` +
    `${known.join(", ")}, so whatever those carry is LOST rather than unsupported. ` +
    `A blocking objection whose evidence arrives under "citation" instead of "citations" ` +
    `is reported as uncited and the panel exits CLEAR (#1215). Copy the JSON contract from ` +
    `.claude/agents/adversarial-reviewer.md verbatim and re-run.`;
  errors.push(message);
  unparsed.push(message);
}

/**
 * Validate and normalise one voter's raw verdict object.
 *
 * A malformed verdict is never silently coerced into a clean one: it is returned with its
 * errors listed and contributes no objections, so a voter whose output could not be parsed
 * reads as *no signal*, not as *no problem*.
 *
 * @param {unknown} raw
 * @returns {LensVerdict}
 */
export function normalizeVerdict(raw) {
  /** @type {string[]} */
  const errors = [];
  /**
   * The subset of `errors` where input was *lost or uninterpretable*, as opposed to merely
   * noted. Only this subset fires the gate, so that defects the module already handles
   * correctly — a declared verdict it recomputed, an uncited objection it reported under
   * "Discarded" — do not raise a false alarm and teach readers to override the outcome.
   * @type {string[]}
   */
  const unparsed = [];

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return {
      lens: null,
      verdict: "INVALID",
      objections: [],
      notes: "",
      errors: ["verdict is not an object"],
      unparsed: ["verdict is not an object"],
    };
  }

  const record = /** @type {Record<string, unknown>} */ (raw);
  checkUnknownKeys(record, VERDICT_KEYS, "verdict ", errors, unparsed);

  const lensRaw = typeof record.lens === "string" ? record.lens.trim() : "";
  const lens = LENSES.includes(lensRaw) ? lensRaw : null;
  if (!lens) {
    // Fatal: with an unrecognised lens we cannot say the panel covered the three questions,
    // and a fourth voter mislabelling itself can otherwise mask a lens that never ran.
    const message = `unknown lens ${JSON.stringify(record.lens ?? null)}`;
    errors.push(message);
    unparsed.push(message);
  }

  const notes = typeof record.notes === "string" ? record.notes.trim() : "";
  // A note, not fatal, in both shapes: an audit trail hides no *objection*, which is what
  // `unparsed` is for. The two messages are kept distinct because "missing" and "the wrong
  // type" send the reader to different places in the dispatch.
  if (!notes) {
    errors.push(
      isUnreadableString(record.notes)
        ? `\`notes\` is not a string (${describeType(record.notes)}, treated as absent) — a verdict with no audit trail cannot be trusted`
        : "missing `notes` — a verdict with no audit trail cannot be trusted",
    );
  }

  // Fatal in *every* shape including absent, and deliberately stricter than `citations` below.
  // An absent `citations` means "no evidence offered", which the uncited-discard path already
  // reports visibly; an absent `objections` means we cannot tell whether the voter had none or
  // lost them — and a missing objections array is exactly the shape a forged clean panel takes.
  const rawObjections = Array.isArray(record.objections) ? record.objections : [];
  if (!Array.isArray(record.objections)) {
    const message = `\`objections\` is not an array (${describeType(record.objections)}, treated as empty)`;
    errors.push(message);
    unparsed.push(message);
  }

  const objections = rawObjections.map((/** @type {unknown} */ o, /** @type {number} */ index) =>
    normalizeObjection(o, index, errors, unparsed),
  );

  // The voter's own `verdict` string is advisory: it is recomputed from the objections it
  // actually supplied, so a voter cannot claim SOUND while listing defects, or vice versa.
  const verdict = objections.length > 0 ? "OBJECTION" : "SOUND";
  if (typeof record.verdict === "string") {
    if (record.verdict.trim().toUpperCase() !== verdict) {
      errors.push(
        `declared verdict ${JSON.stringify(record.verdict)} disagrees with ${objections.length} objection(s); using ${verdict}`,
      );
    }
  } else if (isPresent(record.verdict)) {
    // A note, not fatal, and the one field where that is true by construction: the declared
    // verdict is never an input to anything — it is recomputed from the objections on the line
    // above — so a wrong type here loses nothing. Reported anyway, because a voter that got
    // this field's type wrong probably got others wrong too.
    errors.push(
      `declared \`verdict\` is not a string (${describeType(record.verdict)}, ignored); using recomputed ${verdict}`,
    );
  }

  return { lens, verdict, objections, notes, errors, unparsed };
}

/**
 * @param {unknown} raw
 * @param {number} index
 * @param {string[]} errors mutated with any structural complaint
 * @param {string[]} unparsed mutated with the subset where input was lost or uninterpretable
 * @returns {Objection}
 */
function normalizeObjection(raw, index, errors, unparsed) {
  const isObject = raw !== null && typeof raw === "object" && !Array.isArray(raw);
  if (!isObject) {
    const message = `objection #${index + 1} is not an object`;
    errors.push(message);
    unparsed.push(message);
  }
  const source = /** @type {Record<string, unknown>} */ (isObject ? raw : {});
  checkUnknownKeys(source, OBJECTION_KEYS, `objection #${index + 1} `, errors, unparsed);

  const claim = typeof source.claim === "string" ? source.claim.trim() : "";
  if (!claim) {
    if (isUnreadableString(source.claim)) {
      // Fatal: the voter *wrote* a claim and it is now unreadable. It is lost twice over —
      // the text is gone, and a claimless objection is not actionable, so a cited `blocking`
      // objection wrapped this way vanished from the counts and exited 0.
      const message = `objection #${index + 1} has a non-string \`claim\` (${describeType(source.claim)}, treated as absent)`;
      errors.push(message);
      unparsed.push(message);
    } else {
      // A note, not fatal: an *absent* claim is nothing the voter said. The objection is still
      // printed under "Discarded", so it is visible to the reader rather than lost.
      errors.push(`objection #${index + 1} has no \`claim\``);
    }
  }

  const severityRaw =
    typeof source.severity === "string" ? source.severity.trim().toLowerCase() : "";
  // Absent, `null`, or a blank string: the voter made no choice at all, so this defaults to the
  // lower of the two, which is what the agent contract already tells voters to do when between
  // them. Anything else is a *present* choice: either one of ours, or one in a vocabulary we do
  // not share — and guessing which of ours it meant is exactly the silent coercion #1170 is
  // about. `severity: ["blocking"]` and `{"level":"blocking"}` are present choices; the old
  // `typeof === "string" ? … : ""` funnelled every non-string into the *absent* branch and
  // defaulted them to `advisory`, so a voter-declared blocker exited 0. A one-element array
  // instead of a scalar is a well-known LLM JSON failure mode, and these voters are LLMs.
  const severityBlank = typeof source.severity === "string" && severityRaw === "";
  const severityChosen = isPresent(source.severity) && !severityBlank;
  const severity = /** @type {Objection["severity"]} */ (
    !severityChosen ? "advisory" : SEVERITIES.includes(severityRaw) ? severityRaw : "unrecognised"
  );
  if (severity === "unrecognised") {
    const message =
      `objection #${index + 1} has unrecognised severity ${JSON.stringify(source.severity)}; ` +
      `the tally will not guess between ${SEVERITIES.join(" and ")} — copy the JSON contract ` +
      `from .claude/agents/adversarial-reviewer.md and re-run`;
    errors.push(message);
    unparsed.push(message);
  }

  // Fatal: evidence the voter supplied in a container the tally cannot read is *lost*, not
  // merely unsupported. The "discarded uncited objections do not change the outcome" rule does
  // not cover this — that rule is defended on an uncited objection being *correctly parsed*,
  // the voter simply having offered no evidence. Here the voter offered evidence and the tally
  // threw it away, reporting `CLEAR`. That is #1167's measured symptom in a different shape,
  // and it is what a non-array `objections` one level up has always been treated as.
  //
  // The same absent/`null`/blank doctrine applies here as everywhere else, and it applies
  // *inside* the array too: a `citations` of `""` and a `[null]` entry each carry no evidence,
  // so firing the gate on them would be the module complaining about input nothing was lost
  // from. Only a value with content the tally cannot read is fatal.
  const rawCitations = Array.isArray(source.citations) ? source.citations : [];
  const citationsBlank = typeof source.citations === "string" && source.citations.trim() === "";
  if (isPresent(source.citations) && !citationsBlank && !Array.isArray(source.citations)) {
    const message = `objection #${index + 1} has a non-array \`citations\` (${describeType(source.citations)}, treated as no evidence)`;
    errors.push(message);
    unparsed.push(message);
  }
  const droppedCitations = rawCitations.filter((c) => isPresent(c) && typeof c !== "string").length;
  if (droppedCitations > 0) {
    const message = `objection #${index + 1} has ${droppedCitations} non-string \`citations\` entr${droppedCitations === 1 ? "y" : "ies"}, dropped`;
    errors.push(message);
    unparsed.push(message);
  }
  // Blank strings and nulls are filtered without complaint: each is a present-but-empty value,
  // not evidence the tally failed to interpret, and an objection left with no citations is
  // already reported under "Discarded".
  const citations = rawCitations
    .filter((c) => typeof c === "string")
    .map((c) => c.trim())
    .filter(Boolean);
  const codeCitations = citations.filter(isCodeCitation);

  return {
    claim,
    severity,
    citations,
    codeCitations,
    actionable: claim !== "" && codeCitations.length > 0,
  };
}

/**
 * Tally a panel.
 *
 * @param {unknown[]} rawVerdicts one entry per voter
 * @returns {Tally}
 */
export function tallyPanel(rawVerdicts) {
  const list = Array.isArray(rawVerdicts) ? rawVerdicts : [];
  const lenses = list.map((raw) => normalizeVerdict(raw));

  // Fatal, and belongs to the panel rather than to any lens. The outcome was already
  // `INCOMPLETE` here — three lenses are missing when there are no verdicts — but the report
  // said "the panel did not report on every lens", which sends the reader to re-dispatch three
  // voters when the real fault is that the file holds an object, or a `{"verdicts": […]}`
  // wrapper, instead of the bare array the CLI documents.
  /** @type {string[]} */
  const panelErrors = [];
  if (!Array.isArray(rawVerdicts)) {
    panelErrors.push(
      `panel input is not an array of verdicts (${describeType(rawVerdicts)}, treated as no verdicts)`,
    );
  }

  const seen = new Map();
  for (const entry of lenses) {
    if (!entry.lens) continue;
    seen.set(entry.lens, (seen.get(entry.lens) ?? 0) + 1);
  }
  const missingLenses = LENSES.filter((l) => !seen.has(l));
  const duplicateLenses = [...seen.entries()].filter(([, n]) => n > 1).map(([l]) => l);

  /** @type {TaggedObjection[]} */
  const actionable = [];
  /** @type {TaggedObjection[]} */
  const unsupported = [];
  for (const entry of lenses) {
    for (const objection of entry.objections) {
      const tagged = { ...objection, lens: entry.lens };
      if (objection.actionable) actionable.push(tagged);
      else unsupported.push(tagged);
    }
  }

  const errors = [
    ...panelErrors,
    ...lenses.flatMap((entry) => entry.errors.map((e) => `[${entry.lens ?? "unknown lens"}] ${e}`)),
  ];
  const unparsed = [
    ...panelErrors,
    ...lenses.flatMap((entry) =>
      entry.unparsed.map((e) => `[${entry.lens ?? "unknown lens"}] ${e}`),
    ),
  ];

  const blockingCount = actionable.filter((o) => o.severity === "blocking").length;
  const advisoryCount = actionable.filter((o) => o.severity === "advisory").length;
  const unrecognisedSeverityCount = actionable.filter((o) => o.severity === "unrecognised").length;

  // Precedence. A real blocking objection outranks everything, because the change is already
  // known to be wrong and neither re-running a lens nor re-wording a prompt will change that.
  // Below it, an unreadable panel outranks its own counts: if input was dropped, the counts
  // are not a measurement of the change. Both land on INCOMPLETE, which already exits 1.
  /** @type {Tally["outcome"]} */
  let outcome;
  if (blockingCount > 0) outcome = "BLOCKED";
  else if (missingLenses.length > 0 || duplicateLenses.length > 0 || unparsed.length > 0)
    outcome = "INCOMPLETE";
  else if (advisoryCount > 0) outcome = "ADVISORY";
  else outcome = "CLEAR";

  return {
    lenses,
    missingLenses,
    duplicateLenses,
    panelComplete: missingLenses.length === 0 && duplicateLenses.length === 0,
    actionable,
    unsupported,
    blockingCount,
    advisoryCount,
    unrecognisedSeverityCount,
    unsupportedCount: unsupported.length,
    errors,
    unparsed,
    unparsedCount: unparsed.length,
    outcome,
  };
}

/** One-line explanation of each outcome, for the report and for the PR body. */
const OUTCOME_SUMMARY = Object.freeze({
  BLOCKED: "at least one cited, blocking objection — do not ship as-is",
  ADVISORY: "cited objections, none blocking — fix or answer them in the PR",
  CLEAR: "all three lenses reported and none raised a cited objection",
  INCOMPLETE: "the panel did not report on every lens — this is not a clean result",
});

/**
 * The one line a reader who skims nothing else will read.
 *
 * It has to carry the whole distinction on its own (#1167, #1170): before this, the only
 * clue that a panel had been degraded was a `Malformed input:` section further down that
 * nothing directed anyone to, and a `CLEAR` with three objections thrown away read exactly
 * like a `CLEAR` with none.
 *
 * @param {Tally} tally
 * @returns {string}
 */
export function summaryLine(tally) {
  const parts = [];

  if (tally.unparsedCount > 0) {
    parts.push(
      `${tally.unparsedCount} input(s) could not be parsed, so this panel did not grade what it ` +
        `looked at — read "Malformed input:" below before trusting anything here`,
    );
    // On INCOMPLETE the unparsed clause replaces the stock text, which would otherwise blame
    // a missing lens for a problem that may have nothing to do with the lenses.
    if (tally.outcome !== "INCOMPLETE") parts.unshift(OUTCOME_SUMMARY[tally.outcome]);
    else if (!tally.panelComplete) parts.unshift(OUTCOME_SUMMARY.INCOMPLETE);
  } else {
    parts.push(OUTCOME_SUMMARY[tally.outcome]);
  }

  if (tally.unsupportedCount > 0) {
    parts.push(
      `${tally.unsupportedCount} objection(s) discarded as uncited — a voter raised them and ` +
        `the tally could not act on them; see "Discarded" below`,
    );
  }

  return parts.join("; ");
}

/**
 * Render a tally as plain text for the terminal and for pasting into a PR body.
 *
 * @param {Tally} tally
 * @returns {string}
 */
export function formatReport(tally) {
  /** @type {string[]} */
  const lines = [];
  lines.push(`Adversarial review panel — ${tally.outcome}`);
  lines.push(summaryLine(tally));
  lines.push("");

  for (const lens of LENSES) {
    const entry = tally.lenses.find((l) => l.lens === lens);
    if (!entry) {
      lines.push(`  ${lens}: DID NOT REPORT`);
      continue;
    }
    const cited = entry.objections.filter((o) => o.actionable).length;
    const dropped = entry.objections.length - cited;
    const droppedNote = dropped > 0 ? `, ${dropped} uncited (not actionable)` : "";
    lines.push(`  ${lens}: ${entry.verdict} — ${cited} actionable${droppedNote}`);
  }

  if (tally.actionable.length > 0) {
    lines.push("");
    lines.push("Actionable objections:");
    for (const o of tally.actionable) {
      lines.push(`  [${o.severity}] (${o.lens}) ${o.claim}`);
      lines.push(`      ${o.codeCitations.join(", ")}`);
    }
  }

  if (tally.unsupported.length > 0) {
    lines.push("");
    lines.push("Discarded — no file:line citation, so not actionable:");
    for (const o of tally.unsupported) {
      lines.push(`  (${o.lens}) ${o.claim || "<no claim>"}`);
    }
  }

  if (tally.errors.length > 0) {
    lines.push("");
    lines.push("Malformed input:");
    const fatal = new Set(tally.unparsed);
    // `!!` marks the ones that forced the outcome, so a reader can tell the entry that cost
    // them an objection from the entry that is only a note.
    //
    // This matches by string equality, which makes the marker depend on message *text*: the
    // constraint it rests on is that within one lens, no note-level message may be identical to
    // a fatal one. That holds by construction — a lens's messages carry a `[lens]` prefix and an
    // `#index` (the panel-level ones carry neither, but they are always fatal, so they cannot
    // collide with a note), and the note/fatal pairs on the same field differ in wording — and the test
    // "marks only the fatal entry when one lens produced both kinds" pins it. Carrying a
    // `{ message, fatal }` pair through instead would make it structural, but `errors` and
    // `unparsed` are `string[]` in the `--json` output that callers and the skill already
    // consume, so that is a published-shape change for a failure mode a future edit would have
    // to introduce deliberately. Pinned rather than restructured, on purpose.
    for (const e of tally.errors) lines.push(`  ${fatal.has(e) ? "!!" : "  "} ${e}`);
  }

  return lines.join("\n");
}

/**
 * Process exit code for the CLI. `BLOCKED` and `INCOMPLETE` both fail: a panel that did not
 * run — or whose input could not be read — is not evidence that a change is fine.
 *
 * @param {Tally} tally
 * @returns {0|1}
 */
export function exitCodeFor(tally) {
  return tally.outcome === "BLOCKED" || tally.outcome === "INCOMPLETE" ? 1 : 0;
}
