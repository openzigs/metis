/**
 * Unit tests for the #744 analysis export serializers (PURE).
 *
 * Focus: acceptance-criteria checklist structure, the GitHub issue-draft shape,
 * adversarial-input sanitization (HTML injection + markdown-structure breakout),
 * empty/missing fields, and the combined analysis-report stitching (reusing the
 * #737 matrix serializer). No I/O, no LLM — plain objects in, strings out.
 */
import { describe, it, expect } from "vitest";
import type {
  CodeCitation,
  FindingIssueDraft,
  GapReport,
  GapReportDatabaseChange,
  GapReportRequirement,
  ImpactAffectedSymbolView,
  ImpactAffectedTableView,
  ImpactAnalysisDetail,
  ImpactItemView,
  SqlLineageCoverage,
  TraceabilityMatrix,
} from "@metis/shared";
import {
  buildFindingIssueDraft,
  mdBlock,
  mdInline,
  serializeAnalysisReportMarkdown,
  serializeFindingIssueDraftMarkdown,
  serializeImpactAnalysisMarkdown,
} from "./analysis-export.js";

function draft(overrides: Partial<FindingIssueDraft> = {}): FindingIssueDraft {
  return {
    title: "Add rate limiting to the login endpoint",
    problemStatement: "The login endpoint has no throttling.\nBrute force is possible.",
    affected: {
      files: ["server/src/routes/auth.ts"],
      requirementIds: ["REQ-1"],
    },
    acceptanceCriteria: [
      "Login is limited to 5 attempts per minute per IP",
      "A 429 is returned when the limit is exceeded",
    ],
    suggestedLabels: ["security", "backend"],
    ...overrides,
  };
}

describe("mdInline", () => {
  it("collapses newlines and tabs to a single space so lists cannot break out", () => {
    expect(mdInline("line one\nline two\tthree")).toBe("line one line two three");
  });

  it("HTML-escapes angle brackets and ampersands (OWASP output handling)", () => {
    expect(mdInline("<img src=x onerror=alert(1)>")).toBe("&lt;img src=x onerror=alert(1)&gt;");
    expect(mdInline("a & b")).toBe("a &amp; b");
  });

  it("trims surrounding whitespace", () => {
    expect(mdInline("  hi  ")).toBe("hi");
  });
});

describe("mdBlock", () => {
  it("preserves line breaks but escapes each line", () => {
    expect(mdBlock("a <b>\nc & d")).toBe("a &lt;b&gt;\nc &amp; d");
  });
});

describe("buildFindingIssueDraft", () => {
  it("renders acceptance criteria as an unchecked GitHub task list", () => {
    const { body } = buildFindingIssueDraft(draft());
    expect(body).toContain("## Acceptance criteria");
    expect(body).toContain("- [ ] Login is limited to 5 attempts per minute per IP");
    expect(body).toContain("- [ ] A 429 is returned when the limit is exceeded");
  });

  it("includes problem statement, affected files, requirements, and labels", () => {
    const { title, body, labels } = buildFindingIssueDraft(draft());
    expect(title).toBe("Add rate limiting to the login endpoint");
    expect(body).toContain("## Problem statement");
    expect(body).toContain("The login endpoint has no throttling.");
    expect(body).toContain("## Affected files");
    expect(body).toContain("`server/src/routes/auth.ts`");
    expect(body).toContain("## Related requirements");
    expect(body).toContain("`REQ-1`");
    expect(body).toContain("## Suggested labels");
    expect(body).toContain("`security`");
    expect(labels).toEqual(["security", "backend"]);
  });

  it("renders explicit empty markers when collections are empty", () => {
    const { body, labels } = buildFindingIssueDraft(
      draft({
        acceptanceCriteria: [],
        affected: { files: [], requirementIds: [] },
        suggestedLabels: [],
      }),
    );
    // Every section still present, each with the empty marker.
    expect(body).toContain("## Acceptance criteria\n\n_None._");
    expect(body).toContain("## Affected files\n\n_None._");
    expect(body).toContain("## Related requirements\n\n_None._");
    expect(body).toContain("## Suggested labels\n\n_None._");
    expect(labels).toEqual([]);
  });

  it("neutralizes HTML injection in the title and acceptance criteria", () => {
    const { title, body } = buildFindingIssueDraft(
      draft({
        title: "<script>alert(1)</script>",
        acceptanceCriteria: ["Given <b>x</b>, when y, then z"],
      }),
    );
    expect(title).toBe("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(title).not.toContain("<script>");
    expect(body).toContain("- [ ] Given &lt;b&gt;x&lt;/b&gt;, when y, then z");
  });

  it("prevents a newline in an acceptance criterion from injecting a second list item", () => {
    const { body } = buildFindingIssueDraft(
      draft({ acceptanceCriteria: ["first\n- [ ] injected admin task"] }),
    );
    // The whole malicious value stays on ONE checklist line (newline collapsed),
    // so the injected task never starts its own line.
    expect(body).toContain("- [ ] first - [ ] injected admin task");
    expect(body).not.toContain("\n- [ ] injected admin task");
  });

  it("does not mutate the input draft", () => {
    const input = draft();
    const labelsRef = input.suggestedLabels;
    const out = buildFindingIssueDraft(input);
    out.labels.push("mutated");
    expect(labelsRef).toEqual(["security", "backend"]);
  });
});

describe("serializeFindingIssueDraftMarkdown", () => {
  it("prefixes the sanitized title as an H1 and ends with a newline", () => {
    const md = serializeFindingIssueDraftMarkdown(draft());
    expect(md.startsWith("# Add rate limiting to the login endpoint\n\n")).toBe(true);
    expect(md.endsWith("\n")).toBe(true);
    expect(md).toContain("## Acceptance criteria");
  });
});

// ── Combined analysis report ────────────────────────────────────────────────

function codeCitation(overrides: Partial<CodeCitation> = {}): CodeCitation {
  return {
    filePath: "server/src/routes/auth.ts",
    startLine: 10,
    endLine: 20,
    ...overrides,
  };
}

function gapReq(overrides: Partial<GapReportRequirement> = {}): GapReportRequirement {
  return {
    requirementId: "req-1",
    title: "Rate limit login",
    body: "Login must be throttled.",
    priority: "high",
    coverage: "grounded_in_code",
    verdict: "gap-confirmed",
    storyPoints: 3,
    verificationStatus: "confirmed",
    currentImplementation: {
      hasEvidence: true,
      citations: [codeCitation()],
      citedFindingCount: 1,
    },
    gapFindings: [
      {
        id: "f-1",
        title: "No throttling middleware",
        body: "The route lacks a limiter.",
        severity: "high",
        verificationStatus: "confirmed",
        verdict: "gap-confirmed",
        citations: [codeCitation({ startLine: 5, endLine: 5 })],
      },
    ],
    unverifiedFindings: [],
    noEvidence: false,
    ...overrides,
  };
}

function gapReport(
  reqs: GapReportRequirement[],
  retrieval: GapReport["retrieval"] = null,
): GapReport {
  return { analysisId: "a-1", projectId: "p-1", requirements: reqs, retrieval };
}

function matrix(): TraceabilityMatrix {
  return {
    analysisId: "a-1",
    projectId: "p-1",
    testsDetection: "heuristic",
    rows: [
      {
        requirementId: "req-1",
        title: "Rate limit login",
        coverage: "grounded_in_code",
        verdict: "gap-confirmed",
        findings: [{ id: "f-1", title: "No throttling middleware", severity: "high" }],
        codeLocations: [
          {
            filePath: "server/src/routes/auth.ts",
            startLine: 10,
            endLine: 20,
            source: "citation",
          },
        ],
        tests: [],
      },
    ],
  };
}

describe("serializeAnalysisReportMarkdown", () => {
  it("stitches coverage summary, per-requirement gaps, and the #737 matrix table", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq()]),
      matrix: matrix(),
    });
    expect(md).toContain("# Analysis report");
    expect(md).toContain("1 requirement (Grounded in code: 1)");
    expect(md).toContain("# Gap report");
    expect(md).toContain("## Rate limit login");
    expect(md).toContain("**Effort:** 3 story points");
    expect(md).toContain("**Coverage:** Grounded in code");
    // Citations preserved as filePath:startLine-endLine text.
    expect(md).toContain("`server/src/routes/auth.ts:10-20`");
    // The #737 matrix serializer output is embedded verbatim (table header).
    expect(md).toContain("# Traceability matrix");
    expect(md).toContain(
      "| Requirement | Verdict | Coverage | Findings | Code locations | Tests |",
    );
    // Issue #773 — the verdict leads the requirement's metadata: it is the line a
    // BA acts on, and "gap confirmed" is the ONLY one that licenses building.
    expect(md).toContain("**Verdict:** Gap confirmed");
  });

  it("renders the no-evidence marker and 'Unestimated' effort honestly", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([
        gapReq({
          storyPoints: null,
          coverage: "no_evidence",
          currentImplementation: { hasEvidence: false, citations: [], citedFindingCount: 0 },
          noEvidence: true,
          gapFindings: [],
        }),
      ]),
      matrix: matrix(),
    });
    expect(md).toContain("**Effort:** Unestimated");
    expect(md).toContain("_No source evidence was linked");
    expect(md).toContain("_No gap findings were linked");
  });

  it("handles an empty gap report without throwing", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([]),
      matrix: { ...matrix(), rows: [] },
    });
    expect(md).toContain("_No requirements to report on._");
    expect(md).toContain("0 requirements");
  });

  it("renders unclassified coverage, a '—' verification, and a citation-less gap finding", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([
        gapReq({
          coverage: null,
          verificationStatus: null,
          gapFindings: [
            {
              id: "f-2",
              title: "Undocumented behaviour",
              body: "No test asserts the limit.",
              severity: "low",
              verificationStatus: null,
              verdict: null,
              citations: [],
            },
          ],
        }),
      ]),
      matrix: matrix(),
    });
    expect(md).toContain("**Coverage:** Unclassified");
    expect(md).toContain("**Verification:** —");
    expect(md).toContain("**Undocumented behaviour** (low)");
  });

  it("sanitizes a malicious requirement title in the report", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq({ title: "<img src=x onerror=alert(1)>" })]),
      matrix: matrix(),
    });
    expect(md).toContain("## &lt;img src=x onerror=alert(1)&gt;");
    expect(md).not.toContain("<img src=x");
  });
});

