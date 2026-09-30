/**
 * Issue #30 — the pure half of the Analysis page's sub-views.
 */
import { describe, it, expect } from "vitest";
import {
  ANALYSIS_TABS,
  analysisTabCounts,
  analysisViewHref,
  collectFindings,
  filterFindings,
  findingFacets,
  NO_FINDING_FILTERS,
  paginate,
  parseAnalysisTab,
  runHasQuestionsView,
  tabCountLabel,
  tabForAnchor,
  type AgentFinding,
} from "./analysis-views";
import type { AgentResultSummary, AnalysisFinding } from "@/lib/analysis-api";

function finding(over: Partial<AnalysisFinding> & { id: string }): AnalysisFinding {
  return {
    category: "architecture",
    severity: "medium",
    title: over.id,
    body: "",
    tags: [],
    citations: [],
    derivation: "inferred",
    confidence: 0.5,
    agentResultId: "ar",
    ...over,
  };
}

function agent(agentKey: string, findings: AnalysisFinding[]): AgentResultSummary {
  return {
    id: `ar-${agentKey}`,
    agentKey,
    status: "completed",
    startedAt: null,
    completedAt: null,
    errorMessage: null,
    summary: null,
    findings,
  } as AgentResultSummary;
}

const AGENTS = [
  agent("code", [
    finding({ id: "f1", severity: "high", category: "security", verificationStatus: "confirmed" }),
    finding({ id: "f2", severity: "low", category: "architecture" }),
  ]),
  agent("document", [finding({ id: "f3", severity: "critical", category: "security" })]),
  // Synthesis findings are the run's conclusion, not a specialist finding.
  agent("synthesis", [finding({ id: "f-synth", severity: "info" })]),
];

describe("parseAnalysisTab", () => {
  it("accepts every declared tab", () => {
    for (const t of ANALYSIS_TABS) expect(parseAnalysisTab(t.value)).toBe(t.value);
  });

  it("falls back to the summary for a missing or unknown tab", () => {
    expect(parseAnalysisTab(null)).toBe("summary");
    expect(parseAnalysisTab(undefined)).toBe("summary");
    expect(parseAnalysisTab("constructor")).toBe("summary");
    expect(parseAnalysisTab("FINDINGS")).toBe("summary");
  });
});

describe("tabForAnchor", () => {
  it("maps the pre-tab anchors to the tab now holding their target", () => {
    expect(tabForAnchor("#approvals")).toBe("approvals");
    expect(tabForAnchor("#clarifying-questions")).toBe("questions");
  });

  it("ignores any other href", () => {
    expect(tabForAnchor(null)).toBeNull();
    expect(tabForAnchor(undefined)).toBeNull();
    expect(tabForAnchor("")).toBeNull();
    expect(tabForAnchor("#toString")).toBeNull();
    expect(tabForAnchor("https://example.com/#approvals")).toBeNull();
  });
});

describe("analysisViewHref", () => {
  it("sets a key and preserves the others", () => {
    const href = analysisViewHref("/projects/p1/analysis", new URLSearchParams("analysisId=an-1"), {
      tab: "findings",
    });
    expect(href).toBe("/projects/p1/analysis?analysisId=an-1&tab=findings");
  });

  it("replaces an existing value and removes a null one", () => {
    const cur = new URLSearchParams("analysisId=an-1&tab=findings");
    expect(analysisViewHref("/a", cur, { tab: "questions" })).toBe(
      "/a?analysisId=an-1&tab=questions",
    );
    expect(analysisViewHref("/a", cur, { tab: null, analysisId: null })).toBe("/a");
  });

  it("tolerates having no current params", () => {
    expect(analysisViewHref("/a", null, { analysisId: "x y" })).toBe("/a?analysisId=x+y");
  });
});

