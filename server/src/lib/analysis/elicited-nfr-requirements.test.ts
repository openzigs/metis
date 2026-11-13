/**
 * Issue #1613 — elicited NFRs as draft non-functional requirements (pure part).
 * The persisted, read-back behaviour is proven over real SQLite in
 * `tests/elicited-nfr-requirements-1613.sqlite.test.ts`.
 *
 * Issue #1648 — the dedupe matches whole tokens within one NFR category and
 * one subject, reports every drop, caps the rows per run, and the verdict cap.
 */
import { describe, expect, it } from "vitest";
import type { Nfr } from "@metis/shared";
import {
  ELICITED_NFR_LABEL,
  ELICITED_NFR_REQUIREMENT_ID_PREFIX,
  ELICITED_NFRS_AWAITING_PROMOTION_KEY,
  MAX_ELICITED_NFRS_PER_RUN,
  capElicitedNfrVerdict,
  capElicitedNfrVerdicts,
  elicitedNfrRequirements,
  nfrStatedByRow,
  offerElicitedNfrs,
  restatesTitle,
  sameSubjectWord,
  readElicitedNfrsAwaitingPromotion,
  statesSameNfr,
} from "./elicited-nfr-requirements.js";
import type { StructuredRequirement } from "./types/requirements.js";
import { computeCoverageForRequirements } from "./requirement-coverage.js";
import { computeVerdictsForRequirements } from "./requirement-verdict.js";

const nfr = (over: Partial<Nfr> = {}): Nfr => ({
  id: "n1",
  category: "performance",
  title: "Fast feed listing",
  description: "Listing feeds must be fast.",
  metric: "",
  priority: "should-have",
  ...over,
});

/** `n` NFRs with distinct titles and no target. */
const distinct = (n: number): Nfr[] =>
  Array.from({ length: n }, (_, i) => nfr({ title: `Quality ${String.fromCharCode(97 + i)}` }));

