import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  AGENT_TRANSCRIPT_READERS,
  AI_CONFIG_TERMS,
  DEPENDENCY_MANIFEST_FILES,
  IDENTITY_ANCHORS,
  LENSES,
  REDACTION_SINK_TERMS,
  SECURITY_GATE_TERMS,
  SECURITY_LABEL_WORDS,
  SECURITY_TITLE_PATTERN,
  UNTRUSTED_PARSER_TERMS,
  exitCodeFor,
  formatReport,
  isCodeCitation,
  normalizeVerdict,
  shouldRunAdversarialPass,
  summaryLine,
  tallyPanel,
} from "./adversarial-tally-core.mjs";

/** Load one of the recorded real panel runs kept under `lib/fixtures/`. */
function fixture(name) {
  return JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}.json`, import.meta.url)), "utf8"),
  );
}

/** A well-formed verdict for `lens`, with whatever objections the caller supplies. */
function verdict(lens, objections = []) {
  return {
    lens,
    verdict: objections.length ? "OBJECTION" : "SOUND",
    objections,
    notes: `checked ${lens}`,
  };
}

/** An objection that clears the citation gate. */
function citedObjection(severity = "advisory", citations = ["server/src/routes/analysis.ts:42"]) {
  return { claim: "The guard rejects a legitimate caller.", severity, citations };
}

/** A full, clean three-lens panel. */
function cleanPanel() {
  return LENSES.map((lens) => verdict(lens));
}

/**
 * A complete three-lens panel whose *third* lens is whatever the caller supplies.
 *
 * Use this, never `[...cleanPanel(), malformed]`, when the malformed voter names a lens: the
 * latter gives the panel a **duplicate lens**, which forces `INCOMPLETE`/exit 1 through the
 * pre-existing `duplicateLenses` arm no matter what `unparsed` does — so an outcome assertion
 * passes for a reason that has nothing to do with the defect under test, and survives the
 * mutant that removes the defect's handling.
 */
function panelWithThird(third) {
  return [verdict(LENSES[0]), verdict(LENSES[1]), third];
}

/** A well-formed third-lens verdict carrying exactly one objection, for type-shape tests. */
function thirdLensWith(objection) {
  return {
    lens: LENSES[2],
    verdict: "OBJECTION",
    objections: [objection],
    notes: "checked the third lens",
  };
}

describe("isCodeCitation", () => {
  it.each([
    "server/src/routes/analysis.ts:42",
    "ui/src/lib/analysis-api.ts:17-24",
    "scripts/lib/adversarial-tally-core.mjs:1",
    "packages/shared/src/constants.ts:114",
  ])("accepts the bare %s", (citation) => {
    expect(isCodeCitation(citation)).toBe(true);
  });

  // Issue #1167: every one of these forms was measured being discarded as *uncited* by the
  // anchored pattern, on a panel whose three objections were all subsequently confirmed correct.
  it.each([
    [
      "an em-dash description",
      "scripts/verify-agent-frontmatter.mjs:66 — the fs.existsSync filter",
    ],
    ["a hyphen description", "server/src/routes/analysis.ts:42 - the guard that rejects"],
    ["a bare-space description", "server/src/routes/analysis.ts:42 rejects a legacy caller"],
    ["a parenthesised description", "server/src/app.ts:9 (mounted before the auth middleware)"],
    ["a range plus description", "ui/src/lib/analysis-api.ts:17-24 — the fetch wrapper"],
    ["a colon-led description", "server/src/routes/a.ts:7: the deny branch"],
    ["a comma-separated pair", "server/src/routes/a.ts:7, and see below"],
    ["a trailing close paren", "server/src/routes/a.ts:7)"],
    // The `.` delimiter. Excluding it defended nothing — no test in this file depended on the
    // exclusion — and it discarded a citation that merely ends a sentence, which is #1167's
    // failure direction: silently uncited, outcome unaffected, exit 0.
    ["a sentence-final period", "server/src/routes/analysis.ts:42."],
    ["a period then a following sentence", "server/src/a.ts:42. It rejects a legacy caller."],
  ])("accepts a citation with %s", (_label, citation) => {
    expect(isCodeCitation(citation)).toBe(true);
  });

  // Next.js route groups put literal parentheses in real paths: 93 tracked files live under
  // `ui/src/app/(authed)/`, and a citation to any of them was discarded as *uncited* — on
  // paths `shouldRunAdversarialPass` itself declares require a panel. #1167 verbatim.
  it.each([
    ["a Next.js route group", "ui/src/app/(authed)/admin/auth/page.tsx:42"],
    ["a route group with a description", "ui/src/app/(authed)/projects/page.tsx:17 — the guard"],
    ["a fully parenthesised citation", "(server/src/a.ts:42)"],
  ])("accepts %s", (_label, citation) => {
    expect(isCodeCitation(citation)).toBe(true);
  });

  it("does not let the parenthesis allowance admit prose", () => {
    expect(isCodeCitation("(see the router:42)")).toBe(false);
    expect(isCodeCitation("(the analysis router at :42)")).toBe(false);
  });

  // Backtick-wrapping a path is close to reflex for a model writing about code, and the
  // markdown-link form already passed, so rejecting these was an inconsistency that failed
  // silently. The agent contract states the rule too; this is the tally holding the other end.
  it.each([
    ["backticks", "`server/src/a.ts:42`"],
    ["backticks and a description", "`server/src/a.ts:42` — the guard that rejects"],
    ["double quotes", '"server/src/a.ts:42"'],
    ["single quotes", "'server/src/a.ts:42'"],
    ["a markdown link", "[server/src/a.ts:42](https://example.com)"],
  ])("accepts a citation wrapped in %s", (_label, citation) => {
    expect(isCodeCitation(citation)).toBe(true);
  });

  it("does not let a stripped wrapper turn prose into a citation", () => {
    // The strip must not weaken the property that does the real work: the path is still
    // required to be the first thing in the string.
    expect(isCodeCitation("`see the router:42`")).toBe(false);
    expect(isCodeCitation('"look at server/src/a.ts:7"')).toBe(false);
  });

  it.each([
    ["an issue number", "#1099"],
    ["prose", "the analysis router"],
    ["a file with no line", "server/src/routes/analysis.ts"],
    ["a line-zero citation", "server/src/routes/analysis.ts:0"],
    ["a path with no extension", "server/src/routes/analysis:42"],
    ["a non-numeric line", "server/src/routes/analysis.ts:abc"],
  ])("rejects %s", (_label, citation) => {
    expect(isCodeCitation(citation)).toBe(false);
  });

  // Loosening the anchor must not make the gate worthless: these are the shapes the original
  // `^...$` was defending against, and each must still fail (#1167).
  it.each([
    ["a sentence that merely contains a colon and a number", "the guard fails at line:42"],
    ["a sentence whose first word has no extension", "see the router:42 for the deny branch"],
    ["prose leading with a capitalised clause", "Note that requireAuth:12 is a pass-through"],
    ["an abbreviation before the colon", "i.e. the router:42"],
    ["a URL with a port", "http://localhost:3000/api/analysis"],
    ["an https URL with a port", "https://example.com:8080/path"],
    ["a scheme-less host:port with a path", "example.com:8080/api/analysis"],
    ["a package version specifier", "next@16.2.11"],
    ["a docker-style image tag", "postgres:16.2"],
    ["a semver range", ">=1.2.3 <2.0.0"],
    ["a bare line reference", "line 42 of the router"],
    ["a leading-space-prefixed sentence", "  the analysis router at :42"],
    ["a citation that does not start the string", "look at server/src/a.ts:7"],
  ])("still rejects %s", (_label, citation) => {
    expect(isCodeCitation(citation)).toBe(false);
  });

  // The prose the loosened pattern briefly admitted. Each has a numeric last dotted segment,
  // so requiring the extension to begin with a letter is what excludes them — measured against
  // `git ls-files`, no file in this repository has an extension starting with a digit, so the
  // requirement costs no real citation.
  it.each([
    ["an elapsed duration", "12.5:30 elapsed"],
    ["a version string with a description", "v1.2:34 minutes in"],
    ["a bare duration", "12.5:30"],
    ["an IPv4 address and port", "10.0.0.1:8080"],
    ["an IPv4 address, port and path", "192.168.0.1:5432/metis"],
  ])("rejects %s, which is not code evidence", (_label, citation) => {
    expect(isCodeCitation(citation)).toBe(false);
  });

  it("tolerates surrounding whitespace", () => {
    expect(isCodeCitation("  server/src/app.ts:9  ")).toBe(true);
  });

  it.each([[null], [undefined], [42], [{}], [["server/src/app.ts:9"]]])(
    "rejects the non-string %s",
    (value) => {
      expect(isCodeCitation(value)).toBe(false);
    },
  );
});

describe("shouldRunAdversarialPass", () => {
  it("requires a panel when a route handler changed", () => {
    const result = shouldRunAdversarialPass({ changedPaths: ["server/src/routes/analysis.ts"] });
    expect(result.required).toBe(true);
    expect(result.reasons[0]).toContain("authz surface");
  });

  it.each([
    ["middleware", "server/src/middleware/require-project-access.ts"],
    ["auth modules", "server/src/lib/auth/jwt.ts"],
    ["permission logic", "server/src/lib/rbac/permissions.ts"],
    ["identity handling", "server/src/lib/sso/oidc.ts"],
    ["secret material", "scripts/lib/vault-key-cipher.mjs"],
    ["SSRF guards", "server/src/lib/documents/safe-fetch.ts"],
    ["rate limiting", "server/src/lib/rate-limit/store.ts"],
    ["tenant scoping", "server/src/lib/auth/project-scope.ts"],
    ["schema changes", "server/prisma/schema.prisma"],
  ])("requires a panel for %s", (_label, path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] }).required).toBe(true);
  });

  it("does not require a panel for an unrelated change", () => {
    const result = shouldRunAdversarialPass({
      changedPaths: ["ui/src/components/spinner.tsx", "docs/USER_GUIDE.md"],
      labels: ["type:feature"],
      title: "feat(ui): nicer spinner",
    });
    expect(result).toEqual({ required: false, reasons: [] });
  });

  it("requires a panel from a security label alone", () => {
    const result = shouldRunAdversarialPass({
      changedPaths: ["docs/README.md"],
      labels: ["security"],
    });
    expect(result.required).toBe(true);
    expect(result.reasons).toEqual(["label `security` — declared security work"]);
  });

  it("requires a panel from the title convention alone", () => {
    const result = shouldRunAdversarialPass({
      changedPaths: ["docs/README.md"],
      title: "Security: scope the top-level routes to the analysis's own project",
    });
    expect(result.required).toBe(true);
    expect(result.reasons[0]).toContain("title names security work");
  });

  it("names every distinct signal so the decision explains itself", () => {
    const result = shouldRunAdversarialPass({
      changedPaths: ["server/src/routes/analysis.ts", "server/src/middleware/require-auth.ts"],
      labels: ["security"],
      title: "Security: fix the IDOR",
    });
    expect(result.reasons.length).toBeGreaterThanOrEqual(4);
  });

  it("defaults to not-required when given nothing", () => {
    expect(shouldRunAdversarialPass()).toEqual({ required: false, reasons: [] });
    // Absent and `null` are a caller with nothing to offer — the shape most call sites
    // have, and a legitimate default.
    expect(shouldRunAdversarialPass({ changedPaths: null, labels: null, title: null })).toEqual({
      required: false,
      reasons: [],
    });
  });

  /**
   * This arm used to assert the opposite (#1215). `{ labels: "nope", title: 7 }` returned
   * `{ required: false }`, under a test named "given nothing" — but a value of the wrong
   * type is not nothing, it is a choice the function cannot read, and this module's own
   * `isPresent` docstring names that exact collapse as "#1170's defect one level deeper".
   *
   * Here the consequence is the worst available: a security change gets no panel, and the
   * skip is reported as a considered `required: false` with an empty reasons list. The
   * CHANGELOG's own framing of this signal is that under-firing "reports nothing while
   * doing so" and is the expensive direction; over-firing costs three voters.
   */
  it("THROWS on a list of the wrong type rather than coercing it to empty", () => {
    // The measured case: one path passed as a string, e.g. from a `join`.
    expect(() =>
      shouldRunAdversarialPass({ changedPaths: "server/src/middleware/auth.ts" }),
    ).toThrow(/must be an array/);
    expect(() => shouldRunAdversarialPass({ labels: "security" })).toThrow(/must be an array/);
    expect(() => shouldRunAdversarialPass({ title: 7 })).toThrow(/must be a string/);
  });

  it("still fires on the same path once it is passed as an array", () => {
    const result = shouldRunAdversarialPass({
      changedPaths: ["server/src/middleware/auth.ts"],
    });
    expect(result.required).toBe(true);
    expect(result.reasons.length).toBeGreaterThan(0);
  });

  it("ignores non-string entries in the path and label lists", () => {
    expect(shouldRunAdversarialPass({ changedPaths: [null, 7], labels: [{}] }).required).toBe(
      false,
    );
  });
});

/**
 * The identity signal, #1172.
 *
 * The corpora below are **real paths taken from this repository's history**
 * (`git log --name-only` over auth/session/SSO work, and `git ls-files`), not invented
 * examples — a fix justified by one example is how the unanchored rule got written. A
 * handful of hypothetical paths are marked as such; every one of those is in the *must
 * fire* set, because the only genuinely expensive failure here is a signal that stops
 * firing on a naming convention this repo has not adopted yet and reports nothing while
 * doing so.
 *
 * The asymmetry governs the whole block: an over-fire spends three voters, an under-fire
 * ships an unreviewed authorization change. Every must-not-fire entry is therefore a
 * *measured* member of one of two named non-credential vocabularies (LLM token accounting,
 * AI/sandbox conversation sessions) or an outright substring accident, and nothing is
 * excluded on a guess.
 */
describe("shouldRunAdversarialPass — the identity signal (#1172)", () => {
  /** The name in the reason string, so a test can say *which* signal fired. */
  const IDENTITY_REASON = "identity or session handling";

  /**
   * Must fire. Real identity work from this repository, plus four hypothetical paths
   * (marked) that guard naming conventions a future module might use.
   */
  const MUST_FIRE = [
    // --- credential and identity-provider modules
    "server/src/lib/auth/jwt.ts",
    "server/src/lib/auth/oidc-provider.ts",
    "server/src/lib/auth/saml-provider.ts",
    "server/src/lib/auth/ldap-provider.ts",
    "server/src/lib/auth/sso-config.ts",
    "server/src/lib/auth/sso-state-store-postgres.ts",
    "server/src/lib/auth/saml-request-id-cache.ts",
    "server/src/lib/auth/revocation-store.ts",
    "server/src/lib/auth/require-mfa.ts",
    "server/src/lib/auth/migrate-link-sso.ts",
    "server/src/routes/sso.ts",
    // the issue names this one explicitly
    "server/src/lib/sso/oidc.ts",
    // --- token *credentials*, which must keep firing while token *accounting* stops
    "server/src/lib/acp/api-tokens.ts",
    "server/tests/acp-api-tokens.test.ts",
    "ui/src/app/invites/[token]/page.tsx",
    "server/prisma/migrations/20260625090000_issue413_persistent_token_revocation/migration.sql",
    // --- tests, harnesses and compose files for the same machinery
    "server/tests/jwt.test.ts",
    "server/tests/jwt-secret-guard.test.ts",
    "server/tests/oidc-provider.test.ts",
    "server/tests/saml-provider.test.ts",
    "server/tests/ldap-provider.test.ts",
    "server/tests/sso-config.test.ts",
    "server/tests/sso-oidc-state-store.test.ts",
    "server/tests/sso-state-store-postgres.integration.test.ts",
    "server/tests/migrate-link-sso.test.ts",
    "scripts/lib/saml-harness.mjs",
    "scripts/lib/oidc-harness.mjs",
    "scripts/lib/ldap-harness.mjs",
    "scripts/seed-saml.mjs",
    "scripts/oidc-harness/realm-metis.json",
    "docker-compose.saml.yml",
    "docker-compose.oidc.yml",
    "docker-compose.ldap.yml",
    // --- the UI and e2e surfaces of the same flows
    "ui/src/components/auth/sso-buttons.tsx",
    "ui/src/app/api/auth/sso/providers/route.ts",
    "ui/tests/sso-buttons.test.tsx",
    "e2e/pages/sso-login.page.ts",
    "e2e/tests/sso-login.spec.ts",
    // --- the one deliberate *widening*: OAuth token exchange got no panel before
    "server/src/lib/slack/oauth.ts",
    "server/src/lib/slack/oauth.test.ts",
    // --- hypothetical, and deliberately so: naming this repo has not used yet
    "server/src/lib/session/store.ts",
    "server/src/lib/identity/access-token.ts",
    "ui/src/lib/useSsoLogin.ts",
    "server/src/lib/security/JWTVerifier.ts",
    // --- versioned protocol names. The substring rule this change replaced caught all of
    //     these; the first draft of the word rule caught none of them, because a trailing
    //     digit is a word character and `saml2` is in no vocabulary. Found in review rather
    //     than by this suite, precisely because no entry used the convention — the same way
    //     `JWTVerifier` above exists only because someone thought to write it down.
    "server/src/lib/saml2-binding.ts",
    "ui/src/lib/Saml2Provider.tsx",
    "server/src/lib/oidc3-client.ts",
    "server/src/lib/jwt2-verify.ts",
  ];

  /**
   * Must not fire. Every entry is a tracked path, and each is either a substring accident
   * or a measured member of a non-credential vocabulary. Nothing here is caught by any
   * *other* signal either, so `required` must be false outright.
   */
  const MUST_NOT_FIRE = [
    // --- the headline case: a token *budget* doc, matched on "TOKEN"
    "docs/TOKEN_OPTIMIZATION.md",
    "docs/TOKEN_OPTIMIZATION_GENERIC.md",
    "eval-data/corpus/docretrieval-01-metis-docs/docs/TOKEN_OPTIMIZATION.md",
    // --- substring accidents: "cro-sso-ver", "preproce-sso-r"
    "server/src/lib/ai/cache-crossover.ts",
    "server/src/lib/ai/cache-crossover.test.ts",
    "server/src/lib/code-graph/plsql-preprocessor.ts",
    "server/tests/plsql-preprocessor.test.ts",
    ".claude/agent-memory/code-issue/project_sonnet-vs-haiku-crossover.md",
    // --- LLM token accounting
    //
    // The next two do per-user data access, and are pinned here anyway. Read this before
    // citing either as precedent, because on its face it is the shape the panel rejected
    // for `session`: a judgement written into the corpus that the corpus cannot falsify.
    //
    // What made `session-runtime.ts` a real loss was not reading a user's row — it was
    // deciding the authorization *itself* (a 403 in that file) with no other signal
    // covering it. Neither module below decides anything: both contain zero 4xx throws,
    // and each one's authorization decision sits on a `routes/` path that still fires.
    // "Per-user data access" is the symptom that sends you to read the file; whether the
    // *decision* is covered is what settles it. The named test below pins that premise.
    //
    // `findMany({ where: { userId } })` :77, `findFirst({ userId, projectId: null })`
    // :116/:177 — reached only from routes/usage.ts:143,150 (requireAuth + admin).
    "server/src/lib/ai/token-budget-controller.ts",
    "server/src/lib/ai/token-categorizer.ts",
    // `dailyRollup(userId)` :251 over `findMany({ userId, dayBucket })` :253, per-user write
    // :321 — reached only from routes/ai.ts:797 (requireAuth, self-scoped userIdOrThrow).
    "server/src/lib/ai/token-tracker.ts",
    "server/src/lib/ai/token-tracker-enhanced.test.ts",
    "server/src/lib/analysis/token-budget.ts",
    "server/src/lib/analysis/token-optimization.test.ts",
    "server/src/lib/finops/token-tracker.ts",
    "server/tests/ai-token-tracker.test.ts",
    "server/tests/analysis-token-budget.test.ts",
    "server/tests/finops-token-tracker.test.ts",
    "e2e/tests/token-usage.spec.ts",
    "e2e/tests/token-telemetry.spec.ts",
    "e2e/pages/token-breakdown.page.ts",
    "ui/src/components/projects/TokenBreakdownChart.tsx",
    "ui/tests/token-breakdown-chart.test.tsx",
    // --- design tokens, and a BM25 *tokenizer*
    "ui/tests/contrast-tokens.test.ts",
    ".claude/agent-memory/code-issue/project_bm25-tokenizer-snake-split.md",
  ];

  /**
   * Over-fires we keep on purpose, pinned so a later narrowing has to argue with a test
   * rather than quietly absorb them.
   *
   * Every one is a bare `session`. An earlier draft of this change disqualified them the
   * way `token` is disqualified — `ai`, `sandbox`, `copilot`, `snapshot`, `runtime`,
   * `agent` — and the adversarial panel rejected it: `server/src/lib/library/`
   * `session-runtime.ts` reads like a conversation session and in fact scopes by `userId`
   * and throws a 403. Checked the same way, **three of the nine** that mechanism de-gated
   * do per-user data access. In a server codebase a "session" is a per-user row whatever
   * adjective precedes it, so no adjective is evidence that it is not, and `session` now
   * fires unconditionally. Nine paths of over-fire in 3,911 is the cheap direction.
   *
   * The last four are bare `session` with no qualifier on either side and were never
   * suppressible; they are listed here for the same reason.
   */
  const ACCEPTED_OVER_FIRE = [
    // verified per-user data access — the panel's finding, and why the rest are here
    "server/src/lib/library/session-runtime.ts",
    "server/src/lib/ai/session-snapshot.ts",
    "server/src/lib/sandbox/repos/sandbox-session.repo.ts",
    // AI / sandbox / agent conversation sessions, no longer disqualified
    "server/copilot-svc/src/sessions.ts",
    "server/copilot-svc/tests/sessions.test.ts",
    "server/tests/ai-session-project-provider.test.ts",
    "ui/src/components/sandbox/SandboxSessionTable.tsx",
    "ui/tests/sandbox/sandbox-session-table.test.tsx",
    ".claude/agent-memory/code-issue/feedback_main-session-orchestrates.md",
    // bare `session`, never suppressible either way
    ".github/hooks/scripts/session-start.mjs",
    "e2e/tests/sessions.spec.ts",
    "ui/src/app/(authed)/sessions/page.tsx",
    "ui/tests/sessions-empty-state.test.tsx",
  ];

  it.each(MUST_FIRE)("requires a panel for %s", (path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] }).required).toBe(true);
  });

  it.each(MUST_NOT_FIRE)("does not require a panel for %s", (path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] })).toEqual({
      required: false,
      reasons: [],
    });
  });

  it("names the concrete path that matched, so the decision stays auditable", () => {
    const result = shouldRunAdversarialPass({
      changedPaths: ["server/tests/saml-provider.test.ts"],
    });
    expect(result.reasons).toContain(`server/tests/saml-provider.test.ts — ${IDENTITY_REASON}`);
  });

  it("drops only the identity reason from a path another signal still claims", () => {
    // Under `routes/`, so the panel is still required — but not *because* of "token".
    const result = shouldRunAdversarialPass({
      changedPaths: ["server/src/routes/ai-token-optimization.test.ts"],
    });
    expect(result.required).toBe(true);
    expect(result.reasons.some((r) => r.includes(IDENTITY_REASON))).toBe(false);
    expect(result.reasons.some((r) => r.includes("authz surface"))).toBe(true);
  });

  it("keeps firing on a token-accounting path once identity re-asserts itself", () => {
    // `auth` in the path outranks the `budget` qualifier: a disqualifier must never be
    // able to switch off a path that names identity outright.
    const result = shouldRunAdversarialPass({
      changedPaths: ["server/src/lib/auth/token-budget.ts"],
    });
    expect(result.reasons).toContain(`server/src/lib/auth/token-budget.ts — ${IDENTITY_REASON}`);
  });

  it.each(ACCEPTED_OVER_FIRE)("still fires on %s, accepted as the cheap direction", (path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] }).required).toBe(true);
  });

  it("fires on a session module a qualifier would have wrongly silenced", () => {
    // The panel's finding, kept as its own named test: this module scopes by `userId` and
    // throws a 403, and an earlier draft de-gated it because it is called "runtime".
    const result = shouldRunAdversarialPass({
      changedPaths: ["server/src/lib/library/session-runtime.ts"],
    });
    expect(result.reasons).toContain(
      `server/src/lib/library/session-runtime.ts — ${IDENTITY_REASON}`,
    );
  });

  it("still fires on an unfamiliar `token` compound", () => {
    // The disqualifier list is a denylist on purpose. A compound nobody has classified
    // fires — over-firing costs three voters, under-firing ships an unreviewed change.
    expect(
      shouldRunAdversarialPass({ changedPaths: ["server/src/lib/token-mystery.ts"] }).required,
    ).toBe(true);
  });

  it("an allowlist would lose to inflection, not merely to an unfamiliar name", () => {
    // The strongest case against allowlist semantics, because it needs nobody to invent a
    // new name: `invite` is the obvious word to put in such a list, and the real tracked
    // path still says `invites`. A plural is enough to take a real invitation token dark.
    const result = shouldRunAdversarialPass({
      changedPaths: ["ui/src/app/invites/[token]/page.tsx"],
    });
    expect(result.reasons).toContain(`ui/src/app/invites/[token]/page.tsx — ${IDENTITY_REASON}`);
  });

  it("reads a version number off a protocol name, and only ever to fire", () => {
    // `saml2` is one word to the splitter, so the de-versioned form has to be tried too.
    expect(
      shouldRunAdversarialPass({ changedPaths: ["server/src/lib/saml2-binding.ts"] }).reasons,
    ).toContain(`server/src/lib/saml2-binding.ts — ${IDENTITY_REASON}`);

    // The other direction is deliberately *not* symmetric: de-versioning feeds the checks
    // that fire, never the disqualifier check. `budget2` must not silence a `token` path,
    // because a disqualifier may resolve an ambiguity and never overrule an explicit one —
    // and here the disqualifying word is inferred rather than written.
    expect(
      shouldRunAdversarialPass({ changedPaths: ["server/src/lib/ai/token-budget2.ts"] }).required,
    ).toBe(true);
  });

  it("pins the premise that keeps two per-user token modules out of MUST_NOT_FIRE", () => {
    // `token-budget-controller.ts` and `token-tracker.ts` do per-user data access and are
    // still pinned as must-not-fire. That is only defensible while the routes carrying
    // their authorization decisions fire. If the `routes/` signal is ever narrowed, this
    // fails and the pin has to be re-argued rather than silently inherited.
    for (const route of ["server/src/routes/usage.ts", "server/src/routes/ai.ts"]) {
      expect(shouldRunAdversarialPass({ changedPaths: [route] }).required).toBe(true);
    }
  });
});

/**
 * The auth path arm and the label arm, #1190 — the two signals that failed in the
 * *under*-firing direction and so were split out of #1172 rather than fixed alongside it.
 *
 * ## Why half of this corpus is hypothetical, on purpose
 *
 * #1172's corpus was drawn from tracked paths, and that made it **green across the entire
 * versioned-protocol class** — `saml2`, `oidc3`, `jwt2`, `auth2/session2.ts` all went dark
 * under the new word split and every check passed, because none of those paths exists here.
 * A corpus of real paths tests the naming you already have and is blind to the naming you
 * have not adopted, **and that blindness reads as a pass**. The one hypothetical that ever
 * paid off (`JWTVerifier`) existed only because someone thought to write it down.
 *
 * So each class named in #1190's thread is probed deliberately, whether or not this repo
 * has adopted it: suffixed (`edge-auth`), versioned (`fido2`, `oauth2`, `auth2/session2`),
 * acronym-cased (`JWTVerifier`, `OIDCClient`, `AuthZPolicy`) and factor names this codebase
 * does not use at all (`totp`, `passkey`, `webauthn`).
 *
 * **The argument is coverage of classes, not density of defects** — an earlier draft of this
 * comment had it backwards and review caught it. `3/25` and `5/16` are *pass* rates before
 * the fix, so the gap rates are real **22/25 = 0.88** against hypothetical **11/16 = 0.69**:
 * per entry the real corpus missed *more*, not less. What the hypothetical half buys is not a
 * higher hit rate but reachability. `totp`, `webauthn`, `passkey` and `fido` match **0 of the
 * 3,984 tracked paths** (measured), so no corpus drawn from real paths can contain them at
 * any density — and `ui/src/lib/edge-auth2.ts`, a hypothetical, is the only entry in either
 * half that kills the de-versioning mutation M3. Writing down naming you have *not* adopted
 * is how a class you do not have yet gets tested at all.
 */
describe("shouldRunAdversarialPass — the auth and label arms (#1190)", () => {
  const AUTH_REASON = "authentication/authorization module";
  const IDENTITY_REASON_1190 = "identity or session handling";

  /**
   * Real tracked paths. The first block is what #1190 reports as matching **no signal at
   * all**; the last three fired before and are here as a regression guard, because a
   * widening that silently drops a path is the failure this issue is about.
   */
  const REAL_MUST_FIRE = [
    // the two paths the issue names
    "ui/src/lib/edge-auth.ts",
    "ui/tests/edge-auth.test.ts",
    "e2e/pages/admin-auth.page.ts",
    "e2e/tests/admin-auth.spec.ts",
    "server/tests/startup-auth-guard.test.ts",
    // `authz` as a suffix — of the fourteen tracked suffixed modules and tests, these are
    // the twelve that fired on no signal at all. The two omitted
    // (`routes/products-multi.authz.test.ts`, `tests/routes/admin/embeddings-authz.test.ts`)
    // were already carried by the `routes/` arm.
    "server/src/lib/async/run-authz.ts",
    "server/src/lib/async/run-authz.test.ts",
    "server/src/lib/connectors/connection-authz.ts",
    "server/src/lib/requirements/requirement-authz.ts",
    "server/src/lib/acp/handlers.authz.test.ts",
    "server/tests/background-runs-authz.test.ts",
    "server/tests/custom-agent-authz.test.ts",
    "server/tests/import-routes-authz.test.ts",
    "server/tests/search-routes-authz.test.ts",
    "server/tests/skill-directories-authz.test.ts",
    "server/tests/suggested-connectors-routes-authz.test.ts",
    "server/tests/trigger-routes-authz.test.ts",
    // the login surface itself, dark because `login` could only ever rescue, never fire
    "ui/src/app/login/page.tsx",
    "e2e/pages/login.page.ts",
    "ui/tests/login-form.test.tsx",
    // tests whose *modules* fired while they did not — same anchor-only cause
    "server/tests/require-mfa.test.ts",
    "server/tests/revocation-store.test.ts",
    // --- fired before #1190 too: a widening must not lose these
    "server/src/lib/auth/jwt.ts",
    "server/src/middleware/require-auth.ts",
    "server/src/lib/acp/authz.ts",
  ];

  /**
   * Hypothetical, and the more valuable half of the corpus — see the block comment. Every
   * entry probes a *class* of naming rather than an example of one.
   */
  const HYPOTHETICAL_MUST_FIRE = [
    // suffixed: the shape `(^|/)auth` structurally cannot see
    "ui/src/lib/gateway-auth.ts",
    "server/src/lib/edge/request-authz.ts",
    // versioned: a trailing digit is a word character, so these need de-versioning.
    // `attest/`, not `webauthn/`: the original entry carried `webauthn` as well as `fido2`,
    // so it fired whether or not `fido` was in the vocabulary — review renamed `fido` and
    // watched the entry stay green. Same confounding as `auth2/session2` below, one level up.
    "server/src/lib/attest/fido2-register.ts",
    "server/src/lib/identity/oauth2-callback.ts",
    "server/src/lib/auth2/session2.ts",
    "server/src/lib/saml2-binding.ts",
    // ...and the same class with nothing else to rescue it. The two entries above are
    // *confounded*: `session2` and `saml2` reach the identity arm, so both still fire with
    // the auth arm's de-versioning removed — a mutation arm proved it, and a corpus entry
    // that passes for the wrong reason pins nothing. This one carries only `authz2`.
    "ui/src/lib/edge-auth2.ts",
    // acronym-cased: needs the two-pass camelCase split, not one
    "server/src/lib/security/JWTVerifier.ts",
    "ui/src/lib/OIDCClient.tsx",
    "server/src/lib/idp/AuthZPolicy.ts",
    "ui/src/components/EdgeAuthGuard.tsx",
    // authentication factors this repo has not adopted: 0 tracked paths, so a corpus of
    // real paths is structurally incapable of noticing they were missing. Each carries its
    // factor word and no other — `mfa/totp.ts`, the original entry here, reached the
    // identity arm through the directory name and so pinned `totp` not at all.
    "server/src/lib/identity/totp-verify.ts",
    "server/src/lib/passwordless/passkey-store.ts",
    "server/src/lib/webauthn/attestation.ts",
    // the login surface under names this repo does not currently use
    "ui/src/app/signin/page.tsx",
    "server/src/lib/identity/logout-all-devices.ts",
  ];

  /**
   * Must not fire — the substring class #1172 removed, which the naive repair to #1190
   * (dropping the `(^|\/)` anchor) would reintroduce wholesale.
   *
   * Measured: a plain substring `auth` fires on **93 more tracked paths that no other
   * signal covers**. The `(authed)` pages are 91 of them and `AgentAuthoringWizard.tsx` is
   * the purest case — auth**oring**, an agent-authoring wizard with no authentication in it,
   * exactly `sso`-inside-`crossover` in a different word.
   */
  const MUST_NOT_FIRE = [
    "ui/src/components/custom-agents/AgentAuthoringWizard.tsx",
    "ui/tests/agent-authoring-wizard.test.tsx",
    // `authed` is Next.js for "behind a login", not a word about auth work. Including it
    // would cost 91 paths — 89 files under the `(authed)` route group and 2 tests — whose
    // subject is dashboards, settings and documents.
    "ui/src/app/(authed)/dashboard/page.tsx",
    "ui/src/app/(authed)/documents/page.tsx",
    "ui/tests/authed-boundaries.test.tsx",
    "ui/tests/authed-layout-toaster.test.tsx",
    // #1172's own class, re-pinned here so a change to *this* arm cannot break *that* one
    "server/src/lib/ai/cache-crossover.ts",
    "server/src/lib/code-graph/plsql-preprocessor.ts",
    "docs/TOKEN_OPTIMIZATION.md",
  ];

  /**
   * Over-fires kept on purpose, pinned the same way #1172's `ACCEPTED_OVER_FIRE` pins its
   * bare-`session` paths: 7 of the 29 paths this change newly fires on are prose and
   * fixture data *about* authorization rather than code that performs it. (The other 22 are
   * genuine auth or authz work — review read all 22 and spot-read five in full.)
   *
   * They stay because suppressing them means a path-prefix disqualifier
   * (`.claude/agent-memory/`, `eval-data/corpus/`), and a disqualifier is the mechanism the
   * #1172 panel rejected for `session`. Three wasted voters on a memory file is the cheap
   * direction; a prefix rule that silences a whole subtree is not.
   *
   * **The cost is an open class, not these 7 paths.** Measured, this change takes
   * `.claude/agent-memory/` from 13 to 18 of its 176 tracked files and `eval-data/` from 21
   * to 23 of its 170 — and `CLAUDE.md` requires every `code-issue` PR to commit its memory
   * files, so a future note named `*auth*`/`*authz*` joins the class automatically and
   * without a decision. The trade is still right; the number to weigh a prefix disqualifier
   * against is "18 of 176 prose paths and growing", not "7".
   */
  const ACCEPTED_OVER_FIRE = [
    ".claude/agent-memory/code-issue/project_connection-authz-seam.md",
    ".claude/agent-memory/code-issue/project_hooks-router-authz.md",
    ".claude/agent-memory/code-issue/project_plugins-eval-authz.md",
    ".claude/agent-memory/code-issue/project_products-multi-authz.md",
    ".claude/agent-memory/code-issue/project_e2e-auth-identity-me-vs-login.md",
    "eval-data/corpus/prd-01-auth-portal/source.md",
    "eval-data/corpus/prd-01-auth-portal/expected.json",
  ];

  /** This repo's real labels. `auth` and `area:auth` are the ones that never fired. */
  const LABELS_MUST_FIRE = ["auth", "area:auth", "security", "area:security", "type:security"];

  /**
   * Real labels that must stay silent. `token-optimization` is the load-bearing one: it is
   * why `token` must reach the label vocabulary through `AMBIGUOUS_IDENTITY_TERMS` (which
   * the derivation excludes) rather than through `IDENTITY_TERMS`.
   */
  const LABELS_MUST_NOT_FIRE = [
    "token-optimization",
    "cost-optimization",
    "type:feature",
    "area:ai",
    "area:testcoverage",
    "area:accessibility",
    "phase-3",
    "documentation",
    "scanner",
    "dependencies",
    "good first issue",
    "epic:ba-readiness",
  ];

  it.each(REAL_MUST_FIRE)("requires a panel for the tracked path %s", (path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] }).required).toBe(true);
  });

  it.each(HYPOTHETICAL_MUST_FIRE)("requires a panel for the hypothetical path %s", (path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] }).required).toBe(true);
  });

  it.each(MUST_NOT_FIRE)("does not require a panel for %s", (path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] })).toEqual({
      required: false,
      reasons: [],
    });
  });

  it.each(ACCEPTED_OVER_FIRE)("still fires on %s, accepted as the cheap direction", (path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] }).required).toBe(true);
  });

  it.each(LABELS_MUST_FIRE)("requires a panel from the label %s alone", (label) => {
    const result = shouldRunAdversarialPass({ changedPaths: ["docs/README.md"], labels: [label] });
    expect(result.reasons).toEqual([`label \`${label}\` — declared security work`]);
  });

  it.each(LABELS_MUST_NOT_FIRE)("does not require a panel from the label %s", (label) => {
    expect(shouldRunAdversarialPass({ changedPaths: ["docs/README.md"], labels: [label] })).toEqual(
      {
        required: false,
        reasons: [],
      },
    );
  });

  it("names the auth arm as the reason, so the decision stays auditable", () => {
    expect(shouldRunAdversarialPass({ changedPaths: ["ui/src/lib/edge-auth.ts"] }).reasons).toEqual(
      [`ui/src/lib/edge-auth.ts — ${AUTH_REASON}`],
    );
  });

  it("de-versions for the auth arm specifically, not just via a neighbouring signal", () => {
    // `reasons`, not `required`: asserting only that a versioned auth path fires is
    // satisfiable by the identity arm picking up a sibling word, which is how
    // `auth2/session2.ts` passed while the auth arm's own de-versioning was mutated away.
    for (const path of ["ui/src/lib/edge-auth2.ts", "server/src/lib/edge/request-authz2.ts"]) {
      expect(shouldRunAdversarialPass({ changedPaths: [path] }).reasons).toEqual([
        `${path} — ${AUTH_REASON}`,
      ]);
    }
  });

  /**
   * The invariant that replaces the hand-written anchor list.
   *
   * Before #1190, ten words were trusted to *overrule a disqualifier* — to keep
   * `server/src/lib/auth/token-budget.ts` firing against `budget` — while being unable to
   * fire on their own. `IDENTITY_ANCHORS` is now derived from the two firing sets, and this
   * pins that: if anyone hand-adds a word back to the anchors without also making it a
   * signal, the word appears here as an anchor that cannot fire, and this fails.
   *
   * **It iterates the imported set, not a copy of it.** The first draft hardcoded a
   * 23-word mirror, which made the invariant *vacuous* — the #1190 panel added `principal`
   * to `IDENTITY_ANCHORS` (an anchor that rescues but cannot fire, the exact asymmetry this
   * test exists to forbid) and all 368 tests then in the suite passed. A test that mirrors
   * the thing it guards cannot see the thing it guards change.
   *
   * **What this test does not do is pin any individual word**, and review proved that too.
   * Deriving the loop closes addition and leaves removal open: a word that leaves the set
   * leaves the loop with it. `PATHS_MUST_FIRE_SPEC` below is what pins each word by name.
   */
  it("every word trusted to overrule a disqualifier can also fire on its own", () => {
    const anchors = [...IDENTITY_ANCHORS];
    // Guard the guard: an empty or truncated import would make every loop below vacuous.
    // This is a *floor on the import*, not a pin on any word — and it ratchets: once a 24th
    // word is added it stops detecting the deletion of the 24th or the 23rd either. Deletion
    // by name is `PATHS_MUST_FIRE_SPEC`'s job, and rename is only that test's job: renaming a
    // word in place holds this number constant, which is exactly how `totp`, `fido`, `authn`,
    // `signout`, `credential` and `credentials` each survived a rename at 424/424 green.
    expect(anchors.length).toBeGreaterThanOrEqual(23);

    for (const word of anchors) {
      // The anchor's power: it must rescue a `token` path a qualifier would otherwise
      // silence...
      expect(
        shouldRunAdversarialPass({ changedPaths: [`server/src/lib/${word}/token-budget.ts`] })
          .required,
      ).toBe(true);
      // ...and, since it is trusted that far, it must be a signal in its own right — via an
      // identity or auth arm specifically. Asserting `.required` here is not enough:
      // `credential-thing.ts` fires on the "secret or cryptographic material" arm whether or
      // not `credential` is in the vocabulary, so deleting it left the suite green. Same
      // pass-for-the-wrong-reason confounding as the `edge-auth2` entry above.
      const path = `server/src/lib/x/${word}-thing.ts`;
      const reasons = shouldRunAdversarialPass({ changedPaths: [path] }).reasons;
      expect(
        reasons.some((r) => r.includes(IDENTITY_REASON_1190) || r.includes(AUTH_REASON)),
        `${word} does not fire on an identity or auth arm`,
      ).toBe(true);
    }
  });

  it("de-versions a label the same way it de-versions a path, and only to fire", () => {
    // A label arm that reads words has to answer the versioned-protocol class too.
    expect(shouldRunAdversarialPass({ labels: ["area:oauth2"] }).required).toBe(true);
    // …but a label naming token *accounting* must still not fire, which is what keeps
    // `token` out of the derived vocabulary.
    expect(shouldRunAdversarialPass({ labels: ["token-optimization"] }).required).toBe(false);
  });

  /**
   * The derivation claim, pinned rather than asserted in a comment.
   *
   * The label vocabulary is supposed to be "what the other two arms already call security
   * work". Three arms disagreeing about whether `auth` counts is how #1190 happened, so the
   * agreement has to be a test — and writing this one is what caught `authorization`, a word
   * the title arm fires on and the first draft of the label set had missed.
   */
  it("recognises every word the title arm already treats as security work", () => {
    // Parsed out of the live pattern, not copied from it. A hardcoded mirror made this
    // vacuous: the #1190 panel added `clickjacking` to SECURITY_TITLE_PATTERN *without*
    // adding it to SECURITY_LABEL_WORDS — the precise drift this test advertises — and all
    // 368 tests then in the suite passed.
    const alternation = /\(([a-z|]+)\)/.exec(SECURITY_TITLE_PATTERN.source);
    expect(alternation, "could not parse SECURITY_TITLE_PATTERN's alternation").not.toBeNull();
    const titleWords = alternation[1].split("|").filter(Boolean);
    // Guard the guard: a parse that silently yields [] would pass this test forever.
    expect(titleWords.length).toBeGreaterThanOrEqual(9);

    for (const word of titleWords) {
      expect(shouldRunAdversarialPass({ title: `fix(${word}): something` }).required).toBe(true);
      expect(
        shouldRunAdversarialPass({ labels: [`area:${word}`] }).required,
        `title arm fires on "${word}" but the label arm does not`,
      ).toBe(true);
    }
  });

  it.each([...SECURITY_LABEL_WORDS])("fires on the label word %s", (word) => {
    // Every word in the derived vocabulary must actually reach the gate. This catches a word
    // the tokeniser cannot produce (a hyphen or a digit in an entry), which is silent
    // otherwise. It cannot catch a *deletion* — removing a word removes it from this loop
    // too — which is what the next test is for.
    expect(shouldRunAdversarialPass({ labels: [word] }).required).toBe(true);
  });

  /**
   * A **specification** of labels that must fire, deliberately hardcoded — and legitimately
   * so, unlike the mirrors the panel struck down. The derived `it.each` above cannot catch a
   * *deletion* (removing a word removes it from the loop), and a mutation sweep proved it:
   * `rbac`, `permission(s)`, `secret(s)`, `crypto` and `authentication` could each be deleted
   * from the vocabulary with all 411 tests green. These entries are the independent statement
   * of intent that closes that hole.
   */
  const LABELS_MUST_FIRE_SPEC = [
    "area:rbac",
    "area:permissions",
    "type:permission",
    "type:secrets",
    "area:secret-rotation",
    "area:crypto",
    "area:authentication",
    "area:authorization",
    "type:owasp",
    "area:vulnerability",
    "area:sso",
    "area:oauth",
    "type:session",
  ];

  it.each(LABELS_MUST_FIRE_SPEC)("requires a panel from the label %s", (label) => {
    expect(shouldRunAdversarialPass({ labels: [label] }).required).toBe(true);
  });

  /**
   * The same specification for the **path** vocabulary, and the one the label side had first.
   *
   * Review's mutation sweep found the hole this closes. Deleting any of the 23 words was
   * caught — but for six of them (`signout`, `credential`, `credentials`, `totp`, `fido`,
   * `authn`) the only thing catching it was `expect(anchors.length).toBeGreaterThanOrEqual(23)`
   * in the derived loop above, which is **cardinality, not identity**. Renaming a word in
   * place holds the cardinality and so passes: all six survived at 424/424 while
   * `identity/totp-verify.ts`, `fido2-attest.ts` and `authn-gateway.ts` flipped from firing
   * to dark. A silent narrowing of the gate, which is the defect #1190 exists to prevent,
   * relocated into the test suite.
   *
   * Two rules make each entry a pin rather than a coincidence, both learned the hard way in
   * this PR:
   *
   *   1. **Exactly one vocabulary word per path.** `server/src/lib/mfa/totp.ts` carried `mfa`
   *      too and therefore pinned `totp` not at all — the same confounding as
   *      `auth2/session2.ts`, one level up in the suite that was supposed to catch it.
   *   2. **Assert the reason, never `.required`.** The gate ORs ten arms, so `.required` is
   *      arm-blind: `credential-store.ts` fires on "secret or cryptographic material" whether
   *      or not `credential` is in the identity vocabulary.
   *
   * The list is checked for *exact* coverage of `IDENTITY_ANCHORS` below, so adding a word to
   * the vocabulary without pinning it here fails, and removing one fails too. That is the
   * ratchet the `>= 23` floor cannot be.
   *
   * @type {ReadonlyArray<[word: string, path: string]>}
   */
  const PATHS_MUST_FIRE_SPEC = [
    ["jwt", "server/src/lib/identity/jwt-verifier.ts"],
    ["sso", "server/src/lib/identity/sso-bridge.ts"],
    ["saml", "server/src/lib/identity/saml-binding.ts"],
    ["oidc", "server/src/lib/identity/oidc-discovery.ts"],
    ["ldap", "server/src/lib/identity/ldap-bind.ts"],
    ["oauth", "server/src/lib/identity/oauth-exchange.ts"],
    ["session", "server/src/lib/identity/session-store.ts"],
    ["sessions", "server/src/lib/identity/sessions-index.ts"],
    ["login", "server/src/lib/identity/login-throttle.ts"],
    ["logout", "server/src/lib/identity/logout-handler.ts"],
    ["signin", "server/src/lib/identity/signin-redirect.ts"],
    ["signout", "server/src/lib/identity/signout-broadcast.ts"],
    ["credential", "server/src/lib/identity/credential-store.ts"],
    ["credentials", "server/src/lib/identity/credentials-cache.ts"],
    ["revocation", "server/src/lib/identity/revocation-list.ts"],
    ["mfa", "server/src/lib/identity/mfa-enrolment.ts"],
    ["totp", "server/src/lib/identity/totp-window.ts"],
    ["webauthn", "server/src/lib/identity/webauthn-assertion.ts"],
    ["passkey", "server/src/lib/identity/passkey-registry.ts"],
    ["fido", "server/src/lib/identity/fido-metadata.ts"],
    ["auth", "server/src/lib/edge/request-auth.ts"],
    ["authn", "server/src/lib/edge/authn-gateway.ts"],
    ["authz", "server/src/lib/policy/decision-authz.ts"],
  ];

  it.each(PATHS_MUST_FIRE_SPEC)("fires the identity or auth arm for %s, via %s", (word, path) => {
    const reasons = shouldRunAdversarialPass({ changedPaths: [path] }).reasons;
    expect(
      reasons.some((r) => r.includes(IDENTITY_REASON_1190) || r.includes(AUTH_REASON)),
      `"${word}" no longer reaches the identity or auth arm — reasons: ${JSON.stringify(reasons)}`,
    ).toBe(true);
  });

  it.each(PATHS_MUST_FIRE_SPEC)("pins %s on the word itself, not on a neighbour", (word, path) => {
    // Rule 1, enforced behaviourally rather than trusted: strike the word out of the path and
    // the identity/auth reason must go with it. This is the rename mutation run from inside
    // the suite, and it is what stops a later edit re-confounding an entry the way
    // `mfa/totp.ts` was confounded — where the pin above kept passing for the wrong reason.
    const struck = path.replace(word, "zzz");
    expect(struck, `"${word}" does not appear in its own pin path`).not.toBe(path);
    const reasons = shouldRunAdversarialPass({ changedPaths: [struck] }).reasons;
    expect(
      reasons.some((r) => r.includes(IDENTITY_REASON_1190) || r.includes(AUTH_REASON)),
      `${struck} still reaches the identity or auth arm without "${word}", so the entry above pins a neighbouring word — reasons: ${JSON.stringify(reasons)}`,
    ).toBe(false);
  });

  it("pins every word in the vocabulary, and only words that are in it", () => {
    // The coupling that makes this a specification and not a snapshot: the *paths* are
    // hardcoded (so a rename or deletion fails above), while coverage is checked against the
    // live set (so an addition fails here). Neither direction is left to a cardinality floor.
    expect([...PATHS_MUST_FIRE_SPEC.map(([word]) => word)].sort()).toEqual(
      [...IDENTITY_ANCHORS].sort(),
    );
  });

  it("loses no word the replaced label pattern matched", () => {
    // Hardcoded on purpose, and the one list here that must be: these four are a historical
    // fact about `/security|vuln|owasp|authz/i`, not a mirror of current state, so deleting
    // any of them from SECURITY_LABEL_WORDS fails here. `owasp` was unpinned until the panel
    // pointed it out — a narrowing smuggled inside a widening is exactly what #1190 must not
    // ship.
    for (const word of ["security", "vuln", "owasp", "authz"]) {
      expect(
        shouldRunAdversarialPass({ labels: [`area:${word}`] }).required,
        `the replaced pattern matched "${word}" and this one does not`,
      ).toBe(true);
    }
  });

  it("keeps the prefix reach the old label pattern had", () => {
    // The replaced pattern matched `vuln` unanchored, so a `vulnerability` label fired by
    // prefix. A word set does not get that for free, and dropping it would be a narrowing
    // smuggled inside a widening — the exact direction #1190 exists to prevent.
    for (const label of ["vuln", "vulnerability", "vulnerabilities", "area:vulnerability"]) {
      expect(shouldRunAdversarialPass({ labels: [label] }).required).toBe(true);
    }
  });

  it("keeps the label arm free of the substring class the path arm just escaped", () => {
    // The old label pattern was unanchored and audited as acceptable *over the vocabulary
    // of the day*. These are the labels that audit would have expired on.
    for (const label of ["area:crossover-testing", "type:preprocessor", "authoring-tools"]) {
      expect(shouldRunAdversarialPass({ labels: [label] }).required).toBe(false);
    }
  });
});