/**
 * Issue #773 — the exported report is one of the surfaces that flattened "we could
 * not check" into "you must build this" (it renders finding bodies verbatim as the
 * gap narrative). These tests pin the separation.
 */
describe("#773 — could-not-verify is never exported as a gap", () => {
  it("renders unverifiable findings in their own block, NOT under 'Gap'", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([
        gapReq({
          verdict: "could-not-verify",
          gapFindings: [],
          unverifiedFindings: [
            {
              id: "f-9",
              title: "Could not verify: commit-SHA baselining (REQ-002)",
              body: "Searches for baseline/commit SHA returned no usable results.",
              severity: "info",
              verificationStatus: "could-not-verify",
              verdict: "could-not-verify",
              citations: [],
            },
          ],
        }),
      ]),
      matrix: matrix(),
    });
    expect(md).toContain("### Could not verify (NOT confirmed gaps)");
    expect(md).toContain("**Verdict:** Could not verify — NOT a confirmed gap");
    expect(md).toContain("do NOT treat them as confirmed gaps");
    // The narrative appears under the could-not-verify heading, never the Gap one.
    const gapSection = md.slice(md.indexOf("### Gap"), md.indexOf("### Could not verify"));
    expect(gapSection).toContain("_No gap findings were linked to this requirement._");
    expect(gapSection).not.toContain("commit-SHA baselining");
  });

  it("warns at the top of the document when the run's retrieval was degraded", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq()], {
        successfulSearches: 0,
        failedSearches: 6,
        erroredCalls: 6,
        totalCalls: 6,
        requirementCount: 12,
        starved: true,
        // #1236 — "cut short by its budget" is the EXHAUSTED signal, not the starved
        // one. This run was both: every call errored AND the budget ran out.
        exhausted: true,
        degraded: true,
        searchedScope: [],
      }),
      matrix: matrix(),
    });
    expect(md).toContain("Code search returned little usable evidence on this run");
    expect(md).toContain("cut short by its budget");
  });

  it("omits the budget wording for a degraded run that was NOT cut short (#1236)", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq()], {
        successfulSearches: 0,
        failedSearches: 6,
        erroredCalls: 6,
        totalCalls: 6,
        requirementCount: 12,
        starved: true,
        degraded: true,
        searchedScope: [],
      }),
      matrix: matrix(),
    });
    expect(md).toContain("Code search returned little usable evidence on this run");
    expect(md).not.toContain("cut short by its budget");
  });

  it("adds no warning to a healthy run", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq()], {
        successfulSearches: 8,
        failedSearches: 1,
        erroredCalls: 0,
        totalCalls: 9,
        requirementCount: 3,
        starved: false,
        degraded: false,
        searchedScope: [],
      }),
      matrix: matrix(),
    });
    expect(md).not.toContain("Code search returned little usable evidence");
  });

  /**
   * Issue #773 — the exported markdown is the artifact a BA actually circulates and
   * plans from. The searched scope was persisted and rendered in the UI but ABSENT
   * here, which put every `gap-confirmed` in the exported document back to being
   * judgement-by-vibes: a gap is only ever a gap relative to what was searched.
   */
  it("exports the SEARCHED SCOPE that backs (or fails to back) each gap", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq()], {
        successfulSearches: 1,
        failedSearches: 2,
        erroredCalls: 1,
        totalCalls: 3,
        requirementCount: 4,
        starved: false,
        degraded: false,
        searchedScope: [
          { tool: "search_code_graph", query: "drift severity", hit: true },
          { tool: "search_code_symbols", query: "commit-sha baseline", hit: false },
          { tool: "read_file_slice", query: "src/foo.ts", hit: false, errored: true },
        ],
      }),
      matrix: matrix(),
    });
    expect(md).toContain("# Searched scope");
    expect(md).toContain("3 call(s) across 4 requirement(s) — 1 returned results, 1 errored");
    expect(md).toContain("drift severity");
    expect(md).toContain("— hit");
    expect(md).toContain("— no results");
    expect(md).toContain("— errored");
  });

  it("says so explicitly when the code agent ran no retrieval at all", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq()], {
        successfulSearches: 0,
        failedSearches: 0,
        erroredCalls: 0,
        totalCalls: 0,
        requirementCount: 4,
        starved: false,
        degraded: true,
        searchedScope: [],
      }),
      matrix: matrix(),
    });
    expect(md).toContain("ran no retrieval calls on this run");
  });
});

