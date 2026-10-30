/**
 * Issue #1612 — what reaches the `kind` / `nfrCategory` columns.
 *
 * The rule that matters most is the #1117 lesson: the deterministic synthesis
 * fallback cannot classify anything, so it must leave `kind` unknown (null)
 * rather than default it to `functional` — a default would be published as a
 * finding. Every writer goes through `requirementKindColumns`, and the
 * synthesis tests below drive the real `runSynthesis` on both paths.
 */
import { describe, expect, it, vi } from "vitest";
import type { SynthesizedRequirement } from "@metis/shared";
import { updateRequirementSchema } from "@metis/shared";
import type { AIProvider, ChatResponse } from "../ai/types.js";
import {
  coerceNfrCategory,
  coerceRequirementKind,
  requirementKindColumns,
} from "./requirement-kind.js";
import { fallbackSynthesize, runSynthesis, type FlatFinding } from "./synthesis.js";
import { buildApprovedRequirementSet } from "./approved-requirement-set.js";
import { readWithheldProposal, WITHHELD_PROPOSAL_KEY } from "./withheld-replacement.js";
import { buildSynthesisPrompt } from "./prompts.js";
import type { StructuredRequirement } from "./types/requirements.js";

describe("#1612 — requirementKindColumns", () => {
  it.each([
    [{}, { kind: null, nfrCategory: null }],
    [{ kind: "functional" }, { kind: "functional", nfrCategory: null }],
    [
      { kind: "non-functional", nfrCategory: "performance" },
      { kind: "non-functional", nfrCategory: "performance" },
    ],
    [{ kind: "non-functional" }, { kind: "non-functional", nfrCategory: null }],
    // A category beside any other kind is dropped, never stored.
    [
      { kind: "functional", nfrCategory: "security" },
      { kind: "functional", nfrCategory: null },
    ],
    [{ nfrCategory: "security" }, { kind: null, nfrCategory: null }],
    // Values outside the enums read as unknown.
    [{ kind: "Functional" }, { kind: null, nfrCategory: null }],
    [
      { kind: "non-functional", nfrCategory: "speed" },
      { kind: "non-functional", nfrCategory: null },
    ],
    [
      { kind: 1, nfrCategory: null },
      { kind: null, nfrCategory: null },
    ],
  ])("%j → %j", (input, expected) => {
    expect(requirementKindColumns(input)).toEqual(expected);
  });

  it("coerces stored values the same way", () => {
    expect(coerceRequirementKind("non-functional")).toBe("non-functional");
    expect(coerceRequirementKind(null)).toBeNull();
    expect(coerceNfrCategory("security", "non-functional")).toBe("security");
    expect(coerceNfrCategory("security", "functional")).toBeNull();
    expect(coerceNfrCategory("security", null)).toBeNull();
  });
});

describe("#1612 — the PATCH schema", () => {
  it.each([
    [{ kind: "functional" }, true],
    [{ kind: null }, true],
    [{ kind: "non-functional", nfrCategory: "security" }, true],
    [{ nfrCategory: null }, true],
    [{ kind: "quality" }, false],
    [{ kind: "non-functional", nfrCategory: "speed" }, false],
    [{ nfrCategory: "security" }, false],
    [{ kind: "functional", nfrCategory: "security" }, false],
  ])("%j valid: %s", (body, ok) => {
    expect(updateRequirementSchema.safeParse(body).success).toBe(ok);
  });
});

const FINDINGS: FlatFinding[] = [
  {
    agentKey: "code",
    category: "performance",
    severity: "high",
    title: "Checkout p95 is 2.4 s",
    body: "The checkout endpoint has no caching.",
    tags: ["perf"],
    citations: [],
  },
  {
    agentKey: "code",
    category: "security",
    severity: "high",
    title: "No account lockout",
    body: "Repeated failed logins are never throttled.",
    tags: ["auth"],
    citations: [],
  },
] as FlatFinding[];

function providerReturning(content: string | Error): AIProvider {
  return {
    chat: vi.fn(async () => {
      if (content instanceof Error) throw content;
      return {
        content,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
      } as ChatResponse;
    }),
  } as unknown as AIProvider;
}

const requirement = (over: Record<string, unknown>) => ({
  type: "feature",
  title: "Fast checkout",
  body: "Checkout responds quickly.",
  priority: "high",
  labels: [],
  evidenceFindingIndexes: [0],
  acceptanceCriteria: [],
  ...over,
});

