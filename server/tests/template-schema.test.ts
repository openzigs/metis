/**
 * Template system tests — Epic #595 / Issue #615.
 *
 * Covers:
 *   - Template schema validation (meta-schema)
 *   - Template data validation (output validation)
 *   - Default templates structure
 *   - Template renderer (Markdown + Jira)
 *   - Draft generator template integration
 */
import { describe, expect, it } from "vitest";
import {
  validateTemplateSchema,
  validateTemplateData,
} from "../src/lib/publishing/template-validator.js";
import {
  DEFAULT_TEMPLATES,
  GITHUB_EPIC_TEMPLATE,
  GITHUB_FEATURE_TEMPLATE,
  JIRA_STORY_TEMPLATE,
  JIRA_BUG_TEMPLATE,
} from "../src/lib/publishing/default-templates.js";
import {
  renderToMarkdown,
  renderToJiraFields,
  buildTemplatePrompt,
} from "../src/lib/publishing/template-renderer.js";
import type { TemplateSchema } from "../src/lib/publishing/template-schema.js";
import {
  SECTION_TYPES,
  TEMPLATE_PLATFORMS,
  TEMPLATE_TYPES,
  WELL_KNOWN_SECTIONS,
} from "../src/lib/publishing/template-schema.js";

// ── Schema validation (meta-schema) ────────────────────────────────────

describe("validateTemplateSchema", () => {
  const validSchema: TemplateSchema = {
    name: "Test Template",
    platform: "github",
    templateType: "feature",
    sections: [
      {
        key: "title",
        label: "Title",
        type: "text",
        required: true,
        validation: { minLength: 5 },
      },
      {
        key: "description",
        label: "Description",
        type: "markdown",
        required: true,
      },
    ],
  };

  it("accepts a valid schema", () => {
    const result = validateTemplateSchema(validSchema);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it("rejects null input", () => {
    const result = validateTemplateSchema(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("schema must be a non-null object");
  });

  it("rejects non-object input", () => {
    const result = validateTemplateSchema("string");
    expect(result.valid).toBe(false);
  });

  it("rejects empty name", () => {
    const result = validateTemplateSchema({ ...validSchema, name: "" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("name"))).toBe(true);
  });

  it("rejects name exceeding 128 chars", () => {
    const result = validateTemplateSchema({ ...validSchema, name: "a".repeat(129) });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("128"))).toBe(true);
  });

  it("rejects invalid platform", () => {
    const result = validateTemplateSchema({ ...validSchema, platform: "azure" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("platform"))).toBe(true);
  });

  it("rejects invalid templateType", () => {
    const result = validateTemplateSchema({ ...validSchema, templateType: "incident" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("templateType"))).toBe(true);
  });

  it("rejects non-array sections", () => {
    const result = validateTemplateSchema({ ...validSchema, sections: "not-array" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("array"))).toBe(true);
  });

  it("rejects empty sections array", () => {
    const result = validateTemplateSchema({ ...validSchema, sections: [] });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("at least one"))).toBe(true);
  });

  it("rejects section with invalid type", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [{ key: "x", label: "X", type: "invalid", required: true }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("type"))).toBe(true);
  });

  it("rejects duplicate section keys", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [
        { key: "title", label: "Title", type: "text", required: true },
        { key: "title", label: "Title 2", type: "text", required: false },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("duplicated"))).toBe(true);
  });

  it("rejects section without key", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [{ key: "", label: "X", type: "text", required: true }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects section without label", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [{ key: "x", label: "", type: "text", required: true }],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects section where required is not boolean", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [{ key: "x", label: "X", type: "text", required: "yes" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("boolean"))).toBe(true);
  });

  it("rejects invalid validation rules (negative minLength)", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [
        { key: "x", label: "X", type: "text", required: true, validation: { minLength: -1 } },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("minLength"))).toBe(true);
  });

  it("rejects invalid validation options (not array of strings)", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [
        { key: "x", label: "X", type: "select", required: true, validation: { options: [1, 2] } },
      ],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("options"))).toBe(true);
  });

  it("accepts valid validation rules", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [
        {
          key: "x",
          label: "X",
          type: "text",
          required: true,
          validation: { minLength: 1, maxLength: 100, pattern: "^[a-z]+$" },
        },
      ],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects non-object platformFields", () => {
    const result = validateTemplateSchema({ ...validSchema, platformFields: "bad" });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("platformFields"))).toBe(true);
  });

  it("accepts valid platformFields", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      platformFields: { storyPoints: { jiraField: "customfield_10016" } },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects non-object section entries", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: ["not-an-object"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("must be an object"))).toBe(true);
  });

  it("rejects non-object validation field", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [{ key: "x", label: "X", type: "text", required: true, validation: "bad" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("validation must be an object"))).toBe(true);
  });

  it("rejects invalid maxLength", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [
        { key: "x", label: "X", type: "text", required: true, validation: { maxLength: "nope" } },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid maxItems", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [
        { key: "x", label: "X", type: "checklist", required: true, validation: { maxItems: -5 } },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid minItems", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [
        { key: "x", label: "X", type: "checklist", required: true, validation: { minItems: "no" } },
      ],
    });
    expect(result.valid).toBe(false);
  });

  it("rejects invalid pattern type", () => {
    const result = validateTemplateSchema({
      ...validSchema,
      sections: [
        { key: "x", label: "X", type: "text", required: true, validation: { pattern: 123 } },
      ],
    });
    expect(result.valid).toBe(false);
  });
});

