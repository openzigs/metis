/**
 * Tests for the PURE gap-report builder (#742). Exercises the composition logic
 * directly with minimal inputs — evidence ordering, code-citation dedupe, the
 * story-points passthrough, verification roll-up, and the honest no-evidence
 * state — with no provider, prisma, or snapshot dependency.
 */
import { describe, it, expect } from "vitest";
import type { Citation } from "@metis/shared";
import {
  buildDatabaseChanges,
  buildGapReport,
  type GapReportFindingInput,
  type GapReportRequirementInput,
  type GapReportSchemaImpactInput,
} from "./gap-report.js";
import type { AffectedTableInput } from "../impact-analysis/schema-impact.js";
import type { AffectedSchemaConsumers } from "./affected-schema-consumers.js";

function requirement(
  overrides: Partial<GapReportRequirementInput> = {},
): GapReportRequirementInput {
  return {
    id: "req-1",
    title: "Users can log in",
    body: "The system must let users authenticate with email + password.",
    priority: "high",
    coverage: "grounded_in_code",
    verdict: "gap-confirmed",
    storyPoints: 5,
    evidenceFindingIds: ["f-1"],
    ...overrides,
  };
}

function finding(overrides: Partial<GapReportFindingInput> = {}): GapReportFindingInput {
  return {
    id: "f-1",
    title: "Login handler exists but lacks lockout",
    body: "Requirement asks for lockout; current code in auth.ts logs in but has no throttle; add attempt counting.",
    severity: "high",
    verificationStatus: "confirmed",
    verdict: "gap-confirmed",
    citations: [
      { filePath: "server/src/auth.ts", startLine: 10, endLine: 20, symbolId: "sym-a" } as Citation,
    ],
    ...overrides,
  };
}

function mapOf(...findings: GapReportFindingInput[]): Map<string, GapReportFindingInput> {
  return new Map(findings.map((f) => [f.id, f]));
}

describe("buildGapReport", () => {
  it("assembles a code-grounded gap report with cited current implementation", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement()],
      findingsById: mapOf(finding()),
    });

    expect(report.analysisId).toBe("an-1");
    expect(report.projectId).toBe("proj-1");
    expect(report.requirements).toHaveLength(1);
    const r = report.requirements[0]!;
    expect(r.requirementId).toBe("req-1");
    expect(r.coverage).toBe("grounded_in_code");
    expect(r.storyPoints).toBe(5);
    // current implementation cites code and is not a no-evidence report.
    expect(r.currentImplementation.hasEvidence).toBe(true);
    expect(r.currentImplementation.citedFindingCount).toBe(1);
    expect(r.currentImplementation.citations).toEqual([
      { filePath: "server/src/auth.ts", startLine: 10, endLine: 20, symbolId: "sym-a" },
    ]);
    expect(r.noEvidence).toBe(false);
    // gap narrative is the finding body verbatim (no re-derivation).
    expect(r.gapFindings).toHaveLength(1);
    expect(r.gapFindings[0]!.body).toContain("no throttle");
    expect(r.verificationStatus).toBe("confirmed");
  });

  it("renders an explicit no-evidence report when nothing cites code", () => {
    const docOnly = finding({
      verificationStatus: null,
      citations: [{ documentId: "doc-1", chunkIndex: 0 } as Citation],
    });
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement({ coverage: "no_evidence" })],
      findingsById: mapOf(docOnly),
    });
    const r = report.requirements[0]!;
    expect(r.currentImplementation.hasEvidence).toBe(false);
    expect(r.currentImplementation.citations).toEqual([]);
    expect(r.currentImplementation.citedFindingCount).toBe(0);
    expect(r.noEvidence).toBe(true);
    // The finding is still surfaced as a gap item (it just carries no code).
    expect(r.gapFindings).toHaveLength(1);
    expect(r.gapFindings[0]!.citations).toEqual([]);
  });

  it("passes storyPoints through unchanged and surfaces null as unestimated", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement({ storyPoints: null })],
      findingsById: mapOf(finding()),
    });
    expect(report.requirements[0]!.storyPoints).toBeNull();
  });

  it("dedupes identical code citations across findings and counts cited findings", () => {
    const shared: Citation = {
      filePath: "server/src/auth.ts",
      startLine: 10,
      endLine: 20,
      symbolId: "sym-a",
    } as Citation;
    const f1 = finding({ id: "f-1", citations: [shared] });
    const f2 = finding({
      id: "f-2",
      verificationStatus: "unverified",
      citations: [
        shared,
        { filePath: "server/src/session.ts", startLine: 1, endLine: 4 } as Citation,
      ],
    });
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement({ evidenceFindingIds: ["f-1", "f-2"] })],
      findingsById: mapOf(f1, f2),
    });
    const ci = report.requirements[0]!.currentImplementation;
    // shared citation appears once; distinct one is kept → 2 total.
    expect(ci.citations).toHaveLength(2);
    expect(ci.citedFindingCount).toBe(2);
  });

  it("orders confirmed + code-cited findings ahead of weaker evidence", () => {
    const weak = finding({
      id: "f-weak",
      verificationStatus: null,
      citations: [{ documentId: "doc-1", chunkIndex: 0 } as Citation],
    });
    const strong = finding({ id: "f-strong", verificationStatus: "confirmed" });
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      // evidence links list the weak finding first; the builder reorders.
      requirements: [requirement({ evidenceFindingIds: ["f-weak", "f-strong"] })],
      findingsById: mapOf(weak, strong),
    });
    expect(report.requirements[0]!.gapFindings.map((f) => f.id)).toEqual(["f-strong", "f-weak"]);
  });

  it("skips stale evidence links to findings that are no longer present", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement({ evidenceFindingIds: ["f-1", "gone"] })],
      findingsById: mapOf(finding()),
    });
    expect(report.requirements[0]!.gapFindings.map((f) => f.id)).toEqual(["f-1"]);
  });

  it("rolls verification up to unverified when a code claim was not confirmed", () => {
    const unconfirmed = finding({ verificationStatus: "unverified" });
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement()],
      findingsById: mapOf(unconfirmed),
    });
    expect(report.requirements[0]!.verificationStatus).toBe("unverified");
  });

  it("produces one honest empty report per requirement with no linked findings", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement({ evidenceFindingIds: [] })],
      findingsById: mapOf(),
    });
    const r = report.requirements[0]!;
    expect(r.gapFindings).toEqual([]);
    expect(r.noEvidence).toBe(true);
    expect(r.verificationStatus).toBeNull();
  });
});

