/**
 * Unit tests for the "Used objects" schema-doc classification section — Epic
 * #292 (#299).
 *
 * `buildUsageClassificationSection` is a PURE markdown builder consuming the
 * persisted classification views (#297). It must:
 *   - list every table/column with its used/unreferenced/uncertain class,
 *   - cite evidence references,
 *   - label `uncertain` clearly and NEVER describe anything as removable/drop,
 *   - leave the full-schema documentation untouched (tested by absence of any
 *     mutation to the existing assembleDocument output — covered indirectly).
 */
import { describe, expect, it } from "vitest";
import type { SchemaUsageClassificationView } from "@metis/shared";
import { buildUsageClassificationSection } from "../src/lib/docs-gen/db-schema-synthesizer.js";

function view(over: Partial<SchemaUsageClassificationView>): SchemaUsageClassificationView {
  return {
    id: "c1",
    projectId: "p1",
    kind: "table",
    tableName: "public.users",
    columnName: null,
    columnType: null,
    usageClass: "used",
    uncertainReason: null,
    evidence: [],
    overriddenClass: null,
    computedAt: "2026-06-18T00:00:00.000Z",
    ...over,
  };
}

describe("buildUsageClassificationSection", () => {
  it("returns an empty string when there is no classification (section omitted)", () => {
    expect(buildUsageClassificationSection([])).toBe("");
  });

  it("renders a heading and a row per object with its class", () => {
    const md = buildUsageClassificationSection([
      view({
        tableName: "public.users",
        usageClass: "used",
        evidence: [
          {
            edgeKind: "reads",
            source: "mybatis",
            fromQualifiedName: "UserMapper.findById",
            reconciliation: "matched",
          },
        ],
      }),
      view({
        id: "c2",
        tableName: "public.audit_log",
        usageClass: "unreferenced",
      }),
    ]);
    expect(md).toContain("## Used Objects");
    expect(md).toContain("public.users");
    expect(md).toContain("public.audit_log");
    expect(md).toContain("used");
    expect(md).toContain("unreferenced");
    // Evidence reference cited.
    expect(md).toContain("UserMapper.findById");
  });

  it("labels uncertain clearly with its reason and never uses drop/remove language", () => {
    const md = buildUsageClassificationSection([
      view({
        tableName: "public.legacy",
        usageClass: "uncertain",
        uncertainReason: "table-not-found",
        existsInSchema: false as never,
      }),
      view({
        id: "c3",
        kind: "column",
        tableName: "public.orders",
        columnName: "ts",
        usageClass: "unreferenced",
      }),
    ]);
    expect(md.toLowerCase()).toContain("uncertain");
    expect(md).toContain("table-not-found");
    // Safety: the doc must never describe any object as droppable/removable.
    const lower = md.toLowerCase();
    expect(lower).not.toContain("safe to drop");
    expect(lower).not.toContain("can be dropped");
    expect(lower).not.toContain("can be removed");
    expect(lower).not.toMatch(/\bdrop\b/);
  });

  it("notes that unreferenced objects are review candidates only (no auto-drop)", () => {
    const md = buildUsageClassificationSection([
      view({ tableName: "public.t", usageClass: "unreferenced" }),
    ]);
    const lower = md.toLowerCase();
    expect(lower).toContain("review");
    // No language asserting removal.
    expect(lower).not.toMatch(/\bdrop\b/);
  });

  it("escapes pipe characters in identifiers so the markdown table stays valid", () => {
    const md = buildUsageClassificationSection([
      view({ tableName: "weird|name", usageClass: "used" }),
    ]);
    expect(md).not.toContain("weird|name");
    expect(md).toContain("weird\\|name");
  });

  it("groups columns under their table identity in the rows", () => {
    const md = buildUsageClassificationSection([
      view({ kind: "table", tableName: "public.orders", usageClass: "used" }),
      view({
        id: "x",
        kind: "column",
        tableName: "public.orders",
        columnName: "total",
        usageClass: "unreferenced",
      }),
    ]);
    expect(md).toContain("public.orders");
    expect(md).toContain("total");
  });
});