/**
 * Issue #825 — the DATABASE replay of the gap section: affected tables/columns
 * with their suggested DDL (TEXT ONLY, review-only), risk class, and
 * cross-project consumers. These pin the safety-critical rendering rules:
 * suggested DDL always carries the "never executed" label; an identity-unresolved
 * object is never flattened into "no consumers"; and speculative (unreconciled)
 * objects are separated from confirmed schema facts.
 */
function dbChange(overrides: Partial<GapReportDatabaseChange> = {}): GapReportDatabaseChange {
  return {
    tableName: "public.orders",
    columnName: "status",
    changeKind: "add-column",
    reconciliation: "matched",
    confidence: 0.85,
    suggestedDdl: "ALTER TABLE public.orders ADD COLUMN status text;",
    identityResolved: true,
    consumers: [
      {
        projectId: "p-2",
        projectName: "billing",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ],
    ...overrides,
  };
}

describe("serializeAnalysisReportMarkdown — database changes (#825)", () => {
  it("renders the section with the mandatory review-only DDL label and a consumer", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq({ databaseChanges: [dbChange()] })]),
      matrix: matrix(),
    });
    expect(md).toContain("### Database changes (suggested DDL — review only, never executed)");
    expect(md).toContain("**public.orders.status**");
    expect(md).toContain("add-column");
    expect(md).toContain("matched against live schema");
    expect(md).toContain("confidence 0.85");
    // Suggested DDL rendered inert, and always behind the section's never-executed label.
    expect(md).toContain("`ALTER TABLE public.orders ADD COLUMN status text;`");
    // Resolved identity with a consumer → the consumer is listed with its access verb.
    expect(md).toContain("Consumers: billing (reads)");
  });

  it("omits the section entirely when a requirement has no schema impact", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq()]),
      matrix: matrix(),
    });
    expect(md).not.toContain("### Database changes");
  });

  it("defaults an unclassified risk and includes it in the row", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq({ databaseChanges: [dbChange()] })]),
      matrix: matrix(),
    });
    expect(md).toContain("risk: unclassified");
    expect(md).not.toContain("risk: neutral");
  });

  it("renders a populated risk class when 3a/3b has classified it, using the shared human label (#991)", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq({ databaseChanges: [dbChange({ riskClass: "breaking" })] })]),
      matrix: matrix(),
    });
    // #991 — gap-report bullets render the shared DDL_RISK_LABEL (@metis/shared)
    // instead of leaking the raw `breaking` enum value.
    expect(md).toContain("risk: Needs review");
    expect(md).not.toContain("risk: breaking");
  });

  it("surfaces the #831 CRITICAL marker for a cross-project breaking change", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([
        gapReq({
          databaseChanges: [dbChange({ riskClass: "breaking", crossProjectBreaking: true })],
        }),
      ]),
      matrix: matrix(),
    });
    expect(md).toContain(
      "CRITICAL — breaking change to a shared object with cross-project consumers",
    );
    // The grounding consumer list is still rendered alongside the escalation.
    expect(md).toContain("Consumers: billing (reads)");
  });

  it("omits the CRITICAL marker for an ordinary (non-escalated) change", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([gapReq({ databaseChanges: [dbChange({ riskClass: "breaking" })] })]),
      matrix: matrix(),
    });
    expect(md).not.toContain("CRITICAL");
  });

  it("renders resolved-with-zero-consumers DISTINCTLY from identity-unresolved", () => {
    const resolvedEmpty = serializeAnalysisReportMarkdown({
      gapReport: gapReport([
        gapReq({ databaseChanges: [dbChange({ identityResolved: true, consumers: [] })] }),
      ]),
      matrix: matrix(),
    });
    expect(resolvedEmpty).toContain(
      "No other project in this workspace reads or writes this object",
    );
    expect(resolvedEmpty).not.toContain("Cross-project impact unknown");

    const unresolved = serializeAnalysisReportMarkdown({
      gapReport: gapReport([
        gapReq({ databaseChanges: [dbChange({ identityResolved: false, consumers: undefined })] }),
      ]),
      matrix: matrix(),
    });
    expect(unresolved).toContain("Cross-project impact unknown (database identity unresolved)");
    // The unresolved object must NEVER claim there are no consumers.
    expect(unresolved).not.toContain("No other project in this workspace");
  });

  it("separates unreconciled (speculative) objects under an explicit unverified subheading", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([
        gapReq({
          databaseChanges: [
            dbChange({
              tableName: "public.orders",
              columnName: "status",
              reconciliation: "matched",
            }),
            dbChange({
              tableName: "public.ghost",
              columnName: null,
              reconciliation: "table-not-found",
              changeKind: "add-table",
              suggestedDdl: "-- CREATE TABLE public.ghost ( ... );",
              identityResolved: false,
              consumers: undefined,
            }),
          ],
        }),
      ]),
      matrix: matrix(),
    });
    expect(md).toContain("#### Unverified against live schema");
    expect(md).toContain("treat them as speculative, not confirmed schema facts");
    // The speculative object appears AFTER the unverified subheading, not before it.
    const unverifiedIdx = md.indexOf("#### Unverified against live schema");
    expect(md.indexOf("public.ghost")).toBeGreaterThan(unverifiedIdx);
    // The reconciled object appears BEFORE the unverified subheading.
    expect(md.indexOf("public.orders.status")).toBeLessThan(unverifiedIdx);
  });

  it("sanitizes a malicious consumer project name so it cannot inject markup", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: gapReport([
        gapReq({
          databaseChanges: [
            dbChange({
              consumers: [
                {
                  projectId: "p-x",
                  projectName: "<img src=x onerror=alert(1)>",
                  usage: "writtenBy",
                  objectQualifiedName: "public.orders",
                },
              ],
            }),
          ],
        }),
      ]),
      matrix: matrix(),
    });
    expect(md).toContain("&lt;img src=x onerror=alert(1)&gt; (writes)");
    expect(md).not.toContain("<img src=x");
  });
});

