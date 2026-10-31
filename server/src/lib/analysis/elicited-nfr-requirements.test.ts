/**
 * Issue #1613 — elicited NFRs as draft non-functional requirements (pure part).
 * The persisted, read-back behaviour is proven over real SQLite in
 * `tests/elicited-nfr-requirements-1613.sqlite.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Nfr } from "@metis/shared";
import {
  ELICITED_NFR_LABEL,
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

describe("elicitedNfrRequirements", () => {
  it("writes an NFR as a non-functional requirement with its category, priority and evidence", () => {
    const [r] = elicitedNfrRequirements({
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
    expect(r).toEqual({
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
    });
  });

  it("maps every elicitation priority and keeps a metric-less body as the description", () => {
    const out = elicitedNfrRequirements({
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

  it("drops an NFR the synthesis already states (#1613 dedupe fixture)", () => {
    const out = elicitedNfrRequirements({
      nfrs: [nfr({ title: "P95 latency < 300ms", metric: "p95 < 300 ms" })],
      findingIdsByIndex: [],
      existing: [{ title: "p95 latency < 300 ms", body: "The API answers quickly." }],
    });
    expect(out).toEqual([]);
  });

  it("drops a later NFR that repeats an earlier one's target", () => {
    const out = elicitedNfrRequirements({
      nfrs: [
        nfr({ title: "Fast listing", metric: "p95 < 300ms" }),
        nfr({ title: "Quick API", metric: "P95 < 300 MS" }),
      ],
      findingIdsByIndex: [],
      existing: [],
    });
    expect(out.map((r) => r.title)).toEqual(["Fast listing"]);
  });

  it("an NFR citing nothing rolls up to no_evidence and never to implemented (NFR-2)", () => {
    const elicited = elicitedNfrRequirements({
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
  it("matches a title ignoring case, spacing and punctuation", () => {
    expect(
      statesSameNfr(nfr({ title: "99.9% Uptime!" }), { title: "99.9 % uptime", body: "" }),
    ).toBe(true);
  });

  it("matches the NFR's target written into the existing body", () => {
    expect(
      statesSameNfr(nfr({ title: "Fast API", metric: "p95 < 300ms" }), {
        title: "Responsive API",
        body: "Every endpoint answers with p95 < 300 ms under load.",
      }),
    ).toBe(true);
  });

  it("does not match a different NFR, nor on an empty target", () => {
    expect(
      statesSameNfr(nfr({ title: "Fast API", metric: "" }), {
        title: "Encrypt tokens",
        body: "Tokens are encrypted.",
      }),
    ).toBe(false);
    expect(
      statesSameNfr(nfr({ title: "Fast API", metric: "p95 < 300ms" }), {
        title: "Fast API responses",
        body: "p95 < 500 ms",
      }),
    ).toBe(false);
  });
});
