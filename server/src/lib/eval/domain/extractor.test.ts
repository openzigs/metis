/**
 * Epic #803 (Epic 09) — offline extractor unit tests.
 */
import { describe, expect, it } from "vitest";
import type { DomainCorpusItem } from "./corpus.js";
import { createOfflineExtractor, splitStatements } from "./extractor.js";

function item(document: string): DomainCorpusItem {
  return {
    id: "x",
    title: "X",
    docType: "prd",
    source: "original-synthetic",
    license: "CC0-1.0",
    document,
    expected: [],
  };
}

describe("splitStatements", () => {
  it("strips markdown bullets, numbering, and headings", () => {
    const doc = ["# Heading", "- The system must do A.", "1. Users should do B."].join("\n");
    const out = splitStatements(doc);
    expect(out).toContain("The system must do A.");
    expect(out).toContain("Users should do B.");
    expect(out.some((s) => s.startsWith("#"))).toBe(false);
  });
  it("splits multi-sentence lines and drops very short fragments", () => {
    const out = splitStatements("The portal must allow sign in. Yes.");
    expect(out).toContain("The portal must allow sign in.");
    expect(out).not.toContain("Yes.");
  });
});

describe("createOfflineExtractor", () => {
  it("has a stable default name", () => {
    expect(createOfflineExtractor().name).toBe("offline-stub");
    expect(createOfflineExtractor({ name: "custom" }).name).toBe("custom");
  });

  it("extracts only modal requirement statements", () => {
    const doc = [
      "## Overview",
      "This document captures the scope of the portal.",
      "## Requirements",
      "- The portal must allow customers to sign in with email.",
      "- Customers should be able to reset a password.",
      "- Customers may optionally enable dark mode.",
    ].join("\n");
    const { requirements } = createOfflineExtractor().extract(item(doc));
    expect(requirements).toHaveLength(3);
    // The non-modal overview sentence is not extracted.
    expect(requirements.every((r) => /must|should|may/i.test(r.description))).toBe(true);
  });

  it("maps modal strength to priority + confidence", () => {
    const { requirements } = createOfflineExtractor().extract(
      item(
        [
          "- The system must support email login.",
          "- Identity checks are critical for every login.",
          "- Admins should review the audit log.",
          "- Users may optionally pin a dashboard.",
        ].join("\n"),
      ),
    );
    const byPriority = Object.fromEntries(requirements.map((r) => [r.priority, r]));
    expect(byPriority.high.confidence).toBeCloseTo(0.9, 5);
    expect(byPriority.critical.confidence).toBeCloseTo(0.95, 5);
    expect(byPriority.medium.confidence).toBeCloseTo(0.7, 5);
    expect(byPriority.low.confidence).toBeCloseTo(0.5, 5);
  });

  it("classifies bug and chore statements by keyword", () => {
    const { requirements } = createOfflineExtractor().extract(
      item(
        [
          "- The service must fix the incorrect ranking defect.",
          "- The team must migrate legacy reason codes.",
          "- The portal must allow customers to sign in.",
        ].join("\n"),
      ),
    );
    const types = requirements.map((r) => r.type);
    expect(types).toContain("bug");
    expect(types).toContain("chore");
    expect(types).toContain("feature");
  });

  it("is deterministic and de-duplicates identical statements", () => {
    const doc = ["- The system must export a report.", "- The system must export a report."].join(
      "\n",
    );
    const first = createOfflineExtractor().extract(item(doc)).requirements;
    const second = createOfflineExtractor().extract(item(doc)).requirements;
    expect(first).toHaveLength(1);
    expect(first).toEqual(second);
  });

  it("truncates long titles with an ellipsis while keeping the full description", () => {
    const long = `- The platform must ${"alpha ".repeat(20)}succeed.`;
    const [r] = createOfflineExtractor().extract(item(long)).requirements;
    expect(r.title.endsWith("…")).toBe(true);
    expect(r.description.length).toBeGreaterThan(r.title.length);
  });

  it("scales confidence down for a degraded run simulation", () => {
    const doc = "- The system must support email login.";
    const normal = createOfflineExtractor().extract(item(doc)).requirements[0];
    const degraded = createOfflineExtractor({ confidenceScale: 0.5 }).extract(item(doc))
      .requirements[0];
    expect(degraded.confidence!).toBeCloseTo(normal.confidence! * 0.5, 5);
  });

  it("reports a token estimate proportional to document length", () => {
    const { tokens } = createOfflineExtractor().extract(
      item("- The system must do something useful."),
    );
    expect(tokens).toBeGreaterThan(0);
  });
});
