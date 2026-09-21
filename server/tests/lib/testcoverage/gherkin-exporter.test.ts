/**
 * Gherkin exporter tests — Epic #856 / issue #877.
 *
 * Validates:
 *   - single-feature output (no zip when only one feature tag)
 *   - zip output when suggestions belong to multiple `feature:*` tags
 *   - scenario-tag emission (excluding the `feature:` selector)
 *   - round-trip via `parseFeature`
 */
import { describe, expect, it } from "vitest";
import JSZip from "jszip";

import {
  exportSuggestionsToGherkin,
  type ExportableSuggestion,
} from "../../../src/lib/testcoverage/index.js";
import { parseFeature } from "../../../src/lib/testcoverage/providers/gherkin-provider.js";

const baseSuggestion = (overrides: Partial<ExportableSuggestion>): ExportableSuggestion => ({
  id: "s-1",
  title: "default",
  gwt: { given: ["a precondition"], when: ["an action"], then: ["an outcome"] },
  steps: [],
  mappedRequirementIds: ["REQ-1"],
  faithfulness: 0.9,
  lowConfidence: false,
  ...overrides,
});

describe("exportSuggestionsToGherkin", () => {
  it("returns a single .feature file when all suggestions share one feature", async () => {
    const result = await exportSuggestionsToGherkin([
      baseSuggestion({ id: "s-a", title: "Sign in", tags: ["feature:auth", "smoke"] }),
      baseSuggestion({ id: "s-b", title: "Sign out", tags: ["feature:auth"] }),
    ]);

    expect(result.kind).toBe("feature");
    if (result.kind !== "feature") throw new Error("unreachable");
    expect(result.filename).toBe("auth.feature");
    expect(result.text).toContain("Feature: auth");
    expect(result.text).toContain("Scenario: Sign in");
    expect(result.text).toContain("@smoke");
    expect(result.text).not.toContain("@feature:auth");
  });

  it("returns a zip when multiple feature groups are present", async () => {
    const result = await exportSuggestionsToGherkin([
      baseSuggestion({ id: "s-a", title: "Sign in", tags: ["feature:auth"] }),
      baseSuggestion({ id: "s-b", title: "Add to cart", tags: ["feature:cart"] }),
    ]);
    expect(result.kind).toBe("zip");
    if (result.kind !== "zip") throw new Error("unreachable");
    expect(result.filename).toBe("features.zip");
    expect(result.files.map((f) => f.filename).sort()).toEqual(["auth.feature", "cart.feature"]);
    expect(Buffer.isBuffer(result.data)).toBe(true);

    const zip = await JSZip.loadAsync(result.data);
    expect(Object.keys(zip.files).sort()).toEqual(["auth.feature", "cart.feature"]);
  });

  it("uses the default feature name when no `feature:*` tag is present", async () => {
    const result = await exportSuggestionsToGherkin(
      [baseSuggestion({ id: "s-a", title: "Untagged scenario" })],
      { defaultFeatureName: "Smoke Tests" },
    );
    expect(result.kind).toBe("feature");
    if (result.kind !== "feature") throw new Error("unreachable");
    expect(result.filename).toBe("smoke-tests.feature");
    expect(result.text).toContain("Feature: Smoke Tests");
  });

  it("round-trips through the gherkin importer", async () => {
    const exported = await exportSuggestionsToGherkin([
      baseSuggestion({
        id: "s-1",
        title: "Successful login",
        gwt: {
          given: ["a registered user", "and they navigate to /login"],
          when: ["they submit valid credentials"],
          then: ["they see the dashboard"],
        },
        tags: ["feature:auth", "regression"],
      }),
    ]);
    if (exported.kind !== "feature") throw new Error("unreachable");
    const parsed = parseFeature(exported.text);
    expect(parsed.cases).toHaveLength(1);
    expect(parsed.cases[0].title).toBe("Successful login");
    expect(parsed.cases[0].preconditions).toContain("a registered user");
    expect(parsed.cases[0].preconditions).toContain("they navigate to /login");
    expect(parsed.cases[0].steps.map((s) => s.action)).toContain("they submit valid credentials");
    expect(parsed.cases[0].expected).toContain("they see the dashboard");
    expect(parsed.cases[0].tags).toContain("regression");
  });

  it("returns an empty feature when there are no suggestions", async () => {
    const r = await exportSuggestionsToGherkin([]);
    expect(r.kind).toBe("feature");
    if (r.kind !== "feature") throw new Error("unreachable");
    expect(r.text).toBe("");
  });
});
