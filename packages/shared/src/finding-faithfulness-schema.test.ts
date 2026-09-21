/**
 * Epic #1316 (#1318) — the two invariants {@link findingFaithfulnessSchema}
 * documents in prose are ENFORCED, and enforcing them can never cost a run its
 * findings.
 *
 * Both matter on the READ path. A persisted blob is validated on the way out
 * (`coerceFaithfulness` in `analysis-service.ts`) precisely so a row written by
 * an older or newer shape reads as "not measured" rather than reaching the UI
 * half-formed — but a blob claiming `supportedClaims: 40` of `totalClaims: 4`,
 * or a `score: 1` carrying `unverifiableReason: "judge-unavailable"`, passed
 * that validation and rendered as a measurement. Neither can be produced by
 * `toFaithfulnessMetric`, so anything with that shape is corrupt or forged.
 */
import { describe, expect, it } from "vitest";
import { agentFindingPayloadSchema, findingFaithfulnessSchema } from "./analysis.js";

const base = { score: 0.75, totalClaims: 4, supportedClaims: 3 };

describe("findingFaithfulnessSchema", () => {
  it("accepts a real ratio", () => {
    expect(findingFaithfulnessSchema.safeParse(base).success).toBe(true);
  });

  it("accepts an unverifiable measurement with its reason", () => {
    expect(
      findingFaithfulnessSchema.safeParse({
        score: null,
        totalClaims: 0,
        supportedClaims: 0,
        unverifiableReason: "no-claims",
      }).success,
    ).toBe(true);
  });

  it("rejects more supported claims than there were claims", () => {
    expect(
      findingFaithfulnessSchema.safeParse({ ...base, supportedClaims: 40, totalClaims: 4 }).success,
    ).toBe(false);
  });

  it("rejects an unverifiable reason beside a real score", () => {
    // A number AND "I could not verify" is not a measurement; one of them is a
    // lie, and a reader would believe the number.
    expect(
      findingFaithfulnessSchema.safeParse({ ...base, unverifiableReason: "judge-unavailable" })
        .success,
    ).toBe(false);
  });

  it("rejects a null score with no reason it could not be made", () => {
    expect(
      findingFaithfulnessSchema.safeParse({ score: null, totalClaims: 0, supportedClaims: 0 })
        .success,
    ).toBe(false);
  });

  it("treats an explicit null reason beside a real score as absent, not as a violation", () => {
    // `.nullish()` means a serializer that writes `"unverifiableReason": null`
    // round-trips; only a REASON beside a score is contradictory.
    expect(findingFaithfulnessSchema.safeParse({ ...base, unverifiableReason: null }).success).toBe(
      true,
    );
  });
});

describe("agentFindingPayloadSchema — a bad faithfulness costs the field, not the finding", () => {
  const finding = {
    category: "security",
    severity: "high",
    title: "t",
    body: "b",
    citations: [],
    tags: [],
  };

  it.each([
    ["a violated invariant", { score: 1, totalClaims: 4, supportedClaims: 40 }],
    ["an out-of-range score", { score: 42, totalClaims: 1, supportedClaims: 1 }],
    ["a non-object", "perfect"],
  ])("drops %s rather than failing the parse (#1230)", (_label, faithfulness) => {
    // The #1222 / #1230 rule, one field further on: a malformed value in a
    // field the model should not be authoring at all must never throw and
    // discard a completed investigation's findings.
    const parsed = agentFindingPayloadSchema.safeParse({ ...finding, faithfulness });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.faithfulness).toBeUndefined();
  });

  it("still carries a well-formed value through", () => {
    const parsed = agentFindingPayloadSchema.safeParse({ ...finding, faithfulness: base });
    expect(parsed.success && parsed.data.faithfulness).toEqual(base);
  });
});
