/**
 * Issue #2233 — no silent caps. Each limit that leaves requirements or
 * findings out says exactly what it left out, on the run's capability record.
 */
import { describe, expect, it, vi } from "vitest";
import { MAX_REQUIREMENTS_FOR_RETRIEVAL } from "@metis/shared";
import type { AIProvider, ChatResponse } from "../ai/types.js";

vi.mock("../prisma.js", () => ({ prisma: {} }));

const { requirementsLeftOutAtLimit } = await import("./retrieval.js");
const {
  createCapabilityTracker,
  finalizeCapability,
  recordFindingsLeftOut,
  recordRequirementsLeftOut,
} = await import("./analysis-capability.js");
const { collectFindingsLeftOut, runAgent } = await import("./agent-runner.js");
const { parseAgentFindingsAnswer } = await import("./custom-agent-phase.js");

const reqs = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `REQ-${String(i + 1).padStart(3, "0")}`,
    text: `Export dataset ${i + 1} as a CSV.`,
  }));

const finding = (i: number) => ({
  category: "other",
  severity: "low",
  title: `Finding ${i + 1}`,
  body: "b",
  tags: [],
  citations: [],
});

function tracker() {
  return createCapabilityTracker({
    static: {
      codeGraphPresent: true,
      repoSourceIngested: true,
      fusedCodeRetrievalEnabled: true,
      schemaContextEnabled: true,
    },
    codeAnalysisRequested: true,
    databaseAnalysisRequested: false,
  });
}

describe("requirementsLeftOutAtLimit", () => {
  it("names every requirement past the limit: analysed 24 of 41", () => {
    const notice = requirementsLeftOutAtLimit("requirement-grounded-code", reqs(41));
    expect(notice).toMatchObject({
      stage: "requirement-grounded-code",
      analysedCount: MAX_REQUIREMENTS_FOR_RETRIEVAL,
      totalCount: 41,
    });
    expect(notice!.leftOut.map((r) => r.id)).toEqual(
      reqs(41)
        .slice(MAX_REQUIREMENTS_FOR_RETRIEVAL)
        .map((r) => r.id),
    );
    expect(notice!.leftOut[0]!.excerpt).toBe("Export dataset 25 as a CSV.");
  });

  it("is null at or under the limit, and does not count blank requirements", () => {
    expect(requirementsLeftOutAtLimit("governing-applicability", reqs(24))).toBeNull();
    expect(
      requirementsLeftOutAtLimit("governing-applicability", [
        ...reqs(24),
        { id: "REQ-BLANK", text: "   " },
      ]),
    ).toBeNull();
  });

  it("honours a smaller limit, and a negative one keeps none", () => {
    expect(requirementsLeftOutAtLimit("governing-applicability", reqs(3), 2)?.leftOut).toEqual([
      { id: "REQ-003", excerpt: "Export dataset 3 as a CSV." },
    ]);
    expect(requirementsLeftOutAtLimit("governing-applicability", reqs(2), -1)?.analysedCount).toBe(
      0,
    );
  });
});

describe("recording the notices on the run", () => {
  it("finalizes requirementsLeftOut with its reason, one notice per stage", () => {
    const t = tracker();
    recordRequirementsLeftOut(t, requirementsLeftOutAtLimit("requirement-grounded-code", reqs(26)));
    // A second repository's pass replaces the stage's notice instead of repeating it.
    recordRequirementsLeftOut(t, requirementsLeftOutAtLimit("requirement-grounded-code", reqs(27)));
    recordRequirementsLeftOut(t, requirementsLeftOutAtLimit("governing-applicability", reqs(25)));
    recordRequirementsLeftOut(t, null);
    const cap = finalizeCapability(t);
    expect(cap.requirementsLeftOut?.map((n) => [n.stage, n.leftOut.length])).toEqual([
      ["requirement-grounded-code", 3],
      ["governing-applicability", 1],
    ]);
    expect(cap.reasons).toContain("requirements-left-out");
  });

  it("finalizes findingsLeftOut with its reason", () => {
    const t = tracker();
    recordFindingsLeftOut(t, {
      agentKey: "document",
      producedCount: 52,
      keptCount: 50,
      leftOutTitles: ["a", "b"],
    });
    recordFindingsLeftOut(t, undefined);
    recordFindingsLeftOut(t, {
      agentKey: "web",
      producedCount: 50,
      keptCount: 50,
      leftOutTitles: [],
    });
    const cap = finalizeCapability(t);
    expect(cap.findingsLeftOut).toEqual([
      { agentKey: "document", producedCount: 52, keptCount: 50, leftOutTitles: ["a", "b"] },
    ]);
    expect(cap.reasons).toContain("findings-left-out");
  });

  it("a run under every limit carries neither field nor reason", () => {
    const cap = finalizeCapability(tracker());
    expect("requirementsLeftOut" in cap).toBe(false);
    expect("findingsLeftOut" in cap).toBe(false);
    expect(cap.reasons).not.toContain("requirements-left-out");
    expect(cap.reasons).not.toContain("findings-left-out");
  });
});

describe("collectFindingsLeftOut", () => {
  it("names each finding past the 50th, by title", () => {
    const parsed = {
      findings: [...Array.from({ length: 50 }, (_, i) => finding(i)), finding(50), { title: " " }],
    };
    expect(collectFindingsLeftOut(parsed, "document")).toEqual({
      agentKey: "document",
      producedCount: 52,
      keptCount: 50,
      leftOutTitles: ["Finding 51", "(untitled finding)"],
    });
  });

  it.each([
    null,
    [],
    "x",
    {},
    { findings: "x" },
    { findings: Array.from({ length: 50 }, () => ({})) },
  ])("is undefined for %j", (parsed) => {
    expect(collectFindingsLeftOut(parsed, "document")).toBeUndefined();
  });
});

describe("runAgent reports the findings it cut", () => {
  function provider(content: string): AIProvider {
    return {
      key: "offline-stub",
      model: "stub",
      offline: true,
      chat: vi.fn(async (): Promise<ChatResponse> => ({
        content,
        usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
        model: "stub",
        provider: "offline-stub",
      })),
    } as unknown as AIProvider;
  }
  const INPUT = {
    agentKey: "database" as const,
    projectName: "P",
    projectDescription: "D",
    retrieved: [],
  };

  it("keeps 50 and names the rest", async () => {
    const answer = JSON.stringify({
      summary: "ok",
      findings: Array.from({ length: 53 }, (_, i) => finding(i)),
      notes: [],
    });
    const result = await runAgent(provider(answer), INPUT);
    expect(result.output.findings).toHaveLength(50);
    expect(result.findingsLeftOut).toEqual({
      agentKey: "database",
      producedCount: 53,
      keptCount: 50,
      leftOutTitles: ["Finding 51", "Finding 52", "Finding 53"],
    });
  });

  it("reports nothing for an answer within the cap", async () => {
    const answer = JSON.stringify({ summary: "ok", findings: [finding(0)], notes: [] });
    const result = await runAgent(provider(answer), INPUT);
    expect(result).not.toHaveProperty("findingsLeftOut");
  });
});

describe("parseAgentFindingsAnswer reports the findings it cut", () => {
  it("returns the cut findings beside the answer", () => {
    const parsed = parseAgentFindingsAnswer(
      JSON.stringify({ summary: "ok", findings: Array.from({ length: 51 }, (_, i) => finding(i)) }),
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.output.findings).toHaveLength(50);
    expect(parsed.findingsLeftOut).toMatchObject({
      producedCount: 51,
      keptCount: 50,
      leftOutTitles: ["Finding 51"],
    });
  });
});
