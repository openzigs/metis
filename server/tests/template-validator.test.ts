/**
 * Template validator unit tests — covers ReDoS protection, maxSections,
 * and section validation typing.
 */
import { describe, expect, it } from "vitest";
import {
  validateTemplateSchema,
  validateTemplateData,
} from "../src/lib/publishing/template-validator.js";
import type { TemplateSchema } from "../src/lib/publishing/template-schema.js";

function validSchema(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: "Test",
    platform: "github",
    templateType: "feature",
    sections: [{ key: "title", label: "Title", type: "text", required: true }],
    ...overrides,
  };
}

describe("validateTemplateSchema", () => {
  it("accepts a valid schema", () => {
    const result = validateTemplateSchema(validSchema());
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  describe("ReDoS protection (CWE-1333)", () => {
    it("rejects pattern with catastrophic backtracking: (a+)+$", () => {
      const schema = validSchema({
        sections: [
          {
            key: "title",
            label: "Title",
            type: "text",
            required: true,
            validation: { pattern: "(a+)+$" },
          },
        ],
      });
      const result = validateTemplateSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("unsafe"))).toBe(true);
    });

    it("rejects pattern with nested quantifiers: (a*)*", () => {
      const schema = validSchema({
        sections: [
          {
            key: "title",
            label: "Title",
            type: "text",
            required: true,
            validation: { pattern: "(a*)*" },
          },
        ],
      });
      const result = validateTemplateSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("unsafe"))).toBe(true);
    });

    it("rejects another evil regex: (x+x+)+y", () => {
      const schema = validSchema({
        sections: [
          {
            key: "title",
            label: "Title",
            type: "text",
            required: true,
            validation: { pattern: "(x+x+)+y" },
          },
        ],
      });
      const result = validateTemplateSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("unsafe"))).toBe(true);
    });

    it("accepts a safe pattern: ^[A-Za-z0-9_-]+$", () => {
      const schema = validSchema({
        sections: [
          {
            key: "title",
            label: "Title",
            type: "text",
            required: true,
            validation: { pattern: "^[A-Za-z0-9_-]+$" },
          },
        ],
      });
      const result = validateTemplateSchema(schema);
      expect(result.valid).toBe(true);
    });

    it("rejects an invalid regex syntax", () => {
      const schema = validSchema({
        sections: [
          {
            key: "title",
            label: "Title",
            type: "text",
            required: true,
            validation: { pattern: "[unclosed" },
          },
        ],
      });
      const result = validateTemplateSchema(schema);
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("not a valid regular expression"))).toBe(true);
    });
  });

  describe("maxSections limit", () => {
    it("accepts 50 sections", () => {
      const sections = Array.from({ length: 50 }, (_, i) => ({
        key: `s${i}`,
        label: `Section ${i}`,
        type: "text",
        required: false,
      }));
      const result = validateTemplateSchema(validSchema({ sections }));
      expect(result.valid).toBe(true);
    });

    it("rejects 51 sections", () => {
      const sections = Array.from({ length: 51 }, (_, i) => ({
        key: `s${i}`,
        label: `Section ${i}`,
        type: "text",
        required: false,
      }));
      const result = validateTemplateSchema(validSchema({ sections }));
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("at most 50"))).toBe(true);
    });
  });
});

describe("validateTemplateData — safe pattern runtime check", () => {
  it("does not execute an unsafe pattern at runtime", () => {
    // Even if an unsafe pattern somehow gets stored, the runtime validator
    // should skip it rather than hang on catastrophic backtracking.
    const schema: TemplateSchema = {
      name: "Test",
      platform: "github",
      templateType: "feature",
      sections: [
        {
          key: "title",
          label: "Title",
          type: "text",
          required: true,
          validation: { pattern: "(a+)+$" },
        },
      ],
    };
    // Should complete quickly — no hang from catastrophic backtracking
    const start = Date.now();
    const result = validateTemplateData({ title: "aaaaaaaaaaaaaaaa!" }, schema);
    const elapsed = Date.now() - start;
    // Should return in well under 1 second (no exponential backtracking)
    expect(elapsed).toBeLessThan(1000);
    // The unsafe pattern is skipped, so no pattern error
    expect(result.valid).toBe(true);
  });
});