/**
 * The four categories `shouldRunAdversarialPass` had no opinion about (#1249).
 *
 * ## The evidence this suite is built on, and why it is a PR corpus
 *
 * #1249 reports the gate returning `{ required: false, reasons: [] }` on four consecutive
 * security PRs, three of which a manually-run panel then found real, cited defects in. Widened
 * to every PR merged in that session — sixteen, read with `gh pr view <n> --json files` rather
 * than approximated — **ten security-relevant PRs got no panel**, and three of the four that
 * did fire did so on a `.claude/agent-memory/` note whose *filename* happened to carry `token`
 * or `scope`. Not on anything the PR changed.
 *
 * That last detail is why this suite asserts each PR **twice**. A corpus entry that passes
 * because a sibling path in the same PR carries an unrelated word pins nothing — the lesson
 * #1190 paid for twice, in `auth2/session2.ts` and `mfa/totp.ts`. So every PR is asserted
 * once on its real changed-path list and once on that list with `.changes/` and
 * `.claude/agent-memory/` **stripped**, which is the assertion that can only pass if a signal
 * reaches the code the PR actually changed.
 *
 * Stripping prose also states an honest negative. #1256 and #1264 fire on their full lists and
 * go dark on code alone: their old `required: true` was a filename coincidence and they were
 * never covered. They are not in this corpus, because neither is a security PR — an output-cap
 * fix and a prompt-scoping fix — and pretending the gate should catch them would be scoring
 * this change against a target it should miss.
 */
