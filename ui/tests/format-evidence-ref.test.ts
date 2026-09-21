import { describe, it, expect } from "vitest";
import { formatEvidenceRef } from "@/lib/format-evidence-ref";
import type { ResolvedEvidenceRef } from "@/lib/analysis-api";

const RAW_ID = "ckxq9z8p10001abcd1234efgh";

describe("formatEvidenceRef (#448)", () => {
  describe("AC1 — well-formed evidence resolves to a readable source", () => {
    it("renders the basename of a plain filename source label", () => {
      const ref: ResolvedEvidenceRef = {
        chunkId: RAW_ID,
        sourceLabel: "Regional Hubs WMS_OMS Data Exchange_v0.8.docx",
        sourceId: "doc-1234567890",
      };
      const r = formatEvidenceRef(ref);
      expect(r.label).toBe("Regional Hubs WMS_OMS Data Exchange_v0.8.docx");
      // No line → no `#` suffix.
      expect(r.label).not.toContain("#");
    });

    it("appends ` #<line>` when a line position is present", () => {
      const ref: ResolvedEvidenceRef = {
        chunkId: RAW_ID,
        sourceLabel: "requirements.md",
        line: 42,
      };
      const r = formatEvidenceRef(ref);
      expect(r.label).toBe("requirements.md #42");
    });

    it("renders ` #0` for the first chunk (line 0 is a real position)", () => {
      const ref: ResolvedEvidenceRef = { chunkId: RAW_ID, sourceLabel: "spec.pdf", line: 0 };
      expect(formatEvidenceRef(ref).label).toBe("spec.pdf #0");
    });

    it("falls back to the documentId-style source label when that is all the server resolved", () => {
      const ref: ResolvedEvidenceRef = { chunkId: RAW_ID, sourceLabel: "doc-1234567890" };
      expect(formatEvidenceRef(ref).label).toBe("doc-1234567890");
    });
  });

  describe("AC4 — a connector:repo: source renders via formatSourceLabel", () => {
    it("collapses a connector:repo id to 'basename — repo'", () => {
      const ref: ResolvedEvidenceRef = {
        chunkId: RAW_ID,
        sourceLabel:
          "connector:repo:cmexample0000000000acmerp:src/main/java/com/acme/ShipmentAllocationsVO.java",
      };
      const r = formatEvidenceRef(ref);
      expect(r.label).toBe("ShipmentAllocationsVO.java — acmerp");
      // The noisy connector prefix must never leak into the human label.
      expect(r.label).not.toContain("connector:repo:");
    });

    it("appends the line to a connector:repo label too", () => {
      const ref: ResolvedEvidenceRef = {
        chunkId: RAW_ID,
        sourceLabel: "connector:repo:abc123def:README.md",
        line: 7,
      };
      expect(formatEvidenceRef(ref).label).toBe("README.md — 123def #7");
    });
  });

  describe("AC2 — unresolvable evidence degrades to the raw id", () => {
    it("uses the raw id as label/title for a ref with no sourceLabel", () => {
      const ref: ResolvedEvidenceRef = { chunkId: RAW_ID };
      const r = formatEvidenceRef(ref);
      expect(r.label).toBe(RAW_ID);
      expect(r.title).toBe(RAW_ID);
      expect(r.rawId).toBe(RAW_ID);
    });

    it("uses the raw id as label/title for a bare string input (legacy payload)", () => {
      const r = formatEvidenceRef(RAW_ID);
      expect(r.label).toBe(RAW_ID);
      expect(r.title).toBe(RAW_ID);
      expect(r.rawId).toBe(RAW_ID);
    });

    it("never returns a blank label for a non-blank raw id", () => {
      expect(formatEvidenceRef(RAW_ID).label).not.toBe("");
      expect(formatEvidenceRef({ chunkId: RAW_ID }).label).not.toBe("");
    });

    it("falls back to the raw id when sourceLabel collapses to an empty formatted label", () => {
      // A whitespace-only sourceLabel makes formatSourceLabel().label === "" —
      // the chip must still show the raw id, never a blank label.
      const ref: ResolvedEvidenceRef = { chunkId: RAW_ID, sourceLabel: "   " };
      const r = formatEvidenceRef(ref);
      expect(r.label).toBe(RAW_ID);
    });

    it("falls back to the raw id (with #line) when the formatted label is empty", () => {
      const ref: ResolvedEvidenceRef = { chunkId: RAW_ID, sourceLabel: "   ", line: 5 };
      const r = formatEvidenceRef(ref);
      expect(r.label).toBe(`${RAW_ID} #5`);
    });
  });

  describe("AC3 — the raw chunk/finding id is preserved in rawId and title", () => {
    it("keeps the raw chunkId in rawId and title even when resolved", () => {
      const ref: ResolvedEvidenceRef = {
        chunkId: RAW_ID,
        sourceLabel: "requirements.md",
        line: 3,
      };
      const r = formatEvidenceRef(ref);
      expect(r.rawId).toBe(RAW_ID);
      expect(r.title).toBe(RAW_ID);
      // The readable label differs from the opaque raw id.
      expect(r.label).not.toBe(r.rawId);
    });
  });
});
