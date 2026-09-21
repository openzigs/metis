/**
 * #267 — facts-as-grounding-sources regression tests.
 *
 * Root cause (deferred item #3 of #264): docs are synthesized from per-module
 * code-graph FACTS, but the citation validator could only resolve `rag:`/`web:`
 * source ids. Claims derived from the facts had nothing to cite → ungrounded →
 * `degraded`. SAS exposes this starkly: SAS modules are `function`-only (macros /
 * DATA / PROC steps) and their high-level logic rarely appears verbatim in a raw
 * RAG chunk, so RAG-only grounding leaves narrative sections almost entirely
 * ungrounded.
 *
 * These tests prove that admitting the synthesis facts as citable
 * `facts:<moduleDir>:<idx>` sources materially raises the section grounding
 * ratio for a SAS-style fixture, and that the BEFORE (rag-only) vs AFTER
 * (rag + facts) ratios differ as claimed.
 */
import { describe, it, expect } from "vitest";
import {
  buildGroundingContext,
  mergeFactsIntoContext,
  factsSourceId,
  type FactsSourceInput,
  type RagChunk,
} from "./grounding-context.js";
import { validateCitations } from "./citation-validator.js";
import type { GroundedClaim } from "./claim-extractor.js";

// ── SAS-style fixture: a function-only module (no classes) ────────────────────
// One module dir, three "facts" entries derived from macros / DATA / PROC steps.
const SAS_MODULE_DIR = "sas/claims/etl";

const sasFacts: FactsSourceInput[] = [
  {
    moduleDir: SAS_MODULE_DIR,
    idx: 0,
    label: "sas/claims/etl",
    text: "PURPOSE\nThe CLEAN_CLAIMS macro standardises raw claim records before scoring.",
  },
  {
    moduleDir: SAS_MODULE_DIR,
    idx: 1,
    label: "sas/claims/etl",
    text: "RULES\nClaims with AMOUNT > 10000 are routed to manual review and flagged HIGH_VALUE.",
  },
  {
    moduleDir: SAS_MODULE_DIR,
    idx: 2,
    label: "sas/claims/etl",
    text: "WORKFLOWS\nThe SCORE_CLAIMS PROC SQL step joins claims to the policy table and derives a risk band.",
  },
];

// RAG retrieval for this SAS section returns only one tangential raw-source chunk
// (mirrors the observed behaviour: SAS narrative logic is absent from raw chunks).
const ragChunks: RagChunk[] = [
  {
    documentId: "doc-config",
    chunkId: "c1",
    filename: "etl.cfg",
    text: "libname clm '/data/claims'; options nofmterr;",
  },
];

// The synthesized narrative section decomposes into these atomic claims. Each is
// supported by a FACT (what the doc was actually written from), NOT by the lone
// config RAG chunk — so under rag-only grounding they cannot resolve.
function synthesizedClaims(): GroundedClaim[] {
  return [
    {
      claim: "The CLEAN_CLAIMS macro standardises raw claim records before scoring.",
      sourceIds: [factsSourceId(SAS_MODULE_DIR, 0)],
    },
    {
      claim: "Claims over 10000 are routed to manual review and flagged HIGH_VALUE.",
      sourceIds: [factsSourceId(SAS_MODULE_DIR, 1)],
    },
    {
      claim: "SCORE_CLAIMS joins claims to the policy table to derive a risk band.",
      sourceIds: [factsSourceId(SAS_MODULE_DIR, 2)],
    },
    // One genuinely config-grounded claim that DOES resolve against the rag chunk.
    {
      claim: "The claims library is bound to /data/claims.",
      sourceIds: ["rag:doc-config:c1"],
    },
  ];
}