describe("shouldRunAdversarialPass — the four categories #1249 added", () => {
  const SUPPLY_REASON = "dependency manifest or lockfile (supply chain)";
  const GATE_REASON = "a security or verification gate";
  const PARSER_REASON = "parser over untrusted input";
  const AI_CONFIG_REASON = "AI provider or model configuration";
  const NEW_REASONS = [SUPPLY_REASON, GATE_REASON, PARSER_REASON, AI_CONFIG_REASON];

  /**
   * Real changed-path lists, verbatim from `gh pr view <n> --json files`, for the PRs #1249
   * names plus the rest of the session's security work. Generated from the API rather than
   * typed, because an approximated file list is a corpus that tests the approximation.
   *
   * #1242 (#1219 prototype pollution), #1243 and #1258 (advisory batches, 8 at CVSS 7.0-7.7),
   * #1245/#1254/#1261 (three ReDoS fixes on model output), #1216 (the fail-open gate audit),
   * #1246/#1255/#1259/#1262 (agent-transcript and provider work).
   *
   * @type {Record<number, string[]>}
   */
  const MERGED_PR_FILES = {
    1216: [
      ".changes/unreleased/1215-audit-verify-gates-fail-open.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_verify-gate-fail-open-audit.md",
      ".github/workflows/sast.yml",
      "scripts/lib/adversarial-tally-core.mjs",
      "scripts/lib/adversarial-tally-core.test.mjs",
      "scripts/lib/agent-frontmatter-core.mjs",
      "scripts/lib/agent-frontmatter-core.test.mjs",
      "scripts/lib/check-no-nul-runner.test.mjs",
      "scripts/lib/check-no-nul.mjs",
      "scripts/lib/sast-waiver-gate.test.mjs",
      "scripts/lib/verify-agent-frontmatter-runner.test.mjs",
      "scripts/lib/verify-changelog-fragment-runner.test.mjs",
      "scripts/verify-agent-frontmatter.mjs",
      "scripts/verify-changelog-fragment.mjs",
      "scripts/vitest.config.ts",
      "server/tests/schema-parity.test.ts",
    ],
    1242: [
      ".changes/unreleased/1219-semgrep-object-assign.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_semgrep-insecure-object-assign-is-json-parse-taint.md",
      "server/src/lib/ai/config.ts",
      "server/tests/lib/ai/model-profile-map-keys.test.ts",
    ],
    1243: [
      ".changes/unreleased/1240-dependency-audit-2026-08-03-batch.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_fix-version-becomes-the-vulnerable-version.md",
      ".claude/agent-memory/code-issue/project_override-guard-floor-not-ceiling.md",
      ".claude/agent-memory/code-issue/project_waiver-reachability-needs-every-call-site.md",
      ".github/workflows/sast.yml",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ],
    1245: [
      ".changes/unreleased/1220-classify-final-answer-linear-scanner.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_redos-strip-regex-oracle.md",
      "server/src/lib/analysis/agent-loop-classify-redos.test.ts",
      "server/src/lib/analysis/agent-loop.ts",
    ],
    1246: [
      ".changes/unreleased/1224-single-shot-output-cap.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/feedback_commit-before-mutation-proof.md",
      ".claude/agent-memory/code-issue/project_chatoptions-change-rekeys-e2e-fixtures.md",
      ".claude/agent-memory/code-issue/project_diagnostic-dead-at-producer.md",
      "server/scripts/e2e-build-clarify-fixtures.ts",
      "server/src/lib/ai/providers/anthropic-provider.test.ts",
      "server/src/lib/ai/providers/anthropic-provider.ts",
      "server/src/lib/analysis/agent-runner.ts",
      "server/src/lib/analysis/agentic-salvage-pipeline.test.ts",
      "server/src/lib/analysis/orchestrator.ts",
      "server/tests/analysis-agent-runner.test.ts",
      "server/tests/e2e-clarify-fixture-key-parity.test.ts",
    ],
    1254: [
      ".changes/unreleased/1244-parse-tool-call-fence-redos.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_redos-strip-regex-oracle.md",
      "server/src/lib/analysis/agent-loop-fence-redos.test.ts",
      "server/src/lib/analysis/agent-loop.ts",
    ],
    1255: [
      ".changes/unreleased/1221-clamp-final-answer-output-cap.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_getnumber-skips-registry-schema.md",
      "server/src/index.ts",
      "server/src/lib/ai/model-output-limits.test.ts",
      "server/src/lib/ai/model-output-limits.ts",
      "server/src/lib/analysis/agent-runner.ts",
      "server/src/lib/analysis/orchestrator.ts",
      "server/src/lib/config/key-registry.ts",
      "server/tests/analysis-agent-runner.test.ts",
    ],
    1258: [
      ".changes/unreleased/1241-brace-expansion-1-1-18.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_advisory-guard-floor-goes-stale-on-supersede.md",
      ".claude/agent-memory/code-issue/project_fix-version-becomes-the-vulnerable-version.md",
      ".github/workflows/sast.yml",
      "pnpm-lock.yaml",
      "pnpm-workspace.yaml",
    ],
    1259: [
      ".changes/unreleased/1222-finding-category-coercion.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_derived-on-both-sides-is-a-tautology.md",
      ".claude/agent-memory/code-issue/project_relaxing-a-rule-rewrites-tests-that-used-it-as-a-fixture.md",
      "packages/shared/src/agent-finding-category.test.ts",
      "packages/shared/src/analysis.ts",
      "server/src/lib/analysis/agent-runner.ts",
      "server/src/lib/analysis/agentic-degradation.test.ts",
      "server/src/lib/analysis/finding-provenance-contract.test.ts",
      "server/src/lib/analysis/prompts.ts",
      "server/tests/analysis-finding-category-coercion.test.ts",
      "server/tests/analysis-orchestrator.test.ts",
    ],
    1261: [
      ".changes/unreleased/1253-extract-json-object-fence-redos.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_redos-strip-regex-oracle.md",
      "server/src/lib/analysis/agent-runner-fence-redos.test.ts",
      "server/src/lib/analysis/agent-runner.ts",
    ],
    1262: [
      ".changes/unreleased/1225-transcript-compaction.md",
      ".claude/agent-memory/code-issue/MEMORY.md",
      ".claude/agent-memory/code-issue/project_logger-redacts-any-token-key.md",
      ".claude/agent-memory/code-issue/project_transcript-compaction-hysteresis.md",
      "docs/ARCHITECTURE.md",
      "server/src/lib/analysis/agent-loop.ts",
      "server/src/lib/analysis/context-window-manager.ts",
      "server/src/lib/analysis/token-optimization.test.ts",
      "server/src/lib/analysis/transcript-compaction-loop.test.ts",
      "server/src/lib/analysis/transcript-compaction.test.ts",
      "server/tests/context-window-manager.test.ts",
    ],
  };

  /**
   * A PR's code paths: what it changed, minus the two prose classes every `code-issue` PR
   * carries by policy. `CLAUDE.md` requires a changelog fragment and commits agent memory, so
   * *every* PR here has files under both — which makes them the exact confounder that would
   * let a corpus entry pass without any signal reaching real code.
   */
  const codePathsOf = (files) =>
    files.filter((p) => !p.startsWith(".changes/") && !p.startsWith(".claude/agent-memory/"));

  const PR_NUMBERS = Object.keys(MERGED_PR_FILES).map(Number);

  it("covers every PR the issue and its dispatch name", () => {
    // Guard the guard: a corpus that silently lost entries would make every loop below
    // weaker without failing. #1249's table names four; the dispatch adds the rest of the
    // session's security PRs.
    expect(PR_NUMBERS).toEqual(
      expect.arrayContaining([1216, 1242, 1243, 1245, 1246, 1254, 1255, 1258, 1259, 1261, 1262]),
    );
    for (const n of PR_NUMBERS) expect(MERGED_PR_FILES[n].length).toBeGreaterThan(0);
  });

  it.each(PR_NUMBERS)("PR #%s requires a panel against its real changed-path list", (n) => {
    expect(shouldRunAdversarialPass({ changedPaths: MERGED_PR_FILES[n] }).required).toBe(true);
  });

  it.each(PR_NUMBERS)("PR #%s requires a panel on its CODE paths alone", (n) => {
    // The assertion that cannot be satisfied by a changelog fragment or a memory note whose
    // filename happens to carry a vocabulary word.
    const code = codePathsOf(MERGED_PR_FILES[n]);
    expect(code.length, `#${n} has no code paths left to assert on`).toBeGreaterThan(0);
    const result = shouldRunAdversarialPass({ changedPaths: code });
    expect(result.required, `#${n} fires only on prose: ${JSON.stringify(result.reasons)}`).toBe(
      true,
    );
  });

  it.each(PR_NUMBERS)("PR #%s fires on an arm this issue added, not an incidental one", (n) => {
    // #1247 fires on `routes/` and always did; it is not in this corpus. Every entry here must
    // owe its verdict to one of the four new arms, or the corpus is measuring #1190's work.
    const reasons = shouldRunAdversarialPass({
      changedPaths: codePathsOf(MERGED_PR_FILES[n]),
    }).reasons;
    expect(
      reasons.some((r) => NEW_REASONS.some((needle) => r.includes(needle))),
      `#${n} fires only on pre-existing arms: ${JSON.stringify(reasons)}`,
    ).toBe(true);
  });

  /**
   * Per-signal pins for the four arms #1249 added — the mutation ratchet.
   *
   * This mirrors the structure #1190 arrived at after its panel found the first attempt
   * vacuous, and for the same reasons, restated because they are not obvious:
   *
   *   1. **A derived `it.each` over the live set closes addition and nothing else.** A word that
   *      leaves the vocabulary leaves the loop with it, so deletion and rename are invisible to
   *      it. Each word is therefore *also* pinned by name against a hardcoded path.
   *   2. **Each pin path carries exactly one vocabulary word.** `mfa/totp.ts` pinned `totp` not
   *      at all, because `mfa` fired anyway.
   *   3. **Assert the reason, never `.required`.** The gate ORs fourteen arms now, so
   *      `.required` is arm-blind — `credential-store.ts` fires on the secrets arm whether or
   *      not `credential` is in the identity vocabulary.
   *   4. **A strike-out arm proves the pin is a pin.** Replace the word with `zzz` and the arm's
   *      reason must vanish. Without it, an entry can pass off a neighbouring word forever.
   *
   * Rule 4 is what makes this a mutation proof rather than a claim about one: deleting a word
   * from the vocabulary fails its named pin, and the strike-out arm is the *restore* evidence —
   * it demonstrates that the pin's path fires **because of that word**, so the failure the
   * deletion causes cannot be attributed to anything else in the path.
   *
   * @type {ReadonlyArray<[word: string, path: string, reason: string]>}
   */
  const NEW_SIGNAL_WORD_PINS = [
    // --- security and verification gates ---
    ["sast", "ci/sast-profile.yml", GATE_REASON],
    ["semgrep", "ci/semgrep-rules.yml", GATE_REASON],
    ["codeql", "ci/codeql-suite.yml", GATE_REASON],
    ["gitleaks", "ci/gitleaks-baseline.toml", GATE_REASON],
    ["trivy", "ci/trivy-ignore.yaml", GATE_REASON],
    ["snyk", "ci/snyk-policy.yml", GATE_REASON],
    ["osv", "ci/osv-scanner-config.toml", GATE_REASON],
    ["waiver", "ci/waiver-list.yml", GATE_REASON],
    ["waivers", "ci/waivers-index.yml", GATE_REASON],
    ["advisory", "ci/advisory-floor.yml", GATE_REASON],
    ["advisories", "ci/advisories-batch.yml", GATE_REASON],
    ["cve", "ci/cve-allowfile.yml", GATE_REASON],
    ["dependabot", "ci/dependabot-guard.yml", GATE_REASON],
    ["adversarial", "ci/adversarial-gate.mjs", GATE_REASON],
    ["frontmatter", "ci/frontmatter-gate.mjs", GATE_REASON],
    // --- parsers over untrusted input ---
    ["parse", "server/src/lib/x/parse-fence.ts", PARSER_REASON],
    ["parser", "server/src/lib/x/tag-parser.ts", PARSER_REASON],
    ["parsers", "server/src/lib/x/upload-parsers.ts", PARSER_REASON],
    ["parsing", "server/src/lib/x/parsing-rules.ts", PARSER_REASON],
    ["lexer", "server/src/lib/x/sql-lexer.ts", PARSER_REASON],
    ["unescape", "server/src/lib/x/html-unescape.ts", PARSER_REASON],
    ["deserialize", "server/src/lib/x/payload-deserialize.ts", PARSER_REASON],
    ["deserialise", "server/src/lib/x/payload-deserialise.ts", PARSER_REASON],
    ["redos", "server/src/lib/x/redos-guard.ts", PARSER_REASON],
    // --- AI provider and model configuration (compound: `ai` + one of these) ---
    ["config", "server/src/lib/ai/config.ts", AI_CONFIG_REASON],
    ["configuration", "server/src/lib/ai/configuration.ts", AI_CONFIG_REASON],
    ["provider", "server/src/lib/ai/upstream-provider.ts", AI_CONFIG_REASON],
    ["providers", "server/src/lib/ai/providers/factory.ts", AI_CONFIG_REASON],
    ["model", "server/src/lib/ai/model-router.ts", AI_CONFIG_REASON],
    ["models", "server/src/lib/ai/models.ts", AI_CONFIG_REASON],
  ];

  it.each(NEW_SIGNAL_WORD_PINS)("fires the %s arm for the word in %s", (word, path, reason) => {
    const reasons = shouldRunAdversarialPass({ changedPaths: [path] }).reasons;
    expect(
      reasons.some((r) => r.includes(reason)),
      `"${word}" no longer reaches its arm — reasons: ${JSON.stringify(reasons)}`,
    ).toBe(true);
  });

  it.each(NEW_SIGNAL_WORD_PINS)(
    "pins %s on the word itself, not on a neighbour",
    (word, path, reason) => {
      // The restore arm for the mutation proof: strike the word out and the arm's reason must go
      // with it. If it survives, the pin above was passing on a neighbouring word and deleting
      // the vocabulary entry would have been silent.
      const struck = path.replace(word, "zzz");
      expect(struck, `"${word}" does not appear in its own pin path`).not.toBe(path);
      const reasons = shouldRunAdversarialPass({ changedPaths: [struck] }).reasons;
      expect(
        reasons.some((r) => r.includes(reason)),
        `${struck} still reaches the arm without "${word}", so the pin above proves nothing — reasons: ${JSON.stringify(reasons)}`,
      ).toBe(false);
    },
  );

  it("pins every word in the three word vocabularies, and only words that are in them", () => {
    // The coupling that makes the block above a specification and not a snapshot: the *paths*
    // are hardcoded (so a deletion or rename fails the pin), while coverage is checked against
    // the live exported sets (so an addition fails here). Neither direction rests on a count.
    const pinned = NEW_SIGNAL_WORD_PINS.map(([word]) => word).sort();
    const live = [...SECURITY_GATE_TERMS, ...UNTRUSTED_PARSER_TERMS, ...AI_CONFIG_TERMS].sort();
    expect(pinned).toEqual(live);
  });

  /**
   * The compound clause of the parser arm, pinned separately because a word list cannot express
   * it: measured against `git ls-files`, `agent` alone is 268 tracked paths (335 counting
   * `agents`) and adding either to the vocabulary would take this arm from 35 to 290, while
   * `runner` alone is not about parsing at all.
   *
   * `server/src/lib/analysis/agent-loop.ts` and `agent-runner.ts` are where all three of this
   * session's ReDoS defects (#1220, #1244, #1253) actually were, and neither carries a word from
   * `UNTRUSTED_PARSER_TERMS`. Without this clause the parser arm would miss the entire class it
   * was added for.
   *
   * **Both spellings of the noun are pinned.** The first draft looped only over
   * `agent-${half}.ts`, and the #1249 panel proved that left `|| w === "agents"` deletable with
   * all 1,556 tests green — an unpinned disjunct is a signal with no mutation ratchet, which is
   * the criterion this suite exists to satisfy. `agents` is the spelling the directory form
   * uses (`server/copilot-svc/src/agents/qa-agent.sandbox-runner.ts`), so it is not decorative.
   */
  it.each(
    ["agent", "agents"].flatMap((noun) =>
      [...AGENT_TRANSCRIPT_READERS].map((half) => [noun, half]),
    ),
  )("fires the parser arm on the %s + %s compound, and on neither half alone", (noun, half) => {
    // `agents` as a directory and `agent` as a filename prefix — the two real shapes.
    const both =
      noun === "agents"
        ? `server/copilot-svc/src/agents/qa.sandbox-${half}.ts`
        : `server/src/lib/analysis/agent-${half}.ts`;
    expect(
      shouldRunAdversarialPass({ changedPaths: [both] }).reasons.some((r) =>
        r.includes(PARSER_REASON),
      ),
      `${noun} + ${half} does not reach the parser arm`,
    ).toBe(true);

    // Neither half alone: this is what keeps the clause from being `agent` (268 paths).
    for (const halfOnly of [
      both.replace(noun, "zzz"),
      `server/src/lib/x/${noun}.ts`,
      `server/src/lib/analysis/zzz-${half}.ts`,
    ]) {
      expect(
        shouldRunAdversarialPass({ changedPaths: [halfOnly] }).reasons.some((r) =>
          r.includes(PARSER_REASON),
        ),
        `${halfOnly} reaches the parser arm on half the compound`,
      ).toBe(false);
    }
  });

  /**
   * The AI-config arm is a compound too, and the `ai` half needs its own pin: without it the arm
   * degenerates into `config`, which fires on every `vitest.config.ts` in the tree (54 paths
   * measured).
   */
  it("requires both halves of the AI-config compound", () => {
    expect(
      shouldRunAdversarialPass({ changedPaths: ["server/src/lib/ai/config.ts"] }).reasons.some(
        (r) => r.includes(AI_CONFIG_REASON),
      ),
    ).toBe(true);
    for (const halfOnly of ["scripts/vitest.config.ts", "server/src/lib/ai/cache-crossover.ts"]) {
      expect(
        shouldRunAdversarialPass({ changedPaths: [halfOnly] }).reasons.some((r) =>
          r.includes(AI_CONFIG_REASON),
        ),
        `${halfOnly} reaches the AI-config arm on half the compound`,
      ).toBe(false);
    }
  });

  /**
   * Every dependency manifest in the set fires, pinned by an **independently written path**.
   *
   * Unlike the word arms this one is an **exact basename** match, which is a stronger form of
   * #1172's rule than word-splitting: it cannot have a substring accident *or* a homograph. So
   * the strike-out arm the word pins use does not apply, and its job is done by
   * `NEW_SIGNALS_MUST_NOT_FIRE` below, which pins that a manifest name *inside* a longer
   * filename stays silent.
   *
   * **The first draft of this was `it.each([...DEPENDENCY_MANIFEST_FILES])` building each path
   * from the entry itself, and a mutation sweep proved it vacuous**: 18 of the 19 filenames
   * could be deleted from the vocabulary with all 1,555 tests green, because deleting an entry
   * also deletes its own test case. Only `pnpm-lock.yaml` was caught, and only because the
   * lockfile-decision test below names it in prose. That is #1190's "a derived loop cannot
   * catch its own deletion" in a second module, and it is why the paths below are hardcoded
   * while *coverage* is checked against the live set — the same ratchet, closing addition and
   * deletion from opposite sides.
   *
   * Each entry deliberately nests the manifest under a directory, so it also pins that the
   * match is on the **basename** and not on the whole path.
   *
   * @type {ReadonlyArray<[file: string, path: string]>}
   */
  const MANIFEST_MUST_FIRE_SPEC = [
    ["package.json", "packages/ui-kit/package.json"],
    ["pnpm-lock.yaml", "pnpm-lock.yaml"],
    ["pnpm-workspace.yaml", "pnpm-workspace.yaml"],
    ["package-lock.json", "images/wrapper/package-lock.json"],
    ["npm-shrinkwrap.json", "images/wrapper/npm-shrinkwrap.json"],
    ["yarn.lock", "images/wrapper/yarn.lock"],
    [".npmrc", "server/.npmrc"],
    ["requirements.txt", "metis-sql-lineage/requirements.txt"],
    ["pipfile.lock", "metis-sql-lineage/Pipfile.lock"],
    ["poetry.lock", "metis-sql-lineage/poetry.lock"],
    ["pyproject.toml", "metis-sql-lineage/pyproject.toml"],
    ["go.mod", "tools/probe/go.mod"],
    ["go.sum", "tools/probe/go.sum"],
    ["cargo.toml", "tools/indexer/Cargo.toml"],
    ["cargo.lock", "tools/indexer/Cargo.lock"],
    ["gemfile.lock", "tools/site/Gemfile.lock"],
    ["pom.xml", "eval-data/fixtures/jpetstore/pom.xml"],
    ["build.gradle", "eval-data/fixtures/android/build.gradle"],
    ["build.gradle.kts", "eval-data/fixtures/android/build.gradle.kts"],
  ];

  it.each(MANIFEST_MUST_FIRE_SPEC)("fires the supply-chain arm for %s, via %s", (file, path) => {
    expect(
      shouldRunAdversarialPass({ changedPaths: [path] }).reasons.some((r) =>
        r.includes(SUPPLY_REASON),
      ),
      `"${file}" no longer reaches the supply-chain arm`,
    ).toBe(true);
  });

  it("pins every manifest in the vocabulary, and only manifests that are in it", () => {
    // Coverage against the live set, so adding a filename without pinning it fails here and
    // removing one fails its named case above. Compared lowercase because the arm matches
    // case-insensitively and the spec paths use each toolchain's real casing (`Cargo.toml`).
    expect(MANIFEST_MUST_FIRE_SPEC.map(([file]) => file).sort()).toEqual(
      [...DEPENDENCY_MANIFEST_FILES].sort(),
    );
    for (const [file, path] of MANIFEST_MUST_FIRE_SPEC) {
      expect(path.split("/").pop().toLowerCase(), `${path} is not a ${file}`).toBe(file);
    }
  });

  /**
   * The lockfile decision, pinned so it is a decision and not a drift (#1249 asks for it
   * explicitly).
   *
   * **A lockfile-only change requires a panel.** Measured over the last 300 commits on `main`:
   * 12 touched `pnpm-lock.yaml`, 22 touched a manifest, and **0 touched the lockfile without
   * also touching a manifest** — so this costs zero additional panels over that window. The
   * feared "every dependabot PR becomes a three-voter panel" does not follow either: every npm
   * bump edits `package.json` too, so those PRs fire on the manifest half regardless.
   *
   * What it buys is the one case a declared-dependencies rule structurally cannot see — a
   * `pnpm update` moving a *transitive* dependency, which rewrites only the lockfile while
   * changing what actually ships.
   */
  it("requires a panel for a lockfile-only change, with no manifest touched", () => {
    const result = shouldRunAdversarialPass({ changedPaths: ["pnpm-lock.yaml"] });
    expect(result.required).toBe(true);
    expect(result.reasons).toEqual([`pnpm-lock.yaml — ${SUPPLY_REASON}`]);
  });

  /**
   * Must not fire — the substring class, re-pinned for four new vocabularies.
   *
   * #1172 removed substring matching after `sso`-inside-`crossover` fired three-voter panels,
   * and #1249's acceptance criteria say "no new substring test". These are the accidents each
   * new arm would have if it were written as `byPattern(/…/i)`, and several are real English:
   * `sparse` contains `parse`, `multiplexer` contains `lexer`, `domain` contains `ai`.
   */
  const NEW_SIGNALS_MUST_NOT_FIRE = [
    // `parse` inside `sparse` — and this repo really does have sparse vectors in its RAG stack
    "server/src/lib/rag/sparse-vector.ts",
    "server/tests/rag/sparse-retrieval.test.ts",
    // `lexer` inside `multiplexer`
    "server/src/lib/stream/multiplexer.ts",
    // `ai` inside `domain`, `chain` and `explain` — the AI-config compound must read a word
    "server/src/lib/domain/config.ts",
    "server/src/lib/chain/model-step.ts",
    "ui/src/components/explain-provider-choice.tsx",
    // `loop` inside `loopback`, one half of the parser compound
    "server/src/lib/net/agent-loopback.ts",
    // a manifest name inside a longer filename: exact-basename is what rejects these
    "server/src/lib/pkg/package-json-reader.ts",
    "ui/package.json.bak",
    "eval-data/corpus/fixtures/cargo.toml.template",
    "docs/pnpm-workspace.yaml.md",
  ];

  it.each(NEW_SIGNALS_MUST_NOT_FIRE)("does not fire any #1249 arm for %s", (path) => {
    const reasons = shouldRunAdversarialPass({ changedPaths: [path] }).reasons;
    const hit = reasons.filter((r) => NEW_REASONS.some((needle) => r.includes(needle)));
    expect(hit, `substring accident: ${JSON.stringify(hit)}`).toEqual([]);
  });

  /**
   * Over-fires kept on purpose, pinned the way #1172 and #1190 pin theirs so a later narrowing
   * argues with a test rather than quietly absorbing them.
   *
   * All are prose *about* a gate or a parser rather than code that is one. Suppressing them
   * means a path-prefix disqualifier over `.claude/agent-memory/` and `.changes/`, and a prefix
   * rule that silences a whole subtree is the mechanism the #1172 panel rejected for `session`.
   * The class is open, not closed: `CLAUDE.md` requires every `code-issue` PR to commit its
   * memory files, so a future note named `*waiver*` or `*parser*` joins it without a decision.
   */
  const NEW_SIGNALS_ACCEPTED_OVER_FIRE = [
    ".claude/agent-memory/code-issue/project_sast-waiver-verification-recipe.md",
    ".claude/agent-memory/code-issue/project_semgrep-non-literal-regexp-gate.md",
    ".claude/agent-memory/code-issue/project_pnpm-engines-is-enforced-not-advisory.md",
    ".claude/agent-memory/code-issue/project_redos-strip-regex-oracle.md",
    ".changes/unreleased/1219-semgrep-object-assign.md",
    // not a gate at all: a markdown front-matter parser over UPLOADED project files, so it is
    // inside the parser arm's class on its own merits and firing here is early, not wrong
    "server/src/lib/library/frontmatter.ts",
    // `agent` + `runner` reaches a *test* runner for the frontmatter gate; already required by
    // the gate arm, so it costs no panel that was not already owed
    "scripts/lib/verify-agent-frontmatter-runner.test.mjs",
  ];

  it.each(NEW_SIGNALS_ACCEPTED_OVER_FIRE)(
    "still fires on %s, accepted as the cheap direction",
    (path) => {
      expect(shouldRunAdversarialPass({ changedPaths: [path] }).required).toBe(true);
    },
  );

  /**
   * The recursion #1249 names, and the reason this issue could have shipped un-panelled.
   *
   * `scripts/lib/adversarial-tally-core.mjs` matched **no signal** before this change, so a PR
   * narrowing `PATH_SIGNALS` — this one — required no adversarial panel. The gate now fires on
   * itself and on its own test file, which is the property that makes every future narrowing of
   * it argue with three voters.
   */
  it("fires on the file that decides whether to fire", () => {
    for (const path of [
      "scripts/lib/adversarial-tally-core.mjs",
      "scripts/lib/adversarial-tally-core.test.mjs",
      "scripts/adversarial-tally.mjs",
      ".claude/agents/adversarial-reviewer.md",
    ]) {
      const reasons = shouldRunAdversarialPass({ changedPaths: [path] }).reasons;
      expect(
        reasons.some((r) => r.includes(GATE_REASON)),
        `${path} does not require a panel — the gate is still invisible to itself`,
      ).toBe(true);
    }
  });

  /**
   * The other two gate modules #1249 names by path, pinned by path rather than by word.
   *
   * `.github/workflows/sast.yml` and `scripts/lib/agent-frontmatter-core.mjs` are the concrete
   * files #1215 found fail-opens in. A word pin proves the vocabulary works; these prove the
   * vocabulary reaches the files the issue was actually written about.
   */
  it.each([
    ".github/workflows/sast.yml",
    "scripts/lib/agent-frontmatter-core.mjs",
    "scripts/verify-agent-frontmatter.mjs",
    ".gitleaks.toml",
    ".github/dependabot.yml",
  ])("requires a panel for the named gate file %s", (path) => {
    expect(
      shouldRunAdversarialPass({ changedPaths: [path] }).reasons.some((r) =>
        r.includes(GATE_REASON),
      ),
    ).toBe(true);
  });
});

