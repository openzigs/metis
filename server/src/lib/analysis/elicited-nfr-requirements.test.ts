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
  MAX_ELICITED_NFRS_PER_RUN,
  capElicitedNfrVerdict,
  elicitedNfrRequirements,
  statesSameNfr,
} from "./elicited-nfr-requirements.js";
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
