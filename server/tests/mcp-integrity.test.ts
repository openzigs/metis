/**
 * Issue #105 — integrity helpers (sha256, snapshot, diff).
 */
import { describe, expect, it } from "vitest";
import {
  computeSha256,
  diffSchemas,
  isDiffEmpty,
  snapshotToolSchemas,
} from "../src/lib/mcp/integrity.js";

describe("computeSha256", () => {
  it("returns the standard 64-char hex digest for a known string", () => {
    // sha256 of empty string
    expect(computeSha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
    expect(computeSha256("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
  it("hashes Uint8Array and Buffer the same way as the equivalent string", () => {
    const s = computeSha256("hello");
    expect(computeSha256(Buffer.from("hello"))).toBe(s);
    expect(computeSha256(new TextEncoder().encode("hello"))).toBe(s);
  });
});

describe("snapshotToolSchemas", () => {
  it("produces a key-stable snapshot independent of input order", () => {
    const a = snapshotToolSchemas([
      { name: "b", description: "B", risk: "low" },
      { name: "a", description: "A", risk: "low" },
    ]);
    const b = snapshotToolSchemas([
      { name: "a", description: "A", risk: "low" },
      { name: "b", description: "B", risk: "low" },
    ]);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });
  it("captures description, risk, and inputSchema", () => {
    const out = snapshotToolSchemas([
      {
        name: "lookup",
        description: "look up",
        risk: "medium",
        inputSchema: { type: "object", properties: { q: { type: "string" } } },
      },
    ]);
    expect(out.lookup).toBeDefined();
  });
});

describe("diffSchemas", () => {
  const baseline = snapshotToolSchemas([
    { name: "a", description: "A", risk: "low" },
    { name: "b", description: "B", risk: "low" },
  ]);

  it("returns no changes for identical snapshots", () => {
    const diff = diffSchemas(baseline, baseline);
    expect(isDiffEmpty(diff)).toBe(true);
  });
  it("detects added tools", () => {
    const next = snapshotToolSchemas([
      { name: "a", description: "A", risk: "low" },
      { name: "b", description: "B", risk: "low" },
      { name: "c", description: "C", risk: "low" },
    ]);
    expect(diffSchemas(baseline, next).added).toEqual(["c"]);
  });
  it("detects removed tools", () => {
    const next = snapshotToolSchemas([{ name: "a", description: "A", risk: "low" }]);
    expect(diffSchemas(baseline, next).removed).toEqual(["b"]);
  });
  it("detects changed schemas (description / risk / inputSchema)", () => {
    const next = snapshotToolSchemas([
      { name: "a", description: "A2", risk: "low" }, // description changed
      { name: "b", description: "B", risk: "high" }, // risk changed
    ]);
    const diff = diffSchemas(baseline, next);
    expect(diff.changed.sort()).toEqual(["a", "b"]);
  });
  it("ignores key ordering in nested input schemas", () => {
    const left = snapshotToolSchemas([
      {
        name: "a",
        description: "x",
        risk: "low",
        inputSchema: { type: "object", properties: { a: 1, b: 2 } },
      },
    ]);
    const right = snapshotToolSchemas([
      {
        name: "a",
        description: "x",
        risk: "low",
        inputSchema: { properties: { b: 2, a: 1 }, type: "object" },
      },
    ]);
    expect(isDiffEmpty(diffSchemas(left, right))).toBe(true);
  });
  it("treats null/undefined baseline as full add", () => {
    const next = snapshotToolSchemas([{ name: "a", description: "", risk: "low" }]);
    expect(diffSchemas(null, next).added).toEqual(["a"]);
    expect(diffSchemas(undefined, next).added).toEqual(["a"]);
  });
});