describe("#267 SAS fixture — facts as citable grounding sources", () => {
  it("BEFORE (rag-only) leaves fact-derived claims ungrounded; AFTER (rag+facts) resolves them", () => {
    const claims = synthesizedClaims();

    // BEFORE: rag-only grounding (the status quo that produced ~98% ungrounded).
    const ragOnly = buildGroundingContext({ ragChunks });
    const before = validateCitations(claims, ragOnly, { strip: true });

    // AFTER: same rag context, with this section's facts merged in (#267).
    const withFacts = mergeFactsIntoContext(ragOnly, sasFacts);
    const after = validateCitations(claims, withFacts, { strip: true });

    // BEFORE: only the single config claim resolves → 1/4 = 25%.
    expect(before.groundedClaims.length).toBe(1);
    expect(before.groundingRatio).toBeCloseTo(0.25, 5);
    expect(before.hasUngrounded).toBe(true);

    // AFTER: all four claims resolve → 4/4 = 100%.
    expect(after.groundedClaims.length).toBe(4);
    expect(after.groundingRatio).toBe(1);
    expect(after.hasUngrounded).toBe(false);

    // The improvement is material (well beyond rounding noise).
    expect(after.groundingRatio - before.groundingRatio).toBeGreaterThan(0.5);
  });

  it("facts text is meaningful (the rule/snippet), not a bare label, so claims can match", () => {
    const ctx = buildGroundingContext({ factsSources: sasFacts });
    const ruleSource = ctx.sources.find((s) => s.sourceId === factsSourceId(SAS_MODULE_DIR, 1));
    expect(ruleSource?.text).toContain("AMOUNT > 10000");
    expect(ruleSource?.text).toContain("HIGH_VALUE");
  });

  it("BACK-COMPAT: no facts → grounding context and ratio are identical to rag-only", () => {
    const claims = synthesizedClaims();
    const ragOnly = buildGroundingContext({ ragChunks });
    const merged = mergeFactsIntoContext(ragOnly, []);

    // Same object (no copy) and same validation outcome.
    expect(merged).toBe(ragOnly);
    const a = validateCitations(claims, ragOnly, { strip: true });
    const b = validateCitations(claims, merged, { strip: true });
    expect(b.groundingRatio).toBe(a.groundingRatio);
    expect(b.groundedClaims.length).toBe(a.groundedClaims.length);
  });
});

