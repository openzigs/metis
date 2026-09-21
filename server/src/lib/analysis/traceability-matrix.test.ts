/**
 * Unit tests for the PURE traceability-matrix builder + serializers (#737).
 */
import { describe, it, expect } from "vitest";
import type {
  Citation,
  TraceabilityCodeLocation,
  TraceabilityMatrix,
  TraceabilityTestLink,
} from "@metis/shared";
import {
  buildTraceabilityMatrix,
  escapeMarkdownCell,
  formatCodeLocationCell,
  isDocumentationFilePath,
  isTestFilePath,
  serializeTraceabilityCsv,
  serializeTraceabilityMarkdown,
  type MatrixFindingInput,
  type MatrixRequirementInput,
} from "./traceability-matrix.js";

const codeCitation = (
  filePath: string,
  startLine: number,
  endLine: number,
  symbolId?: string,
): Citation => ({
  filePath,
  startLine,
  endLine,
  ...(symbolId ? { symbolId } : {}),
});

const docCitation = (documentId: string, chunkIndex = 0): Citation => ({ documentId, chunkIndex });

function findingsMap(findings: MatrixFindingInput[]): Map<string, MatrixFindingInput> {
  return new Map(findings.map((f) => [f.id, f]));
}

describe("buildTraceabilityMatrix", () => {
  it("links a requirement to its findings and code locations from citations", () => {
    const requirements: MatrixRequirementInput[] = [
      {
        id: "req-1",
        title: "Users can log in",
        coverage: "grounded_in_code",
        verdict: "gap-confirmed",
        evidenceFindingIds: ["f-1", "f-2"],
      },
    ];
    const findings = findingsMap([
      {
        id: "f-1",
        title: "Login handler exists",
        severity: "high",
        citations: [codeCitation("server/src/auth.ts", 10, 20, "sym-a")],
      },
      {
        id: "f-2",
        title: "Session doc",
        severity: "low",
        citations: [docCitation("doc-1", 3)],
      },
    ]);

    const matrix = buildTraceabilityMatrix({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements,
      findingsById: findings,
    });

    expect(matrix.testsDetection).toBe("heuristic");
    expect(matrix.rows).toHaveLength(1);
    const row = matrix.rows[0]!;
    expect(row.findings.map((f) => f.id)).toEqual(["f-1", "f-2"]);
    // Only the CODE citation becomes a code location; the doc citation does not.
    expect(row.codeLocations).toEqual([
      {
        filePath: "server/src/auth.ts",
        startLine: 10,
        endLine: 20,
        source: "citation",
        symbolId: "sym-a",
      },
    ]);
    expect(row.tests).toEqual([]);
  });

  it("emits an explicit empty row for a requirement with no findings", () => {
    const matrix = buildTraceabilityMatrix({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [
        {
          id: "req-x",
          title: "Orphan requirement",
          coverage: "no_evidence",
          verdict: "could-not-verify",
          evidenceFindingIds: [],
        },
      ],
      findingsById: new Map(),
    });
    const row = matrix.rows[0]!;
    expect(row.findings).toEqual([]);
    expect(row.codeLocations).toEqual([]);
    expect(row.tests).toEqual([]);
    expect(row.coverage).toBe("no_evidence");
  });

  it("ignores stale evidence finding ids without inventing findings", () => {
    const matrix = buildTraceabilityMatrix({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [
        {
          id: "req-1",
          title: "R",
          coverage: null,
          verdict: null,
          evidenceFindingIds: ["missing", "f-1"],
        },
      ],
      findingsById: findingsMap([{ id: "f-1", title: "Real", severity: "medium", citations: [] }]),
    });
    expect(matrix.rows[0]!.findings.map((f) => f.id)).toEqual(["f-1"]);
  });

  it("de-dupes identical code locations across findings", () => {
    const dup = codeCitation("a.ts", 1, 5, "s1");
    const matrix = buildTraceabilityMatrix({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [
        {
          id: "req-1",
          title: "R",
          coverage: null,
          verdict: null,
          evidenceFindingIds: ["f-1", "f-2"],
        },
      ],
      findingsById: findingsMap([
        { id: "f-1", title: "A", severity: "high", citations: [dup] },
        { id: "f-2", title: "B", severity: "low", citations: [dup] },
      ]),
    });
    expect(matrix.rows[0]!.codeLocations).toHaveLength(1);
  });

  it("folds in deterministic-mapping locations with distinct provenance", () => {
    const deterministic = new Map<string, TraceabilityCodeLocation[]>([
      [
        "req-1",
        [
          {
            filePath: "server/src/mapped.ts",
            startLine: 3,
            endLine: 8,
            source: "deterministic-mapping",
            symbolId: "sym-m",
          },
        ],
      ],
    ]);
    const matrix = buildTraceabilityMatrix({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [
        {
          id: "req-1",
          title: "R",
          coverage: "grounded_in_code",
          verdict: "implemented",
          evidenceFindingIds: ["f-1"],
        },
      ],
      findingsById: findingsMap([
        {
          id: "f-1",
          title: "A",
          severity: "high",
          citations: [codeCitation("a.ts", 1, 2, "sym-a")],
        },
      ]),
      deterministicByRequirement: deterministic,
    });
    const sources = matrix.rows[0]!.codeLocations.map((l) => l.source).sort();
    expect(sources).toEqual(["citation", "deterministic-mapping"]);
  });

  it("attaches detected tests via the referenced symbol ids, de-duped", () => {
    const tests = new Map<string, TraceabilityTestLink[]>([
      [
        "sym-a",
        [
          { filePath: "server/src/auth.test.ts", symbol: "describe login" },
          { filePath: "server/src/auth.test.ts", symbol: "describe login" }, // dup
        ],
      ],
    ]);
    const matrix = buildTraceabilityMatrix({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [
        {
          id: "req-1",
          title: "R",
          coverage: "grounded_in_code",
          verdict: "implemented",
          evidenceFindingIds: ["f-1"],
        },
      ],
      findingsById: findingsMap([
        {
          id: "f-1",
          title: "A",
          severity: "high",
          citations: [codeCitation("auth.ts", 1, 2, "sym-a")],
        },
      ]),
      testsBySymbolId: tests,
    });
    expect(matrix.rows[0]!.tests).toEqual([
      { filePath: "server/src/auth.test.ts", symbol: "describe login" },
    ]);
  });
});

