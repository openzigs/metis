import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadLayout,
  saveLayout,
  resetLayout,
  DEFAULT_LAYOUT,
  _CLAMP_BOUNDS,
} from "@/lib/workbench-storage";

describe("workbench-storage", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns defaults when nothing is stored", () => {
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("round-trips a saved layout", () => {
    saveLayout({ leftPct: 30, rightPct: 25, contextIds: ["a", "b"], agentKey: null });
    expect(loadLayout()).toEqual({
      leftPct: 30,
      rightPct: 25,
      contextIds: ["a", "b"],
      agentKey: null,
    });
  });

  it("persists and restores agentKey", () => {
    saveLayout({ leftPct: 22, rightPct: 26, contextIds: [], agentKey: "spec-writer" });
    expect(loadLayout().agentKey).toBe("spec-writer");
  });

  it("defaults agentKey to null when missing from stored data", () => {
    window.localStorage.setItem(
      "metis.workbench.layout",
      JSON.stringify({ leftPct: 22, rightPct: 26, contextIds: [] }),
    );
    expect(loadLayout().agentKey).toBeNull();
  });

  it("clamps out-of-range percentages on save and load", () => {
    saveLayout({ leftPct: 5, rightPct: 99, contextIds: [], agentKey: null });
    const loaded = loadLayout();
    expect(loaded.leftPct).toBe(_CLAMP_BOUNDS.MIN_PCT);
    expect(loaded.rightPct).toBe(_CLAMP_BOUNDS.MAX_PCT);
  });

  it("rejects malformed JSON", () => {
    window.localStorage.setItem("metis.workbench.layout", "{not json");
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("rejects non-object payloads", () => {
    window.localStorage.setItem("metis.workbench.layout", JSON.stringify("nope"));
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("filters non-string contextIds and caps to 50", () => {
    const noisy = [
      ...Array.from({ length: 60 }, (_, i) => `id${i}`),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      123 as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      null as any,
    ];
    window.localStorage.setItem(
      "metis.workbench.layout",
      JSON.stringify({ leftPct: 22, rightPct: 26, contextIds: noisy }),
    );
    const loaded = loadLayout();
    expect(loaded.contextIds.length).toBe(50);
    expect(loaded.contextIds.every((s) => typeof s === "string")).toBe(true);
  });

  it("resetLayout removes the stored entry", () => {
    saveLayout({ leftPct: 30, rightPct: 30, contextIds: ["x"], agentKey: "test" });
    resetLayout();
    expect(loadLayout()).toEqual(DEFAULT_LAYOUT);
  });

  it("uses defaults for non-numeric fields", () => {
    window.localStorage.setItem(
      "metis.workbench.layout",
      JSON.stringify({ leftPct: "huge", rightPct: NaN, contextIds: "nope" }),
    );
    const loaded = loadLayout();
    expect(loaded.leftPct).toBe(DEFAULT_LAYOUT.leftPct);
    expect(loaded.rightPct).toBe(DEFAULT_LAYOUT.rightPct);
    expect(loaded.contextIds).toEqual([]);
  });
});
