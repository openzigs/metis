/**
 * Gherkin provider tests — Epic #856 / issue #877 (Phase 3).
 *
 * Validates the rewritten parser supports:
 *   - Background prepended to every scenario
 *   - Scenario Outline + Examples expansion (one case per row)
 *   - `<placeholder>` substitution in titles, given/when/then
 *   - feature-level @tag merging with scenario-level @tags
 *   - comments + blank line tolerance
 */
import { describe, expect, it } from "vitest";

import {
  gherkinProvider,
  parseFeature,
} from "../../../src/lib/testcoverage/providers/gherkin-provider.js";

describe("gherkinProvider — Phase 3 rewrites", () => {
  it("prepends Background steps to every scenario in the feature", () => {
    const text = `
@regression
Feature: Cart

  Background:
    Given the catalog is loaded
    And the user is signed in

  Scenario: Add item
    When the user adds "shoes" to the cart
    Then the cart count is 1

  Scenario: Remove item
    When the user removes "shoes" from the cart
    Then the cart count is 0
`;
    const r = parseFeature(text);
    expect(r.cases).toHaveLength(2);
    for (const c of r.cases) {
      expect(c.preconditions ?? "").toContain("the catalog is loaded");
      expect(c.preconditions ?? "").toContain("the user is signed in");
    }
  });

  it("expands Scenario Outline with multiple Examples rows and substitutes <placeholders>", () => {
    const text = `
Feature: Login

  Scenario Outline: Sign in as <role>
    Given a user with role "<role>"
    When they enter password "<password>"
    Then they see "<landing>"

    Examples:
      | role  | password | landing   |
      | admin | a1!      | /admin    |
      | user  | u1!      | /home     |
`;
    const r = parseFeature(text);
    expect(r.cases).toHaveLength(2);
    expect(r.cases[0].title).toMatch(/Sign in as admin/);
    expect(r.cases[0].title).toContain("[role=admin");
    expect(r.cases[0].expected).toContain("/admin");
    expect(r.cases[1].title).toMatch(/Sign in as user/);
    expect(r.cases[1].steps[0].action).toContain("u1!");
  });

  it("merges feature-level and scenario-level tags", () => {
    const text = `
@regression @smoke
Feature: Reports

  @critical
  Scenario: Open report
    Given I open the report
    Then I see the report
`;
    const r = parseFeature(text);
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].tags).toEqual(expect.arrayContaining(["regression", "smoke", "critical"]));
  });

  it("ignores comments and blank lines", () => {
    const r = parseFeature("# top comment\n\n# another\n\n");
    expect(r.cases).toEqual([]);
  });

  it("exposes the parser via the provider interface", () => {
    const r = gherkinProvider.parse("Feature: x\n\nScenario: y\n  Given a\n  When b\n  Then c\n", {
      label: "x.feature",
    }) as ReturnType<typeof gherkinProvider.parse> & { cases: { title: string }[] };
    expect(r.cases).toHaveLength(1);
    expect(r.cases[0].title).toBe("y");
  });

  it("returns confidence 0 when no scenarios were parsed", () => {
    const r = parseFeature("Feature: empty\n");
    expect(r.confidence).toBe(0);
  });
});