describe("serializeTraceabilityCsv", () => {
  const matrix: TraceabilityMatrix = {
    analysisId: "an-1",
    projectId: "proj-1",
    testsDetection: "heuristic",
    rows: [
      {
        requirementId: "req-1",
        title: "Users can log in",
        coverage: "grounded_in_code",
        verdict: "gap-confirmed",
        findings: [{ id: "f-1", title: "Login handler", severity: "high" }],
        codeLocations: [{ filePath: "auth.ts", startLine: 10, endLine: 20, source: "citation" }],
        tests: [{ filePath: "auth.test.ts", symbol: "login suite" }],
      },
    ],
  };

  it("emits a header row and one row per requirement", () => {
    const csv = serializeTraceabilityCsv(matrix);
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("Requirement,Verdict,Coverage,Findings,Code locations,Tests");
    expect(lines[1]).toContain("Users can log in");
    expect(lines[1]).toContain("auth.ts:10-20 (citation)");
    expect(lines[1]).toContain("auth.test.ts::login suite");
  });

  it("quotes and escapes a comma, quote, and newline in a requirement title", () => {
    const csv = serializeTraceabilityCsv({
      ...matrix,
      rows: [
        {
          ...matrix.rows[0]!,
          title: 'Login, "securely"\nwith SSO',
        },
      ],
    });
    // Comma + embedded quotes (doubled) + newline force RFC-4180 quoting.
    expect(csv).toContain('"Login, ""securely""\nwith SSO"');
  });

  it("neutralizes a spreadsheet formula injection in a title", () => {
    const csv = serializeTraceabilityCsv({
      ...matrix,
      rows: [{ ...matrix.rows[0]!, title: "=SUM(A1:A9)" }],
    });
    // Leading '=' is prefixed with a single quote so a spreadsheet renders it inert.
    expect(csv).toContain("'=SUM(A1:A9)");
  });

  it("renders explicit empty markers for a requirement with no trace", () => {
    const csv = serializeTraceabilityCsv({
      ...matrix,
      rows: [
        {
          requirementId: "req-2",
          title: "Empty",
          coverage: null,
          verdict: null,
          findings: [],
          codeLocations: [],
          tests: [],
        },
      ],
    });
    // Coverage dash + none / none / none detected — never blank cells.
    expect(csv.split("\r\n")[1]).toBe("Empty,—,—,none,none,none detected");
  });
});

