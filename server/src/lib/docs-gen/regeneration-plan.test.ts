import { describe, expect, it } from "vitest";
import { fingerprintInputs, planRegeneration } from "./regeneration-plan.js";

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