describe("elicitedNfrRequirements", () => {
  it("writes an NFR as a non-functional requirement with its category, priority and evidence", () => {
    const { requirements, dropped } = elicitedNfrRequirements({
      nfrs: [
        nfr({
          category: "security",
          title: "Encrypt tokens at rest",
          description: "API tokens must be encrypted at rest.",
          metric: "AES-256",
          priority: "must-have",
          evidenceIds: ["f-b", "f-unknown", "f-b"],
        }),
      ],
      findingIdsByIndex: ["f-a", "f-b"],
      existing: [],
    });
    expect(dropped).toEqual([]);
    expect(requirements).toEqual([
      {
        type: "feature",
        title: "Encrypt tokens at rest",
        body: "API tokens must be encrypted at rest.\n\nTarget: AES-256",
        priority: "high",
        labels: [ELICITED_NFR_LABEL],
        // The unknown id is not evidence; the repeat is listed once.
        evidenceFindingIndexes: [1],
        acceptanceCriteria: [],
        kind: "non-functional",
        nfrCategory: "security",
      },
    ]);
  });

  it("maps every elicitation priority and keeps a metric-less body as the description", () => {
    const { requirements: out } = elicitedNfrRequirements({
      nfrs: [
        nfr({ title: "A", priority: "must-have" }),
        nfr({ title: "B", priority: "should-have" }),
        nfr({ title: "C", priority: "nice-to-have" }),
      ],
      findingIdsByIndex: [],
      existing: [],
    });
    expect(out.map((r) => r.priority)).toEqual(["high", "medium", "low"]);
    expect(out[0].body).toBe("Listing feeds must be fast.");
  });

  it("drops an NFR the synthesis already states, and says so (#1613 dedupe fixture)", () => {
    const out = elicitedNfrRequirements({
      nfrs: [nfr({ title: "P95 latency < 300ms", metric: "p95 < 300 ms" })],
      findingIdsByIndex: [],
      existing: [{ title: "p95 latency < 300 ms", body: "The API answers quickly." }],
    });
    expect(out).toEqual({
      requirements: [],
      dropped: [
        { title: "P95 latency < 300ms", reason: "duplicate", duplicateOf: "p95 latency < 300 ms" },
      ],
    });
  });

  it("drops a later NFR that repeats an earlier one's target for the same subject", () => {
    const out = elicitedNfrRequirements({
      nfrs: [
        nfr({ title: "Fast API", metric: "p95 < 300ms" }),
        nfr({ title: "Quick API responses", metric: "P95 < 300 MS" }),
      ],
      findingIdsByIndex: [],
      existing: [],
    });
    expect(out.requirements.map((r) => r.title)).toEqual(["Fast API"]);
    expect(out.dropped).toEqual([
      { title: "Quick API responses", reason: "duplicate", duplicateOf: "Fast API" },
    ]);
  });

  it("keeps two NFRs with the same target for different subjects (#1648)", () => {
    const out = elicitedNfrRequirements({
      nfrs: [
        nfr({ category: "availability", title: "API uptime", metric: "99.9%" }),
        nfr({ category: "availability", title: "Database uptime", metric: "99.9%" }),
      ],
      findingIdsByIndex: [],
      existing: [],
    });
    expect(out.requirements.map((r) => r.title)).toEqual(["API uptime", "Database uptime"]);
    expect(out.dropped).toEqual([]);
  });

  it(`writes at most ${MAX_ELICITED_NFRS_PER_RUN} per run and reports the rest (#1648)`, () => {
    const nfrs = distinct(MAX_ELICITED_NFRS_PER_RUN + 2);
    const out = elicitedNfrRequirements({ nfrs, findingIdsByIndex: [], existing: [] });
    expect(out.requirements.map((r) => r.title)).toEqual(
      nfrs.slice(0, MAX_ELICITED_NFRS_PER_RUN).map((n) => n.title),
    );
    expect(out.dropped).toEqual(
      nfrs.slice(MAX_ELICITED_NFRS_PER_RUN).map((n) => ({ title: n.title, reason: "over-cap" })),
    );
  });

  it("a duplicate past the cap is reported as a duplicate, not as over the cap", () => {
    const nfrs = [...distinct(MAX_ELICITED_NFRS_PER_RUN), nfr({ title: "Quality a" })];
    const out = elicitedNfrRequirements({ nfrs, findingIdsByIndex: [], existing: [] });
    expect(out.requirements).toHaveLength(MAX_ELICITED_NFRS_PER_RUN);
    expect(out.dropped).toEqual([
      { title: "Quality a", reason: "duplicate", duplicateOf: "Quality a" },
    ]);
  });

  it("an NFR citing nothing rolls up to no_evidence and never to implemented (NFR-2)", () => {
    const { requirements: elicited } = elicitedNfrRequirements({
      nfrs: [nfr({ evidenceIds: ["f-invented"] })],
      findingIdsByIndex: ["f-code"],
      existing: [],
    });
    expect(elicited[0].evidenceFindingIndexes).toEqual([]);
    // The run's only code finding says "implemented"; the NFR does not cite it.
    const findings = [
      { agentKey: "code" as const, verdict: "implemented" as const, citations: [] },
    ];
    expect(computeCoverageForRequirements(elicited, findings)).toEqual(["no_evidence"]);
    expect(computeVerdictsForRequirements(elicited, findings, true)).toEqual(["could-not-verify"]);
  });
});

