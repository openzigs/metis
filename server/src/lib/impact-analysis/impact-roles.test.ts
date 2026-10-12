/**
 * #1036 — which affected symbols are edit candidates (depth 0) and which are
 * blast radius.
 */
import { describe, expect, it } from "vitest";
import { impactSymbolRole } from "@metis/shared";
import type { DataPathWriter } from "./data-path-writers.js";
import {
  assignImpactRoles,
  DATA_MODEL_CONFIDENCE,
  tablesGainingColumns,
  type RoleSymbol,
} from "./impact-roles.js";
import type { AffectedTableInput, CodeSymbolDetail } from "./schema-impact.js";

const ENTRY = "internal/storage/entry.go";

function sym(
  id: string,
  filePath: string,
  relation: RoleSymbol["relation"],
  depth: number,
  confidence = 0.5,
): RoleSymbol {
  return {
    codeSymbolId: id,
    filePath,
    qualifiedName: `${filePath}::${id}`,
    startLine: 1,
    endLine: 9,
    relation,
    depth,
    confidence,
  };
}

function writer(id: string, over: Partial<DataPathWriter> = {}): DataPathWriter {
  return {
    id,
    qualifiedName: `${ENTRY}::${id}`,
    filePath: ENTRY,
    startLine: 1,
    endLine: 9,
    confidence: 0.6,
    columns: ["entries.status"],
    namesRequirementColumn: false,
    ...over,
  };
}

const none = { writers: [], growingTables: [], dataModel: [], related: [] };
const roleOf = (out: RoleSymbol[], id: string) =>
  impactSymbolRole(out.find((s) => s.codeSymbolId === id)!);

describe("assignImpactRoles — lineage writers (#1036)", () => {
  // The #4386 shape: a UI pagination bug whose seeds are all in internal/ui.
  const uiSeed = sym("showFeedEntriesPage", "internal/ui/feed_entries.go", "direct", 0, 1);
  const statusWriter = sym("SetEntriesStatus", ENTRY, "data-writer", 1, 0.6);

  it("leaves a writer in the blast radius when only the lineage points at it", () => {
    const out = assignImpactRoles([uiSeed, statusWriter], {
      ...none,
      writers: [writer("SetEntriesStatus")],
    });
    expect(roleOf(out, "SetEntriesStatus")).toBe("blast-radius");
    expect(roleOf(out, "showFeedEntriesPage")).toBe("edit-candidate");
  });

  it("promotes a writer that sits in a file the seeding selected", () => {
    const storageSeed = sym("MarkAllAsReadBeforeDate", ENTRY, "direct", 0, 0.9);
    const out = assignImpactRoles([storageSeed, statusWriter], {
      ...none,
      writers: [writer("SetEntriesStatus")],
    });
    expect(roleOf(out, "SetEntriesStatus")).toBe("edit-candidate");
  });

  it("promotes a writer of a column the request names as an identifier", () => {
    const out = assignImpactRoles([uiSeed, statusWriter], {
      ...none,
      writers: [writer("SetEntriesStatus", { namesRequirementColumn: true })],
    });
    expect(roleOf(out, "SetEntriesStatus")).toBe("edit-candidate");
  });

  it("promotes a writer of a table that gains a column, schema prefix or not", () => {
    const out = assignImpactRoles([uiSeed, statusWriter], {
      ...none,
      writers: [writer("SetEntriesStatus", { columns: ["public.entries.status"] })],
      growingTables: ["entries"],
    });
    expect(roleOf(out, "SetEntriesStatus")).toBe("edit-candidate");
  });

  it("does not promote a writer of a DIFFERENT table than the one gaining a column", () => {
    const out = assignImpactRoles([uiSeed, statusWriter], {
      ...none,
      writers: [writer("SetEntriesStatus")],
      growingTables: ["feeds"],
    });
    expect(roleOf(out, "SetEntriesStatus")).toBe("blast-radius");
  });

  it("does not promote a data-writer row it has no writer profile for", () => {
    const out = assignImpactRoles([sym("seed", ENTRY, "direct", 0), statusWriter], none);
    expect(roleOf(out, "SetEntriesStatus")).toBe("blast-radius");
  });

  it("never promotes a caller, even one in a selected file", () => {
    const caller = sym("handler", ENTRY, "caller", 1);
    const out = assignImpactRoles([sym("seed", ENTRY, "direct", 0), caller], {
      ...none,
      writers: [writer("handler")],
    });
    expect(roleOf(out, "handler")).toBe("blast-radius");
  });
});

