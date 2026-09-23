/**
 * Issue #965 (Epic #960) — deterministic impact-drift differ unit tests.
 *
 * Covers the determinism guard (identical runs ⇒ empty diff), tables/symbols
 * added/removed, tier changes, confidence/severity deltas, requirement add/remove,
 * and the nullable-`requirementId` text-key path.
 */
import { describe, expect, it } from "vitest";
import type {
  ImpactAffectedSymbolView,
  ImpactAffectedTableView,
  ImpactAnalysisDetail,
  ImpactItemView,
} from "@metis/shared";
import { diffImpactRuns, fnv1aHex, requirementDriftKey } from "./impact-drift.js";

// ---- Builders --------------------------------------------------------------

function table(
  tableName: string,
  opts: Partial<ImpactAffectedTableView> = {},
): ImpactAffectedTableView {
  return {
    id: `t-${tableName}-${opts.columnName ?? ""}`,
    objectKind: "table",
    tableName,
    columnName: opts.columnName ?? null,
    columnType: null,
    changeKind: "reference",
    suggestedDdl: null,
    source: "mybatis",
    reconciliation: null,
    confidence: 0.5,
    riskClass: null,
    relevanceTier: opts.relevanceTier ?? null,
    relevanceRationale: null,
    ...opts,
  };
}

function symbol(qualifiedName: string, filePath = `${qualifiedName}.ts`): ImpactAffectedSymbolView {
  return {
    id: `s-${qualifiedName}`,
    codeSymbolId: qualifiedName,
    filePath,
    qualifiedName,
    startLine: 1,
    endLine: 2,
    relation: "direct",
    depth: 0,
    confidence: 0.9,
  };
}

function item(opts: Partial<ImpactItemView> & { projectId: string }): ImpactItemView {
  return {
    id: `item-${Math.random()}`,
    projectId: opts.projectId,
    requirementId: opts.requirementId ?? null,
    requirementTitle: opts.requirementTitle ?? null,
    changeType: "modified",
    severity: opts.severity ?? "medium",
    impactScore: 0.5,
    confidence: opts.confidence ?? 0.7,
    matchQuality: "moderate",
    matchQualityReason: null,
    affectedFileCount: 1,
    affectedSymbolCount: (opts.affectedSymbols ?? []).length,
    summary: null,
    affectedSymbols: opts.affectedSymbols ?? [],
    affectedTests: opts.affectedTests ?? [],
    writePathGaps: [],
    affectedTables: opts.affectedTables ?? [],
    affectedTablesSecondary: opts.affectedTablesSecondary ?? [],
    feedback: [],
  };
}

function detail(id: string, items: ImpactItemView[]): ImpactAnalysisDetail {
  return {
    id,
    status: "completed",
    documentId: null,
    sourceText: "requirement change text",
    summary: null,
    errorMessage: null,
    totalImpactedSymbols: items.reduce((n, i) => n + i.affectedSymbolCount, 0),
    startedAt: "2026-07-20T00:00:00.000Z",
    completedAt: "2026-07-20T00:01:00.000Z",
    projectIds: [...new Set(items.map((i) => i.projectId))],
    startedById: "user-1",
    items,
    sharedTableImpacts: [],
    rerunOfId: id === "head" ? "base" : null,
  };
}

// ---- fnv1aHex / requirementDriftKey ---------------------------------------