describe("serializeAnalysisReportMarkdown — SQL-lineage coverage (#895)", () => {
  function coverage(overrides: Partial<SqlLineageCoverage> = {}): SqlLineageCoverage {
    return {
      totalEdges: 4,
      resolvedEdges: 3,
      unresolvedEdges: 1,
      coveragePercent: 75,
      bySource: {
        sqlglot: { total: 2, unresolved: 0 },
        mybatis: { total: 1, unresolved: 1 },
        "catalog-deps": { total: 1, unresolved: 0 },
      },
      unresolvedRefs: [
        {
          edgeId: "e1",
          kind: "reads",
          source: "mybatis",
          reason: "dynamic",
          filePath: "src/M.xml",
          toQualifiedName: "?dynamic:tableName",
          placeholder: "tableName",
          statementId: "M.find",
          mapper: "com.acme.M",
        },
      ],
      ...overrides,
    };
  }

  function reportWithCoverage(cov: SqlLineageCoverage | null): GapReport {
    return { ...gapReport([gapReq()]), sqlLineageCoverage: cov };
  }

  it("surfaces the unresolved percentage as the actionable inverse of resolved", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: reportWithCoverage(coverage()),
      matrix: matrix(),
    });
    expect(md).toContain("# SQL-lineage coverage");
    expect(md).toContain(
      "25% of table edges are dynamically resolved and need manual confirmation (1 of 4 edges; 75% resolved precisely)",
    );
  });

  it("lists the per-source unresolved breakdown and the drillable edge with its reason", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: reportWithCoverage(coverage()),
      matrix: matrix(),
    });
    expect(md).toContain("## Unresolved by source");
    expect(md).toContain("`mybatis`: 1 of 1 unresolved");
    expect(md).toContain("## Edges needing manual confirmation");
    expect(md).toContain("`src/M.xml`");
    expect(md).toContain("dynamic (runtime-built SQL");
    expect(md).toContain("`tableName`");
  });

  it("labels a coarse Tier-1 catalog edge distinctly from a dynamic one", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: reportWithCoverage(
        coverage({
          unresolvedRefs: [
            {
              edgeId: "e2",
              kind: "calls",
              source: "catalog-deps",
              reason: "coarse-catalog",
              filePath: "<oracle-all-dependencies>",
              toQualifiedName: "app.audit",
              placeholder: null,
              statementId: null,
              mapper: null,
            },
          ],
        }),
      ),
      matrix: matrix(),
    });
    expect(md).toContain("coarse Tier-1 catalog dependency (object-level only, direction unknown)");
  });

  it("notes when more unresolved edges exist than the listed sample", () => {
    const md = serializeAnalysisReportMarkdown({
      gapReport: reportWithCoverage(coverage({ unresolvedEdges: 5 })),
      matrix: matrix(),
    });
    expect(md).toContain("4 more unresolved edge(s) not listed");
  });

  it("omits the section entirely when coverage is null or has zero edges", () => {
    const mdNull = serializeAnalysisReportMarkdown({
      gapReport: reportWithCoverage(null),
      matrix: matrix(),
    });
    expect(mdNull).not.toContain("# SQL-lineage coverage");

    const mdEmpty = serializeAnalysisReportMarkdown({
      gapReport: reportWithCoverage(
        coverage({
          totalEdges: 0,
          resolvedEdges: 0,
          unresolvedEdges: 0,
          coveragePercent: null,
          bySource: {},
          unresolvedRefs: [],
        }),
      ),
      matrix: matrix(),
    });
    expect(mdEmpty).not.toContain("# SQL-lineage coverage");
  });
});

// ── #963 — impact analysis markdown export ──────────────────────────────────

function impactSymbol(overrides: Partial<ImpactAffectedSymbolView> = {}): ImpactAffectedSymbolView {
  return {
    id: "sym-1",
    codeSymbolId: "cs-1",
    filePath: "src/orders/service.ts",
    qualifiedName: "OrderService.place",
    startLine: 10,
    endLine: 42,
    relation: "direct",
    depth: 0,
    confidence: 0.91,
    ...overrides,
  };
}