// ── Template data validation (output validation) ──────────────────────

describe("validateTemplateData", () => {
  const schema: TemplateSchema = {
    name: "Test",
    platform: "github",
    templateType: "feature",
    sections: [
      { key: "title", label: "Title", type: "text", required: true, validation: { minLength: 5 } },
      {
        key: "description",
        label: "Description",
        type: "markdown",
        required: true,
        validation: { maxLength: 1000 },
      },
      {
        key: "criteria",
        label: "Acceptance Criteria",
        type: "checklist",
        required: true,
        validation: { minItems: 1, maxItems: 20 },
      },
      {
        key: "points",
        label: "Story Points",
        type: "number",
        required: true,
        validation: { min: 1, max: 21 },
      },
      {
        key: "priority",
        label: "Priority",
        type: "select",
        required: false,
        validation: { options: ["high", "medium", "low"] },
      },
      { key: "tags", label: "Tags", type: "tags", required: false, validation: { maxItems: 5 } },
      { key: "notes", label: "Notes", type: "text", required: false },
    ],
  };

  const validData = {
    title: "Feature Title",
    description: "A description of the feature",
    criteria: ["First criterion", "Second criterion"],
    points: 5,
  };

  it("accepts valid data", () => {
    const result = validateTemplateData(validData, schema);
    expect(result.valid).toBe(true);
  });

  it("rejects missing required field", () => {
    const result = validateTemplateData({ title: "Test" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("description"))).toBe(true);
  });

  it("rejects empty required field", () => {
    const result = validateTemplateData({ ...validData, title: "" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("title"))).toBe(true);
  });

  it("rejects text below minLength", () => {
    const result = validateTemplateData({ ...validData, title: "Hi" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("minimum length"))).toBe(true);
  });

  it("rejects text above maxLength", () => {
    const result = validateTemplateData({ ...validData, description: "x".repeat(1001) }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maximum length"))).toBe(true);
  });

  it("rejects wrong type for text field", () => {
    const result = validateTemplateData({ ...validData, title: 123 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("expected string"))).toBe(true);
  });

  it("rejects non-array for checklist", () => {
    const result = validateTemplateData({ ...validData, criteria: "not an array" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("expected array"))).toBe(true);
  });

  it("rejects checklist below minItems", () => {
    const result = validateTemplateData({ ...validData, criteria: [] }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("minimum items"))).toBe(true);
  });

  it("rejects checklist above maxItems", () => {
    const result = validateTemplateData(
      { ...validData, criteria: Array.from({ length: 21 }, (_, i) => `item ${i}`) },
      schema,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maximum items"))).toBe(true);
  });

  it("rejects wrong type for number field", () => {
    const result = validateTemplateData({ ...validData, points: "five" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("expected number"))).toBe(true);
  });

  it("rejects number below min", () => {
    const result = validateTemplateData({ ...validData, points: 0 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("minimum value"))).toBe(true);
  });

  it("rejects number above max", () => {
    const result = validateTemplateData({ ...validData, points: 50 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maximum value"))).toBe(true);
  });

  it("rejects wrong type for select", () => {
    const result = validateTemplateData({ ...validData, priority: 42 }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("expected string for select"))).toBe(true);
  });

  it("rejects select value not in options", () => {
    const result = validateTemplateData({ ...validData, priority: "urgent" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("not in allowed options"))).toBe(true);
  });

  it("accepts valid select value", () => {
    const result = validateTemplateData({ ...validData, priority: "high" }, schema);
    expect(result.valid).toBe(true);
  });

  it("rejects non-array for tags", () => {
    const result = validateTemplateData({ ...validData, tags: "single" }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("expected array for tags"))).toBe(true);
  });

  it("rejects tags with non-string items", () => {
    const result = validateTemplateData({ ...validData, tags: [1, 2, 3] }, schema);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("all tags must be strings"))).toBe(true);
  });

  it("rejects tags above maxItems", () => {
    const result = validateTemplateData(
      { ...validData, tags: ["a", "b", "c", "d", "e", "f"] },
      schema,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("maximum tags"))).toBe(true);
  });

  it("ignores absent optional fields", () => {
    const result = validateTemplateData(validData, schema);
    expect(result.valid).toBe(true);
  });

  it("validates pattern matching for text fields", () => {
    const patternSchema: TemplateSchema = {
      name: "Test",
      platform: "github",
      templateType: "feature",
      sections: [
        {
          key: "code",
          label: "Code",
          type: "text",
          required: true,
          validation: { pattern: "^[A-Z]{3}-\\d+$" },
        },
      ],
    };
    expect(validateTemplateData({ code: "ABC-123" }, patternSchema).valid).toBe(true);
    expect(validateTemplateData({ code: "abc" }, patternSchema).valid).toBe(false);
  });

  it("handles invalid regex pattern gracefully", () => {
    const badPattern: TemplateSchema = {
      name: "Test",
      platform: "github",
      templateType: "feature",
      sections: [
        {
          key: "code",
          label: "Code",
          type: "text",
          required: true,
          validation: { pattern: "[invalid(" },
        },
      ],
    };
    // Should not throw, just skip pattern validation
    const result = validateTemplateData({ code: "anything" }, badPattern);
    expect(result.valid).toBe(true);
  });
});