describe("fnv1aHex", () => {
  it("is deterministic and 8-char hex, distinguishing distinct inputs", () => {
    expect(fnv1aHex("account.status")).toBe(fnv1aHex("account.status"));
    expect(fnv1aHex("account.status")).toMatch(/^[0-9a-f]{8}$/);
    expect(fnv1aHex("a")).not.toBe(fnv1aHex("b"));
    expect(fnv1aHex("")).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe("requirementDriftKey", () => {
  it("keys on requirementId when present (pipe-delimited, NUL-free)", () => {
    const key = requirementDriftKey({
      projectId: "proj-1",
      requirementId: "req-9",
      requirementTitle: "ignored",
    });
    expect(key).toBe("proj-1|req:req-9");
    expect(key).not.toContain("\u0000");
  });

  it("falls back to a title text-hash when requirementId is null", () => {
    const a = requirementDriftKey({
      projectId: "proj-1",
      requirementId: null,
      requirementTitle: "Account status field",
    });
    const b = requirementDriftKey({
      projectId: "proj-1",
      requirementId: null,
      requirementTitle: "Signon flow",
    });
    expect(a).toBe(`proj-1|txt:${fnv1aHex("Account status field")}`);
    expect(a).not.toBe(b);
    expect(a).not.toContain("\u0000");
  });
});

// ---- diffImpactRuns --------------------------------------------------------

describe("diffImpactRuns — determinism guard", () => {
  it("identical runs ⇒ empty diff, all-zero summary", () => {
    const items = [
      item({
        projectId: "p1",
        requirementId: "r1",
        affectedTables: [table("account")],
        affectedSymbols: [symbol("acct.update")],
      }),
    ];
    const base = detail("base", items);
    // Head is content-identical (different id/timestamps only).
    const head = detail("head", structuredClone(items));

    const report = diffImpactRuns(base, head);
    expect(report.requirements).toEqual([]);
    expect(report.baseAnalysisId).toBe("base");
    expect(report.headAnalysisId).toBe("head");
    expect(report.summary).toMatchObject({
      requirementsChanged: 0,
      requirementsAdded: 0,
      requirementsRemoved: 0,
      requirementsUnchanged: 1,
      tablesAdded: 0,
      symbolsAdded: 0,
    });
  });
});

describe("diffImpactRuns — tables & symbols", () => {
  it("surfaces a new affected table + symbol added in the head run", () => {
    const base = detail("base", [
      item({
        projectId: "p1",
        requirementId: "r1",
        requirementTitle: "Account status",
        affectedTables: [table("account")],
        affectedSymbols: [symbol("acct.read")],
      }),
    ]);
    const head = detail("head", [
      item({
        projectId: "p1",
        requirementId: "r1",
        requirementTitle: "Account status",
        affectedTables: [table("account"), table("account", { columnName: "status" })],
        affectedSymbols: [symbol("acct.read"), symbol("acct.setStatus")],
      }),
    ]);

    const report = diffImpactRuns(base, head);
    expect(report.requirements).toHaveLength(1);
    const d = report.requirements[0];
    expect(d.status).toBe("changed");
    expect(d.tablesAdded).toEqual(["account.status"]);
    expect(d.tablesRemoved).toEqual([]);
    expect(d.symbolsAdded).toEqual(["acct.setStatus.ts::acct.setStatus"]);
    expect(report.summary.tablesAdded).toBe(1);
    expect(report.summary.symbolsAdded).toBe(1);
  });

  it("surfaces a table no longer affected (removed)", () => {
    const base = detail("base", [
      item({
        projectId: "p1",
        requirementId: "r1",
        affectedTables: [table("account"), table("signon")],
        affectedSymbols: [symbol("acct.read")],
      }),
    ]);
    const head = detail("head", [
      item({
        projectId: "p1",
        requirementId: "r1",
        affectedTables: [table("account")],
        affectedSymbols: [symbol("acct.read")],
      }),
    ]);

    const d = diffImpactRuns(base, head).requirements[0];
    expect(d.tablesRemoved).toEqual(["signon"]);
    expect(d.tablesAdded).toEqual([]);
  });

  it("detects a relevance-tier change on a table present in both", () => {
    const base = detail("base", [
      item({
        projectId: "p1",
        requirementId: "r1",
        affectedTables: [table("account", { relevanceTier: "possible" })],
      }),
    ]);
    const head = detail("head", [
      item({
        projectId: "p1",
        requirementId: "r1",
        affectedTablesSecondary: [table("account", { relevanceTier: "unlikely" })],
      }),
    ]);

    const d = diffImpactRuns(base, head).requirements[0];
    expect(d.status).toBe("changed");
    expect(d.tablesTierChanged).toEqual([
      { tableName: "account", columnName: null, fromTier: "possible", toTier: "unlikely" },
    ]);
    expect(d.tablesAdded).toEqual([]);
    expect(d.tablesRemoved).toEqual([]);
  });
});

describe("diffImpactRuns — confidence & severity", () => {
  it("reports confidence delta and severity change", () => {
    const base = detail("base", [
      item({ projectId: "p1", requirementId: "r1", confidence: 0.5, severity: "low" }),
    ]);
    const head = detail("head", [
      item({ projectId: "p1", requirementId: "r1", confidence: 0.8, severity: "high" }),
    ]);

    const d = diffImpactRuns(base, head).requirements[0];
    expect(d.status).toBe("changed");
    expect(d.confidenceDelta).toBeCloseTo(0.3, 5);
    expect(d.severityChanged).toEqual({ from: "low", to: "high" });
  });
});

describe("diffImpactRuns — requirement add/remove", () => {
  it("marks requirements only in head as added and only in base as removed", () => {
    const base = detail("base", [
      item({ projectId: "p1", requirementId: "r-gone", affectedSymbols: [symbol("gone.fn")] }),
      item({ projectId: "p1", requirementId: "r-keep", affectedSymbols: [symbol("keep.fn")] }),
    ]);
    const head = detail("head", [
      item({ projectId: "p1", requirementId: "r-keep", affectedSymbols: [symbol("keep.fn")] }),
      item({ projectId: "p1", requirementId: "r-new", affectedSymbols: [symbol("new.fn")] }),
    ]);

    const report = diffImpactRuns(base, head);
    const byStatus = Object.fromEntries(
      report.requirements.map((d) => [d.requirementId, d.status]),
    );
    expect(byStatus["r-gone"]).toBe("removed");
    expect(byStatus["r-new"]).toBe("added");
    // r-keep is unchanged ⇒ excluded from the list.
    expect(byStatus["r-keep"]).toBeUndefined();
    expect(report.summary.requirementsAdded).toBe(1);
    expect(report.summary.requirementsRemoved).toBe(1);
    expect(report.summary.requirementsUnchanged).toBe(1);
  });
});

describe("diffImpactRuns — nullable requirementId (text key)", () => {
  it("diffs free-text runs by requirement title hash, not id", () => {
    const base = detail("base", [
      item({
        projectId: "p1",
        requirementId: null,
        requirementTitle: "Add account status field",
        affectedTables: [table("account")],
      }),
      item({
        projectId: "p1",
        requirementId: null,
        requirementTitle: "Remove signon banner",
        affectedTables: [table("signon")],
      }),
    ]);
    const head = detail("head", [
      // Same first requirement (by title) now touches an extra column.
      item({
        projectId: "p1",
        requirementId: null,
        requirementTitle: "Add account status field",
        affectedTables: [table("account"), table("account", { columnName: "status" })],
      }),
      // The signon requirement is gone from head.
    ]);

    const report = diffImpactRuns(base, head);
    const changed = report.requirements.find(
      (d) => d.requirementTitle === "Add account status field",
    );
    const removed = report.requirements.find((d) => d.requirementTitle === "Remove signon banner");
    expect(changed?.status).toBe("changed");
    expect(changed?.tablesAdded).toEqual(["account.status"]);
    expect(removed?.status).toBe("removed");
  });
});
