import { describe, expect, it } from "vitest";
import {
  fingerprintInputs,
  isGraphRowsOnlyChange,
  isRunStableItem,
  planRegeneration,
  withRunStableItemsOf,
} from "./regeneration-plan.js";

describe("withRunStableItemsOf (#1230)", () => {
  const graphs = { g: { rows: "r", mark: null } };
  const captured = fingerprintInputs({ "source:a:0": "s1", approvedRequirements: "old" }, graphs);

  it("compares a run's approved requirements as it captured them", () => {
    const fresh = fingerprintInputs({ "source:a:0": "s1", approvedRequirements: "new" }, graphs);
    const compared = withRunStableItemsOf(fresh, captured);
    expect(compared.fingerprint).toBe(captured.fingerprint);
    expect(compared.graphs).toEqual(graphs);
    expect(isRunStableItem("approvedRequirements")).toBe(true);
    expect(isRunStableItem("source:a:0")).toBe(false);
  });

  it("keeps every other difference", () => {
    const fresh = fingerprintInputs({ "source:a:0": "s2", approvedRequirements: "new" }, graphs);
    expect(withRunStableItemsOf(fresh, captured).fingerprint).not.toBe(captured.fingerprint);
  });

  it("drops an item the run never captured, and returns an agreeing snapshot as is", () => {
    const without = fingerprintInputs({ "source:a:0": "s1" });
    const fresh = fingerprintInputs({ "source:a:0": "s1", approvedRequirements: "new" });
    expect(withRunStableItemsOf(fresh, without).fingerprint).toBe(without.fingerprint);
    expect(withRunStableItemsOf(without, without)).toBe(without);
  });
});

describe("isGraphRowsOnlyChange (#1071)", () => {
  const base = {
    "symbol:aaa:0": "s1",
    "edge:bbb:0": "e1",
    "finding:ccc:0": "f1",
    "source:ddd:0": "src1",
    "sql:eee:0": "sql1",
    "evidence:fff:0": "ev1",
    "repository:ggg:0": "true",
    settings: "set1",
    web: "w1",
  };
  const before = fingerprintInputs(base);
  /** The graph rows as a newer extractor writes them: other keys, other values. */
  const rewritten = {
    ...base,
    "symbol:aaa:0": undefined,
    "symbol:zzz:0": "s1",
    "edge:bbb:0": "e2",
    "finding:ccc:0": undefined,
    "finding:yyy:0": "f1",
  };
  const snap = (items: Record<string, string | undefined>) =>
    fingerprintInputs(
      Object.fromEntries(Object.entries(items).filter(([, v]) => v !== undefined)) as Record<
        string,
        string
      >,
    );

  it("is true when graph rows, and only graph rows, differ — in either direction", () => {
    const after = snap(rewritten);
    expect(planRegeneration(before, after).mode).toBe("full");
    expect(isGraphRowsOnlyChange(before, after)).toBe(true);
    expect(isGraphRowsOnlyChange(after, before)).toBe(true);
  });

  it.each([
    ["a symbol row", { "symbol:aaa:0": "s2" }],
    ["an added edge row", { "edge:new:0": "e" }],
    ["a removed finding row", { "finding:ccc:0": undefined }],
  ])("is true for %s alone", (_label, change) => {
    expect(isGraphRowsOnlyChange(before, snap({ ...base, ...change }))).toBe(true);
  });

  it.each([
    ["a source file changed", { "source:ddd:0": "src2" }],
    ["a source file was added", { "source:new:0": "src" }],
    ["a source file was removed", { "source:ddd:0": undefined }],
    ["a SQL file changed", { "sql:eee:0": "sql2" }],
    ["the evidence pool changed", { "evidence:fff:0": "ev2" }],
    ["a repository became unavailable", { "repository:ggg:0": "false" }],
    ["the settings changed", { settings: "set2" }],
    ["the web research changed", { web: "w2" }],
  ])("is false when, besides graph rows, %s", (_label, change) => {
    expect(isGraphRowsOnlyChange(before, snap({ ...rewritten, ...change }))).toBe(false);
    // And when that is the ONLY change.
    expect(isGraphRowsOnlyChange(before, snap({ ...base, ...change }))).toBe(false);
  });

  it("is false for identical snapshots and for a document with no baseline", () => {
    expect(isGraphRowsOnlyChange(before, before)).toBe(false);
    expect(isGraphRowsOnlyChange(null, before)).toBe(false);
  });

  it("does not take a key that merely starts like a graph kind for a graph row", () => {
    expect(isGraphRowsOnlyChange(before, snap({ ...rewritten, "symbols-export:1": "x" }))).toBe(
      false,
    );
    expect(isGraphRowsOnlyChange(before, snap({ ...rewritten, "edges:1": "x" }))).toBe(false);
  });
});

describe("immutable regeneration planning (#1356)", () => {
  it("is order independent and compares every entry, including deletions beyond 20", () => {
    const items = Object.fromEntries(
      Array.from({ length: 35 }, (_, i) => [`repo:r:s${i}`, `${i}`]),
    );
    const before = fingerprintInputs(items);
    expect(fingerprintInputs(Object.fromEntries(Object.entries(items).reverse()))).toEqual(before);
    delete items["repo:r:s34"];
    expect(planRegeneration(before, fingerprintInputs(items))).toMatchObject({
      mode: "full",
      changed: ["repo:r:s34"],
      reason: "Dependency completeness is not recorded",
    });
  });

  it("does not regenerate identical inputs", () => {
    const snapshot = fingerprintInputs({ source: "a" });
    expect(planRegeneration(snapshot, snapshot)).toEqual({ mode: "unchanged", changed: [] });
  });

  it("requires complete dependency mappings, including absence-sensitive additions", () => {
    const before = fingerprintInputs({ a: "1", b: "1" });
    const after = fingerprintInputs({ a: "2", b: "1" });
    const dependencies = { complete: true as const, sections: { overview: ["a"], api: ["b"] } };
    expect(planRegeneration(before, after, dependencies)).toMatchObject({
      mode: "sections",
      sections: ["overview"],
      changed: ["a"],
    });
    expect(
      planRegeneration(before, fingerprintInputs({ a: "1", b: "1", c: "1" }), dependencies),
    ).toMatchObject({ mode: "full", reason: "Changed inputs have no complete section mapping" });
    expect(planRegeneration(before, after, { ...dependencies, complete: false })).toMatchObject({
      mode: "full",
    });
  });

  it("uses full regeneration for legacy history, settings, or every section", () => {
    const before = fingerprintInputs({ settings: "old", a: "1" });
    expect(planRegeneration(null, before)).toMatchObject({
      mode: "full",
      reason: "Legacy version has no input snapshot",
    });
    expect(
      planRegeneration(before, fingerprintInputs({ settings: "new", a: "1" }), {
        complete: true,
        sections: { one: ["settings"] },
      }),
    ).toMatchObject({ mode: "full", reason: "Effective generation settings changed" });
    expect(
      planRegeneration(before, fingerprintInputs({ settings: "old", a: "2" }), {
        complete: true,
        sections: { one: ["a"], two: ["a"] },
      }),
    ).toMatchObject({ mode: "full", reason: "All sections depend on changed inputs" });
  });
});