describe("statesSameNfr", () => {
  const perf = (title: string, body: string) => ({
    title,
    body,
    kind: "non-functional",
    nfrCategory: "performance",
  });
  const availability = (title: string, body: string) => ({
    title,
    body,
    kind: "non-functional",
    nfrCategory: "availability",
  });

  it("matches a title ignoring case, spacing and punctuation", () => {
    expect(
      statesSameNfr(nfr({ title: "99.9% Uptime!" }), { title: "99.9 % uptime", body: "" }),
    ).toBe(true);
  });

  it("matches the NFR's target and subject written into a same-category requirement", () => {
    expect(
      statesSameNfr(
        nfr({ title: "Fast API", metric: "p95 < 300ms" }),
        perf("Responsive API", "Every endpoint answers with p95 < 300 ms under load."),
      ),
    ).toBe(true);
  });

  it("does not match a different NFR, nor on an empty target", () => {
    expect(
      statesSameNfr(nfr({ title: "Fast API", metric: "" }), perf("Encrypt tokens", "Tokens.")),
    ).toBe(false);
    expect(
      statesSameNfr(
        nfr({ title: "Fast API", metric: "p95 < 300ms" }),
        perf("Fast API responses", "p95 < 500 ms"),
      ),
    ).toBe(false);
  });

  // #1648 — the boundaries the substring match got wrong.
  it("does not read 200ms inside 1200ms", () => {
    expect(
      statesSameNfr(
        nfr({ title: "Fast API", metric: "200ms" }),
        perf("Batch API", "The API answers within 1200ms."),
      ),
    ).toBe(false);
  });

  it("does not read 1.5s as 15s, in a target or a title", () => {
    expect(
      statesSameNfr(
        nfr({ title: "Fast API", metric: "1.5s" }),
        perf("Batch API", "The API answers within 15s."),
      ),
    ).toBe(false);
    expect(statesSameNfr(nfr({ title: "Page load 1.5s" }), perf("Page load 15s", ""))).toBe(false);
  });

  it("still matches the same decimal target written differently", () => {
    expect(
      statesSameNfr(
        nfr({ category: "availability", title: "API uptime", metric: "99.9%" }),
        availability("API availability", "The API is up 99.9 % of each month."),
      ),
    ).toBe(true);
  });

  it("does not match the same target for a different subject", () => {
    expect(
      statesSameNfr(
        nfr({ category: "availability", title: "API uptime", metric: "99.9%" }),
        availability("Database uptime", "The database is up 99.9% of the time."),
      ),
    ).toBe(false);
  });

  it("compares targets only within the same NFR category", () => {
    const target = nfr({ category: "reliability", title: "API success rate", metric: "99.9%" });
    const base = { title: "API availability", body: "The API is up 99.9% of the time." };
    expect(statesSameNfr(target, availability(base.title, base.body))).toBe(false);
    // A functional or unclassified requirement is compared on its title only.
    expect(statesSameNfr(target, base)).toBe(false);
    expect(statesSameNfr(target, { ...base, kind: "functional", nfrCategory: "reliability" })).toBe(
      false,
    );
    expect(
      statesSameNfr(target, { ...base, kind: "non-functional", nfrCategory: "reliability" }),
    ).toBe(true);
  });

  it("a title of generic words only matches on the same-category target alone", () => {
    expect(
      statesSameNfr(
        nfr({ title: "Fast response time", metric: "p95 < 300ms" }),
        perf("Listing", "p95 < 300 ms"),
      ),
    ).toBe(true);
  });

  it("names the same subject through a plural, an -ion form or DB (#1709)", () => {
    expect(
      statesSameNfr(
        nfr({ category: "availability", title: "API uptime", metric: "99.9%" }),
        availability("Service level", "All public APIs are up 99.9% of the month."),
      ),
    ).toBe(true);
    expect(
      statesSameNfr(
        nfr({ category: "security", title: "Encrypt stored tokens", metric: "AES-256" }),
        {
          title: "Key storage",
          body: "AES-256 encryption.",
          kind: "non-functional",
          nfrCategory: "security",
        },
      ),
    ).toBe(true);
    expect(
      statesSameNfr(
        nfr({ category: "availability", title: "DB uptime", metric: "99.9%" }),
        availability("Storage", "The database is up 99.9% of the time."),
      ),
    ).toBe(true);
    // Still not another subject that merely shares a stem's first letters.
    expect(
      statesSameNfr(
        nfr({ category: "availability", title: "API uptime", metric: "99.9%" }),
        availability("Storage", "The apiary is up 99.9% of the time."),
      ),
    ).toBe(false);
  });
});

