import { describe, expect, it } from "vitest";

import { csvProvider } from "../../../src/lib/testcoverage/providers/csv-provider.js";
import { gherkinProvider } from "../../../src/lib/testcoverage/providers/gherkin-provider.js";
import { markdownProvider } from "../../../src/lib/testcoverage/providers/markdown-provider.js";
import {
  detectProviderForUpload,
  resolveProvider,
} from "../../../src/lib/testcoverage/providers/registry.js";
import { ColumnMappingRequiredError } from "../../../src/lib/testcoverage/types.js";

describe("csvProvider", () => {
  it("parses a happy-path CSV", async () => {
    const csv = [
      "Title,Steps,Expected,Priority,Tags",
      '"Login","1. Open\n2. Submit","Dashboard",High,"auth,smoke"',
      '"Logout","Click logout","Login page",Low,"auth"',
    ].join("\n");
    const result = await csvProvider.parse(csv, { label: "tests.csv" });
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].title).toBe("Login");
    expect(result.cases[0].priority).toBe("high");
    expect(result.cases[0].tags).toEqual(["auth", "smoke"]);
    expect(result.cases[0].steps).toHaveLength(2);
  });

  it("throws ColumnMappingRequiredError on unrecognised headers", async () => {
    const csv = "Foo,Bar\nx,y";
    await expect(async () => csvProvider.parse(csv, { label: "bad.csv" })).rejects.toBeInstanceOf(
      ColumnMappingRequiredError,
    );
  });

  it("accepts column overrides for low-confidence inputs", async () => {
    const csv = "Foo,Bar\nLogin,Click";
    const result = await csvProvider.parse(csv, {
      label: "bad.csv",
      columnOverrides: { Foo: "title", Bar: "steps" },
    });
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0].title).toBe("Login");
  });

  it("skips rows with empty titles", async () => {
    const csv = ["Title,Steps", "Login,Click", ",Click"].join("\n");
    const result = await csvProvider.parse(csv, { label: "tests.csv" });
    expect(result.cases).toHaveLength(1);
  });

  it("handles empty CSV gracefully", async () => {
    const result = await csvProvider.parse("", { label: "empty.csv" });
    expect(result.cases).toEqual([]);
    expect(result.notes.some((n) => /empty/i.test(n))).toBe(true);
  });
});

describe("markdownProvider", () => {
  it("parses ## blocks into test cases", () => {
    const md = `# Suite\n\n## Login flow\n\n**Preconditions:**\nUser exists\n\n**Steps:**\n1. Open app\n2. Type creds -> Form valid\n\n**Expected:**\nDashboard\n\n**Tags:**\nsmoke, auth\n\n## Logout flow\n\n**Steps:**\nClick logout\n\n**Expected:**\nLogin page\n`;
    const result = markdownProvider.parse(md, { label: "tests.md" }) as ReturnType<
      typeof markdownProvider.parse
    > & { cases: { title: string }[] };
    expect(result.cases.length).toBe(2);
    expect(result.cases[0].title).toBe("Login flow");
    expect(result.cases[0].tags).toEqual(["smoke", "auth"]);
    expect(result.cases[0].steps[1].expected).toBe("Form valid");
  });

  it("returns empty result for an empty doc", () => {
    const result = markdownProvider.parse("# nothing", { label: "x.md" });
    expect((result as { cases: unknown[] }).cases).toEqual([]);
  });
});

describe("gherkinProvider", () => {
  it("parses a feature file with tags + multiple scenarios", () => {
    const feature = `@regression\nFeature: Login\n\n  @smoke\n  Scenario: Successful login\n    Given a user "alice"\n    When she submits the form\n    And clicks submit\n    Then she sees the dashboard\n\n  Scenario: Failed login\n    Given a user "bob"\n    When he submits invalid creds\n    Then he sees an error\n`;
    const result = gherkinProvider.parse(feature, { label: "x.feature" }) as ReturnType<
      typeof gherkinProvider.parse
    > & { cases: { title: string; tags: string[] }[] };
    expect(result.cases).toHaveLength(2);
    expect(result.cases[0].title).toBe("Successful login");
    expect(result.cases[0].tags).toContain("smoke");
    expect(result.cases[0].steps.length).toBeGreaterThanOrEqual(2);
  });

  it("ignores comments and blank lines", () => {
    const result = gherkinProvider.parse("# nothing\n\n", { label: "x.feature" }) as {
      cases: unknown[];
    };
    expect(result.cases).toEqual([]);
  });
});

describe("registry", () => {
  it("resolveProvider returns the right provider", () => {
    expect(resolveProvider("csv").source).toBe("csv");
    expect(resolveProvider("markdown").source).toBe("markdown");
  });

  it("resolveProvider throws on unsupported source", () => {
    expect(() => resolveProvider("jira")).toThrow();
  });

  it("detectProviderForUpload by extension", () => {
    expect(detectProviderForUpload("a.csv", "text/csv")?.source).toBe("csv");
    expect(
      detectProviderForUpload(
        "a.xlsx",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      )?.source,
    ).toBe("excel");
    expect(
      detectProviderForUpload(
        "a.docx",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      )?.source,
    ).toBe("docx");
    expect(detectProviderForUpload("a.feature", "")?.source).toBe("gherkin");
    expect(detectProviderForUpload("a.md", "text/markdown")?.source).toBe("markdown");
    expect(detectProviderForUpload("a.pdf", "application/pdf")).toBeNull();
  });
});