function impactTable(overrides: Partial<ImpactAffectedTableView> = {}): ImpactAffectedTableView {
  return {
    id: "tbl-1",
    objectKind: "table",
    tableName: "orders",
    columnName: null,
    columnType: null,
    changeKind: "add-column",
    suggestedDdl: "ALTER TABLE orders ADD COLUMN status TEXT;",
    source: "live-db",
    reconciliation: "matched",
    confidence: 0.8,
    relevanceTier: "likely",
    relevanceRationale: "Directly referenced by the changed requirement.",
    consumerResolution: "identity",
    consumers: [
      {
        projectId: "project-002",
        projectName: "Beta",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ],
    ...overrides,
  };
}

function impactItem(overrides: Partial<ImpactItemView> = {}): ImpactItemView {
  return {
    id: "item-1",
    projectId: "project-001",
    requirementId: "req-1",
    requirementTitle: "Track order status",
    changeType: "modified",
    severity: "high",
    impactScore: 0.72,
    confidence: 0.65,
    affectedFileCount: 2,
    affectedSymbolCount: 4,
    summary: "Adds a status column and touches the order placement path.",
    affectedSymbols: [impactSymbol()],
    affectedTables: [impactTable()],
    affectedTablesSecondary: [],
    affectedTests: [],
    writePathGaps: [],
    feedback: [],
    ...overrides,
  };
}

function impactDetail(overrides: Partial<ImpactAnalysisDetail> = {}): ImpactAnalysisDetail {
  return {
    id: "ia-1",
    status: "completed",
    documentId: null,
    sourceText: "Add order status tracking.",
    summary: "One requirement change impacts two projects.",
    errorMessage: null,
    totalImpactedSymbols: 4,
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:01:00.000Z",
    projectIds: ["project-001", "project-002"],
    startedById: "user-1",
    items: [impactItem()],
    sharedTableImpacts: [],
    ...overrides,
  };
}

describe("serializeImpactAnalysisMarkdown (#963)", () => {
  it("renders the run summary, narrative, tables (tier + rationale + DDL), symbols, and consumers", () => {
    const md = serializeImpactAnalysisMarkdown(impactDetail(), {
      projectNames: { "project-001": "Alpha", "project-002": "Beta" },
    });
    // Header + run summary line + run narrative.
    expect(md).toContain("# Impact analysis");
    expect(md).toContain("Status: completed · 2 project(s) · 4 impacted symbol(s)");
    expect(md).toContain("One requirement change impacts two projects.");
    // Project section uses the display name.
    expect(md).toContain("## Project: Alpha");
    // Per-item heading + narrative.
    expect(md).toContain("### Track order status — modified · severity high");
    expect(md).toContain("Adds a status column and touches the order placement path.");
    // Metadata line.
    expect(md).toContain("**Impact score:** 0.72");
    // Likely table with tier + rationale + DDL + consumers.
    expect(md).toContain("#### Likely / possibly-related tables");
    expect(md).toContain("relevance: likely related");
    expect(md).toContain("Rationale: Directly referenced by the changed requirement.");
    expect(md).toContain("Suggested DDL (review only, never executed):");
    expect(md).toContain("Consumers: Beta (reads)");
    // Affected code.
    expect(md).toContain("#### Affected code");
    expect(md).toContain("src/orders/service.ts:10-42");
    expect(md).toContain("OrderService.place");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("is deterministic — identical input yields byte-identical output", () => {
    const a = serializeImpactAnalysisMarkdown(impactDetail());
    const b = serializeImpactAnalysisMarkdown(impactDetail());
    expect(a).toEqual(b);
  });

  it("falls back to the raw project id when no display name is supplied", () => {
    const md = serializeImpactAnalysisMarkdown(impactDetail());
    expect(md).toContain("## Project: project-001");
  });

  it("renders the low-confidence secondary bucket under its own heading", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTablesSecondary: [
              impactTable({
                id: "tbl-2",
                tableName: "audit_log",
                relevanceTier: "unlikely",
                relevanceRationale: "Tangential fan-out.",
                consumerResolution: null,
                consumers: undefined,
                suggestedDdl: null,
              }),
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("#### Low-confidence tables (judged possibly unrelated)");
    expect(md).toContain("audit_log");
    expect(md).toContain("relevance: unlikely related");
  });

  it("renders the shared-table rollup for multi-project runs", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sharedTableImpacts: [{ tableName: "orders", projectIds: ["project-001", "project-002"] }],
      }),
      { projectNames: { "project-001": "Alpha", "project-002": "Beta" } },
    );
    expect(md).toContain("## Shared-table impact (across projects)");
    expect(md).toContain("**orders** — impacted in 2 projects: Alpha, Beta");
  });

  it("renders the three cross-project consumer states distinctly", () => {
    const unverifiable = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTables: [impactTable({ consumerResolution: "unverifiable", consumers: [] })],
          }),
        ],
      }),
    );
    expect(unverifiable).toContain("Cross-project consumers could not be verified.");

    const noConsumers = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTables: [impactTable({ consumerResolution: "identity", consumers: [] })],
          }),
        ],
      }),
    );
    expect(noConsumers).toContain("No other project in this workspace reads or writes this table.");

    const notComputed = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTables: [impactTable({ consumerResolution: undefined, consumers: undefined })],
          }),
        ],
      }),
    );
    expect(notComputed).not.toContain("Consumers:");
    expect(notComputed).not.toContain("could not be verified");
  });

  // Issue #982 — the DDL risk class (#957) is now exported, using the SAME
  // vocabulary as the UI risk badge.
  it("renders 'Needs review' for a breaking risk class", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [impactItem({ affectedTables: [impactTable({ riskClass: "breaking" })] })],
      }),
    );
    expect(md).toContain("risk: Needs review");
  });

  it("renders 'Additive' for expanding and 'Verify only' for neutral risk classes", () => {
    const expanding = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [impactItem({ affectedTables: [impactTable({ riskClass: "expanding" })] })],
      }),
    );
    expect(expanding).toContain("risk: Additive");

    const neutral = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [impactItem({ affectedTables: [impactTable({ riskClass: "neutral" })] })],
      }),
    );
    expect(neutral).toContain("risk: Verify only");
  });

  it("omits the risk segment when riskClass is absent (legacy rows)", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [impactItem({ affectedTables: [impactTable({ riskClass: undefined })] })],
      }),
    );
    expect(md).not.toContain("risk:");
  });

  it("renders risk before relevance, mirroring the UI badge order", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTables: [impactTable({ riskClass: "breaking", relevanceTier: "likely" })],
          }),
        ],
      }),
    );
    const riskIdx = md.indexOf("risk: Needs review");
    const relevanceIdx = md.indexOf("relevance: likely related");
    expect(riskIdx).toBeGreaterThan(-1);
    expect(relevanceIdx).toBeGreaterThan(riskIdx);
  });

  it("shows an explicit empty state when there are no impact items", () => {
    const md = serializeImpactAnalysisMarkdown(impactDetail({ items: [], projectIds: [] }));
    expect(md).toContain("_No code impact was detected for the supplied requirement change._");
    expect(md).not.toContain("## Project:");
  });

  it("surfaces the failure reason for a failed run", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({ status: "failed", errorMessage: "Provider offline", items: [] }),
    );
    expect(md).toContain("**This run failed:** Provider offline");
  });

  it("renders a column-level row with schema-qualified naming and no DDL", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTables: [
              impactTable({
                objectKind: "column",
                tableName: "orders",
                columnName: "status",
                suggestedDdl: null,
                relevanceTier: null,
                relevanceRationale: null,
                consumerResolution: undefined,
                consumers: undefined,
              }),
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("**orders.status**");
    expect(md).not.toContain("Suggested DDL");
  });

  it("neutralizes HTML / markdown-structure injection in model-supplied fields (OWASP)", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        summary: "<script>alert(1)</script>",
        items: [
          impactItem({
            requirementTitle: "Evil\n## Injected heading",
            relevanceRationale: undefined,
            affectedTables: [
              impactTable({
                suggestedDdl: "DROP TABLE users; -->\n-- comment escape",
                relevanceRationale: "line1\n- injected bullet",
              }),
            ],
          }),
        ],
      }),
    );
    // No raw <script>; angle brackets are entity-escaped.
    expect(md).not.toContain("<script>");
    expect(md).toContain("&lt;script&gt;");
    // A newline in a single-line field cannot inject a new markdown heading.
    expect(md).not.toContain("\n## Injected heading");
    // The DDL is collapsed to a single inline-code line (no newline breakout)
    // and its angle bracket is HTML-escaped so it cannot de-comment.
    expect(md).toContain("`DROP TABLE users; --&gt; -- comment escape`");
  });

  it("renders symbols without line numbers using the bare file path", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedSymbols: [impactSymbol({ startLine: null, endLine: null })],
          }),
        ],
      }),
    );
    expect(md).toContain("`src/orders/service.ts`");
    expect(md).not.toContain("service.ts:");
  });
});

// ── #1004 — requirement text, per-table grouping, write-path gaps + tests ────

/** The verbatim BA phrasing from the epic #999 walkthrough (requirement 1). */
const CANCELLATION_TEXT =
  "Customers must be able to cancel an order within 24 hours of placing it. A cancelled order must record who cancelled it and when, and every item on the cancelled order must be returned to available stock.";

