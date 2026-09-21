/**
 * Dedup helpers — pure unit tests.
 */
import { describe, expect, it } from "vitest";
import {
  buildMarkerComment,
  computeBodyHash,
  computeDedupHash,
  injectMarker,
  normalizeTitle,
  parseMarker,
  stripMarker,
} from "../src/lib/publishing/dedup.js";

describe("dedup helpers", () => {
  it("normalizeTitle is whitespace + case insensitive", () => {
    expect(normalizeTitle("  Foo   BAR  ")).toBe("foo bar");
  });

  it("computeDedupHash is stable & owner/repo aware", () => {
    const a = computeDedupHash("acme", "metis", "Hello World");
    const b = computeDedupHash("ACME", "metis", " hello   world ");
    const c = computeDedupHash("acme", "metis-2", "Hello World");
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("buildMarkerComment + parseMarker round-trip", () => {
    const marker = { batchId: "b1", draftId: "d1", hash: "abc123" };
    const comment = buildMarkerComment(marker);
    expect(comment).toContain("batch=b1");
    expect(parseMarker(`Body\n\n${comment}\n`)).toEqual(marker);
  });

  it("injectMarker replaces an existing marker rather than stacking", () => {
    const marker1 = { batchId: "b1", draftId: "d1", hash: "h1" };
    const marker2 = { batchId: "b2", draftId: "d1", hash: "h1" };
    const body = "Hello world";
    const stamped1 = injectMarker(body, marker1);
    const stamped2 = injectMarker(stamped1, marker2);
    expect(parseMarker(stamped2)).toEqual(marker2);
    // No duplicate markers.
    const matches = stamped2.match(/metis-publish:/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it("stripMarker leaves bodies alone when no marker is present", () => {
    expect(stripMarker("Plain body")).toContain("Plain body");
  });

  it("computeBodyHash is sensitive to whitespace differences", () => {
    expect(computeBodyHash("a")).not.toBe(computeBodyHash("a "));
  });

  it("parseMarker returns null for non-matching bodies", () => {
    expect(parseMarker(null)).toBeNull();
    expect(parseMarker("")).toBeNull();
    expect(parseMarker("just a body without a marker")).toBeNull();
  });
});