describe("sameSubjectWord (#1709)", () => {
  it("matches a word with its plural, -ion, -ed and -ing forms, and an abbreviation", () => {
    for (const [a, b] of [
      ["api", "apis"],
      ["database", "databases"],
      ["encrypt", "encryption"],
      ["encrypted", "encrypt"],
      ["encrypting", "encrypt"],
      ["db", "database"],
      ["dbs", "databases"],
      ["token", "token"],
    ]) {
      expect(sameSubjectWord(a!, b!), `${a} ~ ${b}`).toBe(true);
    }
  });

  it("does not match other endings, other words, a stem under three letters, or -ion under five", () => {
    for (const [a, b] of [
      ["api", "apiary"],
      ["token", "tokenizer"],
      ["database", "data"],
      ["ui", "uis"],
      ["cache", "session"],
      // An -ion on a stem under five letters is another word.
      ["port", "portion"],
      ["opt", "option"],
      ["mill", "million"],
      ["stat", "station"],
    ]) {
      expect(sameSubjectWord(a!, b!), `${a} !~ ${b}`).toBe(false);
    }
  });
});

describe("nfrStatedByRow (#1709)", () => {
  it("reads the title, category and target back from an elicited row", () => {
    const [written] = elicitedNfrRequirements({
      nfrs: [nfr({ category: "security", title: "Encrypt tokens", metric: "AES-256" })],
      findingIdsByIndex: [],
      existing: [],
    }).requirements;
    expect(nfrStatedByRow({ ...written!, nfrCategory: written!.nfrCategory ?? null })).toEqual({
      title: "Encrypt tokens",
      category: "security",
      metric: "AES-256",
    });
  });

  it("reads no target from a body without one, and no NFR from a row without a category", () => {
    expect(
      nfrStatedByRow({ title: "Encrypt tokens", body: "Encrypted.", nfrCategory: "security" }),
    ).toEqual({ title: "Encrypt tokens", category: "security", metric: "" });
    expect(nfrStatedByRow({ title: "T", body: "B", nfrCategory: null })).toBeNull();
    expect(nfrStatedByRow({ title: "T", body: "B", nfrCategory: "not-a-category" })).toBeNull();
  });
});

describe("capElicitedNfrVerdict", () => {
  it("caps every confident verdict to could-not-verify and leaves no verdict alone", () => {
    expect(capElicitedNfrVerdict("implemented")).toBe("could-not-verify");
    expect(capElicitedNfrVerdict("partial")).toBe("could-not-verify");
    expect(capElicitedNfrVerdict("gap-confirmed")).toBe("could-not-verify");
    expect(capElicitedNfrVerdict("could-not-verify")).toBe("could-not-verify");
    expect(capElicitedNfrVerdict(null)).toBeNull();
  });
});