describe("shouldRunAdversarialPass — the redaction/audit/logging sink arm (#1275)", () => {
  const SINK_REASON = "redaction, audit or logging sink";

  /**
   * PR #1271's changed-path list, **verbatim from `gh pr view 1271 --json files`**.
   *
   * Typed from the API rather than approximated, for the reason #1249's corpus gives: an
   * approximated file list is a corpus that tests the approximation. This is the PR the issue
   * is about — it narrows the token-count exemption across the redaction sinks — and before
   * this change the gate's only reason for it was the *filename* of a memory note.
   */
  const PR_1271_FILES = [
    ".changes/unreleased/1268-redaction-sink-registry.md",
    ".claude/agent-memory/code-issue/MEMORY.md",
    ".claude/agent-memory/code-issue/project_custom-agents-backend.md",
    ".claude/agent-memory/code-issue/project_logger-redacts-any-token-key.md",
    "docs/decisions/0008-redaction-sinks.md",
    "server/src/lib/audit/audit-service.ts",
    "server/src/lib/custom-agents/invocation-audit.ts",
    "server/src/lib/logger.ts",
    "server/src/lib/sandbox/audit/redact.ts",
    "server/tests/audit-redaction.test.ts",
    "server/tests/custom-agent-invocation-audit.test.ts",
    "server/tests/lib/sandbox/audit/redact.test.ts",
    "server/tests/redaction-sinks.enumeration.test.ts",
  ];

  /** The two prose classes every `code-issue` PR carries by policy — the confounder. */
  const codePathsOf = (files) =>
    files.filter((p) => !p.startsWith(".changes/") && !p.startsWith(".claude/agent-memory/"));

  it("requires a panel for PR #1271's real changed-path list", () => {
    expect(shouldRunAdversarialPass({ changedPaths: PR_1271_FILES }).required).toBe(true);
  });

  it("requires a panel for PR #1271 on its CODE paths alone", () => {
    // The assertion the gate failed before this change: strip the changelog fragment and the
    // memory notes and all nine code paths were dark, `{ required: false, reasons: [] }`. The
    // one reason it did return came from `project_logger-redacts-any-token-key.md` matching the
    // word `token` in a *filename* — #1249's "a coincidence is not coverage", recurring.
    const code = codePathsOf(PR_1271_FILES);
    expect(code.length).toBeGreaterThan(0);
    const result = shouldRunAdversarialPass({ changedPaths: code });
    expect(result.required, `#1271 fires only on prose: ${JSON.stringify(result.reasons)}`).toBe(
      true,
    );
  });

  it("fires PR #1271 on the arm this issue added, not an incidental one", () => {
    const reasons = shouldRunAdversarialPass({
      changedPaths: codePathsOf(PR_1271_FILES),
    }).reasons;
    expect(
      reasons.some((r) => r.includes(SINK_REASON)),
      `#1271 fires only on pre-existing arms: ${JSON.stringify(reasons)}`,
    ).toBe(true);
  });

  it("pins that the memory note alone was the whole pre-change verdict", () => {
    // Guard the guard above: if this note ever stops firing on `token`, the "all nine code
    // paths were dark" claim becomes untestable and the CODE-paths assertion becomes the only
    // thing standing. Named so the premise is visible rather than assumed.
    const note = ".claude/agent-memory/code-issue/project_logger-redacts-any-token-key.md";
    expect(PR_1271_FILES).toContain(note);
    expect(shouldRunAdversarialPass({ changedPaths: [note] }).required).toBe(true);
  });

  /**
   * The three files the issue names, each asserted **individually** and on this arm's reason —
   * not on `.required`, which is arm-blind across fifteen ORed signals.
   */
  it.each([
    "server/src/lib/logger.ts",
    "server/src/lib/sandbox/audit/redact.ts",
    "server/src/lib/audit/audit-service.ts",
    "server/src/lib/custom-agents/invocation-audit.ts",
  ])("requires a panel for the redaction sink %s", (path) => {
    const reasons = shouldRunAdversarialPass({ changedPaths: [path] }).reasons;
    expect(
      reasons.some((r) => r.includes(SINK_REASON)),
      `${path} implements redaction and reaches no sink signal — reasons: ${JSON.stringify(reasons)}`,
    ).toBe(true);
  });

  /**
   * The measurement that decided the mechanism, kept as a test so it is a decision and not a
   * preference (#1275 offers an exact-path registry and prefers it).
   *
   * Every path here is a **real tracked** security-control implementation that PR #1271 does
   * *not* touch, so a registry seeded from that PR — the only seed available — would leave all
   * six silent. `pii-redactor.ts` is the one that settles it: a fifth redaction implementation
   * named in no issue in this thread.
   *
   * **Eleven** sink implementations are tracked; #1271 touches four, so the registry misses
   * seven. These are the six of those seven that fired *no* signal before this change; the
   * seventh, `server/src/middleware/request-logger.ts`, already fired on the middleware arm and
   * is pinned by its own named test below. All eleven are named `*audit*`, `*log*` or
   * `*redact*`, which is why a word vocabulary covers the registry *and* the convention that
   * produced it. (The first draft of this comment said "six sinks exist" directly above an
   * `it.each` of six *further* files — all three panel lenses caught the contradiction.)
   */
  it.each([
    "server/src/lib/connectors/pii-redactor.ts",
    "server/src/lib/audit/mcp-audit.ts",
    "server/src/lib/sandbox/audit/audit-emitter.ts",
    "server/src/lib/sandbox/repos/sandbox-audit-event.repo.ts",
    "server/src/lib/mcp/provisioners/log-streamer.ts",
    ".github/hooks/scripts/terminal-audit.mjs",
  ])("fires on %s, which an exact-path registry of #1271's files would have missed", (path) => {
    expect(
      shouldRunAdversarialPass({ changedPaths: [path] }).reasons.some((r) =>
        r.includes(SINK_REASON),
      ),
    ).toBe(true);
  });

  /**
   * Per-word pins — the mutation ratchet, in the shape #1249 arrived at after its own sweep
   * proved a derived loop vacuous (18 of 19 manifest entries deletable, 1,555 tests green).
   *
   * Four rules, restated because each was learned by a panel finding rather than by design:
   *
   *   1. **The path is hardcoded**, so deleting or renaming the word fails this case. A loop
   *      built from the live set closes *addition* and nothing else.
   *   2. **Each path carries exactly one word from this vocabulary and nothing else that
   *      fires**, so the pin cannot pass on a neighbour.
   *   3. **The reason is asserted, never `.required`** — fifteen arms are ORed now.
   *   4. **A strike-out arm is the restore evidence**: replace the word with `zzz` and this
   *      arm's reason must vanish, which is what proves the pin's path fires *because of that
   *      word* and so attributes the deletion failure to the deletion.
   *
   * @type {ReadonlyArray<[word: string, path: string]>}
   */
  const SINK_WORD_PINS = [
    ["redact", "server/src/lib/x/redact-fields.ts"],
    ["redacts", "server/src/lib/x/redacts-keys.ts"],
    ["redacted", "server/src/lib/x/redacted-fields.ts"],
    ["redaction", "server/src/lib/x/redaction-policy.ts"],
    ["redactor", "server/src/lib/x/field-redactor.ts"],
    ["redactors", "server/src/lib/x/field-redactors.ts"],
    ["pii", "server/src/lib/x/pii-filter.ts"],
    ["scrub", "server/src/lib/x/scrub-fields.ts"],
    ["scrubber", "server/src/lib/x/value-scrubber.ts"],
    ["scrubbing", "server/src/lib/x/scrubbing-rules.ts"],
    ["audit", "server/src/lib/x/audit-writer.ts"],
    ["audits", "server/src/lib/x/audits-index.ts"],
    ["auditing", "server/src/lib/x/auditing-hooks.ts"],
    ["log", "server/src/lib/x/log-sink.ts"],
    ["logs", "server/src/lib/x/logs-writer.ts"],
    ["logger", "server/src/lib/x/logger-core.ts"],
    ["logging", "server/src/lib/x/logging-rules.ts"],
  ];

  it.each(SINK_WORD_PINS)("fires the sink arm for the word %s, via %s", (word, path) => {
    expect(
      shouldRunAdversarialPass({ changedPaths: [path] }).reasons.some((r) =>
        r.includes(SINK_REASON),
      ),
      `"${word}" no longer reaches the sink arm`,
    ).toBe(true);
  });

  it.each(SINK_WORD_PINS)("pins %s on the word itself, not on a neighbour", (word, path) => {
    const struck = path.replace(word, "zzz");
    expect(struck, `"${word}" does not appear in its own pin path`).not.toBe(path);
    const reasons = shouldRunAdversarialPass({ changedPaths: [struck] }).reasons;
    expect(
      reasons.some((r) => r.includes(SINK_REASON)),
      `${struck} still reaches the sink arm without "${word}", so the pin proves nothing — reasons: ${JSON.stringify(reasons)}`,
    ).toBe(false);
  });

  it("pins every word in the sink vocabulary, and only words that are in it", () => {
    // Coverage against the live exported set: adding a word without pinning it fails here,
    // removing one fails its named case above. Neither direction rests on a count.
    expect(SINK_WORD_PINS.map(([word]) => word).sort()).toEqual([...REDACTION_SINK_TERMS].sort());
  });

  /**
   * Must not fire — the substring class, which is the whole reason `log` is affordable.
   *
   * #1275 warns that "`log` alone would be worse than any of those", quoting #1249's rejected
   * signals at 85, 54 and 52 paths. Measured over all 4,093 tracked paths, `/log/i` as a
   * **substring** is 57, `log` as a **word** is 5, and the whole logging sub-vocabulary is 10 —
   * leaving **47** pure substring accidents. Every path below is one of those 47, and all but
   * the hypothetical are real tracked files.
   *
   * `login/page.tsx` and `logout/route.ts` still fire — on the identity and auth arms, which is
   * correct and unrelated — so this asserts the *sink reason* is absent rather than that the
   * gate is silent. Filtering by reason is what makes them usable as evidence at all.
   */
  const SINK_MUST_NOT_FIRE = [
    // `log` inside `dialog`, 22 tracked paths
    "ui/src/components/ui/dialog.tsx",
    // inside `changelog`, 8
    "CHANGELOG.md",
    // inside `logical`, 7
    "server/src/lib/portability/logical-dump.ts",
    // inside `tautology`, 1
    ".claude/agent-memory/code-issue/project_derived-on-both-sides-is-a-tautology.md",
    // inside `login`/`logout`, 9 — these fire other arms, never this one
    "ui/src/app/login/page.tsx",
    "ui/src/app/api/auth/logout/route.ts",
    // `audit` inside `audition` — the only English word that contains it, so hypothetical
    "ui/src/components/media/audition-player.tsx",
    // `pii` and `scrub` have no English homograph; `redact` inside `redacted` is the same
    // subject and is a vocabulary entry in its own right, not an accident
  ];

  it.each(SINK_MUST_NOT_FIRE)("does not fire the sink arm for %s", (path) => {
    const hit = shouldRunAdversarialPass({ changedPaths: [path] }).reasons.filter((r) =>
      r.includes(SINK_REASON),
    );
    expect(hit, `substring accident: ${JSON.stringify(hit)}`).toEqual([]);
  });

  /**
   * Over-fires kept on purpose, pinned the way #1172, #1190 and #1249 pin theirs, so a later
   * narrowing argues with a test rather than quietly absorbing them.
   *
   * The prose entries are the same open class every previous arm accepted: suppressing them
   * means a path-prefix disqualifier over `.claude/agent-memory/`, `.changes/` and
   * `eval-data/corpus/`, and a prefix rule that silences a whole subtree is the mechanism the
   * #1172 panel rejected for `session`. `SR_AUDIT.md` is a screen-reader audit and is the
   * purest homograph in the set — one path, and no word-level rule can tell it from a security
   * audit. `pr-audit.ts` audits a diff rather than recording a security event.
   */
  const SINK_ACCEPTED_OVER_FIRE = [
    "docs/accessibility/SR_AUDIT.md",
    "server/src/lib/agents/pr-reviewer/pr-audit.ts",
    "eval-data/corpus/docretrieval-02-metis-docs-wide/docs/security/2026-q2-mcp-audit.md",
    ".changes/unreleased/1215-audit-verify-gates-fail-open.md",
    ".claude/agent-memory/code-issue/project_ci-dependency-audit-live-feed-red.md",
    "ui/src/app/(authed)/settings/audit/page.tsx",
  ];

  it.each(SINK_ACCEPTED_OVER_FIRE)("still fires on %s, accepted as the cheap direction", (path) => {
    expect(shouldRunAdversarialPass({ changedPaths: [path] }).required).toBe(true);
  });

  it("names the concrete path and the sink arm, so the decision stays auditable", () => {
    expect(
      shouldRunAdversarialPass({ changedPaths: ["server/src/lib/logger.ts"] }).reasons,
    ).toEqual([
      "server/src/lib/logger.ts — redaction, audit or logging sink — a secret leaks here by omission",
    ]);
  });

  it("does not silence a sink path that another arm also claims", () => {
    // `server/src/middleware/request-logger.ts` fired on the middleware arm before this change
    // and must still fire on both: a widening that redistributes reasons is fine, one that
    // loses a pre-existing one is the dangerous direction.
    const reasons = shouldRunAdversarialPass({
      changedPaths: ["server/src/middleware/request-logger.ts"],
    }).reasons;
    expect(reasons.some((r) => r.includes("middleware"))).toBe(true);
    expect(reasons.some((r) => r.includes(SINK_REASON))).toBe(true);
  });
});

