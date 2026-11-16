/**
 * Issue #2595 — the BA hand-off document (change request + impact analysis),
 * PURE: plain objects in, markdown out. The loader and the route are tested in
 * `handoff-export-loader.test.ts` and `routes/impact-handoff-export.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type {
  ImpactAffectedSymbolView,
  ImpactAffectedTableView,
  ImpactAnalysisDetail,
  ImpactItemView,
} from "@metis/shared";
import {
  answeredClarifications,
  handoffTitle,
  HANDOFF_MAX_FILES,
  HANDOFF_MAX_LIST,
  serializeHandoffMarkdown,
  type HandoffChangeRequest,
  type HandoffInput,
  type HandoffRequirement,
} from "./handoff-export.js";
import type { ClarificationState } from "../analysis/types/requirements.js";

function symbol(overrides: Partial<ImpactAffectedSymbolView> = {}): ImpactAffectedSymbolView {
  return {
    id: "sym-1",
    codeSymbolId: "cs-1",
    filePath: "internal/storage/api_key.go",
    qualifiedName: "internal/storage/api_key.go::Storage::CreateAPIKey",
    startLine: 73,
    endLine: 101,
    relation: "direct",
    depth: 0,
    confidence: 0.95,
    ...overrides,
  };
}

function table(overrides: Partial<ImpactAffectedTableView> = {}): ImpactAffectedTableView {
  return {
    id: "tbl-1",
    objectKind: "table",
    tableName: "api_keys",
    columnName: null,
    columnType: null,
    changeKind: "add-column",
    suggestedDdl: "ALTER TABLE api_keys ADD COLUMN expires_at TIMESTAMP;",
    source: "live-db",
    reconciliation: "matched",
    confidence: 0.8,
    relevanceTier: "likely",
    relevanceRationale: null,
    ...overrides,
  };
}

function item(overrides: Partial<ImpactItemView> = {}): ImpactItemView {
  return {
    id: "item-1",
    projectId: "project-001",
    requirementId: "req-1",
    requirementTitle: "Optional expiry date on an API key",
    changeType: "modified",
    severity: "medium",
    impactScore: 0.65,
    confidence: 0.6,
    matchQuality: "strong",
    matchQualityReason: null,
    affectedFileCount: 3,
    affectedSymbolCount: 4,
    summary: "Touches API key creation.",
    affectedSymbols: [
      symbol(),
      symbol({ id: "sym-2", qualifiedName: "handler.createAPIKeyHandler", depth: 1 }),
      symbol({ id: "sym-3", qualifiedName: "ui.showKeys", depth: 2 }),
    ],
    affectedTables: [],
    affectedTablesSecondary: [],
    affectedTests: [symbol({ id: "t-1", filePath: "internal/storage/api_key_test.go" })],
    writePathGaps: [],
    editCandidateFiles: [],
    blastRadiusFiles: [],
    droppedColumnProposals: [],
    optionalColumnProposals: [],
    uncheckedColumnProposals: [],
    feedback: [],
    ...overrides,
  };
}

function detail(overrides: Partial<ImpactAnalysisDetail> = {}): ImpactAnalysisDetail {
  return {
    id: "ia-1",
    status: "completed",
    documentId: null,
    sourceText: null,
    summary: "One project, one requirement change.",
    errorMessage: null,
    rerunOfId: null,
    totalImpactedSymbols: 4,
    startedAt: "2026-11-16T10:00:00.000Z",
    completedAt: "2026-11-16T10:05:00.000Z",
    projectIds: ["project-001"],
    startedById: "user-1",
    items: [item()],
    projectOutcomes: [],
    sharedTableImpacts: [],
    ...overrides,
  };
}

function requirement(overrides: Partial<HandoffRequirement> = {}): HandoffRequirement {
  return {
    title: "Optional expiry date on an API key",
    body: "A key may be given an expiry date.",
    approved: true,
    verdict: "gap-confirmed",
    passages: [
      {
        filename: "FRD-12.md",
        headingPath: ["FRD-12", "FRD-12.1 API keys can expire"],
        quote: "When an API key is created, the person creating it may give an expiry date.",
      },
    ],
    ...overrides,
  };
}

function changeRequest(overrides: Partial<HandoffChangeRequest> = {}): HandoffChangeRequest {
  return {
    title: "Expiring API keys",
    requirements: [requirement()],
    restrictedLeftOut: 0,
    passagesWithheld: false,
    ...overrides,
  };
}

function render(overrides: Partial<HandoffInput> = {}): string {
  return serializeHandoffMarkdown({
    detail: detail(),
    projectNames: { "project-001": "Miniflux" },
    changeRequest: changeRequest(),
    impactClarifications: [],
    ...overrides,
  });
}

/** The body of one `## heading` section, up to the next `## ` heading. */
function section(md: string, heading: string): string {
  const start = md.indexOf(`## ${heading}`);
  expect(start, `section "${heading}"`).toBeGreaterThan(-1);
  const next = md.indexOf("\n## ", start + 3);
  return md.slice(start, next === -1 ? undefined : next);
}