describe("readElicitedNfrsAwaitingPromotion (#1705)", () => {
  it("reads the NFRs a gate-blocked run stored for promotion", () => {
    const stored = [nfr(), nfr({ id: "n2", title: "Encrypt tokens", category: "security" })];
    expect(
      readElicitedNfrsAwaitingPromotion({ [ELICITED_NFRS_AWAITING_PROMOTION_KEY]: stored }),
    ).toEqual(stored);
  });

  it("reads nothing when no NFRs are waiting, or the stored value is not a list of NFRs", () => {
    expect(readElicitedNfrsAwaitingPromotion({})).toEqual([]);
    expect(
      readElicitedNfrsAwaitingPromotion({ [ELICITED_NFRS_AWAITING_PROMOTION_KEY]: "nfrs" }),
    ).toEqual([]);
    expect(
      readElicitedNfrsAwaitingPromotion({
        [ELICITED_NFRS_AWAITING_PROMOTION_KEY]: [{ title: "No category" }],
      }),
    ).toEqual([]);
  });
});
describe("restatesTitle (#2449)", () => {
  it("reads the walkthrough's restatement in another word form as the same title", () => {
    expect(
      restatesTitle("Reset link expiry after 30 minutes", "Reset link expires after 30 minutes"),
    ).toBe(true);
    expect(restatesTitle("Session cookies are secure", "Session cookies secured")).toBe(true);
    expect(restatesTitle("Reset link must expire", "Reset link expires")).toBe(true);
    expect(restatesTitle("Data security", "Data secure")).toBe(true);
  });

  it("reads order: a title with its roles or endpoints swapped is another requirement", () => {
    for (const [a, b] of [
      ["Admins cannot read user passwords", "Users cannot read admin passwords"],
      ["Replicate data from primary to secondary", "Replicate data from secondary to primary"],
      // Recall first: a reordering may be a restatement, but it is listed for
      // the analyst to reject rather than dropped unseen.
      ["Secure session cookies", "Session cookies are secured"],
    ]) {
      expect(restatesTitle(a!, b!), `${a} !~ ${b}`).toBe(false);
    }
  });

  it("reads relations, negation and quantity words exactly", () => {
    for (const [a, b] of [
      ["Session expires after 30 minutes", "Session expires within 30 minutes"],
      ["Session expires before 30 minutes", "Session expires after 30 minutes"],
      ["Passwords are stored", "Passwords are not stored"],
      ["Admins can read logs", "Admins cannot read logs"],
      ["All exports are encrypted", "Any exports are encrypted"],
      ["Passwords must be hashed", "Passwords should be hashed"],
    ]) {
      expect(restatesTitle(a!, b!), `${a} !~ ${b}`).toBe(false);
    }
  });

  it("joins two forms of a word only by a known ending, not by a shared prefix", () => {
    for (const [a, b] of [
      ["Internal service timeout 30 seconds", "Interval service timeout 30 seconds"],
      ["Public API rate limit", "Publish API rate limit"],
      ["Media load under 2 seconds", "Median load under 2 seconds"],
    ]) {
      expect(restatesTitle(a!, b!), `${a} !~ ${b}`).toBe(false);
    }
  });

  it("offers, rather than drops, an NFR whose title only swaps a listed one's roles", () => {
    const { offered, dropped } = offerElicitedNfrs({
      structured: [
        {
          id: "REQ-1",
          title: "Admins cannot read user passwords",
          description: "Admins cannot read user passwords.",
          type: "functional",
          stakeholders: [],
          priority: "must-have",
          ambiguities: [],
          evidenceNeeds: [],
          rawSource: "",
        },
      ],
      nfrs: [nfr({ category: "security", title: "Users cannot read admin passwords" })],
      findingIdsByIndex: [],
      synthesized: [],
    });
    expect(dropped).toEqual([]);
    expect(offered.map((r) => r.title)).toEqual(["Users cannot read admin passwords"]);
  });

  it("keeps apart a title that adds a word, another number, or a paraphrase", () => {
    for (const [a, b] of [
      ["Password reset link expiry", "Password reset link"],
      ["Single-use reset link with atomic consumption", "Reset link is single-use"],
      ["Reset link expiry after 15 minutes", "Reset link expires after 30 minutes"],
      ["Page load 1.5s", "Page load 15s"],
      ["Account-enumeration protection on reset request", "Reset request must not reveal accounts"],
      // One stem, but an ending past three letters is another word.
      ["Process audit", "Processor audit"],
      ["", "Reset link"],
    ]) {
      expect(restatesTitle(a!, b!), `${a} !~ ${b}`).toBe(false);
    }
  });

  it("drops an elicited NFR whose title restates a requirement of any kind", () => {
    expect(
      statesSameNfr(
        nfr({
          category: "security",
          title: "Reset link expiry after 30 minutes",
        }),
        {
          title: "Reset link expires after 30 minutes",
          body: "The emailed link stops working after 30 minutes.",
          kind: "functional",
        },
      ),
    ).toBe(true);
  });
});