describe("serializeTraceabilityMarkdown", () => {
  const matrix: TraceabilityMatrix = {
    analysisId: "an-1",
    projectId: "proj-1",
    testsDetection: "heuristic",
    rows: [
      {
        requirementId: "req-1",
        title: "Users can log in",
        coverage: "grounded_in_code",
        verdict: "gap-confirmed",
        findings: [{ id: "f-1", title: "Login handler", severity: "high" }],
        codeLocations: [{ filePath: "auth.ts", startLine: 10, endLine: 20, source: "citation" }],
        tests: [],
      },
    ],
  };

  it("produces a header, divider, and one row per requirement", () => {
    const md = serializeTraceabilityMarkdown(matrix);
    const lines = md.split("\n");
    expect(lines[0]).toBe(
      "| Requirement | Verdict | Coverage | Findings | Code locations | Tests |",
    );
    expect(lines[1]).toBe("| --- | --- | --- | --- | --- | --- |");
    expect(lines[2]).toContain("Users can log in");
    expect(lines[2]).toContain("none detected");
  });

  it("escapes pipes and newlines so a title cannot break the table grid", () => {
    const md = serializeTraceabilityMarkdown({
      ...matrix,
      rows: [{ ...matrix.rows[0]!, title: "a | b\nc" }],
    });
    const rowLine = md.split("\n")[2]!;
    expect(rowLine).toContain("a \\| b<br>c");
    // The escaped pipe must not add a real column separator (6 columns ⇒ 7 bars).
    expect(rowLine.match(/(?<!\\)\|/g)).toHaveLength(7);
  });

  it("handles an empty matrix (header + divider only)", () => {
    const md = serializeTraceabilityMarkdown({ ...matrix, rows: [] });
    expect(md.split("\n")).toHaveLength(2);
  });
});

describe("escapeMarkdownCell", () => {
  it("escapes backslashes, pipes, and newlines", () => {
    expect(escapeMarkdownCell("a\\b|c\r\nd")).toBe("a\\\\b\\|c<br>d");
  });
});

describe("formatCodeLocationCell", () => {
  it("renders a range with provenance", () => {
    expect(
      formatCodeLocationCell({ filePath: "a.ts", startLine: 5, endLine: 9, source: "citation" }),
    ).toBe("a.ts:5-9 (citation)");
  });
  it("falls back to startLine when endLine is missing", () => {
    expect(
      formatCodeLocationCell({ filePath: "a.ts", startLine: 7, endLine: null, source: "citation" }),
    ).toBe("a.ts:7-7 (citation)");
  });
  it("renders path-only when there is no line range", () => {
    expect(
      formatCodeLocationCell({
        filePath: "a.ts",
        startLine: null,
        endLine: null,
        source: "deterministic-mapping",
      }),
    ).toBe("a.ts (deterministic-mapping)");
  });
});

describe("isTestFilePath", () => {
  it.each([
    "server/src/auth.test.ts",
    "ui/src/foo.spec.tsx",
    "pkg/handler_test.go",
    "app/tests/test_login.py",
    "src/__tests__/thing.ts",
    "a/spec/b.rb",
  ])("detects test path %s", (p) => {
    expect(isTestFilePath(p)).toBe(true);
  });

  it.each(["server/src/auth.ts", "ui/src/page.tsx", "lib/latest.ts", "src/contest.ts"])(
    "rejects non-test path %s",
    (p) => {
      expect(isTestFilePath(p)).toBe(false);
    },
  );
});

describe("isDocumentationFilePath", () => {
  it.each([
    // The four live jpetstore-site rows this predicate exists for (#1003) —
    // must still be excluded after anchoring the predicate.
    "src/site/xdoc/index.xml",
    "src/site/es/xdoc/index.xml",
    "src/site/ja/xdoc/index.xml",
    "src/site/ko/xdoc/index.xml",
    "src/site/resources/images/logo.png",
    // Repo-root docs directories, anchored at the path start.
    "docs/ARCHITECTURE.md",
    "doc/setup.md",
    "documentation/guide.adoc",
    // `xdoc`/`xdocs` stays depth-independent — unambiguous Maven convention.
    "some/nested/module/xdoc/page.xml",
  ])("detects documentation/site path %s", (p) => {
    expect(isDocumentationFilePath(p)).toBe(true);
  });

  it.each([
    "src/main/resources/org/mybatis/jpetstore/persistence/OrderMapper.xml",
    "src/main/resources/org/mybatis/jpetstore/persistence/LineItemMapper.xml",
    "src/main/java/org/mybatis/jpetstore/service/OrderService.java",
    "server/src/lib/docs-gen/grounding/json-extract.ts",
    "src/main/java/org/mybatis/jpetstore/domain/Sitemap.java",
    "src/contest.ts",
    // A source file inside a `documentation/` PACKAGE (not repo-root docs)
    // must NOT be excluded — this was the latent recall regression the
    // segment-anywhere predicate caused (#1003 follow-up).
    "src/main/java/com/acme/documentation/DocumentationService.java",
    // A nested `docs/` package, same reasoning.
    "src/main/java/com/acme/docs/DocsController.java",
    // `javadoc` was dropped from the heuristic entirely — it can't be scoped
    // unambiguously, so it must no longer be treated as a docs signal.
    "project/javadoc/package-summary.html",
    "src/main/java/com/acme/javadoc/JavadocRenderer.java",
  ])("retains non-documentation path %s", (p) => {
    expect(isDocumentationFilePath(p)).toBe(false);
  });
});