/**
 * Issue #773 — the gap report surfaces finding bodies VERBATIM as the gap
 * narrative ("the finding body IS the gap narrative"), which is exactly how a
 * failed search became a work item. A `could-not-verify` finding must therefore
 * leave the gap narrative entirely.
 */
describe("#773 — could-not-verify is split out of the gap narrative", () => {
  it("keeps an unverifiable finding OUT of gapFindings", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement({ verdict: "could-not-verify", evidenceFindingIds: ["f-9"] })],
      findingsById: mapOf(
        finding({
          id: "f-9",
          title: "Could not verify: commit-SHA baselining",
          body: "Searches returned no usable results.",
          severity: "info",
          verificationStatus: "could-not-verify",
          verdict: "could-not-verify",
          citations: [],
        }),
      ),
    });

    const r = report.requirements[0]!;
    expect(r.gapFindings).toHaveLength(0);
    expect(r.unverifiedFindings).toHaveLength(1);
    expect(r.unverifiedFindings[0]!.verdict).toBe("could-not-verify");
    expect(r.verdict).toBe("could-not-verify");
  });

  it("keeps a CONFIRMED gap in gapFindings (anti-regression)", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement()],
      findingsById: mapOf(finding()),
    });

    const r = report.requirements[0]!;
    expect(r.gapFindings).toHaveLength(1);
    expect(r.unverifiedFindings).toHaveLength(0);
    expect(r.verdict).toBe("gap-confirmed");
  });

  it("carries the run's searched-scope provenance onto the report", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement()],
      findingsById: mapOf(finding()),
      retrieval: {
        successfulSearches: 3,
        failedSearches: 1,
        totalCalls: 4,
        requirementCount: 2,
        starved: false,
        degraded: false,
        searchedScope: [{ tool: "search_code_symbols", query: "lockout", hit: true }],
      },
    });

    expect(report.retrieval?.searchedScope[0]?.query).toBe("lockout");
    expect(report.retrieval?.degraded).toBe(false);
  });

  it("defaults retrieval to null for a run with no agentic code pass", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [],
      findingsById: mapOf(),
    });
    expect(report.retrieval).toBeNull();
  });
});

/**
 * Issue #825 — the DATABASE replay of the gap findings. `buildDatabaseChanges`
 * joins the schema-impact rows (1c / #823) with the cross-project consumer
 * enumeration (1b / #822); these tests pin the join, the dedupe/ordering, and —
 * critically — the safety distinction between "resolved with no consumers" and
 * "identity unresolved".
 */