describe("collectFindings / filterFindings / findingFacets", () => {
  const all = collectFindings({ agentResults: AGENTS });

  it("tags each specialist finding with its agent and drops synthesis", () => {
    expect(all.map((f) => [f.id, f.agentKey])).toEqual([
      ["f1", "code"],
      ["f2", "code"],
      ["f3", "document"],
    ]);
  });

  it("applies no filter by default", () => {
    expect(filterFindings(all, NO_FINDING_FILTERS)).toHaveLength(3);
  });

  it("filters on each facet independently and in combination", () => {
    const ids = (xs: AgentFinding[]) => xs.map((f) => f.id);
    expect(ids(filterFindings(all, { ...NO_FINDING_FILTERS, severity: "high" }))).toEqual(["f1"]);
    expect(ids(filterFindings(all, { ...NO_FINDING_FILTERS, category: "security" }))).toEqual([
      "f1",
      "f3",
    ]);
    expect(ids(filterFindings(all, { ...NO_FINDING_FILTERS, agentKey: "document" }))).toEqual([
      "f3",
    ]);
    expect(ids(filterFindings(all, { ...NO_FINDING_FILTERS, verification: "confirmed" }))).toEqual([
      "f1",
    ]);
    expect(
      ids(filterFindings(all, { ...NO_FINDING_FILTERS, category: "security", agentKey: "code" })),
    ).toEqual(["f1"]);
  });

  it("offers only values present in the run, severities by rank", () => {
    const facets = findingFacets([
      ...all,
      { ...all[0], id: "f4", severity: "info" },
      { ...all[0], id: "f5", severity: "zzz-custom" },
      { ...all[0], id: "f6", severity: "aaa-custom" },
    ]);
    expect(facets.severities).toEqual([
      "critical",
      "high",
      "low",
      "info",
      "aaa-custom",
      "zzz-custom",
    ]);
    expect(facets.categories).toEqual(["architecture", "security"]);
    expect(facets.agents).toEqual(["code", "document"]);
  });
});

describe("paginate", () => {
  const items = Array.from({ length: 45 }, (_, i) => i);

  it("slices one page and reports the range", () => {
    const p = paginate(items, 1, 20);
    expect(p.items).toEqual(items.slice(20, 40));
    expect(p).toMatchObject({ page: 1, pageCount: 3, total: 45, from: 21, to: 40 });
  });

  it("returns a short last page", () => {
    const p = paginate(items, 2, 20);
    expect(p.items).toEqual([40, 41, 42, 43, 44]);
    expect(p).toMatchObject({ from: 41, to: 45 });
  });

  it("clamps an out-of-range page (e.g. after a filter shrinks the list)", () => {
    expect(paginate(items, 9, 20).page).toBe(2);
    expect(paginate(items, -3, 20).page).toBe(0);
  });

  it("reports one empty page for an empty list", () => {
    expect(paginate([], 0, 20)).toEqual({
      items: [],
      page: 0,
      pageCount: 1,
      total: 0,
      from: 0,
      to: 0,
    });
  });
});

describe("analysisTabCounts", () => {
  const base = { agentResults: AGENTS, requirements: [{}, {}] as never[], metadata: null };

  it("counts requirements, specialist findings and agents", () => {
    expect(analysisTabCounts(base, undefined)).toEqual({
      requirements: 2,
      findings: 3,
      questions: undefined,
      approvals: undefined,
      agents: 3,
    });
  });

  it("counts OUTSTANDING questions and approvals", () => {
    const counts = analysisTabCounts(
      {
        ...base,
        metadata: {
          enhancement: { enableClarification: true, enableWebResearch: false },
          structuredRequirements: { requirements: [], totalAmbiguities: 14, totalEvidenceNeeds: 0 },
        },
      },
      { allowed: false, pendingCount: 12, rejectedCount: 1 },
    );
    expect(counts.questions).toBe(14);
    expect(counts.approvals).toBe(12);
  });

  it("reads zero open questions when clarification ran but found none", () => {
    const counts = analysisTabCounts(
      {
        ...base,
        metadata: { enhancement: { enableClarification: true, enableWebResearch: false } },
      },
      undefined,
    );
    expect(counts.questions).toBe(0);
  });
});

describe("runHasQuestionsView / tabCountLabel", () => {
  it("is true when either enhancement ran", () => {
    expect(runHasQuestionsView(null)).toBe(false);
    expect(runHasQuestionsView({})).toBe(false);
    expect(
      runHasQuestionsView({ enhancement: { enableClarification: false, enableWebResearch: true } }),
    ).toBe(true);
    expect(
      runHasQuestionsView({ enhancement: { enableClarification: true, enableWebResearch: false } }),
    ).toBe(true);
  });

  it("words outstanding counts", () => {
    expect(tabCountLabel("questions", 3)).toBe("3 open");
    expect(tabCountLabel("approvals", 2)).toBe("2 pending");
    expect(tabCountLabel("findings", 29)).toBe("29");
  });
});