describe("normalizeVerdict", () => {
  it("accepts a clean SOUND verdict", () => {
    const result = normalizeVerdict(verdict("over-blocking"));
    expect(result).toMatchObject({ lens: "over-blocking", verdict: "SOUND", errors: [] });
  });

  it("rejects a verdict that is not an object", () => {
    expect(normalizeVerdict("SOUND")).toMatchObject({ lens: null, verdict: "INVALID" });
    expect(normalizeVerdict(null).errors).toEqual(["verdict is not an object"]);
    expect(normalizeVerdict([]).verdict).toBe("INVALID");
  });

  it("flags an unknown lens", () => {
    const result = normalizeVerdict(verdict("vibes"));
    expect(result.lens).toBeNull();
    expect(result.errors.join(" ")).toContain("unknown lens");
  });

  it("flags a missing audit trail", () => {
    const result = normalizeVerdict({
      lens: "over-blocking",
      verdict: "SOUND",
      objections: [],
      notes: "  ",
    });
    expect(result.errors.join(" ")).toContain("missing `notes`");
  });

  it("recomputes the verdict from the objections rather than trusting the voter", () => {
    const claimedClean = normalizeVerdict({
      lens: "over-blocking",
      verdict: "SOUND",
      objections: [citedObjection("blocking")],
      notes: "n",
    });
    expect(claimedClean.verdict).toBe("OBJECTION");
    expect(claimedClean.errors.join(" ")).toContain("disagrees with 1 objection");
  });

  it("does not complain when the declared verdict agrees", () => {
    expect(normalizeVerdict(verdict("over-blocking", [citedObjection()])).errors).toEqual([]);
  });

  it("treats a non-array `objections` as empty and says so", () => {
    const result = normalizeVerdict({
      lens: "over-blocking",
      verdict: "SOUND",
      objections: "none",
      notes: "n",
    });
    expect(result.objections).toEqual([]);
    expect(result.errors.join(" ")).toContain("not an array");
  });

  it("marks an uncited objection as not actionable", () => {
    const result = normalizeVerdict(
      verdict("over-blocking", [{ claim: "Feels fragile.", severity: "blocking", citations: [] }]),
    );
    expect(result.objections[0].actionable).toBe(false);
  });

  it("marks an objection cited only by issue number as not actionable", () => {
    const result = normalizeVerdict(
      verdict("instruction-correctness", [
        { claim: "Premise is stale.", severity: "advisory", citations: ["#1099"] },
      ]),
    );
    expect(result.objections[0]).toMatchObject({
      actionable: false,
      citations: ["#1099"],
      codeCitations: [],
    });
  });

  it("keeps a supporting non-code citation alongside a code one", () => {
    const result = normalizeVerdict(
      verdict("instruction-correctness", [
        {
          claim: "Premise is stale.",
          severity: "advisory",
          citations: ["#1099", "server/src/routes/a.ts:7"],
        },
      ]),
    );
    expect(result.objections[0]).toMatchObject({
      actionable: true,
      codeCitations: ["server/src/routes/a.ts:7"],
    });
  });

  it("rejects a cited objection that carries no claim", () => {
    const result = normalizeVerdict(
      verdict("over-blocking", [
        { claim: "  ", severity: "blocking", citations: ["server/src/a.ts:1"] },
      ]),
    );
    expect(result.objections[0].actionable).toBe(false);
    expect(result.errors.join(" ")).toContain("has no `claim`");
  });

  // Issue #1170: the old behaviour coerced this to `advisory`, which demoted the objection
  // into a count that cannot fail the run. It must now refuse to guess.
  it("refuses to interpret an unknown severity rather than downgrading it to advisory", () => {
    const result = normalizeVerdict(
      verdict("over-blocking", [
        { claim: "c", severity: "catastrophic", citations: ["server/src/a.ts:1"] },
      ]),
    );
    expect(result.objections[0].severity).toBe("unrecognised");
    expect(result.objections[0].severity).not.toBe("advisory");
    expect(result.errors.join(" ")).toContain("unrecognised severity");
    expect(result.unparsed.join(" ")).toContain("unrecognised severity");
  });

  it.each([["major"], ["minor"], ["critical"], ["high"], ["P0"], ["nit"]])(
    "does not guess a mapping for the plausible-but-unknown severity %s",
    (severity) => {
      const result = normalizeVerdict(
        verdict("over-blocking", [{ claim: "c", severity, citations: ["server/src/a.ts:1"] }]),
      );
      expect(result.objections[0].severity).toBe("unrecognised");
      expect(result.unparsed).toHaveLength(1);
    },
  );

  it("defaults a missing severity to advisory without complaint", () => {
    const result = normalizeVerdict(
      verdict("over-blocking", [{ claim: "c", citations: ["server/src/a.ts:1"] }]),
    );
    expect(result.objections[0].severity).toBe("advisory");
    expect(result.errors).toEqual([]);
  });

  it("handles an objection that is not an object", () => {
    const result = normalizeVerdict(verdict("over-blocking", ["just a string"]));
    expect(result.objections[0].actionable).toBe(false);
    expect(result.errors.join(" ")).toContain("objection #1 is not an object");
  });

  it("drops non-string and blank citations, and says so only for the readable loss", () => {
    const result = normalizeVerdict(
      verdict("over-blocking", [
        { claim: "c", severity: "blocking", citations: [null, "   ", 42, "server/src/a.ts:1"] },
      ]),
    );
    expect(result.objections[0].citations).toEqual(["server/src/a.ts:1"]);
    // `null` and the blank string are present-but-empty values that say nothing, so they stay
    // silent; `42` is content the tally could not read, so it is recorded.
    expect(result.unparsed.join(" ")).toContain("1 non-string `citations` entry");
  });

  it("treats a non-array citations field as no citations, and records the loss", () => {
    const result = normalizeVerdict(
      verdict("over-blocking", [
        { claim: "c", severity: "blocking", citations: "server/src/a.ts:1" },
      ]),
    );
    expect(result.objections[0].actionable).toBe(false);
    expect(result.unparsed.join(" ")).toContain("non-array `citations`");
  });
});