/** The one rationale sentence the pre-#1004 export repeated once per column. */
const ORDERS_RATIONALE = "Order cancellation needs new actor and timestamp fields on the order.";

/** Count non-overlapping occurrences of a literal substring. */
function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) return count;
    count += 1;
    from = at + needle.length;
  }
}

/** The body of one panel, up to the next heading of any level. */
function panelBody(md: string, heading: string): string {
  const start = md.indexOf(heading);
  if (start === -1) return "";
  const after = md.slice(start + heading.length);
  const next = after.search(/\n#{2,4} /);
  return next === -1 ? after : after.slice(0, next);
}

/**
 * Unindented bullets inside the likely/possibly-related tables panel. Column
 * rows are nested (indented), so one such bullet == one TABLE.
 */
function tablePanelBullets(md: string): string[] {
  return panelBody(md, "#### Likely / possibly-related tables")
    .split("\n")
    .filter((line) => line.startsWith("- **"));
}

/**
 * The observed shape of the real JPetStore run: ONE table-level row plus many
 * verify-only column rows, every one of which carries the SAME rationale
 * sentence. Pre-#1004 this serialized to one bullet per row (27 for `orders`)
 * with the rationale repeated verbatim 27 times.
 */
function ordersTableRows(columnCount: number): ImpactAffectedTableView[] {
  const rows: ImpactAffectedTableView[] = [
    impactTable({
      id: "orders-table",
      tableName: "orders",
      columnName: null,
      changeKind: "reference",
      suggestedDdl: "-- Verify table orders",
      relevanceTier: "likely",
      relevanceRationale: ORDERS_RATIONALE,
      consumerResolution: undefined,
      consumers: undefined,
    }),
  ];
  for (let i = 1; i <= columnCount; i += 1) {
    rows.push(
      impactTable({
        id: `orders-col-${i}`,
        objectKind: "column",
        tableName: "orders",
        columnName: `col_${String(i).padStart(2, "0")}`,
        changeKind: "reference",
        suggestedDdl: `-- Verify column orders.col_${String(i).padStart(2, "0")}`,
        relevanceTier: "likely",
        relevanceRationale: ORDERS_RATIONALE,
        consumerResolution: undefined,
        consumers: undefined,
      }),
    );
  }
  return rows;
}

describe("serializeImpactAnalysisMarkdown — requirement text (#1004)", () => {
  it("exports the analysed requirement text verbatim, as a quoted block", () => {
    const md = serializeImpactAnalysisMarkdown(impactDetail({ sourceText: CANCELLATION_TEXT }));
    expect(md).toContain("## Requirement analysed");
    expect(md).toContain(`> ${CANCELLATION_TEXT}`);
  });

  it("titles a pasted-text item from its OWN persisted title, not 'Unlabelled requirement change'", () => {
    // #1013 — a pasted-text run has `requirementId === null` (no Requirement row
    // to join), but the engine now snapshots the change's title onto the item, so
    // the heading is stored data rather than something inferred from the run.
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: CANCELLATION_TEXT,
        projectIds: ["project-001"],
        items: [
          impactItem({
            requirementId: null,
            requirementTitle:
              "Customers must be able to cancel an order within 24 hours of placing it.",
          }),
        ],
      }),
    );
    expect(md).not.toContain("Unlabelled requirement change");
    expect(md).toContain(
      "### Customers must be able to cancel an order within 24 hours of placing it. — modified · severity high",
    );
  });

  it("numbers untitled LEGACY items (rows written before #1013 carry no title)", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: `${CANCELLATION_TEXT}\n\nSupport partial shipments.`,
        projectIds: ["project-001"],
        items: [
          impactItem({ id: "item-1", requirementTitle: null, requirementId: null }),
          impactItem({ id: "item-2", requirementTitle: null, requirementId: null }),
        ],
      }),
    );
    expect(md).not.toContain("Unlabelled requirement change");
    expect(md).toContain("### Requirement change 1 of 2");
    expect(md).toContain("### Requirement change 2 of 2");
  });

  it("keeps the persisted requirement title when one exists", () => {
    const md = serializeImpactAnalysisMarkdown(impactDetail({ sourceText: CANCELLATION_TEXT }));
    expect(md).toContain("### Track order status — modified · severity high");
  });

  it("falls back to the requirement id, then to the unlabelled marker, when nothing else is known", () => {
    const withId = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: null,
        items: [impactItem({ requirementTitle: null, requirementId: "req-9" })],
      }),
    );
    expect(withId).toContain("### req-9 — modified");

    const withNothing = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: null,
        items: [impactItem({ requirementTitle: null, requirementId: null })],
      }),
    );
    expect(withNothing).toContain("### Unlabelled requirement change — modified");
    expect(withNothing).not.toContain("## Requirement analysed");
  });

  it("truncates an oversized source text instead of embedding the whole document", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({ sourceText: "x".repeat(9000), items: [] }),
    );
    expect(md).toContain("(truncated");
    expect(md.length).toBeLessThan(9000);
  });

  it("quotes blank lines too, so a multi-paragraph requirement stays inside the block", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({ sourceText: "First paragraph.\n\nSecond paragraph.", items: [] }),
    );
    expect(md).toContain("> First paragraph.\n>\n> Second paragraph.");
  });

  it("quotes every line of the source text so it cannot inject document structure (OWASP)", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText:
          "# Injected requirement heading\n<img src=x onerror=alert(1)>\n- injected bullet",
        items: [],
      }),
    );
    expect(md).not.toContain("\n# Injected requirement heading");
    expect(md).toContain("> # Injected requirement heading");
    expect(md).not.toContain("<img");
    expect(md).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(md).toContain("> - injected bullet");
  });
});

/**
 * #1013 — the two mis-attribution modes that FORCED #1004's three-condition gate,
 * now asserted to produce the CORRECT per-item heading rather than a neutral one.
 *
 * #1004 could only infer a heading from run-level state (the source text), so it
 * had to refuse whenever the inference might land on the wrong item. #1013 makes
 * the title a per-item column written by the engine from the very change that
 * produced the row, so there is no inference left to get wrong: the serializer
 * reads `item.requirementTitle` and nothing else. Both shapes below are the real
 * reproductions, re-pointed at the fixed behaviour.
 */