const CLARIFIED_BODY = [
  "A key may be given an expiry date.",
  "",
  "<!-- metis:clarifications:start -->",
  "## Clarifications",
  "",
  "_Answers recorded during METIS clarification, verbatim. Each says who wrote it._",
  "",
  "- **Q:** Date only, or date and time?",
  "  **A:** Date only, end of day UTC _(typed by the requester)_",
  "<!-- metis:clarifications:end -->",
].join("\n");

describe("serializeHandoffMarkdown — #2595", () => {
  it("states every part of the hand-off, in order", () => {
    const md = render();
    const order = [
      "# Expiring API keys - impact hand-off",
      "## Summary",
      "## Requirements",
      "## Affected files and code citations",
      "## Clarifications answered",
      "## Risks",
      "## Open items: could not verify",
    ].map((h) => md.indexOf(h));
    expect(order.every((i) => i > -1)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(md).toContain("run completed · 2026-11-16");
    expect(md.endsWith("\n")).toBe(true);
  });

  it("summarises the run and the change request", () => {
    const md = section(
      render({
        changeRequest: changeRequest({
          requirements: [requirement(), requirement({ title: "Second", approved: false })],
        }),
      }),
      "Summary",
    );
    expect(md).toContain("One project, one requirement change.");
    expect(md).toContain("- 2 requirement(s) in the change request, 1 approved");
    expect(md).toContain("- 1 requirement change(s) with code impact");
    expect(md).toContain("- 4 impacted symbol(s)");
  });

  it("says so when the run wrote no summary, and when it failed", () => {
    const md = section(
      render({ detail: detail({ summary: null, status: "failed", errorMessage: "Index gone" }) }),
      "Summary",
    );
    expect(md).toContain("*No summary was written for this run.*");
    expect(md).toContain("**This run failed:** Index gone");
  });

  it("states each requirement with its status, verdict and source passage", () => {
    const md = section(render(), "Requirements");
    expect(md).toContain("### 1. Optional expiry date on an API key");
    expect(md).toContain("*Approved · Nothing in the code covers it*");
    expect(md).toContain("A key may be given an expiry date.");
    expect(md).toContain(
      "> When an API key is created, the person creating it may give an expiry date.",
    );
    // The document and the section the passage sits under.
    expect(md).toContain("*Source passage: FRD-12.md, FRD-12.1 API keys can expire*");
  });

  it("labels an unapproved requirement and each verdict", () => {
    const md = section(
      render({
        changeRequest: changeRequest({
          requirements: [
            requirement({ title: "A", approved: false, verdict: "could-not-verify" }),
            requirement({ title: "B", verdict: "implemented" }),
            requirement({ title: "C", verdict: null }),
          ],
        }),
      }),
      "Requirements",
    );
    expect(md).toContain("*Not yet approved · Could not verify*");
    expect(md).toContain("*Approved · Covered by the code*");
    expect(md).toMatch(/### 3\. C\n\n\*Approved\*\n/);
  });

  it("says when a requirement has no recorded passage, and quotes at most two", () => {
    const passage = requirement().passages[0]!;
    const md = section(
      render({
        changeRequest: changeRequest({
          requirements: [
            requirement({ title: "None", passages: [] }),
            requirement({
              title: "Three",
              passages: [
                { ...passage, quote: "first" },
                { ...passage, quote: "second" },
                { ...passage, quote: "third" },
              ],
            }),
          ],
        }),
      }),
      "Requirements",
    );
    expect(md).toContain("*No source passage was recorded.*");
    expect(md).toContain("> first");
    expect(md).toContain("> second");
    expect(md).not.toContain("> third");
  });

  it("shows no passage to a reader who cannot see the change request whole", () => {
    const md = section(
      render({ changeRequest: changeRequest({ passagesWithheld: true }) }),
      "Requirements",
    );
    expect(md).not.toContain("> When an API key is created");
    expect(md).not.toContain("No source passage was recorded");
    expect(md).toContain("Source passages are not shown");
  });

  it("states a run's pasted requirement when it has no change request", () => {
    const md = render({
      changeRequest: null,
      detail: detail({ sourceText: "Keys can expire.\nAnd be listed." }),
    });
    expect(md).not.toContain("## Requirements");
    expect(section(md, "Requirement analysed")).toContain("> Keys can expire. And be listed.");
    expect(md).toContain("# Impact analysis ia-1 - hand-off");
  });

  it("omits the requirement section when there is neither a change request nor text", () => {
    const md = render({ changeRequest: null });
    expect(md).not.toContain("## Requirement");
  });

  it("says when the change request has no requirement to state", () => {
    const md = render({ changeRequest: changeRequest({ requirements: [] }) });
    expect(section(md, "Requirements")).toContain("No draft or approved requirement");
  });

  it("lists the files to edit with their code citations, and only counts the rest", () => {
    const md = section(render(), "Affected files and code citations");
    expect(md).toContain("### Optional expiry date on an API key");
    expect(md).toContain("*modified · severity medium · 3 file(s), 4 symbol(s)*");
    expect(md).toContain("Touches API key creation.");
    expect(md).toContain("**Files to edit**");
    // The symbol's name without the file path it repeats.
    expect(md).toContain(
      "- `internal/storage/api_key.go:73-101` · `Storage::CreateAPIKey` · Likely",
    );
    // The blast radius and the tests are counted, never listed.
    expect(md).not.toContain("createAPIKeyHandler");
    expect(md).not.toContain("api_key_test.go");
    expect(md).toContain(
      "*2 further symbol(s) in the blast radius and 1 covering test(s): listed on the impact analysis page.*",
    );
  });

  it("caps the files to edit and counts what it leaves out", () => {
    const edits = Array.from({ length: HANDOFF_MAX_FILES + 5 }, (_, i) =>
      symbol({ id: `s-${i}`, filePath: `f${i}.go`, qualifiedName: `f${i}.go::fn${i}` }),
    );
    const md = render({ detail: detail({ items: [item({ affectedSymbols: edits })] }) });
    expect(md).toContain(`\`f${HANDOFF_MAX_FILES - 1}.go:73-101\``);
    expect(md).not.toContain(`\`f${HANDOFF_MAX_FILES}.go:73-101\``);
    expect(md).toContain("- *…and 5 more on the impact analysis page.*");
  });

  it("names a whole-file symbol by its path alone, and a line-less one without lines", () => {
    const md = render({
      detail: detail({
        items: [
          item({
            affectedSymbols: [
              symbol({ filePath: "db/migrations.go", qualifiedName: "db/migrations.go" }),
              symbol({ id: "s-2", startLine: null, endLine: null, qualifiedName: "pkg.Fn" }),
              symbol({ id: "s-3", endLine: null }),
            ],
            affectedTests: [],
          }),
        ],
      }),
    });
    expect(md).toContain("- `db/migrations.go:73-101` · Likely");
    expect(md).toContain("- `internal/storage/api_key.go` · `pkg.Fn` ·");
    expect(md).toContain("- `internal/storage/api_key.go:73` · `Storage::CreateAPIKey`");
  });

  it("names repositories and projects only when there is more than one", () => {
    const one = render({
      detail: detail({
        items: [item({ affectedSymbols: [symbol({ repo: { id: "r1", name: "v2" } })] })],
      }),
    });
    expect(one).not.toContain(" in v2");
    expect(one).toMatch(/### Optional expiry date on an API key\n/);

    const two = render({
      projectNames: { "project-001": "Miniflux", "project-002": "Reader" },
      detail: detail({
        projectIds: ["project-001", "project-002"],
        items: [
          item({
            affectedSymbols: [
              symbol({ repo: { id: "r1", name: "v2" } }),
              symbol({ id: "s-2", repo: { id: "r2", name: "client" } }),
            ],
          }),
        ],
      }),
    });
    expect(two).toContain("### Optional expiry date on an API key (Miniflux)");
    expect(two).toContain("`internal/storage/api_key.go:73-101` in v2 ·");
    expect(two).toContain("`internal/storage/api_key.go:73-101` in client ·");
  });

  it("names the affected tables once each, capped", () => {
    const tables = [
      table(),
      table({ id: "t-2", columnName: "expires_at" }),
      ...Array.from({ length: 11 }, (_, i) => table({ id: `x-${i}`, tableName: `t${i}` })),
    ];
    const md = render({ detail: detail({ items: [item({ affectedTables: tables })] }) });
    expect(md).toContain("**Tables:** `api_keys`, `t0`,");
    expect(md).toContain("`t8` and 2 more");
    expect(md).not.toContain("`t9`");
  });

  it("numbers a change with no title, and says when no code is affected", () => {
    const md = render({
      detail: detail({ items: [item({ requirementTitle: null, requirementId: null })] }),
    });
    expect(md).toContain("### Requirement change 1 of 1");
    const none = render({ detail: detail({ items: [] }) });
    expect(section(none, "Affected files and code citations")).toContain(
      "No code impact was detected",
    );
  });

  it("states the clarifications answered, from the requirement and from the run", () => {
    const md = section(
      render({
        changeRequest: changeRequest({ requirements: [requirement({ body: CLARIFIED_BODY })] }),
        impactClarifications: [
          { subject: "Reading time", question: "Minutes or seconds?", answer: "Minutes" },
        ],
      }),
      "Clarifications answered",
    );
    expect(md).toContain(
      "- **Date only, or date and time?** (Optional expiry date on an API key)\n  - Date only, end of day UTC",
    );
    expect(md).toContain("- **Minutes or seconds?** (Reading time)\n  - Minutes");
  });

  it("keeps the requirement's generated clarifications block out of its body", () => {
    const md = render({
      changeRequest: changeRequest({ requirements: [requirement({ body: CLARIFIED_BODY })] }),
    });
    const requirements = section(md, "Requirements");
    expect(requirements).toContain("A key may be given an expiry date.");
    expect(requirements).not.toContain("Date only");
    expect(md).not.toContain("metis:");
  });

  it("caps the clarifications", () => {
    const many = Array.from({ length: HANDOFF_MAX_LIST + 3 }, (_, i) => ({
      subject: "S",
      question: `Q${i}?`,
      answer: `A${i}`,
    }));
    const md = render({ impactClarifications: many });
    expect(md).toContain(`Q${HANDOFF_MAX_LIST - 1}?`);
    expect(md).not.toContain(`Q${HANDOFF_MAX_LIST}?`);
    expect(md).toContain("- *…and 3 more answered.*");
  });

  it("says when no clarifying question was answered", () => {
    expect(section(render(), "Clarifications answered")).toContain(
      "*No clarifying question has been answered.*",
    );
  });

  it("lists the risks: a high severity, a breaking schema change, an untested write path", () => {
    const md = section(
      render({
        detail: detail({
          items: [
            item({
              severity: "high",
              affectedTables: [
                table({ columnName: "key", riskClass: "breaking" }),
                table({ id: "t-2", riskClass: "expanding" }),
              ],
              affectedTablesSecondary: [
                table({ id: "t-3", tableName: "users", riskClass: "breaking" }),
              ],
              writePathGaps: [
                {
                  tableName: "api_keys",
                  writingSymbols: ["Storage.CreateAPIKey"],
                  coveredWritingSymbols: [],
                },
                { tableName: "sessions", writingSymbols: [], coveredWritingSymbols: [] },
              ],
            }),
            item({ id: "item-2", requirementTitle: "Critical one", severity: "critical" }),
            item({ id: "item-3", requirementTitle: "Low one", severity: "low" }),
          ],
        }),
      }),
      "Risks",
    );
    expect(md).toContain("- **Optional expiry date on an API key**: severity high.");
    expect(md).toContain("- **Critical one**: severity critical.");
    expect(md).not.toContain("Low one");
    expect(md).toContain(
      "- Breaking schema change: `api_keys.key` (Optional expiry date on an API key).",
    );
    expect(md).toContain("- Breaking schema change: `users` (");
    expect(md).not.toContain("Expanding");
    expect(md).toContain(
      "- No test covers the write path to `api_keys`, written by `Storage.CreateAPIKey` (",
    );
    expect(md).toContain("- No test covers the write path to `sessions` (");
  });

  it("says when no risk was found, and caps a long list", () => {
    expect(section(render(), "Risks")).toContain("*No high-severity change");
    const many = Array.from({ length: HANDOFF_MAX_LIST + 2 }, (_, i) =>
      item({ id: `i-${i}`, requirementTitle: `R${i}`, severity: "high" }),
    );
    const md = section(render({ detail: detail({ items: many }) }), "Risks");
    expect(md).toContain("- *…and 2 more on the impact analysis page.*");
  });

  it("lists what could not be verified", () => {
    const md = section(
      render({
        projectNames: { "project-001": "Miniflux", "project-002": "Reader", "project-003": "Old" },
        changeRequest: changeRequest({
          restrictedLeftOut: 2,
          requirements: [requirement({ title: "Python client", verdict: "could-not-verify" })],
        }),
        detail: detail({
          projectIds: ["project-001", "project-002", "project-003", "project-004"],
          projectOutcomes: [
            { projectId: "project-001", outcome: "affected", reason: null },
            { projectId: "project-002", outcome: "not-checked", reason: "no-index" },
            { projectId: "project-003", outcome: "error", reason: null },
            { projectId: "project-004", outcome: "not-checked", reason: null },
          ],
          items: [
            item({
              affectedSymbols: [symbol({ codeSymbolId: null })],
              affectedTables: [
                table({ columnName: "expires_at", reconciliation: "column-not-found" }),
                table({ id: "t-2", tableName: "ghost", reconciliation: "table-not-found" }),
                table({ id: "t-3" }),
              ],
              uncheckedColumnProposals: [
                {
                  id: "cp-1",
                  tableName: "api_keys",
                  columnName: "label",
                  columnType: "TEXT",
                  suggestedDdl: "ALTER TABLE api_keys ADD COLUMN label TEXT;",
                  reason: "No live schema was connected.",
                  writer: null,
                },
              ],
            }),
          ],
        }),
      }),
      "Open items: could not verify",
    );
    expect(md).toContain(
      "- Requirement **Python client**: the code could neither confirm nor rule it out.",
    );
    expect(md).toContain("- 2 requirements are left out: they rest on a source you cannot see.");
    expect(md).toContain("- Project **Reader**: not checked (no code index).");
    expect(md).toContain("- Project **Old**: the check failed.");
    expect(md).toContain("- Project **project-004**: not checked.");
    expect(md).not.toContain("Miniflux");
    expect(md).toContain("- `api_keys.expires_at` is not in the live schema (");
    expect(md).toContain("- `ghost` is not in the live schema (");
    expect(md).not.toContain("- `api_keys` is not in the live schema");
    expect(md).toContain(
      "- Proposed column `api_keys.label` was not checked: No live schema was connected. (",
    );
    expect(md).toContain("- 1 affected symbol(s) could not be matched to the code index (");
  });

  it("says one requirement was left out, and when nothing is unverified", () => {
    const one = render({ changeRequest: changeRequest({ restrictedLeftOut: 1 }) });
    expect(one).toContain("- 1 requirement is left out");
    expect(section(render(), "Open items: could not verify")).toContain(
      "*Nothing is left unverified.*",
    );
  });

  describe("text from people, documents and models cannot restructure the document", () => {
    it("keeps a title on its one line and shows HTML as text", () => {
      const md = render({
        changeRequest: changeRequest({
          title: "Keys\n# Injected",
          requirements: [requirement({ title: "A <script>alert(1)</script>\n## Not a heading" })],
        }),
      });
      expect(md).toContain("# Keys # Injected - impact hand-off");
      expect(md).not.toMatch(/^# Injected/m);
      expect(md).toContain("### 1. A &lt;script>alert(1)&lt;/script> ## Not a heading");
      expect(md).not.toMatch(/^## Not a heading/m);
      expect(md).not.toContain("<script>");
    });

    it("keeps a quoted passage inside its quote", () => {
      const md = render({
        changeRequest: changeRequest({
          requirements: [
            requirement({
              passages: [{ headingPath: [], quote: "line one\n## Heading\n- item" }],
            }),
          ],
        }),
      });
      expect(md).toContain("> line one ## Heading - item");
      expect(md).toContain("*Source passage*");
    });

    it("nests a body's headings under the requirement and closes a fence the clip left open", () => {
      const body = `# Big heading\n\n\`\`\`\n${"x".repeat(2000)}\n\`\`\``;
      const md = render({
        changeRequest: changeRequest({ requirements: [requirement({ body })] }),
      });
      expect(md).toContain("#### Big heading");
      expect(md).not.toMatch(/^# Big heading/m);
      expect(md).toContain("… (shortened)\n```");
      // The sections after the body are outside any fence.
      const fences = md.split("\n").filter((l) => l.startsWith("```")).length;
      expect(fences % 2).toBe(0);
    });

    it("keeps a path and a symbol inside their code spans", () => {
      const md = render({
        detail: detail({
          items: [
            item({
              affectedSymbols: [symbol({ filePath: "a`b.go", qualifiedName: "x`\n# y" })],
            }),
          ],
        }),
      });
      expect(md).toContain("`a b.go:73-101` · `x # y`");
    });
  });
});

describe("handoffTitle", () => {
  it("names the change request, else the run", () => {
    expect(handoffTitle({ detail: detail(), changeRequest: changeRequest() })).toBe(
      "Expiring API keys - impact hand-off",
    );
    expect(handoffTitle({ detail: detail(), changeRequest: changeRequest({ title: "  " }) })).toBe(
      "Impact analysis ia-1 - hand-off",
    );
    expect(handoffTitle({ detail: detail(), changeRequest: null })).toBe(
      "Impact analysis ia-1 - hand-off",
    );
  });
});

describe("answeredClarifications", () => {
  const state = (rounds: ClarificationState["rounds"]): ClarificationState => ({
    analysisId: "ia-1",
    currentRound: rounds.length,
    maxRounds: 3,
    rounds,
    resolvedAmbiguities: [],
    escalatedToSonnet: false,
    completed: false,
  });
  const question = (id: string, requirementId: string, answer?: string) => ({
    id,
    requirementId,
    ambiguityField: "R7",
    question: `Question ${id}?`,
    context: "",
    ...(answer !== undefined ? { answer } : {}),
  });

  it("returns the answered questions, labelled by their requirement", () => {
    const out = answeredClarifications(
      state([
        {
          round: 1,
          questions: [
            question("q1", "T1", "On the question"),
            question("q2", "T2"),
            question("q3", "T9"),
          ],
          answers: [
            { questionId: "q2", answer: "Only in the round" },
            { questionId: "q3", answer: "   " },
          ],
        },
      ]),
      {
        requirements: [
          { id: "T1", title: "Search speed" } as never,
          { id: "T2", title: "Filters" } as never,
        ],
        totalAmbiguities: 0,
        totalEvidenceNeeds: 0,
      },
    );
    expect(out).toEqual([
      { subject: "Search speed", question: "Question q1?", answer: "On the question" },
      { subject: "Filters", question: "Question q2?", answer: "Only in the round" },
    ]);
  });

  it("labels a question by its requirement id when the requirement is unknown", () => {
    const out = answeredClarifications(
      state([{ round: 1, questions: [question("q1", "T7", "Yes")], answers: [] }]),
      null,
    );
    expect(out).toEqual([{ subject: "T7", question: "Question q1?", answer: "Yes" }]);
  });

  it("returns nothing with no dialog", () => {
    expect(answeredClarifications(null, null)).toEqual([]);
    expect(answeredClarifications(undefined, undefined)).toEqual([]);
  });
});