describe("offerElicitedNfrs (#2449)", () => {
  const listed = (id: string, title: string, extra: Partial<StructuredRequirement> = {}) => ({
    id,
    title,
    description: `${title}.`,
    type: "functional" as const,
    stakeholders: [],
    priority: "must-have" as const,
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
    ...extra,
  });

  it("offers each NFR the list does not state as a marked non-functional requirement", () => {
    const { offered, dropped } = offerElicitedNfrs({
      structured: [listed("REQ-1", "Reset link expires after 30 minutes")],
      nfrs: [
        nfr({
          category: "security",
          title: "Reset link expiry after 30 minutes",
        }),
        nfr({
          category: "security",
          title: "Rate limiting of reset requests",
          description: "Reset requests are rate limited.",
          metric: "5 per hour",
          priority: "nice-to-have",
          evidenceIds: ["f-b"],
        }),
      ],
      findingIdsByIndex: ["f-a", "f-b"],
      synthesized: [],
    });
    expect(dropped).toEqual([
      {
        title: "Reset link expiry after 30 minutes",
        reason: "duplicate",
        duplicateOf: "Reset link expires after 30 minutes",
      },
    ]);
    expect(offered).toEqual([
      {
        id: expect.stringMatching(/^NFR-[0-9a-f]{12}$/),
        title: "Rate limiting of reset requests",
        description: "Reset requests are rate limited.\n\nTarget: 5 per hour",
        type: "non-functional",
        stakeholders: [],
        priority: "nice-to-have",
        ambiguities: [],
        evidenceNeeds: [],
        rawSource: "",
        elicitedNfr: { nfrCategory: "security", evidenceFindingIds: ["f-b"] },
      },
    ]);
    expect(offered[0]!.id.startsWith(ELICITED_NFR_REQUIREMENT_ID_PREFIX)).toBe(true);
  });

  it("does not offer one a synthesis item states, nor one already on the list", () => {
    const uptime = nfr({
      category: "availability",
      title: "API uptime",
      metric: "99.9%",
    });
    const first = offerElicitedNfrs({
      structured: [],
      nfrs: [uptime],
      findingIdsByIndex: [],
      synthesized: [
        {
          type: "feature",
          title: "Service level",
          body: "The API is up 99.9% of the month.",
          priority: "medium",
          labels: [],
          evidenceFindingIndexes: [],
          acceptanceCriteria: [],
          kind: "non-functional",
          nfrCategory: "availability",
        },
      ],
    });
    expect(first.offered).toEqual([]);

    const once = offerElicitedNfrs({
      structured: [],
      nfrs: [uptime],
      findingIdsByIndex: [],
      synthesized: [],
    });
    expect(once.offered).toHaveLength(1);
    // Listed, even reworded by the reviewer: compared by category, target and subject.
    const reworded = { ...once.offered[0]!, title: "Uptime of the API" };
    const again = offerElicitedNfrs({
      structured: [reworded],
      nfrs: [uptime],
      findingIdsByIndex: [],
      synthesized: [],
    });
    expect(again.offered).toEqual([]);
    expect(again.dropped).toEqual([
      {
        title: "API uptime",
        reason: "duplicate",
        duplicateOf: "Uptime of the API",
      },
    ]);
  });

  it("offers at most the per-run cap, priority mapped back to the reviewed scale", () => {
    const { offered } = offerElicitedNfrs({
      structured: [],
      nfrs: distinct(MAX_ELICITED_NFRS_PER_RUN + 2).map((n, i) =>
        i === 0 ? { ...n, priority: "must-have" as const } : n,
      ),
      findingIdsByIndex: [],
      synthesized: [],
    });
    expect(offered).toHaveLength(MAX_ELICITED_NFRS_PER_RUN);
    expect(offered.slice(0, 2).map((r) => r.priority)).toEqual(["must-have", "should-have"]);
    expect(new Set(offered.map((r) => r.id)).size).toBe(offered.length);
  });
});

describe("capElicitedNfrVerdicts (#2449)", () => {
  it("caps only the rows labelled as elicited NFRs", () => {
    expect(
      capElicitedNfrVerdicts(
        [{ labels: ["functional"] }, { labels: [ELICITED_NFR_LABEL] }, { labels: [] }],
        ["implemented", "implemented", null],
      ),
    ).toEqual(["implemented", "could-not-verify", null]);
  });
});
