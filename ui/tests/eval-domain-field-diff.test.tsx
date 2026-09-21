/**
 * Epic #803 (Epic 09) — Domain Eval field-diff tests.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DomainFieldDiff } from "@/components/eval/domain-field-diff";
import type { DomainItemResult } from "@/lib/eval-api";

const baseItem: DomainItemResult = {
  itemId: "prd-01",
  docType: "prd",
  title: "Auth portal",
  truePositives: 1,
  falsePositives: 1,
  falseNegatives: 1,
  precision: 0.5,
  recall: 0.5,
  f1: 0.5,
  meanRougeL: 0.7,
  matches: [
    { expectedId: "R1", predictedId: "P1", titleSimilarity: 0.9, rougeL: 0.8, confidence: 0.9 },
    { expectedId: "R2", predictedId: null, titleSimilarity: 0, rougeL: 0, confidence: null },
    { expectedId: null, predictedId: "P2", titleSimilarity: 0, rougeL: 0, confidence: 0.5 },
  ],
  expected: [
    {
      id: "R1",
      type: "feature",
      title: "Email login",
      description: "Users log in with email",
      priority: "high",
    },
    {
      id: "R2",
      type: "feature",
      title: "SSO",
      description: "SAML single sign-on",
      priority: "medium",
    },
  ],
  predicted: [
    {
      id: "P1",
      type: "feature",
      title: "Email sign-in",
      description: "Users sign in with email",
      priority: "high",
      confidence: 0.9,
    },
    {
      id: "P2",
      type: "chore",
      title: "Audit log",
      description: "Record auth events",
      priority: "low",
      confidence: 0.5,
    },
  ],
};

describe("DomainFieldDiff", () => {
  it("renders a matched, a missed and a hallucinated row", () => {
    render(<DomainFieldDiff item={baseItem} />);
    const matched = screen.getByTestId("domain-diff-row-prd-01-0");
    const missed = screen.getByTestId("domain-diff-row-prd-01-1");
    const extra = screen.getByTestId("domain-diff-row-prd-01-2");
    expect(matched.getAttribute("data-kind")).toBe("match");
    expect(missed.getAttribute("data-kind")).toBe("missed");
    expect(extra.getAttribute("data-kind")).toBe("hallucinated");
  });

  it("flags fields that differ between expected and predicted", () => {
    const { container } = render(<DomainFieldDiff item={baseItem} />);
    const titleRow = container.querySelector(
      '[data-testid="domain-diff-row-prd-01-0"] [data-field="title"]',
    );
    expect(titleRow?.getAttribute("data-differs")).toBe("true");
  });

  it("shows an empty hint when there are no matches", () => {
    render(<DomainFieldDiff item={{ ...baseItem, matches: [] }} />);
    expect(screen.getByTestId("domain-diff-empty-prd-01")).toBeInTheDocument();
  });
});
