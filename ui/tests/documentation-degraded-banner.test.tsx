/**
 * Tier-aware "within normal tolerance" reframe of the generated-documentation
 * degraded banner. A doc is flagged `degraded` whenever ANY section misses ITS
 * faithfulness bar, but the three tiers carry very different meaning:
 *
 *  - narrative / reconstruction sections are inferred/domain BY DESIGN, so a
 *    below-bar result there is within normal tolerance → CALM headline.
 *  - a literal code-derived section below its strict bar, a failed section, or a
 *    no-modules result genuinely warrants a look → REVIEW-RECOMMENDED headline
 *    that names the sections and drops the word "unreliable".
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { DegradedWarningsBanner } from "@/app/(authed)/projects/[id]/documentation/page";

type Tier = "narrative" | "reconstruction" | "literal";

const tierWarning = (section: string, tier: Tier) => ({
  kind: "section-ungrounded" as const,
  section,
  message: `Section "${section}" detail.`,
  severity: "warning" as const,
  ratio: 0.3,
  threshold: tier === "narrative" ? 0.4 : tier === "reconstruction" ? 0.6 : 0.8,
  tier,
  ...(tier === "narrative" ? { domainContext: true } : {}),
});

describe("DegradedWarningsBanner — tier-aware headline", () => {
  it("renders the CALM 'within normal tolerance' headline when every section is narrative/reconstruction", () => {
    render(
      <DegradedWarningsBanner
        warnings={[
          tierWarning("Overview & Domain", "narrative"),
          tierWarning("Key Workflows", "reconstruction"),
        ]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/within normal tolerance/i);
    expect(alert).toHaveTextContent(/expected for these section types/i);
    // The calm path must NOT use alarming language.
    expect(alert).not.toHaveTextContent(/unreliable/i);
    expect(alert).not.toHaveTextContent(/review recommended|worth verifying/i);
  });

  it("renders the REVIEW-RECOMMENDED headline that NAMES a literal section and drops 'unreliable'", () => {
    render(
      <DegradedWarningsBanner
        warnings={[
          tierWarning("Overview & Domain", "narrative"),
          tierWarning("Business Rules", "literal"),
        ]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Most sections are grounded/i);
    expect(alert).toHaveTextContent(/"Business Rules"/);
    expect(alert).toHaveTextContent(/worth verifying/i);
    // The word "unreliable" must be gone from the headline reframe.
    expect(alert).not.toHaveTextContent(/This document is degraded/i);
    // The narrative section is mentioned in the breakdown, but not as concerning.
    expect(alert).not.toHaveTextContent(/"Overview & Domain" .*worth verifying/);
  });

  it("renders REVIEW-RECOMMENDED naming a FAILED section", () => {
    render(
      <DegradedWarningsBanner
        warnings={[
          { kind: "section-failed", section: "Calculations", message: "boom", severity: "error" },
        ]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/"Calculations"/);
    expect(alert).toHaveTextContent(/worth verifying/i);
  });

  it("names MULTIPLE concerning sections with an 'and' join", () => {
    render(
      <DegradedWarningsBanner
        warnings={[
          tierWarning("Business Rules", "literal"),
          tierWarning("Integrations", "literal"),
        ]}
        errorMessage={null}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/"Business Rules" and "Integrations"/);
  });

  it("falls back to a generic REVIEW headline when a concerning section has no usable label", () => {
    // A failed section with a blank label is concerning but yields no name to
    // surface, so the headline must use the generic 'sections below' phrasing
    // rather than naming an empty string.
    render(
      <DegradedWarningsBanner
        warnings={[{ kind: "section-failed", section: "", message: "boom", severity: "error" }]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/the sections below fall short of the code-fidelity bar/i);
    expect(alert).toHaveTextContent(/worth verifying/i);
    expect(alert).not.toHaveTextContent(/""/); // never names an empty section
  });
});

describe("DegradedWarningsBanner — per-section tier tags in the breakdown", () => {
  it("shows the narrative, reconstruction, and literal tags on their respective list items", () => {
    render(
      <DegradedWarningsBanner
        warnings={[
          tierWarning("Overview & Domain", "narrative"),
          tierWarning("Key Workflows", "reconstruction"),
          tierWarning("Business Rules", "literal"),
        ]}
        errorMessage={null}
      />,
    );
    const items = screen.getAllByRole("listitem");
    const text = items.map((li) => li.textContent ?? "");
    expect(text.some((t) => /narrative section, within expected range/.test(t))).toBe(true);
    expect(
      text.some((t) => /reconstruction section, inferred; verify against source/.test(t)),
    ).toBe(true);
    expect(text.some((t) => /below the code-fidelity bar, review/.test(t))).toBe(true);
  });
});

describe("DegradedWarningsBanner — a11y + styling preserved", () => {
  it("keeps role='alert' and the amber Card styling regardless of severity", () => {
    const { container } = render(
      <DegradedWarningsBanner
        warnings={[tierWarning("Overview & Domain", "narrative")]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    // Amber styling is retained for both calm and review-recommended states.
    expect(container.querySelector(".bg-amber-50")).not.toBeNull();
    expect(container.querySelector(".border-amber-300")).not.toBeNull();
  });
});

describe("DegradedWarningsBanner — DOCS_GEN_GROUNDING off / sample (#186)", () => {
  const skipped = (section: string) => ({
    kind: "grounding-skipped",
    section,
    message: `Section "${section}" was NOT fact-checked.`,
    severity: "warning",
  });
  const spotChecked = (section: string) => ({
    kind: "grounding-sampled",
    section,
    message: `Section "${section}" was only SPOT-CHECKED.`,
    severity: "warning",
    ratio: 0.9,
    threshold: 0.8,
    sampled: true,
  });

  it("an unchecked (off) document never claims its sections are grounded or short of the bar", () => {
    render(
      <DegradedWarningsBanner
        warnings={[skipped("Business Rules"), skipped("Key Workflows")]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Not fact-checked: 2 section\(s\)/);
    expect(alert).not.toHaveTextContent(/grounded/i);
    expect(alert).not.toHaveTextContent(/code-fidelity bar/i);
  });

  it("a spot-checked (sample) document says its figures are estimates and never 'within tolerance'", () => {
    render(
      <DegradedWarningsBanner warnings={[spotChecked("Business Rules")]} errorMessage={null} />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Spot-checked only/);
    expect(alert).toHaveTextContent(/\[sampled faithfulness 90% \(threshold 80%\)\]/);
    expect(alert).not.toHaveTextContent(/within normal tolerance/i);
    expect(alert).not.toHaveTextContent(/falls? short of the code-fidelity bar/i);
  });

  it("keeps the review headline for real problems and adds the sample notice", () => {
    render(
      <DegradedWarningsBanner
        warnings={[
          spotChecked("Overview"),
          { ...tierWarning("Business Rules", "literal"), sampled: true },
        ]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Spot-checked only/);
    expect(alert).toHaveTextContent(/"Business Rules" falls short of the code-fidelity bar/);
    // The spot-checked section is listed, but never named as short of the bar.
    expect(alert).not.toHaveTextContent(/"Overview"[^.]*short of the code-fidelity bar/);
  });
});
