/**
 * Issue #430 — Change-Analysis run labels must be human-readable and
 * unambiguous: a stable sequence + a date-time, with the truncated id only as a
 * secondary token (never the sole/primary label).
 */
import { describe, it, expect } from "vitest";
import {
  formatChangeRunLabel,
  formatChangeRunLabels,
  formatRunTimestamp,
  shortRunId,
} from "@/lib/format-change-run-label";

describe("formatRunTimestamp", () => {
  it("formats an ISO string as a locale date-time", () => {
    const out = formatRunTimestamp("2026-06-22T14:14:00.000Z");
    expect(out).toMatch(/2026/);
    // Includes a time component (digits and a separator), not just a date.
    expect(out).toMatch(/\d/);
    expect(out).not.toBe("Unknown date");
  });

  it("accepts a Date instance", () => {
    expect(formatRunTimestamp(new Date("2026-01-02T03:04:00Z"))).toMatch(/2026/);
  });

  it("degrades gracefully on an unparseable timestamp", () => {
    expect(formatRunTimestamp("not-a-date")).toBe("Unknown date");
  });
});

describe("shortRunId", () => {
  it("keeps the leading 8 chars", () => {
    expect(shortRunId("cmqpu6znXXXXXXXX")).toBe("cmqpu6zn");
  });
  it("handles short / empty ids without throwing", () => {
    expect(shortRunId("abc")).toBe("abc");
    expect(shortRunId("")).toBe("");
  });
});

describe("formatChangeRunLabel", () => {
  it("primary label leads with a Run # sequence and a date-time, never a bare id", () => {
    const label = formatChangeRunLabel(
      { id: "cmqpu6znabcdef", startedAt: "2026-06-22T14:14:00Z" },
      3,
    );
    expect(label.primary).toMatch(/^Run #3 — /);
    expect(label.primary).toMatch(/2026/);
    // The bare truncated id must NOT be the primary label.
    expect(label.primary).not.toBe("cmqpu6zn");
    expect(label.shortId).toBe("cmqpu6zn");
    expect(label.sequence).toBe(3);
    expect(label.rawId).toBe("cmqpu6znabcdef");
  });

  it("tolerates a null/undefined id without throwing (defensive fallback)", () => {
    const label = formatChangeRunLabel(
      { id: undefined as unknown as string, startedAt: "2026-06-22T14:14:00Z" },
      1,
    );
    expect(label.shortId).toBe("");
    expect(label.rawId).toBe("");
    expect(label.primary).toMatch(/^Run #1 — /);
  });
});

describe("formatChangeRunLabels", () => {
  it("assigns stable oldest→newest sequence ordinals", () => {
    const runs = [
      { id: "newest", startedAt: "2026-06-22T10:00:00Z" },
      { id: "middle", startedAt: "2026-06-20T10:00:00Z" },
      { id: "oldest", startedAt: "2026-06-18T10:00:00Z" },
    ];
    const { byId, ordered } = formatChangeRunLabels(runs);
    expect(byId.get("oldest")?.sequence).toBe(1);
    expect(byId.get("middle")?.sequence).toBe(2);
    expect(byId.get("newest")?.sequence).toBe(3);
    // `ordered` preserves the input order (newest-first display list).
    expect(ordered.map((l) => l.rawId)).toEqual(["newest", "middle", "oldest"]);
  });

  it("produces distinct primary labels for two runs on the same calendar day", () => {
    const runs = [
      { id: "aaaaaaaa1111", startedAt: "2026-06-22T09:00:00Z" },
      { id: "bbbbbbbb2222", startedAt: "2026-06-22T17:30:00Z" },
    ];
    const { byId } = formatChangeRunLabels(runs);
    const a = byId.get("aaaaaaaa1111")!.primary;
    const b = byId.get("bbbbbbbb2222")!.primary;
    expect(a).not.toBe(b);
  });

  it("falls back to input order for tied / unparseable timestamps without throwing", () => {
    const runs = [
      { id: "x", startedAt: "bad" },
      { id: "y", startedAt: "also-bad" },
    ];
    const { byId } = formatChangeRunLabels(runs);
    expect(byId.get("x")?.sequence).toBe(1);
    expect(byId.get("y")?.sequence).toBe(2);
    expect(byId.get("x")?.primary).toContain("Unknown date");
  });

  it("returns empty structures for an empty list", () => {
    const { byId, ordered } = formatChangeRunLabels([]);
    expect(byId.size).toBe(0);
    expect(ordered).toEqual([]);
  });
});