function affectedRow(overrides: Partial<AffectedTableInput> = {}): AffectedTableInput {
  return {
    objectKind: "column",
    tableName: "public.orders",
    columnName: "status",
    columnType: "text",
    changeKind: "add-column",
    suggestedDdl: "ALTER TABLE public.orders ADD COLUMN status text;",
    source: "orm",
    reconciliation: "matched",
    confidence: 0.85,
    ...overrides,
  };
}

function consumersFor(overrides: Partial<AffectedSchemaConsumers> = {}): AffectedSchemaConsumers {
  return {
    tableName: "public.orders",
    columnName: "status",
    changeKind: "add-column",
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

describe("buildDatabaseChanges", () => {
  it("returns [] for undefined input and for an empty row set", () => {
    expect(buildDatabaseChanges(undefined)).toEqual([]);
    expect(buildDatabaseChanges({ rows: [], consumers: [] })).toEqual([]);
  });

  it("joins a row with its consumers by (table, column) and carries them through", () => {
    const changes = buildDatabaseChanges({ rows: [affectedRow()], consumers: [consumersFor()] });
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(c.tableName).toBe("public.orders");
    expect(c.columnName).toBe("status");
    expect(c.changeKind).toBe("add-column");
    expect(c.reconciliation).toBe("matched");
    expect(c.confidence).toBe(0.85);
    expect(c.suggestedDdl).toBe("ALTER TABLE public.orders ADD COLUMN status text;");
    expect(c.identityResolved).toBe(true);
    expect(c.consumers).toEqual([
      {
        projectId: "p-2",
        projectName: "billing",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ]);
    // 3a (#830) — the builder now classifies risk deterministically. The default
    // row is a plain nullable add-column ⇒ expanding (never a fabricated value).
    expect(c.riskClass).toBe("expanding");
  });

  it("renders resolved-with-zero-consumers DISTINCTLY from identity-unresolved", () => {
    const resolvedEmpty = buildDatabaseChanges({
      rows: [affectedRow()],
      consumers: [consumersFor({ identityResolved: true, consumers: [] })],
    });
    // Resolved: an empty (but present) consumer list — a real "no other project".
    expect(resolvedEmpty[0]!.identityResolved).toBe(true);
    expect(resolvedEmpty[0]!.consumers).toEqual([]);

    const unresolvedEntry = buildDatabaseChanges({
      rows: [affectedRow()],
      consumers: [consumersFor({ identityResolved: false, consumers: [] })],
    });
    // Unresolved: NO consumers field at all — "unknown", never "0 consumers".
    expect(unresolvedEntry[0]!.identityResolved).toBe(false);
    expect(unresolvedEntry[0]!.consumers).toBeUndefined();
  });

  it("treats a row with no matching consumer entry as identity-unresolved (unknown)", () => {
    const changes = buildDatabaseChanges({ rows: [affectedRow()], consumers: [] });
    expect(changes[0]!.identityResolved).toBe(false);
    expect(changes[0]!.consumers).toBeUndefined();
  });

  it("dedupes affected rows by (table, column), keeping the highest-confidence row", () => {
    const changes = buildDatabaseChanges({
      rows: [
        affectedRow({ confidence: 0.4, suggestedDdl: "low" }),
        affectedRow({ confidence: 0.95, suggestedDdl: "high" }),
      ],
      consumers: [],
    });
    expect(changes).toHaveLength(1);
    expect(changes[0]!.confidence).toBe(0.95);
    expect(changes[0]!.suggestedDdl).toBe("high");
  });

  it("orders changes by confidence (desc), then object label — deterministic", () => {
    const changes = buildDatabaseChanges({
      rows: [
        affectedRow({ tableName: "public.a", columnName: null, confidence: 0.6 }),
        affectedRow({ tableName: "public.z", columnName: null, confidence: 0.95 }),
        affectedRow({ tableName: "public.m", columnName: null, confidence: 0.6 }),
      ],
      consumers: [],
    });
    expect(changes.map((c) => c.tableName)).toEqual(["public.z", "public.a", "public.m"]);
  });

  it("passes an unreconciled (table-not-found) row through with its speculative DDL", () => {
    const changes = buildDatabaseChanges({
      rows: [
        affectedRow({
          tableName: "public.ghost",
          columnName: null,
          reconciliation: "table-not-found",
          changeKind: "add-table",
          confidence: 0.4,
          suggestedDdl: "-- CREATE TABLE public.ghost ( ... );",
        }),
      ],
      consumers: [],
    });
    expect(changes[0]!.reconciliation).toBe("table-not-found");
    expect(changes[0]!.changeKind).toBe("add-table");
    expect(changes[0]!.suggestedDdl).toContain("CREATE TABLE public.ghost");
  });

  it("classifies each row's riskClass deterministically (#830)", () => {
    const changes = buildDatabaseChanges({
      rows: [
        affectedRow({
          tableName: "public.a",
          columnName: "x",
          changeKind: "add-column",
          suggestedDdl: "ALTER TABLE public.a ADD COLUMN x text;",
          confidence: 0.9,
        }),
        affectedRow({
          tableName: "public.b",
          columnName: "y",
          changeKind: "drop-column",
          suggestedDdl: "ALTER TABLE public.b DROP COLUMN y;",
          confidence: 0.8,
        }),
        affectedRow({
          tableName: "public.c",
          columnName: "z",
          changeKind: "reference",
          suggestedDdl: "-- Verify column public.c.z — referenced by impacted code",
          confidence: 0.7,
        }),
      ],
      consumers: [],
    });
    const riskByTable = Object.fromEntries(changes.map((c) => [c.tableName, c.riskClass]));
    expect(riskByTable["public.a"]).toBe("expanding");
    expect(riskByTable["public.b"]).toBe("breaking");
    expect(riskByTable["public.c"]).toBe("neutral");
  });
});

/**
 * Issue #831 — cross-project breaking-change escalation. A `breaking` change on a
 * shared object with a RESOLVED identity and ≥1 enumerated consumer is the
 * CRITICAL case (`crossProjectBreaking: true`), grounded in the enumerated
 * consumers (1b / #822) — never guessed. Anything less (unresolved identity, no
 * consumers, or a non-breaking risk class) is NEVER escalated.
 */
function breakingRow(overrides: Partial<AffectedTableInput> = {}): AffectedTableInput {
  return affectedRow({
    changeKind: "drop-column",
    suggestedDdl: "ALTER TABLE public.orders DROP COLUMN status;",
    ...overrides,
  });
}

describe("buildDatabaseChanges — #831 cross-project breaking escalation", () => {
  it("escalates a BREAKING change with a resolved identity + a reading consumer to CRITICAL", () => {
    const changes = buildDatabaseChanges({
      rows: [breakingRow()],
      consumers: [consumersFor()],
    });
    const c = changes[0]!;
    expect(c.riskClass).toBe("breaking");
    expect(c.identityResolved).toBe(true);
    expect(c.crossProjectBreaking).toBe(true);
    // The escalation is GROUNDED — the consumer list is still carried alongside.
    expect(c.consumers).toEqual([
      {
        projectId: "p-2",
        projectName: "billing",
        usage: "readBy",
        objectQualifiedName: "public.orders",
      },
    ]);
  });

  it("also escalates when the sole consumer WRITES the object (reads/writes both count)", () => {
    const changes = buildDatabaseChanges({
      rows: [breakingRow()],
      consumers: [
        consumersFor({
          consumers: [
            {
              projectId: "p-3",
              projectName: "warehouse",
              usage: "writtenBy",
              objectQualifiedName: "public.orders",
            },
          ],
        }),
      ],
    });
    expect(changes[0]!.crossProjectBreaking).toBe(true);
  });

  it("does NOT escalate a BREAKING change with consumers when identity is UNRESOLVED", () => {
    const changes = buildDatabaseChanges({
      rows: [breakingRow()],
      // Identity unresolved ⇒ the consumer list is dropped entirely (unknown).
      consumers: [consumersFor({ identityResolved: false, consumers: [] })],
    });
    const c = changes[0]!;
    expect(c.riskClass).toBe("breaking");
    expect(c.identityResolved).toBe(false);
    expect(c.consumers).toBeUndefined();
    // Never escalate on unconfirmed identity — stays "could-not-verify" (#826).
    expect(c.crossProjectBreaking).toBeUndefined();
  });

  it("does NOT escalate a BREAKING change on a resolved object with ZERO consumers", () => {
    const changes = buildDatabaseChanges({
      rows: [breakingRow()],
      consumers: [consumersFor({ identityResolved: true, consumers: [] })],
    });
    const c = changes[0]!;
    expect(c.riskClass).toBe("breaking");
    expect(c.identityResolved).toBe(true);
    expect(c.consumers).toEqual([]);
    expect(c.crossProjectBreaking).toBeUndefined();
  });

  it("does NOT escalate an EXPANDING change even with a resolved reading consumer", () => {
    // The default affectedRow() is a plain nullable add-column ⇒ expanding.
    const changes = buildDatabaseChanges({
      rows: [affectedRow()],
      consumers: [consumersFor()],
    });
    const c = changes[0]!;
    expect(c.riskClass).toBe("expanding");
    expect(c.consumers).toHaveLength(1);
    expect(c.crossProjectBreaking).toBeUndefined();
  });

  it("does NOT escalate a NEUTRAL (reference) change even with a resolved consumer", () => {
    const changes = buildDatabaseChanges({
      rows: [
        affectedRow({
          changeKind: "reference",
          suggestedDdl: "-- Verify column public.orders.status — referenced by impacted code",
        }),
      ],
      consumers: [consumersFor()],
    });
    const c = changes[0]!;
    expect(c.riskClass).toBe("neutral");
    expect(c.consumers).toHaveLength(1);
    expect(c.crossProjectBreaking).toBeUndefined();
  });

  it("column-level precision: dropping column X is not escalated by a consumer entry for column Y", () => {
    // The affected object is `status`; the ONLY consumer entry is keyed to a
    // DIFFERENT column (`total`) of the same table, so it never joins — the
    // status row stays identity-unresolved and is not escalated.
    const changes = buildDatabaseChanges({
      rows: [breakingRow({ columnName: "status" })],
      consumers: [
        consumersFor({
          columnName: "total",
          identityResolved: true,
          consumers: [
            {
              projectId: "p-2",
              projectName: "billing",
              usage: "readBy",
              objectQualifiedName: "public.orders",
            },
          ],
        }),
      ],
    });
    const statusChange = changes.find((c) => c.columnName === "status")!;
    expect(statusChange.riskClass).toBe("breaking");
    expect(statusChange.identityResolved).toBe(false);
    expect(statusChange.crossProjectBreaking).toBeUndefined();
  });

  it("escalates only the breaking+consumer rows in a mixed batch (per-object)", () => {
    const changes = buildDatabaseChanges({
      rows: [
        // Breaking + resolved consumer ⇒ CRITICAL.
        breakingRow({ tableName: "public.orders", columnName: "status", confidence: 0.9 }),
        // Breaking but NO consumers ⇒ not escalated.
        breakingRow({ tableName: "public.audit", columnName: "note", confidence: 0.8 }),
        // Expanding + consumer ⇒ not escalated.
        affectedRow({ tableName: "public.ledger", columnName: "memo", confidence: 0.7 }),
      ],
      consumers: [
        consumersFor({ tableName: "public.orders", columnName: "status" }),
        consumersFor({ tableName: "public.ledger", columnName: "memo" }),
      ],
    });
    const byTable = Object.fromEntries(changes.map((c) => [c.tableName, c.crossProjectBreaking]));
    expect(byTable["public.orders"]).toBe(true);
    expect(byTable["public.audit"]).toBeUndefined();
    expect(byTable["public.ledger"]).toBeUndefined();
  });
});

describe("buildGapReport — databaseChanges threading (#825)", () => {
  it("attaches per-requirement databaseChanges from the schema-impact map", () => {
    const schemaImpact = new Map<string, GapReportSchemaImpactInput>([
      ["req-1", { rows: [affectedRow()], consumers: [consumersFor()] }],
    ]);
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement()],
      findingsById: mapOf(finding()),
      schemaImpactByRequirementId: schemaImpact,
    });
    const r = report.requirements[0]!;
    expect(r.databaseChanges).toHaveLength(1);
    expect(r.databaseChanges![0]!.tableName).toBe("public.orders");
  });

  it("omits databaseChanges entirely when a requirement has no schema impact", () => {
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement()],
      findingsById: mapOf(finding()),
      // No map at all → no requirement gets a database section.
    });
    expect(report.requirements[0]!.databaseChanges).toBeUndefined();
  });

  it("omits databaseChanges for a requirement whose schema-impact rows are empty", () => {
    const schemaImpact = new Map<string, GapReportSchemaImpactInput>([
      ["req-1", { rows: [], consumers: [] }],
    ]);
    const report = buildGapReport({
      analysisId: "an-1",
      projectId: "proj-1",
      requirements: [requirement()],
      findingsById: mapOf(finding()),
      schemaImpactByRequirementId: schemaImpact,
    });
    expect(report.requirements[0]!.databaseChanges).toBeUndefined();
  });
});