describe("tallyPanel", () => {
  it("reports CLEAR when all three lenses report nothing", () => {
    const tally = tallyPanel(cleanPanel());
    expect(tally.outcome).toBe("CLEAR");
    expect(tally.panelComplete).toBe(true);
    expect(tally.errors).toEqual([]);
  });

  it("reports BLOCKED for a cited blocking objection", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [citedObjection("blocking")]);
    const tally = tallyPanel(panel);
    expect(tally.outcome).toBe("BLOCKED");
    expect(tally.blockingCount).toBe(1);
    expect(tally.actionable[0].lens).toBe("over-blocking");
  });

  it("reports ADVISORY for a cited non-blocking objection", () => {
    const panel = cleanPanel();
    panel[1] = verdict("test-falsifiability", [citedObjection("advisory")]);
    const tally = tallyPanel(panel);
    expect(tally.outcome).toBe("ADVISORY");
    expect(tally.advisoryCount).toBe(1);
    expect(tally.blockingCount).toBe(0);
  });

  it("does not let an uncited blocking objection block", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [
      { claim: "Feels wrong.", severity: "blocking", citations: [] },
    ]);
    const tally = tallyPanel(panel);
    expect(tally.outcome).toBe("CLEAR");
    expect(tally.blockingCount).toBe(0);
  });

  it("still reports the uncited objection rather than deleting it", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [
      { claim: "Feels wrong.", severity: "blocking", citations: [] },
    ]);
    const tally = tallyPanel(panel);
    expect(tally.unsupportedCount).toBe(1);
    expect(tally.unsupported[0]).toMatchObject({ lens: "over-blocking", claim: "Feels wrong." });
  });

  it("reports INCOMPLETE when a lens never answered", () => {
    const tally = tallyPanel([verdict("over-blocking"), verdict("test-falsifiability")]);
    expect(tally.outcome).toBe("INCOMPLETE");
    expect(tally.missingLenses).toEqual(["instruction-correctness"]);
    expect(tally.panelComplete).toBe(false);
  });

  it("reports INCOMPLETE when one lens answered twice and another not at all", () => {
    const tally = tallyPanel([
      verdict("over-blocking"),
      verdict("over-blocking"),
      verdict("test-falsifiability"),
    ]);
    expect(tally.duplicateLenses).toEqual(["over-blocking"]);
    expect(tally.outcome).toBe("INCOMPLETE");
  });

  it("lets a real blocking objection outrank an incomplete panel", () => {
    const tally = tallyPanel([verdict("over-blocking", [citedObjection("blocking")])]);
    expect(tally.outcome).toBe("BLOCKED");
  });

  it("prefers INCOMPLETE over ADVISORY when a lens is missing", () => {
    const tally = tallyPanel([verdict("over-blocking", [citedObjection("advisory")])]);
    expect(tally.outcome).toBe("INCOMPLETE");
  });

  it("treats an empty panel as INCOMPLETE, never as CLEAR", () => {
    expect(tallyPanel([]).outcome).toBe("INCOMPLETE");
    expect(tallyPanel(null).outcome).toBe("INCOMPLETE");
    expect(tallyPanel(undefined).missingLenses).toEqual([...LENSES]);
  });

  it("prefixes each malformed-input error with its lens", () => {
    const tally = tallyPanel([
      ...cleanPanel(),
      { lens: "over-blocking", objections: [], notes: "" },
    ]);
    expect(tally.errors.some((e) => e.startsWith("[over-blocking]"))).toBe(true);
  });

  it("labels errors from an unidentifiable voter", () => {
    const tally = tallyPanel([...cleanPanel(), "garbage"]);
    expect(tally.errors).toContain("[unknown lens] verdict is not an object");
  });

  it("collects objections across all three lenses", () => {
    const tally = tallyPanel([
      verdict("over-blocking", [citedObjection("advisory")]),
      verdict("test-falsifiability", [citedObjection("blocking")]),
      verdict("instruction-correctness", [citedObjection("advisory")]),
    ]);
    expect(tally.actionable).toHaveLength(3);
    expect(tally.blockingCount).toBe(1);
    expect(tally.advisoryCount).toBe(2);
  });
});

