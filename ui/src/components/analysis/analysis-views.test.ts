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
  findingFiltersParams,
  NO_FINDING_FILTERS,
  paginate,
  parseAnalysisTab,
  parseFindingFilters,
  requirementPage,
  sameFindingFilters,
  traceabilityPendingMessage,
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

// Issue #424 — the findings filters live in the URL so a filtered view can be shared.
describe("parseFindingFilters / findingFiltersParams", () => {
  it("reads every facet from the query string", () => {
    expect(
      parseFindingFilters(
        new URLSearchParams(
          "tab=findings&severity=high&category=security&agent=code&verification=confirmed",
        ),
      ),
    ).toEqual({
      severity: "high",
      category: "security",
      agentKey: "code",
      verification: "confirmed",
    });
  });

  it("is no filter at all for an empty or missing query string", () => {
    expect(parseFindingFilters(new URLSearchParams())).toEqual(NO_FINDING_FILTERS);
    expect(parseFindingFilters(null)).toEqual(NO_FINDING_FILTERS);
  });

  it("treats an empty value as no filter", () => {
    expect(parseFindingFilters(new URLSearchParams("severity=&agent="))).toEqual(
      NO_FINDING_FILTERS,
    );
  });

  it("ignores a verification value the filter bar cannot show", () => {
    expect(parseFindingFilters(new URLSearchParams("verification=bogus")).verification).toBeNull();
    expect(parseFindingFilters(new URLSearchParams("verification=unverified")).verification).toBe(
      "unverified",
    );
  });

  it("writes a set facet and removes an unset one", () => {
    expect(
      findingFiltersParams({ ...NO_FINDING_FILTERS, severity: "low", agentKey: "document" }),
    ).toEqual({ severity: "low", category: null, agent: "document", verification: null });
  });

  it("round-trips through analysisViewHref", () => {
    const f = {
      severity: "critical",
      category: "a b&c",
      agentKey: "web",
      verification: "confirmed" as const,
    };
    const href = analysisViewHref(
      "/p",
      new URLSearchParams("tab=findings"),
      findingFiltersParams(f),
    );
    expect(parseFindingFilters(new URLSearchParams(href.split("?")[1]))).toEqual(f);
    expect(
      analysisViewHref(
        "/p",
        new URLSearchParams(href.split("?")[1]),
        findingFiltersParams(NO_FINDING_FILTERS),
      ),
    ).toBe("/p?tab=findings");
  });
});

// Issue #424 — a deep link to a requirement opens the page that holds it.
describe("requirementPage", () => {
  const reqs = Array.from({ length: 12 }, (_, i) => ({ id: `r-${i}` }));

  it("is the zero-based page holding the requirement", () => {
    expect(requirementPage(reqs, "r-0", 5)).toBe(0);
    expect(requirementPage(reqs, "r-4", 5)).toBe(0);
    expect(requirementPage(reqs, "r-5", 5)).toBe(1);
    expect(requirementPage(reqs, "r-11", 5)).toBe(2);
  });

  it("is null for a requirement the list does not hold", () => {
    expect(requirementPage(reqs, "elsewhere", 5)).toBeNull();
    expect(requirementPage([], "r-0", 5)).toBeNull();
  });
});

// Issue #424 — the Traceability tab says why it is empty instead of rendering nothing.
describe("traceabilityPendingMessage", () => {
  it("is null once the run completed", () => {
    expect(traceabilityPendingMessage("completed")).toBeNull();
  });

  it("says a running or queued run has no traceability yet", () => {
    expect(traceabilityPendingMessage("running")).toMatch(/when the run completes/);
    expect(traceabilityPendingMessage("pending")).toMatch(/when the run completes/);
  });

  it("says a run that did not complete has none", () => {
    expect(traceabilityPendingMessage("failed")).toMatch(/did not complete/);
    expect(traceabilityPendingMessage("cancelled")).toMatch(/did not complete/);
  });
});

// Issue #476 — the URL's filters are compared with the shown ones, so the
// page's own write echoing back is not mistaken for a navigation.
describe("sameFindingFilters", () => {
  it("is true for equal filters, whatever object holds them", () => {
    expect(sameFindingFilters(NO_FINDING_FILTERS, { ...NO_FINDING_FILTERS })).toBe(true);
    expect(
      sameFindingFilters(parseFindingFilters(new URLSearchParams("severity=high&agent=code")), {
        ...NO_FINDING_FILTERS,
        agentKey: "code",
        severity: "high",
      }),
    ).toBe(true);
  });

  it.each([
    ["severity", { severity: "high" }],
    ["category", { category: "security" }],
    ["agentKey", { agentKey: "code" }],
    ["verification", { verification: "confirmed" as const }],
  ])("is false when %s differs", (_facet, over) => {
    expect(sameFindingFilters(NO_FINDING_FILTERS, { ...NO_FINDING_FILTERS, ...over })).toBe(false);
  });
});