describe("serializeImpactAnalysisMarkdown — per-item heading attribution (#1013)", () => {
  /** Three pasted requirements; the engine drops the two that hit no code. */
  const THREE_REQUIREMENT_PASTE = [
    CANCELLATION_TEXT,
    "Support partial shipments so an order can be fulfilled from two warehouses.",
    "Every line item must record the warehouse that fulfilled it.",
  ].join("\n\n");

  it("titles the SURVIVING item with its own requirement when the paste's earlier changes hit no code", () => {
    // Mode 1. `impact-analysis-engine.ts` skips any change with
    // `affectedSymbolCount === 0`, so ONE surviving item does NOT mean one pasted
    // requirement. #1004's first cut derived from the source text and stamped
    // requirement #1's sentence above requirement #3's tables and symbols; the
    // shipped gate then refused and printed `Requirement change 1 of 1`.
    // The persisted title comes from change #3 itself, so it is now correct.
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: THREE_REQUIREMENT_PASTE,
        projectIds: ["project-001"],
        items: [
          impactItem({
            id: "item-3",
            requirementId: null,
            requirementTitle: "Every line item must record the warehouse that fulfilled it.",
            summary: "Records the fulfilling warehouse on each line item.",
          }),
        ],
      }),
    );
    expect(md).toContain(
      "### Every line item must record the warehouse that fulfilled it. — modified · severity high",
    );
    // The FIRST requirement's sentence must never appear as a heading.
    expect(md).not.toContain("### Customers must be able to cancel an order");
    expect(md).not.toContain("### Requirement change 1 of 1");
    // The verbatim block (#1004) is unchanged — still the whole paste.
    expect(md).toContain("## Requirement analysed");
    expect(md).toContain(`> ${CANCELLATION_TEXT}`);
    expect(md).not.toContain("Unlabelled requirement change");
  });

  it("gives each project's item its own heading in a two-project, one-item-each run", () => {
    // Mode 2. #1004's first cut evaluated the gate PER PROJECT while the derived
    // label was run-scoped, so both projects' items were stamped with the SAME
    // first sentence. Each row now carries the title of the change that produced
    // it, so the two headings differ by construction.
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: `${CANCELLATION_TEXT}\n\nSupport partial shipments so an order can be fulfilled from two warehouses.`,
        projectIds: ["project-001", "project-002"],
        items: [
          impactItem({
            id: "item-1",
            projectId: "project-001",
            requirementId: null,
            requirementTitle:
              "Customers must be able to cancel an order within 24 hours of placing it.",
          }),
          impactItem({
            id: "item-2",
            projectId: "project-002",
            requirementId: null,
            requirementTitle:
              "Support partial shipments so an order can be fulfilled from two warehouses.",
          }),
        ],
      }),
    );
    expect(
      countOccurrences(
        md,
        "### Customers must be able to cancel an order within 24 hours of placing it.",
      ),
    ).toBe(1);
    expect(
      countOccurrences(
        md,
        "### Support partial shipments so an order can be fulfilled from two warehouses.",
      ),
    ).toBe(1);
    expect(md).not.toContain("### Requirement change");
    expect(md).not.toContain("Unlabelled requirement change");
  });

  it("titles every item of a MULTI-change single-project run distinctly", () => {
    // The case #1008 explicitly could not solve: several changes per project all
    // fell back to `Requirement change N of M`.
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: THREE_REQUIREMENT_PASTE,
        projectIds: ["project-001"],
        items: [
          impactItem({
            id: "item-1",
            requirementId: null,
            requirementTitle:
              "Customers must be able to cancel an order within 24 hours of placing it.",
          }),
          impactItem({
            id: "item-2",
            requirementId: null,
            requirementTitle:
              "Support partial shipments so an order can be fulfilled from two warehouses.",
          }),
          impactItem({
            id: "item-3",
            requirementId: null,
            requirementTitle: "Every line item must record the warehouse that fulfilled it.",
          }),
        ],
      }),
    );
    const headings = md.split("\n").filter((l) => l.startsWith("### "));
    expect(headings).toHaveLength(3);
    expect(new Set(headings).size).toBe(3);
    expect(md).not.toContain("### Requirement change");
  });

  it("still refuses to guess for a LEGACY row that predates the column", () => {
    // Pre-#1013 rows read NULL. The heading stays neutral and points at the
    // verbatim block — a confidently wrong heading is worse than a neutral one.
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: THREE_REQUIREMENT_PASTE,
        projectIds: ["project-001"],
        items: [impactItem({ id: "legacy-1", requirementTitle: null, requirementId: null })],
      }),
    );
    expect(md).toContain("### Requirement change 1 of 1");
    expect(md).not.toContain("### Customers must be able to cancel an order");
    expect(md).not.toContain("Unlabelled requirement change");
    expect(md).toContain("## Requirement analysed");
  });

  it("mixes persisted and legacy rows without leaking one row's title onto another", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: THREE_REQUIREMENT_PASTE,
        projectIds: ["project-001"],
        items: [
          impactItem({
            id: "item-1",
            requirementId: null,
            requirementTitle:
              "Customers must be able to cancel an order within 24 hours of placing it.",
          }),
          impactItem({ id: "legacy-2", requirementId: null, requirementTitle: null }),
        ],
      }),
    );
    expect(md).toContain(
      "### Customers must be able to cancel an order within 24 hours of placing it.",
    );
    expect(md).toContain("### Requirement change 2 of 2");
    expect(countOccurrences(md, "### Customers must be able to cancel an order")).toBe(1);
  });

  it("routes a persisted title through the markdown sanitizer (OWASP output handling)", () => {
    // The title is user-supplied text taken verbatim from the paste, and it now
    // lands in a heading in both the download and the published Jira body.
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        sourceText: CANCELLATION_TEXT,
        projectIds: ["project-001"],
        items: [
          impactItem({
            requirementId: null,
            requirementTitle: "<img src=x onerror=alert(1)>\n# Injected heading",
          }),
        ],
      }),
    );
    expect(md).not.toContain("<img");
    expect(md).toContain("&lt;img src=x onerror=alert(1)&gt;");
    // `mdInline` collapses the newline, so the title cannot open a second
    // document-level heading from inside the one it is rendered in.
    expect(md).not.toContain("\n# Injected heading");
    expect(md).toContain("&gt; # Injected heading — modified");
  });
});

