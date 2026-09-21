import { describe, it, expect, vi } from "vitest";
import {
  scoreFaithfulness,
  stripUngroundedClaims,
  summarizeFaithfulness,
  summarizeGrounding,
  validateCitations,
} from "./citation-validator.js";
import { buildGroundingContext } from "./grounding-context.js";
import type { GroundedClaim } from "./claim-extractor.js";
import type { ClaimVerdict } from "./faithfulness-judge.js";

const ctx = buildGroundingContext({
  ragChunks: [
    { documentId: "doc1", chunkId: "c1", text: "Invoices over 1000 require approval." },
    { documentId: "doc2", chunkId: "c2", text: "Refunds are processed weekly." },
  ],
  webDigests: [
    {
      id: "d1",
      requirementId: "r1",
      evidenceNeedId: "e1",
      query: "q",
      sources: [],
      digest: "Dual approval is common.",
      needsHumanReview: false,
    },
  ],
});

describe("validateCitations", () => {
  it("marks a claim grounded when it cites a real retrieved source", () => {
    const claims: GroundedClaim[] = [
      { claim: "Invoices over 1000 require approval.", sourceIds: ["rag:doc1:c1"] },
    ];
    const r = validateCitations(claims, ctx);
    expect(r.groundedClaims).toHaveLength(1);
    expect(r.ungroundedClaims).toHaveLength(0);
    expect(r.hasUngrounded).toBe(false);
    expect(r.groundingRatio).toBe(1);
  });

  it("flags a fabricated citation as ungrounded and reports the unknown id", () => {
    const claims: GroundedClaim[] = [
      { claim: "The system mines bitcoin.", sourceIds: ["rag:fabricated:99"] },
    ];
    const r = validateCitations(claims, ctx);
    expect(r.groundedClaims).toHaveLength(0);
    expect(r.ungroundedClaims).toHaveLength(1);
    expect(r.ungroundedClaims[0].reason).toBe("unresolved-citation");
    expect(r.unknownSourceIds).toContain("rag:fabricated:99");
    expect(r.hasUngrounded).toBe(true);
  });

  it("flags a claim with no citation as ungrounded (no-citation)", () => {
    const claims: GroundedClaim[] = [{ claim: "An uncited assertion.", sourceIds: [] }];
    const r = validateCitations(claims, ctx);
    expect(r.ungroundedClaims).toHaveLength(1);
    expect(r.ungroundedClaims[0].reason).toBe("no-citation");
  });

  it("keeps a partially-fabricated claim grounded but strips the fabricated id and reports it", () => {
    const claims: GroundedClaim[] = [
      { claim: "Invoices need approval.", sourceIds: ["rag:doc1:c1", "rag:made-up:7"] },
    ];
    const r = validateCitations(claims, ctx);
    expect(r.groundedClaims).toHaveLength(1);
    expect(r.groundedClaims[0].sourceIds).toEqual(["rag:doc1:c1"]);
    expect(r.unknownSourceIds).toContain("rag:made-up:7");
  });

  it("computes the grounding ratio across mixed claims", () => {
    const claims: GroundedClaim[] = [
      { claim: "grounded a", sourceIds: ["rag:doc1:c1"] },
      { claim: "grounded b", sourceIds: ["web:d1"] },
      { claim: "ungrounded", sourceIds: [] },
      { claim: "fabricated", sourceIds: ["rag:nope:0"] },
    ];
    const r = validateCitations(claims, ctx);
    expect(r.totalClaims).toBe(4);
    expect(r.groundedClaims).toHaveLength(2);
    expect(r.ungroundedClaims).toHaveLength(2);
    expect(r.groundingRatio).toBe(0.5);
  });

  it("returns a clean ratio of 1 for an empty claim set", () => {
    const r = validateCitations([], ctx);
    expect(r.totalClaims).toBe(0);
    expect(r.groundingRatio).toBe(1);
    expect(r.hasUngrounded).toBe(false);
  });

  it("resolves web-digest citations", () => {
    const r = validateCitations([{ claim: "Dual approval.", sourceIds: ["web:d1"] }], ctx);
    expect(r.groundedClaims).toHaveLength(1);
  });
});