// ── Default templates ──────────────────────────────────────────────────

describe("default templates", () => {
  it("has exactly 4 default templates", () => {
    expect(DEFAULT_TEMPLATES).toHaveLength(4);
  });

  it("all default templates pass meta-schema validation", () => {
    for (const tpl of DEFAULT_TEMPLATES) {
      const result = validateTemplateSchema(tpl);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    }
  });

  it("GitHub Epic template has required sections", () => {
    const keys = GITHUB_EPIC_TEMPLATE.sections.map((s) => s.key);
    expect(keys).toContain("title");
    expect(keys).toContain("description");
    expect(keys).toContain("acceptanceCriteria");
    expect(keys).toContain("storyPoints");
  });

  it("GitHub Feature template has required sections", () => {
    const keys = GITHUB_FEATURE_TEMPLATE.sections.map((s) => s.key);
    expect(keys).toContain("title");
    expect(keys).toContain("description");
    expect(keys).toContain("acceptanceCriteria");
    expect(keys).toContain("storyPoints");
  });

  it("Jira Story template has platform field mappings", () => {
    expect(JIRA_STORY_TEMPLATE.platformFields).toBeDefined();
    expect(JIRA_STORY_TEMPLATE.platformFields!.storyPoints?.jiraField).toBe("customfield_10016");
    expect(JIRA_STORY_TEMPLATE.platformFields!.priority?.jiraField).toBe("priority");
  });

  it("Jira Bug template has severity and environment sections", () => {
    const keys = JIRA_BUG_TEMPLATE.sections.map((s) => s.key);
    expect(keys).toContain("stepsToReproduce");
    expect(keys).toContain("expectedBehavior");
    expect(keys).toContain("actualBehavior");
    expect(keys).toContain("severity");
    expect(keys).toContain("environment");
  });

  it("Jira Bug template has platform field mappings", () => {
    expect(JIRA_BUG_TEMPLATE.platformFields).toBeDefined();
    expect(JIRA_BUG_TEMPLATE.platformFields!.severity?.jiraField).toBe("customfield_10017");
  });

  it("each template has a unique name", () => {
    const names = DEFAULT_TEMPLATES.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("each template targets the correct platform", () => {
    expect(GITHUB_EPIC_TEMPLATE.platform).toBe("github");
    expect(GITHUB_FEATURE_TEMPLATE.platform).toBe("github");
    expect(JIRA_STORY_TEMPLATE.platform).toBe("jira");
    expect(JIRA_BUG_TEMPLATE.platform).toBe("jira");
  });
});

// ── Template schema constants ──────────────────────────────────────────

describe("template schema constants", () => {
  it("SECTION_TYPES has expected values", () => {
    expect(SECTION_TYPES).toContain("text");
    expect(SECTION_TYPES).toContain("markdown");
    expect(SECTION_TYPES).toContain("checklist");
    expect(SECTION_TYPES).toContain("number");
    expect(SECTION_TYPES).toContain("select");
    expect(SECTION_TYPES).toContain("tags");
  });

  it("TEMPLATE_PLATFORMS has expected values", () => {
    expect(TEMPLATE_PLATFORMS).toContain("github");
    expect(TEMPLATE_PLATFORMS).toContain("jira");
    expect(TEMPLATE_PLATFORMS).toContain("universal");
  });

  it("TEMPLATE_TYPES has expected values", () => {
    expect(TEMPLATE_TYPES).toContain("epic");
    expect(TEMPLATE_TYPES).toContain("feature");
    expect(TEMPLATE_TYPES).toContain("story");
    expect(TEMPLATE_TYPES).toContain("bug");
    expect(TEMPLATE_TYPES).toContain("task");
  });

  it("WELL_KNOWN_SECTIONS has essential keys", () => {
    expect(WELL_KNOWN_SECTIONS).toContain("title");
    expect(WELL_KNOWN_SECTIONS).toContain("description");
    expect(WELL_KNOWN_SECTIONS).toContain("acceptanceCriteria");
    expect(WELL_KNOWN_SECTIONS).toContain("storyPoints");
    expect(WELL_KNOWN_SECTIONS).toContain("priority");
  });
});

// ── Template renderer ──────────────────────────────────────────────────

describe("renderToMarkdown", () => {
  const schema: TemplateSchema = {
    name: "Test",
    platform: "github",
    templateType: "feature",
    sections: [
      { key: "title", label: "Title", type: "text", required: true },
      { key: "description", label: "Description", type: "markdown", required: true },
      { key: "criteria", label: "Acceptance Criteria", type: "checklist", required: true },
      { key: "points", label: "Story Points", type: "number", required: true },
      { key: "priority", label: "Priority", type: "select", required: false },
      { key: "tags", label: "Tags", type: "tags", required: false },
    ],
  };

  it("renders sections as markdown headings", () => {
    const md = renderToMarkdown(
      {
        title: "Test Feature",
        description: "A great feature",
        criteria: ["Works", "Is tested"],
        points: 5,
      },
      schema,
    );
    expect(md).toContain("## Description");
    expect(md).toContain("A great feature");
    expect(md).toContain("## Acceptance Criteria");
    expect(md).toContain("- [ ] Works");
    expect(md).toContain("- [ ] Is tested");
    expect(md).toContain("## Story Points");
    expect(md).toContain("5");
  });

  it("excludes title from body (it's the issue title)", () => {
    const md = renderToMarkdown(
      { title: "My Title", description: "Desc", criteria: ["A"], points: 1 },
      schema,
    );
    expect(md).not.toContain("## Title");
    expect(md).not.toContain("My Title");
  });

  it("skips absent optional sections", () => {
    const md = renderToMarkdown(
      { title: "Test", description: "Desc", criteria: ["A"], points: 1 },
      schema,
    );
    expect(md).not.toContain("## Priority");
    expect(md).not.toContain("## Tags");
  });

  it("renders tags as inline code", () => {
    const md = renderToMarkdown(
      { title: "Test", description: "Desc", criteria: ["A"], points: 1, tags: ["bug", "ui"] },
      schema,
    );
    expect(md).toContain("`bug`");
    expect(md).toContain("`ui`");
  });

  it("renders select as bold label-value", () => {
    const md = renderToMarkdown(
      { title: "Test", description: "Desc", criteria: ["A"], points: 1, priority: "high" },
      schema,
    );
    expect(md).toContain("**Priority**: high");
  });
});

describe("renderToJiraFields", () => {
  it("maps fields with jiraField to top-level keys", () => {
    const fields = renderToJiraFields(
      { title: "Bug Title", priority: "High", storyPoints: 5, description: "A bug" },
      JIRA_STORY_TEMPLATE,
    );
    expect(fields.summary).toBe("Bug Title");
    expect(fields.priority).toEqual({ name: "High" });
    expect(fields.customfield_10016).toBe(5);
  });

  it("renders unmapped sections into description", () => {
    const fields = renderToJiraFields(
      {
        title: "Story",
        description: "A story desc",
        acceptanceCriteria: ["AC1"],
        storyPoints: 3,
        priority: "Medium",
      },
      JIRA_STORY_TEMPLATE,
    );
    expect(fields.description).toContain("A story desc");
    expect(fields.description).toContain("AC1");
  });
});

describe("buildTemplatePrompt", () => {
  it("generates LLM instructions from schema", () => {
    const prompt = buildTemplatePrompt(GITHUB_FEATURE_TEMPLATE);
    expect(prompt).toContain("MUST structure your output as a JSON object");
    expect(prompt).toContain('"title"');
    expect(prompt).toContain("(REQUIRED)");
    expect(prompt).toContain("(optional)");
    expect(prompt).toContain("Return ONLY valid JSON");
  });

  it("includes select options", () => {
    const prompt = buildTemplatePrompt(GITHUB_FEATURE_TEMPLATE);
    expect(prompt).toContain("critical");
    expect(prompt).toContain("high");
    expect(prompt).toContain("medium");
    expect(prompt).toContain("low");
  });

  it("includes placeholder examples", () => {
    const prompt = buildTemplatePrompt(GITHUB_FEATURE_TEMPLATE);
    expect(prompt).toContain("Example:");
  });
});

// ── Template service (unit tests with mocked Prisma) ───────────────────

describe("template-service", () => {
  // Service tests that need Prisma mocking are in template-service.test.ts
  // Here we just verify the exports exist
  it("exports are available", async () => {
    const mod = await import("../src/lib/publishing/template-service.js");
    expect(typeof mod.listTemplates).toBe("function");
    expect(typeof mod.getTemplate).toBe("function");
    expect(typeof mod.createTemplate).toBe("function");
    expect(typeof mod.updateTemplate).toBe("function");
    expect(typeof mod.deleteTemplate).toBe("function");
    expect(typeof mod.seedDefaultTemplates).toBe("function");
    expect(typeof mod.findTemplate).toBe("function");
  });
});

// ── Draft generator template integration ──────────────────────────────

describe("draft-generator template integration", () => {
  it("renderWithTemplate validates and renders valid data", async () => {
    const { renderWithTemplate } = await import("../src/lib/publishing/draft-generator.js");
    const result = renderWithTemplate(
      {
        title: "Test Feature",
        description: "A great feature description here",
        acceptanceCriteria: ["Works correctly", "Has tests"],
        storyPoints: 5,
        labels: ["feature", "metis-generated"],
      },
      GITHUB_FEATURE_TEMPLATE,
    );
    expect(result.valid).toBe(true);
    expect(result.body).toContain("## Description");
    expect(result.body).toContain("A great feature description here");
  });

  it("renderWithTemplate returns errors for invalid data", async () => {
    const { renderWithTemplate } = await import("../src/lib/publishing/draft-generator.js");
    const result = renderWithTemplate(
      { title: "Hi" }, // too short, missing required fields
      GITHUB_FEATURE_TEMPLATE,
    );
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("buildTemplatePrompt is re-exported from draft-generator", async () => {
    const mod = await import("../src/lib/publishing/draft-generator.js");
    expect(typeof mod.buildTemplatePrompt).toBe("function");
    const prompt = mod.buildTemplatePrompt(GITHUB_EPIC_TEMPLATE);
    expect(prompt).toContain("JSON");
  });
});