describe("formatReport", () => {
  it("names the outcome and every lens on a clean panel", () => {
    const report = formatReport(tallyPanel(cleanPanel()));
    expect(report).toContain("Adversarial review panel — CLEAR");
    for (const lens of LENSES) expect(report).toContain(lens);
    expect(report).not.toContain("Actionable objections");
  });

  it("lists actionable objections with their citations", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [
      citedObjection("blocking", ["server/src/routes/analysis.ts:42"]),
    ]);
    const report = formatReport(tallyPanel(panel));
    expect(report).toContain("Actionable objections:");
    expect(report).toContain("[blocking] (over-blocking)");
    expect(report).toContain("server/src/routes/analysis.ts:42");
  });

  it("shows discarded objections and the count of them per lens", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [
      { claim: "Feels wrong.", severity: "blocking", citations: [] },
    ]);
    const report = formatReport(tallyPanel(panel));
    expect(report).toContain("1 uncited (not actionable)");
    expect(report).toContain("Discarded — no file:line citation");
    expect(report).toContain("Feels wrong.");
  });

  it("renders a discarded objection that has no claim at all", () => {
    const report = formatReport(tallyPanel([verdict("over-blocking", [{ citations: [] }])]));
    expect(report).toContain("<no claim>");
  });

  it("marks a lens that never reported", () => {
    const report = formatReport(tallyPanel([verdict("over-blocking")]));
    expect(report).toContain("test-falsifiability: DID NOT REPORT");
    expect(report).toContain("INCOMPLETE");
  });

  it("surfaces malformed input", () => {
    const report = formatReport(tallyPanel([...cleanPanel(), "garbage"]));
    expect(report).toContain("Malformed input:");
  });
});

describe("exitCodeFor", () => {
  it.each([
    ["BLOCKED", [verdict("over-blocking", [citedObjection("blocking")])], 1],
    ["INCOMPLETE", [verdict("over-blocking")], 1],
    ["CLEAR", cleanPanel(), 0],
  ])("exits %s -> %i", (_outcome, panel, expected) => {
    expect(exitCodeFor(tallyPanel(panel))).toBe(expected);
  });

  it("exits 0 on ADVISORY so a non-blocking note does not fail the run", () => {
    const panel = cleanPanel();
    panel[2] = verdict("instruction-correctness", [citedObjection("advisory")]);
    expect(exitCodeFor(tallyPanel(panel))).toBe(0);
  });
});

/**
 * Issue #1170. Input the tally could not interpret is a *third* state alongside "objections
 * found" and "no objections found", and it must never render or exit as the second. It is
 * folded into the existing `INCOMPLETE` rather than a fourth outcome, because `INCOMPLETE`
 * already means "the panel did not actually grade what it looked at" and already exits 1.
 */
describe("unparsed input reaches the outcome", () => {
  /** A complete three-lens panel whose only defect is one unrecognised severity. */
  function panelWithUnknownSeverity() {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [citedObjection("major")]);
    return panel;
  }

  it("reports INCOMPLETE, not ADVISORY, when a severity could not be interpreted", () => {
    const tally = tallyPanel(panelWithUnknownSeverity());
    expect(tally.outcome).toBe("INCOMPLETE");
    expect(tally.outcome).not.toBe("ADVISORY");
    expect(tally.unparsedCount).toBe(1);
  });

  it("exits non-zero when a severity could not be interpreted", () => {
    expect(exitCodeFor(tallyPanel(panelWithUnknownSeverity()))).toBe(1);
  });

  it("does not count an unrecognised severity as advisory or blocking", () => {
    const tally = tallyPanel(panelWithUnknownSeverity());
    expect(tally.advisoryCount).toBe(0);
    expect(tally.blockingCount).toBe(0);
    expect(tally.unrecognisedSeverityCount).toBe(1);
  });

  // Each case is a complete three-lens panel whose third voter is the malformed one — never
  // `[...cleanPanel(), malformed]`, which would duplicate a lens and carry the `INCOMPLETE`
  // assertion on `duplicateLenses` instead of on `unparsed`. Measured: under the mutant that
  // drops `|| unparsed.length > 0` from `outcome`, the confounded form left two of these three
  // cases green.
  it.each([
    // A voter that is not an object names no lens, so it can only be a *fourth* entry beside a
    // complete panel: as a third it would leave `instruction-correctness` missing, and the
    // `missingLenses` arm would carry the assertion instead of `unparsed`.
    ["a voter that is not an object", [...cleanPanel(), "garbage"]],
    [
      "a non-array objections field",
      panelWithThird({ lens: "instruction-correctness", objections: "none", notes: "n" }),
    ],
    [
      "an objection that is not an object",
      panelWithThird({ lens: "instruction-correctness", objections: ["a string"], notes: "n" }),
    ],
    [
      // The deliberate asymmetry with `citations`, where an absent field is *not* fatal: an
      // absent `citations` means "no evidence offered", which the uncited-discard path already
      // reports; an absent `objections` cannot be told apart from objections that were lost.
      "an objections field that is absent entirely",
      panelWithThird({ lens: "instruction-correctness", verdict: "SOUND", notes: "n" }),
    ],
    [
      "an objections field that is null",
      panelWithThird({
        lens: "instruction-correctness",
        verdict: "SOUND",
        objections: null,
        notes: "n",
      }),
    ],
  ])("treats %s as unparsed input", (_label, panel) => {
    const tally = tallyPanel(panel);
    expect(tally.unparsedCount).toBeGreaterThan(0);
    // Both confounds pinned: neither arm may be what makes this INCOMPLETE.
    expect(tally.duplicateLenses).toEqual([]);
    expect(tally.missingLenses).toEqual([]);
    expect(tally.outcome).toBe("INCOMPLETE");
    expect(exitCodeFor(tally)).toBe(1);
  });

  it.each([
    ["absent", undefined, "absent"],
    ["null", null, "null"],
  ])("names an %s objections field as itself, not as a JavaScript type", (_l, value, described) => {
    // `objections` is fatal even when the voter never wrote it, so this is one of only two
    // messages that can describe an *absent* field. Running it through `typeof` would print
    // "a undefined", and — wrongly, since JSON has no such type — "a object" for `null`,
    // sending the voter to look for a field they never sent.
    const third = {
      lens: "instruction-correctness",
      verdict: "SOUND",
      objections: value,
      notes: "n",
    };
    if (value === undefined) delete third.objections;
    const tally = tallyPanel(panelWithThird(third));
    expect(tally.unparsed.join(" ")).toContain(`\`objections\` is not an array (${described},`);
  });

  it("does not treat a recomputed verdict disagreement as unparsed", () => {
    // The module deliberately recomputes the verdict from the objections, so nothing was
    // lost here — flagging it would fire the gate on input it handled correctly.
    const panel = cleanPanel();
    panel[0] = {
      lens: "over-blocking",
      verdict: "SOUND",
      objections: [citedObjection("advisory")],
      notes: "n",
    };
    const tally = tallyPanel(panel);
    expect(tally.unparsed).toEqual([]);
    expect(tally.outcome).toBe("ADVISORY");
  });

  it("still lets a real blocking objection outrank unparsed input", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [citedObjection("blocking")]);
    panel[1] = verdict("test-falsifiability", [citedObjection("major")]);
    const tally = tallyPanel(panel);
    expect(tally.outcome).toBe("BLOCKED");
    expect(exitCodeFor(tally)).toBe(1);
  });

  it("keeps a clean panel clean — the gate does not fire on well-formed input", () => {
    const tally = tallyPanel(cleanPanel());
    expect(tally.unparsedCount).toBe(0);
    expect(tally.outcome).toBe("CLEAR");
  });
});

/**
 * The type sweep.
 *
 * #1167 and #1170 were both a *value* the module could not interpret being replaced by a
 * default instead of failing the panel. The same defect exists one level deeper for the
 * *types*: `typeof x === "string" ? x : ""` and `Array.isArray(x) ? x : []` route every wrong
 * type into the branch that means "the voter said nothing", and 100% statement coverage cannot
 * catch it, because each of those ternaries always executes.
 *
 * So every field the tally reads from external input is enumerated here against the JSON type
 * shapes, and each wrong type must be either recorded in `unparsed` or a *deliberate* note.
 * The boundary tests below are as load-bearing as the fatal ones: a gate that fires on input
 * the module handled correctly teaches implementers to override it.
 */
describe("wrong types are recorded, never silently coerced", () => {
  /**
   * The four wrong types a JSON value can take where a string was expected, each with the
   * description the message must carry. The third column is not decoration: it is the only
   * part of the message that tells a voter *which* type they sent, and without asserting it
   * `describeType` can be replaced by `return "a string"` with the whole suite still green —
   * measured, at 100% branch coverage, which is the same blind spot this describe block exists
   * to cover.
   */
  const NON_STRINGS = [
    ["a one-element array", ["blocking"], "an array"],
    ["an object", { level: "blocking" }, "an object"],
    ["a number", 1, "a number"],
    ["a boolean", true, "a boolean"],
  ];

  describe("objection.severity", () => {
    // Issue #1170, one level deeper. The old `typeof === "string" ? … : ""` funnelled every
    // non-string into the *absent* branch, which defaults to `advisory` — so a voter-declared
    // blocker became a count that cannot fail the run, with no `errors` and no `unparsed` at
    // all. A one-element array instead of a scalar is a well-known LLM JSON failure mode.
    it.each(NON_STRINGS)("refuses to interpret %s severity", (_label, severity) => {
      const tally = tallyPanel(
        panelWithThird(thirdLensWith({ claim: "c", severity, citations: ["server/src/a.ts:42"] })),
      );
      expect(tally.actionable[0].severity).toBe("unrecognised");
      expect(tally.actionable[0].severity).not.toBe("advisory");
      expect(tally.advisoryCount).toBe(0);
      expect(tally.unparsedCount).toBe(1);
      expect(tally.outcome).toBe("INCOMPLETE");
      expect(exitCodeFor(tally)).toBe(1);
      // Neither confound may be what fails this panel.
      expect(tally.duplicateLenses).toEqual([]);
      expect(tally.missingLenses).toEqual([]);
    });

    it("names the offending value in the error so the voter can fix it", () => {
      const tally = tallyPanel(
        panelWithThird(
          thirdLensWith({ claim: "c", severity: ["blocking"], citations: ["server/src/a.ts:42"] }),
        ),
      );
      expect(tally.unparsed.join(" ")).toContain('["blocking"]');
    });

    it.each([
      ["absent", undefined],
      ["null", null],
      ["a blank string", "   "],
    ])("still defaults %s severity to advisory without complaint", (_label, severity) => {
      // The boundary. These three make no choice in any vocabulary — `null` is how a template
      // with nothing to put in the field serialises — so defaulting is interpretation, not a
      // guess, and firing the gate here would be over-blocking.
      const objection = { claim: "c", severity, citations: ["server/src/a.ts:42"] };
      if (severity === undefined) delete objection.severity;
      const tally = tallyPanel(panelWithThird(thirdLensWith(objection)));
      expect(tally.actionable[0].severity).toBe("advisory");
      expect(tally.unparsed).toEqual([]);
      expect(tally.outcome).toBe("ADVISORY");
      expect(exitCodeFor(tally)).toBe(0);
    });
  });

  describe("objection.citations", () => {
    // Issue #1167's symptom in a different shape: the voter *did* supply evidence, the tally
    // could not read the container, and the objection vanished — `CLEAR`, exit 0, nothing in
    // `errors`. A non-array `objections` one level up has always been fatal; this is the same
    // loss one level down.
    it.each([
      ["a bare string", "server/src/a.ts:42", "a string"],
      ["an object", { file: "server/src/a.ts", line: 42 }, "an object"],
      ["a number", 42, "a number"],
      ["a boolean", true, "a boolean"],
    ])("records %s citations as unparsed, not a dropped objection", (_l, citations, described) => {
      const tally = tallyPanel(
        panelWithThird(thirdLensWith({ claim: "c", severity: "blocking", citations })),
      );
      expect(tally.unparsed.join(" ")).toContain(`non-array \`citations\` (${described}`);
      expect(tally.unparsedCount).toBe(1);
      expect(tally.outcome).not.toBe("CLEAR");
      expect(tally.outcome).toBe("INCOMPLETE");
      expect(exitCodeFor(tally)).toBe(1);
      expect(tally.duplicateLenses).toEqual([]);
      expect(tally.missingLenses).toEqual([]);
    });

    it("records non-string entries inside the array", () => {
      const tally = tallyPanel(
        panelWithThird(
          thirdLensWith({
            claim: "c",
            severity: "blocking",
            citations: [{ file: "server/src/a.ts", line: 42 }],
          }),
        ),
      );
      expect(tally.unparsed.join(" ")).toContain("non-string `citations`");
      expect(tally.outcome).toBe("INCOMPLETE");
      expect(exitCodeFor(tally)).toBe(1);
    });

    it("counts the dropped entries rather than reporting only the first", () => {
      const tally = tallyPanel(
        panelWithThird(
          thirdLensWith({
            claim: "c",
            severity: "blocking",
            citations: [42, { file: "server/src/a.ts" }],
          }),
        ),
      );
      expect(tally.unparsed.join(" ")).toContain("2 non-string `citations` entries");
    });

    it("records a dropped entry even when the surviving citations still carry the objection", () => {
      // The outcome here is BLOCKED either way — the point is that the reader is told an entry
      // was thrown away, rather than the loss being invisible because it changed no count.
      const tally = tallyPanel(
        panelWithThird(
          thirdLensWith({
            claim: "c",
            severity: "blocking",
            citations: ["server/src/a.ts:42", 7],
          }),
        ),
      );
      expect(tally.outcome).toBe("BLOCKED");
      expect(tally.unparsed.join(" ")).toContain("1 non-string `citations` entry");
    });

    it.each([
      ["absent", undefined],
      ["null", null],
      ["an empty array", []],
      // The same absent/null/blank doctrine the other fields use, applied here and *inside* the
      // array. Each of these carries no evidence, so firing the gate would be the module
      // complaining about input nothing was lost from.
      ["a blank string", "   "],
      ["an array of nulls", [null, null]],
      ["an array of blanks", ["  "]],
    ])("keeps %s citations a discard, not a parse failure", (_label, citations) => {
      // The boundary, and the asymmetry with `objections`: no evidence was *offered* here, so
      // the uncited-discard path reports it under "Discarded" and the outcome is untouched.
      // Inverting that would invert #1113's precision-first rule.
      const objection = { claim: "c", severity: "blocking", citations };
      if (citations === undefined) delete objection.citations;
      const tally = tallyPanel(panelWithThird(thirdLensWith(objection)));
      expect(tally.unparsed).toEqual([]);
      expect(tally.unsupportedCount).toBe(1);
      expect(tally.outcome).toBe("CLEAR");
      expect(exitCodeFor(tally)).toBe(0);
    });
  });

  describe("objection.claim", () => {
    // Lost twice over: the text is gone, and a claimless objection is not actionable — so a
    // cited `blocking` objection whose claim arrived in the wrong container disappeared from
    // the counts and the panel exited 0.
    it.each(NON_STRINGS)("records %s claim as unparsed", (_label, claim, described) => {
      const tally = tallyPanel(
        panelWithThird(
          thirdLensWith({ claim, severity: "blocking", citations: ["server/src/a.ts:42"] }),
        ),
      );
      expect(tally.unparsed.join(" ")).toContain("non-string `claim`");
      expect(tally.unparsed.join(" ")).toContain(described);
      expect(tally.outcome).toBe("INCOMPLETE");
      expect(exitCodeFor(tally)).toBe(1);
      expect(tally.duplicateLenses).toEqual([]);
      expect(tally.missingLenses).toEqual([]);
      // The message must also reach the rendered report, marked fatal — pushing it to
      // `unparsed` alone leaves the reader with an outcome and no stated cause.
      expect(formatReport(tally)).toContain("!! [instruction-correctness] objection #1 has a");
    });

    it.each([
      ["absent", undefined],
      ["null", null],
      ["blank", "   "],
    ])("keeps %s claim a note, not a parse failure", (_label, claim) => {
      // The boundary: nothing was said, so nothing was lost, and the objection is still printed
      // under "Discarded" where a reader can see it.
      const objection = { claim, severity: "blocking", citations: ["server/src/a.ts:42"] };
      if (claim === undefined) delete objection.claim;
      const tally = tallyPanel(panelWithThird(thirdLensWith(objection)));
      expect(tally.errors.join(" ")).toContain("has no `claim`");
      expect(tally.unparsed).toEqual([]);
      expect(exitCodeFor(tally)).toBe(0);
    });
  });

  describe("verdict-level fields", () => {
    it.each(NON_STRINGS)(
      "reports %s notes as the wrong type, not as missing",
      (_l, notes, described) => {
        // A note in both shapes, deliberately: `notes` is an audit trail, and losing it hides no
        // *objection*, which is what `unparsed` is for. But the two messages must differ —
        // "missing" sends the voter to add a field it already sent.
        const tally = tallyPanel(
          panelWithThird({ lens: LENSES[2], verdict: "SOUND", objections: [], notes }),
        );
        expect(tally.errors.join(" ")).toContain(`\`notes\` is not a string (${described}`);
        expect(tally.errors.join(" ")).not.toContain("missing `notes`");
        expect(tally.unparsed).toEqual([]);
        expect(tally.outcome).toBe("CLEAR");
        expect(exitCodeFor(tally)).toBe(0);
      },
    );

    it("keeps an absent notes field reading as missing", () => {
      const tally = tallyPanel(
        panelWithThird({ lens: LENSES[2], verdict: "SOUND", objections: [] }),
      );
      expect(tally.errors.join(" ")).toContain("missing `notes`");
      expect(tally.unparsed).toEqual([]);
    });

    it.each(NON_STRINGS)(
      "notes a declared verdict of %s without failing",
      (_l, value, described) => {
        // The one field where "note, not fatal" is true by construction: the declared verdict is
        // never an input — it is recomputed from the objections — so a wrong type loses nothing.
        // Reported anyway, because a voter that got this field's type wrong got something wrong.
        const tally = tallyPanel(
          panelWithThird({ lens: LENSES[2], verdict: value, objections: [], notes: "n" }),
        );
        expect(tally.errors.join(" ")).toContain(
          `declared \`verdict\` is not a string (${described}`,
        );
        expect(tally.unparsed).toEqual([]);
        expect(tally.outcome).toBe("CLEAR");
      },
    );

    it("says nothing about an absent declared verdict", () => {
      const tally = tallyPanel(panelWithThird({ lens: LENSES[2], objections: [], notes: "n" }));
      expect(tally.errors).toEqual([]);
      expect(tally.outcome).toBe("CLEAR");
    });
  });

  describe("verdict.lens", () => {
    // Already fatal in every shape, absent included — a voter whose lens cannot be read cannot
    // be counted toward the three questions, and a fourth voter mislabelling itself would
    // otherwise mask a lens that never ran. Pinned here so the sweep covers every field.
    it.each([...NON_STRINGS, ["null", null], ["absent", undefined]])(
      "treats %s lens as unparsed and names the value",
      (label, lens) => {
        const third = { lens, verdict: "SOUND", objections: [], notes: "n" };
        if (label === "absent") delete third.lens;
        const tally = tallyPanel([...cleanPanel(), third]);
        expect(tally.unparsed.join(" ")).toContain("unknown lens");
        expect(tally.unparsed.join(" ")).toContain(JSON.stringify(lens ?? null));
        expect(tally.outcome).toBe("INCOMPLETE");
        expect(exitCodeFor(tally)).toBe(1);
        // A fourth voter beside a complete panel, so neither arm confounds the assertion.
        expect(tally.duplicateLenses).toEqual([]);
        expect(tally.missingLenses).toEqual([]);
      },
    );
  });

  describe("the panel input itself", () => {
    // Already exit 1 before this change — three lenses are missing when there are no verdicts —
    // but the report blamed the lenses, sending the reader to re-dispatch three voters when the
    // file actually held a `{"verdicts": [...]}` wrapper instead of a bare array.
    it.each([
      ["an object", { verdicts: [] }, "an object"],
      ["a string", "[]", "a string"],
      // `null` and `undefined` are named as themselves, not run through `typeof` — which would
      // print "a object" for `null` and "a undefined" — because these two call sites are the
      // ones that fire even when the value is absent, and telling a voter their absent field
      // was "a undefined" sends them looking for something they never wrote.
      ["null", null, "null"],
      ["absent", undefined, "absent"],
      ["a number", 3, "a number"],
    ])("records %s panel input as unparsed", (_label, input, described) => {
      const tally = tallyPanel(input);
      expect(tally.unparsed.join(" ")).toContain(
        `panel input is not an array of verdicts (${described},`,
      );
      expect(tally.outcome).toBe("INCOMPLETE");
      expect(exitCodeFor(tally)).toBe(1);
    });

    it("names the cause in the report and in the summary line", () => {
      const report = formatReport(tallyPanel({ verdicts: [] }));
      expect(report).toContain("!! panel input is not an array");
      expect(report.split("\n")[1]).toContain("could not be parsed");
    });

    it("says nothing about the panel input when it is an array", () => {
      expect(tallyPanel([]).unparsed).toEqual([]);
      expect(tallyPanel(cleanPanel()).unparsed).toEqual([]);
    });
  });

  it("marks only the fatal entry when one lens produced both kinds", () => {
    // Pins the constraint the `!!` marker rests on: it matches `unparsed` against `errors` by
    // string equality, so no note-level message may ever be textually identical to a fatal one
    // from the same lens. Here the same voter produces a note (`notes` of the wrong type) and a
    // fatal (an unreadable severity), and exactly one line is marked.
    const report = formatReport(
      tallyPanel(
        panelWithThird({
          lens: LENSES[2],
          verdict: "OBJECTION",
          objections: [{ claim: "c", severity: 1, citations: ["server/src/a.ts:42"] }],
          notes: 7,
        }),
      ),
    );
    const complaints = report.split("\n").filter((l) => l.includes("[instruction-correctness]"));
    const marked = complaints.filter((l) => l.startsWith("  !!"));
    const unmarked = complaints.filter((l) => !l.startsWith("  !!"));

    expect(complaints).toHaveLength(2);

    expect(marked).toHaveLength(1);
    expect(marked[0]).toContain("unrecognised severity");
    expect(unmarked).toHaveLength(1);
    expect(unmarked[0]).toContain("`notes` is not a string");
  });
});

