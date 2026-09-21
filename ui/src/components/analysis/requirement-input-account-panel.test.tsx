/**
 * Issue #1112 (Epic #1107) — the user-visible account of what became of every
 * requirement typed into "Evaluate new requirements".
 *
 * #1101's failure was not a wrong number, it was an ABSENCE: R7 produced no
 * output and no warning. These tests lock the surface that makes an absence
 * impossible to mistake for a considered-and-found-nothing result.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  deriveCapabilityReasons,
  type AnalysisCapability,
  type RequirementInputAccount,
} from "@metis/shared";
import { RequirementInputAccountPanel } from "./requirement-input-account-panel";
import { AnalysisCapabilityBanner } from "./analysis-capability-banner";

function capability(account?: RequirementInputAccount): AnalysisCapability {
  const base = {
    codeAnalysisRequested: true,
    databaseAnalysisRequested: false,
    codeGraphPresent: true,
    agentMode: "agentic" as const,
    repoSourceIngested: true,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
    quarantineFallbackUsed: false,
    skippedRepos: [] as AnalysisCapability["skippedRepos"],
    ...(account ? { requirementInputAccount: account } : {}),
  };
  return { ...base, reasons: deriveCapabilityReasons(base) };
}

/** The #1101 run: seven supplied, six analyzed, the seventh cut by the cap. */
const DROPPED_R7: RequirementInputAccount = {
  parsedCount: 7,
  analyzedIds: ["NR-1", "NR-2", "NR-3", "NR-4", "NR-5", "NR-6"],
  merged: [],
  dropped: [
    {
      id: "NR-7",
      excerpt: "Customers must be able to view their order history.",
      reason: "candidate-cap",
    },
  ],
  inputTruncated: false,
};

describe("RequirementInputAccountPanel", () => {
  it("renders nothing for a run that carried no free-text requirements", () => {
    const { container } = render(<RequirementInputAccountPanel capability={capability()} />);
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when there is no capability record at all (pre-#1112 runs)", () => {
    const { container } = render(<RequirementInputAccountPanel capability={null} />);
    expect(container.firstChild).toBeNull();
  });

  it("states how many of the supplied requirements were analyzed", () => {
    render(<RequirementInputAccountPanel capability={capability(DROPPED_R7)} />);
    expect(screen.getByTestId("requirement-input-account-summary")).toHaveTextContent(
      "6 of 7 requirements you supplied were analyzed",
    );
  });

  it("names the dropped requirement and why it was dropped", () => {
    render(<RequirementInputAccountPanel capability={capability(DROPPED_R7)} />);
    const dropped = screen.getByTestId("requirement-input-dropped-NR-7");

    expect(dropped).toHaveTextContent("NR-7");
    expect(dropped).toHaveTextContent("Customers must be able to view their order history.");
    expect(dropped).toHaveTextContent("not analyzed");
    expect(dropped).toHaveTextContent("over the per-run limit on requirements");
  });

  it("reports a merged requirement as merged, naming the survivor — not as a drop", () => {
    render(
      <RequirementInputAccountPanel
        capability={capability({
          parsedCount: 2,
          analyzedIds: ["NR-1"],
          merged: [
            {
              id: "NR-2",
              excerpt: "Log every login attempt.",
              mergedIntoId: "REQ-003",
              mergedIntoExcerpt: "The system must log every login.",
            },
          ],
          dropped: [],
          inputTruncated: false,
        })}
      />,
    );

    const merged = screen.getByTestId("requirement-input-merged-NR-2");
    expect(merged).toHaveTextContent("merged into");
    expect(merged).toHaveTextContent("REQ-003");
    expect(merged).toHaveTextContent("It was analyzed under that requirement.");
    expect(screen.queryByTestId("requirement-input-dropped-list")).toBeNull();
  });

  it("says the paste was cut when the input hit the character limit", () => {
    render(
      <RequirementInputAccountPanel
        capability={capability({
          parsedCount: 1,
          analyzedIds: ["NR-1"],
          merged: [],
          dropped: [],
          inputTruncated: true,
        })}
      />,
    );

    expect(screen.getByTestId("requirement-input-truncated")).toHaveTextContent(
      "reached the input limit",
    );
  });

  it("confirms a clean run rather than staying ambiguous", () => {
    render(
      <RequirementInputAccountPanel
        capability={capability({
          parsedCount: 2,
          analyzedIds: ["NR-1", "NR-2"],
          merged: [],
          dropped: [],
          inputTruncated: false,
        })}
      />,
    );

    expect(screen.getByTestId("requirement-input-account-summary")).toHaveTextContent(
      "2 of 2 requirements you supplied were analyzed",
    );
    expect(screen.queryByTestId("requirement-input-dropped-list")).toBeNull();
    expect(screen.queryByTestId("requirement-input-truncated")).toBeNull();
  });

  it("uses singular wording for a single supplied requirement", () => {
    render(
      <RequirementInputAccountPanel
        capability={capability({
          parsedCount: 1,
          analyzedIds: ["NR-1"],
          merged: [],
          dropped: [],
          inputTruncated: false,
        })}
      />,
    );
    expect(screen.getByTestId("requirement-input-account-summary")).toHaveTextContent(
      "1 of 1 requirement you supplied was analyzed",
    );
  });

  it("explains an unparseable block in plain language", () => {
    render(
      <RequirementInputAccountPanel
        capability={capability({
          parsedCount: 1,
          analyzedIds: [],
          merged: [],
          dropped: [{ id: "NR-1", excerpt: "---", reason: "unparseable" }],
          inputTruncated: false,
        })}
      />,
    );
    expect(screen.getByTestId("requirement-input-dropped-NR-1")).toHaveTextContent(
      "no requirement text could be read",
    );
  });
});

describe("the run does not report unqualified success (#1112 + #733 banner)", () => {
  it("raises the degraded banner for a run that dropped an input", () => {
    render(<AnalysisCapabilityBanner capability={capability(DROPPED_R7)} />);

    expect(screen.getByTestId("analysis-capability-banner")).toBeInTheDocument();
    expect(screen.getByTestId("capability-reason-requirement-inputs-dropped")).toHaveTextContent(
      "were not analyzed",
    );
  });

  it("does NOT raise the banner for a run whose inputs were merely de-duplicated", () => {
    const { container } = render(
      <AnalysisCapabilityBanner
        capability={capability({
          parsedCount: 2,
          analyzedIds: ["NR-1"],
          merged: [{ id: "NR-2", excerpt: "b", mergedIntoId: "NR-1", mergedIntoExcerpt: "a" }],
          dropped: [],
          inputTruncated: false,
        })}
      />,
    );
    expect(container.firstChild).toBeNull();
  });
});