describe("summarizeGrounding", () => {
  it("summarizes a fully grounded result", () => {
    const r = validateCitations([{ claim: "x", sourceIds: ["rag:doc1:c1"] }], ctx);
    expect(summarizeGrounding(r)).toBe("1/1 claims grounded (100%)");
  });

  it("summarizes ungrounded and fabricated counts", () => {
    const r = validateCitations(
      [
        { claim: "ok", sourceIds: ["rag:doc1:c1"] },
        { claim: "bad", sourceIds: ["rag:fake:1"] },
      ],
      ctx,
    );
    const s = summarizeGrounding(r);
    expect(s).toContain("1/2 claims grounded (50%)");
    expect(s).toContain("1 ungrounded");
    expect(s).toContain("fabricated citation");
  });
});

describe("strip mode", () => {
  const claims: GroundedClaim[] = [
    { claim: "grounded", sourceIds: ["rag:doc1:c1"] },
    { claim: "ungrounded", sourceIds: [] },
  ];

  it("sets stripped=true only when strip is requested AND something is ungrounded", () => {
    expect(validateCitations(claims, ctx, { strip: true }).stripped).toBe(true);
    expect(validateCitations(claims, ctx).stripped).toBe(false);
    const allGrounded: GroundedClaim[] = [{ claim: "g", sourceIds: ["rag:doc1:c1"] }];
    expect(validateCitations(allGrounded, ctx, { strip: true }).stripped).toBe(false);
  });
});

// ── Issue #273 — entailment-based faithfulness scoring ─────────────────────

const factsCtx = buildGroundingContext({
  factsSources: [
    {
      moduleDir: "domain",
      idx: 0,
      label: "Domain",
      text: "Row-level security is enforced at query time. Roles map to row filters.",
    },
  ],
});

/** Build a fake judge whose `judge()` returns the provided verdicts. */
function fakeJudge(verdicts: ClaimVerdict[] | null) {
  return { judge: vi.fn().mockResolvedValue(verdicts) };
}

/** Build a fake extractor whose `decompose()` returns the provided claims. */
function fakeExtractor(claims: GroundedClaim[]) {
  return { decompose: vi.fn().mockResolvedValue({ claims }) };
}

describe("scoreFaithfulness (#273)", () => {
  it("scores a genuinely supported synthesis section HIGH (no false degraded)", async () => {
    // SAS-style POSITIVE fixture: an abstractive overview whose every claim is
    // supported by the facts bundle. None of these reproduce a sourceId, yet
    // they are all entailed → faithfulness 1.0.
    const claims: GroundedClaim[] = [
      { claim: "The system enforces row-level security.", sourceIds: [] },
      { claim: "Access is governed by role-to-row mappings.", sourceIds: [] },
    ];
    const verdicts: ClaimVerdict[] = [
      { claim: claims[0].claim, supported: true, sourceIds: [] },
      { claim: claims[1].claim, supported: true, sourceIds: [] },
    ];
    const r = await scoreFaithfulness(
      "Overview & Domain",
      "## Overview\nThe system enforces row-level security.\nAccess is governed by role-to-row mappings.",
      factsCtx,
      { extractor: fakeExtractor(claims) as never, judge: fakeJudge(verdicts) as never },
    );
    expect(r.totalClaims).toBe(2);
    expect(r.supportedClaims).toBe(2);
    expect(r.faithfulness).toBe(1);
    expect(r.verified).toBe(true);
    expect(r.unsupportedClaims).toHaveLength(0);
  });

  it("scores a hallucinated section LOW and lists the unsupported claims (NEGATIVE fixture)", async () => {
    const claims: GroundedClaim[] = [
      { claim: "The system enforces row-level security.", sourceIds: [] },
      { claim: "The system trains a fraud-detection neural network nightly.", sourceIds: [] },
      { claim: "User passwords are stored in plaintext.", sourceIds: [] },
    ];
    const verdicts: ClaimVerdict[] = [
      { claim: claims[0].claim, supported: true, sourceIds: ["facts:domain:0"] },
      { claim: claims[1].claim, supported: false, sourceIds: [] },
      { claim: claims[2].claim, supported: false, sourceIds: [] },
    ];
    const r = await scoreFaithfulness("Overview & Domain", "irrelevant", factsCtx, {
      extractor: fakeExtractor(claims) as never,
      judge: fakeJudge(verdicts) as never,
    });
    expect(r.totalClaims).toBe(3);
    expect(r.supportedClaims).toBe(1);
    expect(r.faithfulness).toBeCloseTo(1 / 3, 5);
    expect(r.verified).toBe(true);
    expect(r.unsupportedClaims.map((c) => c.claim)).toContain(
      "The system trains a fraud-detection neural network nightly.",
    );
  });

  it("treats an unverifiable judgement (null verdicts) as pass-through, not a failure", async () => {
    const claims: GroundedClaim[] = [{ claim: "anything", sourceIds: [] }];
    const r = await scoreFaithfulness("S", "anything", factsCtx, {
      extractor: fakeExtractor(claims) as never,
      judge: fakeJudge(null) as never,
    });
    expect(r.verified).toBe(false);
    expect(r.faithfulness).toBe(1); // unverifiable → neutral/clean ratio
    expect(r.unsupportedClaims).toHaveLength(0);
  });

  it("returns a clean, verified-unnecessary result when there are no claims", async () => {
    const r = await scoreFaithfulness("S", "## Just a heading", factsCtx, {
      extractor: fakeExtractor([]) as never,
      judge: fakeJudge(null) as never,
    });
    expect(r.totalClaims).toBe(0);
    expect(r.faithfulness).toBe(1);
    expect(r.unsupportedClaims).toHaveLength(0);
  });

  it("is pass-through (unverified) when the context is empty", async () => {
    const empty = buildGroundingContext({});
    const r = await scoreFaithfulness("S", "some text", empty, {
      extractor: fakeExtractor([{ claim: "x", sourceIds: [] }]) as never,
      judge: fakeJudge([{ claim: "x", supported: false, sourceIds: [] }]) as never,
    });
    expect(r.verified).toBe(false);
    expect(r.faithfulness).toBe(1);
  });

  it("carries sourceIds through as optional attribution on supported claims", async () => {
    const claims: GroundedClaim[] = [{ claim: "Access control is enforced.", sourceIds: [] }];
    const verdicts: ClaimVerdict[] = [
      { claim: "Access control is enforced.", supported: true, sourceIds: ["facts:domain:0"] },
    ];
    const r = await scoreFaithfulness("S", "Access control is enforced.", factsCtx, {
      extractor: fakeExtractor(claims) as never,
      judge: fakeJudge(verdicts) as never,
    });
    expect(r.supportedAttributions[0].sourceIds).toEqual(["facts:domain:0"]);
  });
});