describe("summaryLine", () => {
  it("does not let a parse failure read as a clean panel", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [citedObjection("major")]);
    const line = summaryLine(tallyPanel(panel));
    expect(line).toContain("could not be parsed");
    expect(line).toContain("Malformed input");
    expect(line).not.toContain("none raised a cited objection");
  });

  it("puts the unparsed warning on the outcome line even when the panel is BLOCKED", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [citedObjection("blocking")]);
    panel[1] = verdict("test-falsifiability", [citedObjection("bikeshed")]);
    expect(summaryLine(tallyPanel(panel))).toContain("could not be parsed");
  });

  it("distinguishes a CLEAR with discarded objections from a CLEAR without", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [
      { claim: "Feels wrong.", severity: "blocking", citations: [] },
    ]);
    const withDiscards = summaryLine(tallyPanel(panel));
    expect(withDiscards).toContain("discarded as uncited");

    expect(summaryLine(tallyPanel(cleanPanel()))).not.toContain("discarded as uncited");
  });

  it("says plainly what a clean panel means", () => {
    expect(summaryLine(tallyPanel(cleanPanel()))).toBe(
      "all three lenses reported and none raised a cited objection",
    );
  });

  it("names the missing-lens cause separately from the unparsed cause", () => {
    const line = summaryLine(tallyPanel([verdict("over-blocking")]));
    expect(line).toContain("did not report on every lens");
    expect(line).not.toContain("could not be parsed");
  });

  it("names BOTH causes when a lens is missing and input was also unparsed", () => {
    // A panel can be defective twice over, and reporting only one cause sends the reader to
    // re-dispatch a lens when the real problem was the severity vocabulary, or vice versa.
    const line = summaryLine(
      tallyPanel([
        verdict("over-blocking", [citedObjection("major")]),
        verdict("test-falsifiability"),
      ]),
    );
    expect(line).toContain("did not report on every lens");
    expect(line).toContain("could not be parsed");
  });

  it("omits the missing-lens text when the lenses were fine and only the input was not", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [citedObjection("major")]);
    const line = summaryLine(tallyPanel(panel));
    expect(line).toContain("could not be parsed");
    expect(line).not.toContain("did not report on every lens");
  });

  it("is the second line of the rendered report, warnings and all", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [citedObjection("major")]);
    panel[1] = verdict("test-falsifiability", [
      { claim: "Feels wrong.", severity: "advisory", citations: [] },
    ]);
    const tally = tallyPanel(panel);
    const secondLine = formatReport(tally).split("\n")[1];

    expect(secondLine).toBe(summaryLine(tally));
    expect(secondLine).toContain("could not be parsed");
    expect(secondLine).toContain("discarded as uncited");
  });

  it("keeps a CLEAR panel with discarded objections distinguishable in the report itself", () => {
    const panel = cleanPanel();
    panel[0] = verdict("over-blocking", [
      { claim: "Feels wrong.", severity: "blocking", citations: [] },
    ]);
    const report = formatReport(tallyPanel(panel));
    const [outcomeLine, secondLine] = report.split("\n");

    expect(outcomeLine).toBe("Adversarial review panel — CLEAR");
    expect(secondLine).toContain("discarded as uncited");
  });
});

/**
 * The two panel runs that produced #1167 and #1170. The fixtures are **reconstructions**, not
 * copies: the raw voter JSON of neither run was kept, so each is rebuilt from the record that
 * was — PR #1165's body and `.claude/agent-memory/code-issue/` for #1163, issue #1170's own
 * account for #1169 — preserving the shape that caused the defect (a trailing description on
 * every citation; a `blocking|major|minor` vocabulary) and the outcome each run reported.
 * They are the acceptance evidence: each reads as a clean-looking, exit-0 panel on the old
 * code, and neither does now.
 */
describe("regression: the two measured panel runs", () => {
  it("#1163 — three cited objections carrying trailing descriptions are NOT discarded", () => {
    const tally = tallyPanel(fixture("panel-1163"));

    // The run's true outcome, recorded in PR #1165, was ADVISORY. The old anchored pattern
    // threw all three objections away as uncited and printed CLEAR.
    expect(tally.outcome).not.toBe("CLEAR");
    expect(tally.outcome).toBe("ADVISORY");
    expect(tally.unsupportedCount).toBe(0);
    expect(tally.actionable).toHaveLength(3);
    expect(tally.advisoryCount).toBe(3);
    expect(formatReport(tally)).not.toContain("Discarded — no file:line citation");
  });

  it("#1163 — every objection the voters filed reaches the outcome, none is dropped", () => {
    const tally = tallyPanel(fixture("panel-1163"));
    // Deliberately iterated from the *filed* objections rather than from `actionable`: on the
    // old code `actionable` is empty, so a loop over it would pass by never running.
    const filed = tally.lenses.flatMap((lens) => lens.objections);

    expect(filed).toHaveLength(3);
    for (const objection of filed) {
      expect(objection.actionable).toBe(true);
      expect(objection.codeCitations.length).toBeGreaterThan(0);
    }
    expect(tally.actionable).toHaveLength(filed.length);
  });

  it("#1169 — a `major` severity does not exit 0 as a clean panel", () => {
    const tally = tallyPanel(fixture("panel-1169"));

    expect(exitCodeFor(tally)).toBe(1);
    expect(tally.outcome).toBe("INCOMPLETE");
    expect(tally.outcome).not.toBe("ADVISORY");
    expect(tally.advisoryCount).toBe(0);
    expect(tally.unrecognisedSeverityCount).toBe(3);
  });

  it("#1169 — the outcome line itself, not a section below it, carries the parse failure", () => {
    const report = formatReport(tallyPanel(fixture("panel-1169")));
    const [outcomeLine, summary] = report.split("\n");
    expect(outcomeLine).toBe("Adversarial review panel — INCOMPLETE");
    expect(summary).toContain("could not be parsed");
    expect(report).toContain("Malformed input:");
  });
});

/**
 * Evidence that arrives under a key the tally does not read is LOST (Issue #1215).
 *
 * ## What reading missed
 *
 * This module already argues, above `citations`, that "evidence the voter supplied in a
 * container the tally cannot read is *lost*, not merely unsupported", and fires the gate
 * on a non-array `citations` for exactly that reason. What it did not cover is the same
 * loss arriving through the field's **name** rather than its type — and that is the
 * likelier of the two, because the contract's example shows `"citations": [...]` and a
 * voter with a single citation writing `"citation": "path:12"` is an ordinary LLM
 * near-miss. #1170 is the precedent: voters do emit off-contract vocabularies.
 *
 * Measured on the real runner before the fix: a panel of three lenses, every `notes`
 * present, every declared verdict consistent, carrying one **blocking** objection cited
 * to `server/src/routes/x.ts:42` under the singular key, printed `CLEAR` and exited 0 —
 * with no "Malformed input" section at all, so nothing warned the reader. The objection
 * was reported as *uncited*, which is the one classification the "discarded objections
 * cannot block" rule is explicitly not defended for.
 *
 * The pair below is an IDENTITY mutation: the claim, the severity and the citation text
 * are byte-identical across both arms, and only the key's name changes.
 */
describe("an unrecognised key with content is unparsed, not ignored (Issue #1215)", () => {
  const CITATION = "server/src/routes/x.ts:42";
  const CLAIM = "IDOR: the handler resolves by bare PK under a :projectId router";

  /** @param {Record<string, unknown>} objection */
  function panelWith(objection) {
    return [
      {
        lens: "over-blocking",
        verdict: "OBJECTION",
        notes: "Traced the router and the handler.",
        objections: [objection],
      },
      {
        lens: "test-falsifiability",
        verdict: "SOUND",
        notes: "Reverted and re-ran.",
        objections: [],
      },
      {
        lens: "instruction-correctness",
        verdict: "SOUND",
        notes: "Read the instruction against the diff.",
        objections: [],
      },
    ];
  }

  it("BLOCKS when the evidence is under the plural `citations` array", () => {
    const tally = tallyPanel(
      panelWith({ claim: CLAIM, severity: "blocking", citations: [CITATION] }),
    );
    expect(tally.outcome).toBe("BLOCKED");
    expect(exitCodeFor(tally)).toBe(1);
  });

  it("does not report CLEAR when the same evidence is under the singular `citation`", () => {
    const tally = tallyPanel(panelWith({ claim: CLAIM, severity: "blocking", citation: CITATION }));

    expect(tally.outcome).not.toBe("CLEAR");
    expect(tally.outcome).toBe("INCOMPLETE");
    expect(exitCodeFor(tally)).toBe(1);
    expect(formatReport(tally)).toContain('"citation"');
  });

  /**
   * The verdict object itself, not just its objections. A voter that files its findings
   * under a key of its own invention has said something the tally never reads — the
   * panel below would otherwise be three clean SOUND verdicts and a silent exit 0.
   */
  it("flags an unrecognised key on the VERDICT object too", () => {
    const panel = LENSES.map((lens) => ({
      lens,
      verdict: "SOUND",
      notes: "Checked.",
      objections: [],
    }));
    panel[1] = { ...panel[1], evidence: ["ui/src/lib/x-api.ts:17"] };

    const tally = tallyPanel(panel);
    expect(tally.outcome).toBe("INCOMPLETE");
    expect(exitCodeFor(tally)).toBe(1);
    expect(formatReport(tally)).toContain('"evidence"');
  });

  /**
   * The forged-clean shape: three SOUND voters and nothing to discard, so no other rule
   * in the module has anything to notice. Only the unknown key says the panel may have
   * had something to say.
   */
  it("flags an unrecognised key even on a panel with no objections at all", () => {
    const tally = tallyPanel([
      {
        lens: "over-blocking",
        verdict: "SOUND",
        notes: "Checked.",
        objections: [],
        objection: { claim: CLAIM, severity: "blocking", citations: [CITATION] },
      },
      { lens: "test-falsifiability", verdict: "SOUND", notes: "Checked.", objections: [] },
      { lens: "instruction-correctness", verdict: "SOUND", notes: "Checked.", objections: [] },
    ]);
    expect(tally.outcome).toBe("INCOMPLETE");
    expect(exitCodeFor(tally)).toBe(1);
  });

  /**
   * The over-block guard, and it is the same absent/null/blank doctrine the rest of the
   * module runs on: a key that carries nothing lost nothing. Without this the fix would
   * turn every voter that emits a tidy `"citation": null` into a re-dispatch.
   */
  it.each([
    ["null", null],
    ["absent-as-undefined", undefined],
    ["a blank string", "   "],
    ["an empty array", []],
  ])("does NOT fire on an unrecognised key holding %s", (_label, value) => {
    const tally = tallyPanel(
      panelWith({ claim: CLAIM, severity: "blocking", citations: [CITATION], citation: value }),
    );
    expect(tally.outcome).toBe("BLOCKED");
  });

  it("leaves a fully contract-shaped clean panel CLEAR", () => {
    const tally = tallyPanel(
      LENSES.map((lens) => ({ lens, verdict: "SOUND", notes: "Checked.", objections: [] })),
    );
    expect(tally.outcome).toBe("CLEAR");
    expect(exitCodeFor(tally)).toBe(0);
  });
});