describe("#267 mergeFactsIntoContext budget — Bedrock-size (>60K) facts", () => {
  // Simulate a Bedrock-size selection: many module facts whose combined text far
  // exceeds the old DEFAULT_CHAR_BUDGET (60K). buildSectionFactsSources selects
  // these up to factsCharCap (150K on Bedrock), and the model reads ALL of them
  // in the blob — so ALL must be citable. Pre-fix, the merge fell back to 60K
  // and dropped the >60K tail from the citable set → those claims went ungrounded.
  const BEDROCK_FACTS_CAP = 150_000;
  const MODULE_TEXT_LEN = 5_000; // ~5K chars per module
  const MODULE_COUNT = 20; // 20 × 5K = 100K total > 60K default, < 150K cap

  function bigFacts(): FactsSourceInput[] {
    return Array.from({ length: MODULE_COUNT }, (_, i) => ({
      moduleDir: `sas/mod${i}`,
      idx: i,
      label: `sas/mod${i}`,
      // Distinct, non-trivial text per module so each is a real citable source.
      text: `MODULE ${i} FACTS\n` + `x`.repeat(MODULE_TEXT_LEN),
    }));
  }

  // A pre-existing RAG source that was citable in the base context BEFORE the merge.
  const baseRag: RagChunk[] = [
    {
      documentId: "doc-base",
      chunkId: "r1",
      filename: "base.cfg",
      text: "libname base '/data/base';",
    },
  ];

  it("all facts the model saw (>60K) remain citable AND base RAG is not evicted", () => {
    const facts = bigFacts();
    const totalFactsChars = facts.reduce((n, f) => n + f.text.length, 0);
    // Sanity: the fixture really does exceed the old 60K default.
    expect(totalFactsChars).toBeGreaterThan(60_000);
    expect(totalFactsChars).toBeLessThan(BEDROCK_FACTS_CAP);

    const ragBase = buildGroundingContext({ ragChunks: baseRag });
    expect(ragBase.sourceIds.has("rag:doc-base:r1")).toBe(true);

    // Merge with the SAME budget the blob used (factsCharCap), as the call site
    // now does. Every selected module must end up citable.
    const merged = mergeFactsIntoContext(ragBase, facts, BEDROCK_FACTS_CAP);

    // (a) ALL 20 facts modules are citable — including those past the 60K mark.
    for (let i = 0; i < MODULE_COUNT; i++) {
      expect(merged.sourceIds.has(factsSourceId(`sas/mod${i}`, i))).toBe(true);
    }
    // (b) the pre-existing RAG source is NOT evicted by the large facts set.
    expect(merged.sourceIds.has("rag:doc-base:r1")).toBe(true);
    expect(merged.sources.length).toBe(MODULE_COUNT + 1);

    // Claims derived from the tail (e.g. module 19, well past 60K) resolve.
    const tailClaim: GroundedClaim = {
      claim: "Module 19 does a thing.",
      sourceIds: [factsSourceId("sas/mod19", 19)],
    };
    const ragClaim: GroundedClaim = {
      claim: "The base library is bound.",
      sourceIds: ["rag:doc-base:r1"],
    };
    const result = validateCitations([tailClaim, ragClaim], merged, { strip: true });
    expect(result.groundedClaims.length).toBe(2);
    expect(result.hasUngrounded).toBe(false);
  });

  it("REGRESSION GUARD: default-60K budget WOULD drop the >60K tail (old behaviour)", () => {
    const facts = bigFacts();
    const ragBase = buildGroundingContext({ ragChunks: baseRag });
    // No budget arg → falls back to DEFAULT 60K. Demonstrates the bug the fix avoids.
    const merged = mergeFactsIntoContext(ragBase, facts);

    // Only ~12 of the 20 modules fit under 60K; the tail is NOT citable.
    const citableFacts = facts.filter((f) =>
      merged.sourceIds.has(factsSourceId(f.moduleDir, f.idx)),
    ).length;
    expect(citableFacts).toBeLessThan(MODULE_COUNT);
    // The very last module (tail) is dropped from the citable set.
    expect(merged.sourceIds.has(factsSourceId("sas/mod19", 19))).toBe(false);
    // Base RAG still survives even under the small budget (always preserved).
    expect(merged.sourceIds.has("rag:doc-base:r1")).toBe(true);
  });
});

describe("#267 factsSourceId — sanitise collisions are dropped, never cross-attributed", () => {
  it("two distinct module dirs that sanitise to the same id → first wins, duplicate dropped", () => {
    // `a/b` and `a:b` both sanitise to `a_b`; at the same rank (idx) they collide.
    const collidingFacts: FactsSourceInput[] = [
      { moduleDir: "a/b", idx: 0, label: "a/b", text: "FIRST module facts text." },
      { moduleDir: "a:b", idx: 0, label: "a:b", text: "SECOND module facts text." },
    ];
    // Confirm the ids really do collide.
    expect(factsSourceId("a/b", 0)).toBe(factsSourceId("a:b", 0));

    const ctx = buildGroundingContext({ factsSources: collidingFacts });

    // Only ONE source admitted under the shared id — the FIRST.
    const matches = ctx.sources.filter((s) => s.sourceId === factsSourceId("a/b", 0));
    expect(matches.length).toBe(1);
    expect(matches[0]?.text).toBe("FIRST module facts text.");
    // The second module's text is NOT attributed to the surviving id.
    expect(matches[0]?.text).not.toContain("SECOND");
  });

  it("mergeFactsIntoContext drops a colliding duplicate the same way", () => {
    const collidingFacts: FactsSourceInput[] = [
      { moduleDir: "x/y", idx: 0, label: "x/y", text: "KEEP this one." },
      { moduleDir: "x:y", idx: 0, label: "x:y", text: "DROP this one." },
    ];
    const merged = mergeFactsIntoContext(buildGroundingContext({}), collidingFacts);
    const matches = merged.sources.filter((s) => s.sourceId === factsSourceId("x/y", 0));
    expect(matches.length).toBe(1);
    expect(matches[0]?.text).toBe("KEEP this one.");
  });
});
