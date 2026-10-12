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
import {
  classifyWarningSeverity,
  DegradedWarningsBanner,
  FactConsistencyNote,
  factConsistencyNotes,
  SchemaNamesNote,
  schemaNamesNotes,
} from "@/app/(authed)/projects/[id]/documentation/page";

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
  it("keeps role='alert' and the warning-token Card styling regardless of severity", () => {
    const { container } = render(
      <DegradedWarningsBanner
        warnings={[tierWarning("Overview & Domain", "narrative")]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toBeInTheDocument();
    // Warning styling (the #267 token, formerly raw amber) holds for both states.
    expect(container.querySelector(".bg-warning-muted")).not.toBeNull();
    expect(container.querySelector(".border-warning\\/40")).not.toBeNull();
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

  const runMarker = (kind: "grounding-skipped" | "grounding-sampled") => ({
    kind,
    section: "Document",
    message: "This document was not fully fact-checked.",
    severity: "warning",
    runLevel: true,
  });

  it("never counts the document-level marker as a section", () => {
    render(
      <DegradedWarningsBanner
        warnings={[skipped("Business Rules"), runMarker("grounding-skipped")]}
        errorMessage={null}
      />,
    );
    expect(screen.getByRole("alert")).toHaveTextContent(/Not fact-checked: 1 section\(s\)/);
  });

  it("the document-level marker alone still yields the mode notice", () => {
    const { unmount } = render(
      <DegradedWarningsBanner warnings={[runMarker("grounding-skipped")]} errorMessage={null} />,
    );
    let alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Not fact-checked: this document was generated/);
    expect(alert).not.toHaveTextContent(/grounded/i);
    unmount();
    render(
      <DegradedWarningsBanner warnings={[runMarker("grounding-sampled")]} errorMessage={null} />,
    );
    alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Spot-checked only/);
    expect(alert).not.toHaveTextContent(/within normal tolerance/i);
  });

  it("an off document with a failed section never claims most sections are grounded (#193 review)", () => {
    render(
      <DegradedWarningsBanner
        warnings={[
          skipped("Overview"),
          {
            kind: "section-failed",
            section: "Key Workflows",
            message: 'Section "Key Workflows" failed to generate.',
            severity: "error",
          },
        ]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/Not fact-checked/);
    expect(alert).toHaveTextContent(/"Key Workflows"/);
    expect(alert).not.toHaveTextContent(/grounded/i);
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

// #1061 — names the schema check could not match are INFORMATION. The check
// only marks, a mark can be false, and the document is `ready`: the page shows
// one neutral line and never the degraded-output banner's "falls short of the
// code-fidelity bar" for them.
describe("names not matched to the database schema (#1061)", () => {
  const MESSAGE =
    "4 names in Data Architecture could not be matched to the database schema (jobs, " +
    "certificate_cache, feeds.error_counter, entries.category_id). Compared with the live " +
    'schema of "miniflux-pg" (public). They are marked or listed in the section\'s Schema check ' +
    "note; nothing was removed or changed. A database read can be incomplete, so an unmatched " +
    "name can be real.";
  const schemaNames = (message = MESSAGE) => ({
    kind: "schema-unverified" as const,
    section: "Data Architecture",
    message,
    severity: "info" as const,
  });

  it("shows the server's sentence as a status note, not an alert", () => {
    render(<SchemaNamesNote warnings={[schemaNames()]} />);
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent(
      "4 names in Data Architecture could not be matched to the database schema",
    );
    expect(note).toHaveTextContent("nothing was removed or changed");
    expect(screen.queryByRole("alert")).toBeNull();
    for (const alarm of [/code-fidelity bar/, /worth verifying/, /Degraded/i, /Needs review/i]) {
      expect(note).not.toHaveTextContent(alarm);
    }
  });

  it("renders nothing without one", () => {
    for (const warnings of [undefined, null, [], [tierWarning("Business Rules", "literal")]]) {
      const { container, unmount } = render(<SchemaNamesNote warnings={warnings} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    expect(schemaNamesNotes([tierWarning("Business Rules", "literal")])).toEqual([]);
    expect(schemaNamesNotes([schemaNames("a"), schemaNames("b")])).toEqual(["a", "b"]);
  });

  it("is kept out of the degraded-output banner beside a section that is short of the bar", () => {
    render(
      <DegradedWarningsBanner
        warnings={[schemaNames(), tierWarning("Business Rules", "literal")]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent(/"Business Rules" falls short of the code-fidelity bar/);
    expect(alert).not.toHaveTextContent(/Data Architecture/);
    expect(alert).not.toHaveTextContent(/could not be matched to the database schema/);
    // One listed warning: the one that degrades the document.
    expect(alert.querySelectorAll("li")).toHaveLength(1);
  });

  it("is not classified as concerning", () => {
    expect(classifyWarningSeverity([schemaNames()])).toEqual({
      reviewRecommended: false,
      concerningSections: [],
    });
  });
});

// #1070 — what the cross-section consistency check found is information too:
// it compares how values are written and changes nothing.
describe("values stated differently in two places (#1070)", () => {
  const MESSAGE =
    "Consistency check: 1 value stated differently from the source. `POLLING_FREQUENCY` is " +
    "stated with a value that is not the source's (`30 min` in Integrations & Glossary). The " +
    "source has `60min` at config/options.go:41. Nothing was " +
    "removed or changed: the check compares how values are written, so two spellings of one " +
    "value can be reported. Compare the statements with the source.";
  const inconsistent = (message = MESSAGE) => ({
    kind: "fact-inconsistent" as const,
    section: "Document",
    message,
    severity: "info" as const,
  });

  it("shows the server's sentence as a status note, not an alert", () => {
    render(<FactConsistencyNote warnings={[inconsistent()]} />);
    const note = screen.getByRole("status");
    expect(note).toHaveTextContent(
      "`POLLING_FREQUENCY` is stated with a value that is not the source's",
    );
    expect(note).toHaveTextContent("Nothing was removed or changed");
    expect(screen.queryByRole("alert")).toBeNull();
    for (const alarm of [/code-fidelity bar/, /worth verifying/, /Degraded/i, /Needs review/i]) {
      expect(note).not.toHaveTextContent(alarm);
    }
  });

  it("renders nothing without one, and is not the schema note", () => {
    for (const warnings of [undefined, null, [], [tierWarning("Business Rules", "literal")]]) {
      const { container, unmount } = render(<FactConsistencyNote warnings={warnings} />);
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    expect(factConsistencyNotes([inconsistent("a"), inconsistent("b")])).toEqual(["a", "b"]);
    expect(schemaNamesNotes([inconsistent()])).toEqual([]);
  });

  it("is kept out of the degraded-output banner and is not concerning", () => {
    render(
      <DegradedWarningsBanner
        warnings={[inconsistent(), tierWarning("Business Rules", "literal")]}
        errorMessage={null}
      />,
    );
    const alert = screen.getByRole("alert");
    expect(alert).not.toHaveTextContent(/POLLING_FREQUENCY/);
    expect(alert.querySelectorAll("li")).toHaveLength(1);
    expect(classifyWarningSeverity([inconsistent()])).toEqual({
      reviewRecommended: false,
      concerningSections: [],
    });
  });
});