describe("summarizeFaithfulness (#273)", () => {
  it("summarizes a verified, supported section", async () => {
    const claims: GroundedClaim[] = [{ claim: "a", sourceIds: [] }];
    const r = await scoreFaithfulness("S", "a", factsCtx, {
      extractor: fakeExtractor(claims) as never,
      judge: fakeJudge([{ claim: "a", supported: true, sourceIds: [] }]) as never,
    });
    expect(summarizeFaithfulness(r)).toContain("1/1 claims supported (100%)");
  });

  it("summarizes an unverifiable section", async () => {
    const r = await scoreFaithfulness("S", "a", factsCtx, {
      extractor: fakeExtractor([{ claim: "a", sourceIds: [] }]) as never,
      judge: fakeJudge(null) as never,
    });
    expect(summarizeFaithfulness(r).toLowerCase()).toContain("unverified");
  });
});

describe("stripUngroundedClaims", () => {
  it("removes lines matching ungrounded claims, keeping headings and grounded prose", () => {
    const md = [
      "## Section",
      "",
      "Invoices over 1000 require approval.",
      "Made-up unverifiable fact.",
    ].join("\n");
    const r = validateCitations(
      [
        { claim: "Invoices over 1000 require approval.", sourceIds: ["rag:doc1:c1"] },
        { claim: "Made-up unverifiable fact.", sourceIds: ["rag:fake:1"] },
      ],
      ctx,
      { strip: true },
    );
    const out = stripUngroundedClaims(md, r.ungroundedClaims);
    expect(out).toContain("## Section");
    expect(out).toContain("Invoices over 1000 require approval.");
    expect(out).not.toContain("Made-up unverifiable fact.");
  });

  it("matches list-marker and blockquote variants of a claim line", () => {
    const md = ["- Made-up fact.", "> Made-up fact."].join("\n");
    const out = stripUngroundedClaims(md, [
      { claim: "Made-up fact.", sourceIds: [], reason: "no-citation" },
    ]);
    expect(out.trim()).toBe("");
  });

  it("returns markdown unchanged when there are no ungrounded claims", () => {
    const md = "## Section\n\nAll good.";
    expect(stripUngroundedClaims(md, [])).toBe(md);
  });

  it("never strips a heading even if its text matches a claim", () => {
    const md = "## Overview";
    const out = stripUngroundedClaims(md, [
      { claim: "Overview", sourceIds: [], reason: "no-citation" },
    ]);
    expect(out).toBe(md);
  });
});