describe("assignImpactRoles — data model of a table that gains a column (#1036)", () => {
  const model: CodeSymbolDetail = {
    id: "Entry",
    kind: "class",
    qualifiedName: "internal/model/entry.go::Entry",
    filePath: "internal/model/entry.go",
    startLine: 27,
    endLine: 60,
    language: "go",
  };

  it("adds the definition and the types as edit candidates", () => {
    const out = assignImpactRoles([sym("seed", ENTRY, "direct", 0, 1)], {
      ...none,
      dataModel: [model],
    });
    expect(out.find((s) => s.codeSymbolId === "Entry")).toEqual({
      codeSymbolId: "Entry",
      filePath: "internal/model/entry.go",
      qualifiedName: "internal/model/entry.go::Entry",
      startLine: 27,
      endLine: 60,
      relation: "data-model",
      depth: 0,
      confidence: DATA_MODEL_CONFIDENCE,
    });
  });

  it("replaces a caller row for the same symbol with the stronger claim", () => {
    const out = assignImpactRoles([sym("Entry", "internal/model/entry.go", "caller", 2)], {
      ...none,
      dataModel: [model],
    });
    expect(out.filter((s) => s.codeSymbolId === "Entry")).toHaveLength(1);
    expect(out[0]!.relation).toBe("data-model");
    expect(out[0]!.depth).toBe(0);
  });

  it("leaves a symbol the seeding already selected as it was", () => {
    const seeded = sym("Entry", "internal/model/entry.go", "direct", 0, 0.9);
    const out = assignImpactRoles([seeded], { ...none, dataModel: [model] });
    expect(out).toEqual([seeded]);
  });
});

describe("assignImpactRoles — what was retrieved but not selected (#1036)", () => {
  const match = (id: string, confidence: number) => ({
    codeSymbolId: id,
    filePath: `pkg/${id}.go`,
    qualifiedName: `pkg/${id}.go::${id}`,
    startLine: 3,
    endLine: 8,
    confidence,
  });

  it("appends it as blast radius, after the edit candidates", () => {
    const out = assignImpactRoles([sym("seed", ENTRY, "direct", 0, 1)], {
      ...none,
      related: [match("R", 0.4)],
    });
    expect(out.map((s) => [s.codeSymbolId, s.relation, s.depth])).toEqual([
      ["seed", "direct", 0],
      ["R", "related", 1],
    ]);
  });

  it("does not repeat a symbol the graph walk already listed", () => {
    const caller = sym("R", "pkg/R.go", "caller", 1, 0.7);
    const out = assignImpactRoles([caller], { ...none, related: [match("R", 0.4)] });
    expect(out).toEqual([caller]);
  });

  it("does not list the same retrieved symbol twice", () => {
    const out = assignImpactRoles([], { ...none, related: [match("R", 0.4), match("R", 0.3)] });
    expect(out).toHaveLength(1);
  });

  it("returns the list unchanged when there is nothing to settle", () => {
    const symbols = [sym("a", ENTRY, "direct", 0, 0.9), sym("b", ENTRY, "caller", 1, 0.5)];
    expect(assignImpactRoles(symbols, none)).toEqual(symbols);
  });

  it("sorts by depth, then confidence", () => {
    const out = assignImpactRoles([sym("far", ENTRY, "caller", 2, 0.9)], {
      ...none,
      related: [match("low", 0.1), match("high", 0.5)],
    });
    expect(out.map((s) => s.codeSymbolId)).toEqual(["high", "low", "far"]);
  });
});

describe("tablesGainingColumns (#1036)", () => {
  const rowOf = (tableName: string, changeKind: AffectedTableInput["changeKind"]) =>
    ({ tableName, changeKind }) as AffectedTableInput;

  it("lists each table with an add-column row once", () => {
    expect(
      tablesGainingColumns([
        rowOf("entries", "reference"),
        rowOf("entries", "add-column"),
        rowOf("entries", "add-column"),
        rowOf("feeds", "add-column"),
        rowOf("users", "reference"),
      ]),
    ).toEqual(["entries", "feeds"]);
  });

  it("is empty when nothing gains a column", () => {
    expect(tablesGainingColumns([rowOf("entries", "reference")])).toEqual([]);
  });
});