describe("#1612 — synthesis sets kind only when the model says", () => {
  it("keeps the model's kind and category", async () => {
    const result = await runSynthesis(
      providerReturning(
        JSON.stringify({
          summary: "s",
          requirements: [
            requirement({ kind: "non-functional", nfrCategory: "performance" }),
            requirement({
              title: "Lock accounts",
              evidenceFindingIndexes: [1],
              kind: "functional",
            }),
          ],
        }),
      ),
      { projectName: "Shop", findings: FINDINGS },
    );
    expect(result.degraded).toBeUndefined();
    expect(result.output.requirements.map((r) => [r.kind, r.nfrCategory])).toEqual([
      ["non-functional", "performance"],
      ["functional", undefined],
    ]);
  });

  it("a kind outside the enum reads as unknown and costs nothing else", async () => {
    const result = await runSynthesis(
      providerReturning(
        JSON.stringify({
          summary: "s",
          requirements: [requirement({ kind: "quality", nfrCategory: "speed" })],
        }),
      ),
      { projectName: "Shop", findings: FINDINGS },
    );
    const [r] = result.output.requirements;
    expect(r!.kind).toBeUndefined();
    expect(r!.nfrCategory).toBeUndefined();
    expect(r!.title).toBe("Fast checkout");
    expect(requirementKindColumns(r!)).toEqual({ kind: null, nfrCategory: null });
  });

  it("the fallback path leaves kind NULL — it never defaults to functional (#1117)", async () => {
    const result = await runSynthesis(providerReturning(new Error("provider down")), {
      projectName: "Shop",
      findings: FINDINGS,
    });
    expect(result.degraded?.reason).toBe("provider-error");
    expect(result.output.requirements.length).toBeGreaterThan(0);
    for (const r of result.output.requirements) {
      expect(r.kind).toBeUndefined();
      expect(requirementKindColumns(r)).toEqual({ kind: null, nfrCategory: null });
    }
    for (const r of fallbackSynthesize(FINDINGS).requirements) {
      expect(requirementKindColumns(r).kind).toBeNull();
    }
  });

  it("the prompt asks for kind and lists the NFR categories", () => {
    const { systemMessage } = buildSynthesisPrompt({
      projectName: "Shop",
      findingsTable: "[0] x",
    });
    expect(systemMessage).toContain('"kind": "functional|non-functional"');
    expect(systemMessage).toMatch(/nfrCategory.*performance, security/s);
    expect(systemMessage).toMatch(/Omit `kind` when the findings do not show which it is/);
  });
});

function structured(id: string, type: string): StructuredRequirement {
  return {
    id,
    title: `Requirement ${id}`,
    description: `Requirement ${id}`,
    type: type as StructuredRequirement["type"],
    stakeholders: [],
    priority: "must-have",
    ambiguities: [],
    evidenceNeeds: [],
    rawSource: "",
  };
}
function synth(id: string, extra: Partial<SynthesizedRequirement>): SynthesizedRequirement {
  return {
    type: "feature",
    title: `Requirement ${id}`,
    body: "b",
    priority: "medium",
    labels: [],
    evidenceFindingIndexes: [],
    acceptanceCriteria: [],
    structuredIds: [id],
    ...extra,
  };
}

describe("#1612 — the approval checkpoint writes the reviewed kind", () => {
  const promote = (reviewedType: string, item: Partial<SynthesizedRequirement>) =>
    buildApprovedRequirementSet({
      structured: [structured("REQ-1", reviewedType)],
      approvedIds: new Set(["REQ-1"]),
      synthesis: { summary: "s", requirements: [synth("REQ-1", item)] },
    }).requirements[0]!;

  it("prefers the reviewed classification when it is one of the two kinds", () => {
    const r = promote("functional", { kind: "non-functional", nfrCategory: "security" });
    expect(requirementKindColumns(r)).toEqual({ kind: "functional", nfrCategory: null });
  });

  it("keeps the item's category when both say non-functional", () => {
    const r = promote("non-functional", { kind: "non-functional", nfrCategory: "security" });
    expect(requirementKindColumns(r)).toEqual({ kind: "non-functional", nfrCategory: "security" });
  });

  it("falls back to the item's kind for a reviewed type that is not a kind", () => {
    const r = promote("constraint", { kind: "non-functional", nfrCategory: "compliance" });
    expect(requirementKindColumns(r)).toEqual({
      kind: "non-functional",
      nfrCategory: "compliance",
    });
  });

  it("leaves it unknown when neither says", () => {
    const r = promote("assumption", {});
    expect(r).not.toHaveProperty("kind");
    expect(requirementKindColumns(r)).toEqual({ kind: null, nfrCategory: null });
  });
});

describe("#1612 — a withheld replacement carries the kind it would have written", () => {
  const row = (extra: Record<string, unknown>) => ({
    type: "feature",
    title: "t",
    body: "b",
    priority: "medium",
    labels: "[]",
    acceptanceCriteria: "[]",
    storyPoints: null,
    coverage: null,
    verdict: null,
    sourceCandidateIds: null,
    ...extra,
  });

  it("reads kind and category back, and a pre-#1612 proposal as unknown", () => {
    const proposal = readWithheldProposal({
      [WITHHELD_PROPOSAL_KEY]: {
        at: "2026-10-30T00:00:00Z",
        rows: [row({ kind: "non-functional", nfrCategory: "availability" }), row({})],
      },
    });
    expect(proposal!.rows.map((r) => [r.kind, r.nfrCategory])).toEqual([
      ["non-functional", "availability"],
      [null, null],
    ]);
  });
});