describe("serializeImpactAnalysisMarkdown — table grouping (#1004)", () => {
  const detail = impactDetail({
    sourceText: CANCELLATION_TEXT,
    projectIds: ["project-001"],
    items: [
      impactItem({
        requirementTitle: null,
        requirementId: null,
        affectedTables: [
          ...ordersTableRows(27),
          impactTable({
            id: "lineitem-table",
            tableName: "lineitem",
            columnName: null,
            changeKind: "add-column",
            suggestedDdl: "ALTER TABLE lineitem ADD COLUMN shipment_status TEXT;",
            riskClass: "expanding",
            relevanceTier: "possible",
            relevanceRationale: "Line items carry per-item shipment state.",
            consumerResolution: undefined,
            consumers: undefined,
          }),
        ],
      }),
    ],
  });

  it("emits one top-level bullet per TABLE, not one per row", () => {
    const md = serializeImpactAnalysisMarkdown(detail);
    // Column rows are nested (indented), so an UNINDENTED `- **` bullet is a
    // table group. These 29 rows (1 `orders` table + 27 `orders` columns +
    // 1 `lineitem`) previously serialized to 29 top-level bullets; grouped, they
    // are 2. Asserting the whole list — not just that `- **orders** —` appears
    // once — is what makes this fail if the grouping is ever undone.
    const tableBullets = tablePanelBullets(md);
    expect(tableBullets).toHaveLength(2);
    expect(tableBullets[0]).toContain("**orders**");
    expect(tableBullets[1]).toContain("**lineitem**");
  });

  it("states each table's rationale exactly once, not once per column", () => {
    const md = serializeImpactAnalysisMarkdown(detail);
    expect(countOccurrences(md, ORDERS_RATIONALE)).toBe(1);
  });

  it("nests the columns under their table instead of flattening them to top-level bullets", () => {
    const md = serializeImpactAnalysisMarkdown(detail);
    // Every referenced column is still reported…
    expect(md).toContain("Referenced by impacted code (27 columns)");
    expect(md).toContain("`col_01`");
    expect(md).toContain("`col_27`");
    // …but not as 27 separate `- **orders.col_NN**` bullets.
    expect(countOccurrences(md, "- **orders.col_")).toBe(0);
    // …and their verify-only `-- Verify column …` noise is not repeated per row.
    expect(countOccurrences(md, "-- Verify column")).toBe(0);
  });

  it("keeps a proposed column change as its own nested, schema-qualified row with its DDL", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTables: [
              impactTable({
                id: "orders-table",
                tableName: "orders",
                columnName: null,
                changeKind: "reference",
                suggestedDdl: null,
                consumerResolution: undefined,
                consumers: undefined,
              }),
              impactTable({
                id: "orders-cancelled-by",
                objectKind: "column",
                tableName: "orders",
                columnName: "cancelled_by",
                changeKind: "add-column",
                suggestedDdl: "ALTER TABLE orders ADD COLUMN cancelled_by TEXT;",
                riskClass: "expanding",
                consumerResolution: undefined,
                consumers: undefined,
              }),
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("Proposed column changes (1)");
    expect(md).toContain("**orders.cancelled_by**");
    expect(md).toContain("ALTER TABLE orders ADD COLUMN cancelled_by TEXT;");
    // The proposed column is NESTED under its table — one unindented bullet, not two.
    expect(tablePanelBullets(md)).toHaveLength(1);
  });

  it("orders the table sections likely-first, mirroring the UI", () => {
    const md = serializeImpactAnalysisMarkdown(detail);
    expect(md.indexOf("- **orders** —")).toBeLessThan(md.indexOf("- **lineitem** —"));
  });

  it("breaks a tier tie by confidence descending, then by table name", () => {
    const table = (id: string, name: string, confidence: number): ImpactAffectedTableView =>
      impactTable({
        id,
        tableName: name,
        columnName: null,
        confidence,
        relevanceTier: "likely",
        relevanceRationale: null,
        consumerResolution: undefined,
        consumers: undefined,
        suggestedDdl: null,
      });
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTables: [
              table("t-a", "zeta", 0.5),
              table("t-b", "alpha", 0.9),
              table("t-c", "beta", 0.5),
            ],
          }),
        ],
      }),
    );
    // alpha (0.90) outranks the 0.50 pair; within that pair, name order decides.
    expect(md.indexOf("- **alpha**")).toBeLessThan(md.indexOf("- **beta**"));
    expect(md.indexOf("- **beta**")).toBeLessThan(md.indexOf("- **zeta**"));
  });

  it("caps a very wide referenced-column list and says how many were elided", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [impactItem({ affectedTables: ordersTableRows(60) })],
      }),
    );
    expect(md).toContain("Referenced by impacted code (60 columns)");
    expect(md).toContain("…and 20 more");
  });

  it("keeps routines in their own list rather than grouping them as tables", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTables: [
              impactTable({
                id: "proc-1",
                objectKind: "procedure",
                tableName: "sp_cancel_order",
                columnName: null,
                suggestedDdl: null,
                consumerResolution: undefined,
                consumers: undefined,
              }),
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("Affected procedures & functions");
    expect(md).toContain("**sp_cancel_order**");
  });
});

describe("serializeImpactAnalysisMarkdown — write-path gaps + tests (#1004)", () => {
  it("exports the untested write-path callout with its writing symbols", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            writePathGaps: [
              {
                tableName: "orders",
                writingSymbols: ["OrderMapper.insertOrder", "OrderService.save"],
                coveredWritingSymbols: [],
              },
              { tableName: "lineitem", writingSymbols: [], coveredWritingSymbols: [] },
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("#### Untested write paths");
    expect(md).toContain("2 impacted tables have untested write paths");
    expect(md).toContain("**orders** — no test covers this write path");
    expect(md).toContain("`OrderMapper.insertOrder`");
    expect(md).toContain("**lineitem** — no test covers this write path");
  });

  it("uses the singular phrasing for a single write-path gap", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            writePathGaps: [{ tableName: "orders", writingSymbols: [], coveredWritingSymbols: [] }],
          }),
        ],
      }),
    );
    expect(md).toContain("1 impacted table has an untested write path");
  });

  it("#1012 — reports a PARTIALLY covered table as N of M, naming both sides", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            writePathGaps: [
              {
                tableName: "account",
                writingSymbols: ["AccountMapper.updateAccount"],
                coveredWritingSymbols: ["AccountMapper.insertAccount"],
              },
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("**account** — 1 of 2 write paths untested");
    expect(md).toContain("untested: `AccountMapper.updateAccount`");
    expect(md).toContain("covered: `AccountMapper.insertAccount`");
    // The blanket "no test covers this" wording must NOT be used for a partial.
    expect(md).not.toContain("**account** — no test covers this write path");
  });

  it("exports the tests covering the impacted code with a count", () => {
    const md = serializeImpactAnalysisMarkdown(
      impactDetail({
        items: [
          impactItem({
            affectedTests: [
              impactSymbol({
                id: "test-1",
                filePath: "src/orders/service.test.ts",
                qualifiedName: "cancels an order",
                relation: "caller",
                depth: 1,
              }),
              impactSymbol({
                id: "test-2",
                filePath: "src/orders/mapper.test.ts",
                qualifiedName: "inserts an order",
                relation: "caller",
                depth: 1,
              }),
            ],
          }),
        ],
      }),
    );
    expect(md).toContain("#### Tests covering the impacted code (2 across 2 files)");
    expect(md).toContain("`src/orders/service.test.ts:10-42`");
    expect(md).toContain("cancels an order");
  });

  it("omits both sections when the run has no gaps and no covering tests", () => {
    const md = serializeImpactAnalysisMarkdown(impactDetail());
    expect(md).not.toContain("Untested write paths");
    expect(md).not.toContain("Tests covering the impacted code");
  });
});
