/**
 * Unit tests for parseContractDocMeta (Issue #90 / epic #86).
 */
import { describe, expect, it } from "vitest";
import { parseContractDocMeta } from "./products-api";

describe("parseContractDocMeta", () => {
  it("decodes version + diff fields from a contract-doc metadata blob", () => {
    const meta = parseContractDocMeta({
      metadata: JSON.stringify({
        contractVersion: 3,
        diffSummary: "2 added, 1 removed, 0 changed.",
        hasContractChanges: true,
      }),
    });
    expect(meta).toEqual({
      contractVersion: 3,
      diffSummary: "2 added, 1 removed, 0 changed.",
      hasContractChanges: true,
    });
  });

  it("reports no changes for an initial version", () => {
    const meta = parseContractDocMeta({
      metadata: JSON.stringify({
        contractVersion: 1,
        diffSummary: "Initial version.",
        hasContractChanges: false,
      }),
    });
    expect(meta?.hasContractChanges).toBe(false);
    expect(meta?.contractVersion).toBe(1);
  });

  it("returns null for empty metadata", () => {
    expect(parseContractDocMeta({ metadata: "" })).toBeNull();
  });

  it("returns null for unparseable metadata", () => {
    expect(parseContractDocMeta({ metadata: "{not json" })).toBeNull();
  });

  it("returns null when metadata lacks a contractVersion (legacy / non-contract doc)", () => {
    expect(
      parseContractDocMeta({
        metadata: JSON.stringify({ generatedAt: "2026-01-01", repoCount: 1 }),
      }),
    ).toBeNull();
  });

  it("returns null for a JSON primitive", () => {
    expect(parseContractDocMeta({ metadata: "42" })).toBeNull();
    expect(parseContractDocMeta({ metadata: "null" })).toBeNull();
  });

  it("defaults diffSummary to empty string when absent", () => {
    const meta = parseContractDocMeta({
      metadata: JSON.stringify({ contractVersion: 2, hasContractChanges: true }),
    });
    expect(meta?.diffSummary).toBe("");
  });
});
