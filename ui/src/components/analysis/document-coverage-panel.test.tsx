/**
 * Issue #2230 — the document reader's coverage report on the results page: a
 * section read with nothing in it must not look like one never read.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  deriveCapabilityReasons,
  type AnalysisCapability,
  type DocumentReadingCoverage,
} from "@metis/shared";
import {
  DocumentCoveragePanel,
  describeKinds,
  describeStatementsToRequirements,
  extractedRequirementCount,
} from "./document-coverage-panel";

function capability(documentReading?: DocumentReadingCoverage): AnalysisCapability {
  const base = {
    codeAnalysisRequested: false,
    databaseAnalysisRequested: false,
    codeGraphPresent: false,
    agentMode: "single-shot" as const,
    repoSourceIngested: false,
    fusedCodeRetrievalEnabled: true,
    schemaContextEnabled: true,
    quarantineFallbackUsed: false,
    skippedRepos: [] as AnalysisCapability["skippedRepos"],
    ...(documentReading ? { documentReading } : {}),
  };
  return { ...base, reasons: deriveCapabilityReasons(base) };
}

const READ: DocumentReadingCoverage = {
  documents: [
    {
      documentId: "d1",
      filename: "booking.docx",
      status: "read",
      mode: "whole",
      statements: 4,
      requirements: 3,
      droppedUnverified: 2,
      merge: "failed",
      sections: [
        { heading: "Booking FRD", status: "read", statements: 0, kinds: {} },
        {
          heading: "Booking FRD › 3 Booking",
          status: "read",
          statements: 4,
          kinds: { requirement: 2, "business-rule": 1, background: 1 },
        },
        { heading: "Booking FRD › 4 Fees", status: "unread", statements: 0, kinds: {} },
      ],
    },
    {
      documentId: "d2",
      filename: "old.docx",
      status: "unread",
      reason: "Its stored file could not be read.",
      sections: [],
      statements: 0,
      requirements: 0,
      droppedUnverified: 0,
    },
  ],
};

describe("DocumentCoveragePanel", () => {
  it("renders nothing when the reader did not run", () => {
    const { container } = render(<DocumentCoveragePanel capability={capability()} />);
    expect(container).toBeEmptyDOMElement();
    const none = render(<DocumentCoveragePanel capability={null} />);
    expect(none.container).toBeEmptyDOMElement();
  });

  it("says what was read from each document and each section", () => {
    render(<DocumentCoveragePanel capability={capability(READ)} />);
    const doc = screen.getByTestId("document-coverage-d1");
    expect(doc).toHaveTextContent(
      "booking.docx — 3 requirement statements (with constraints and business rules) from 3 sections.",
    );
    expect(doc).toHaveTextContent("1 section produced nothing.");
    const sections = within(doc).getAllByTestId("document-coverage-section");
    expect(sections[0]).toHaveTextContent("Booking FRD — nothing extracted");
    expect(sections[1]).toHaveTextContent(
      "Booking FRD › 3 Booking — 2 requirements, 1 business rule, 1 background statement",
    );
    // #2407 — a section the reply left out, even when asked again, is unread too.
    expect(sections[2]).toHaveTextContent(
      "not read: the model's reply could not be read, or left this section out even when asked again.",
    );
    expect(sections[2]).toHaveClass("text-warning");
  });

  it("#2361 — says an overview merged into a later section was read, not that it produced nothing", () => {
    const merged: DocumentReadingCoverage = {
      documents: [
        {
          ...READ.documents[0]!,
          sections: [
            {
              heading: "Booking FRD › 1 Overview",
              status: "read",
              statements: 0,
              kinds: {},
              mergedInto: ["Booking FRD › 3 Booking", "Booking FRD › 4 Fees"],
            },
            { heading: "Booking FRD › 2 Scope", status: "read", statements: 0, kinds: {} },
          ],
        },
      ],
    };
    render(<DocumentCoveragePanel capability={capability(merged)} />);
    const doc = screen.getByTestId("document-coverage-d1");
    // Only the section with nothing at all counts as producing nothing.
    expect(doc).toHaveTextContent("1 section produced nothing.");
    const sections = within(doc).getAllByTestId("document-coverage-section");
    expect(sections[0]).toHaveTextContent(
      "Booking FRD › 1 Overview — read; what it says is set out in full in Booking FRD › 3 Booking; Booking FRD › 4 Fees",
    );
    expect(sections[0]).not.toHaveTextContent("nothing extracted");
    expect(sections[1]).toHaveTextContent("Booking FRD › 2 Scope — nothing extracted");
  });

  it("names every loss: unread sections, dropped statements, a merge that did not complete, an unread document", () => {
    render(<DocumentCoveragePanel capability={capability(READ)} />);
    const doc = screen.getByTestId("document-coverage-d1");
    expect(doc).toHaveTextContent("1 section was not read");
    expect(doc).toHaveTextContent("2 statements were left out because the passage quoted");
    expect(doc).toHaveTextContent("a requirement may appear twice");
    const unread = screen.getByTestId("document-coverage-d2");
    expect(unread).toHaveTextContent("old.docx — not read. Its stored file could not be read.");
    expect(unread).toHaveClass("text-warning");
  });

  it("says when a document was read section by section", () => {
    render(
      <DocumentCoveragePanel
        capability={capability({
          documents: [
            { ...READ.documents[0]!, mode: "sectioned", droppedUnverified: 0, merge: "done" },
          ],
        })}
      />,
    );
    const doc = screen.getByTestId("document-coverage-d1");
    expect(doc).toHaveTextContent("read section by section");
    expect(doc).not.toHaveTextContent("appear twice");
    expect(doc).not.toHaveTextContent("left out");
  });
});

describe("#2280 — a reused reading", () => {
  it("says the document was not read again, when and with which model its reading was made", () => {
    render(
      <DocumentCoveragePanel
        capability={capability({
          documents: [
            {
              ...READ.documents[0]!,
              reused: { readAt: "2026-11-03T10:00:00.000Z", model: "claude-sonnet-5-5" },
            },
          ],
        })}
      />,
    );
    expect(screen.getByTestId("document-coverage-reused")).toHaveTextContent(
      'Not read again: the reading saved on 2026-11-03 (read with claude-sonnet-5-5) was reused, because the file has not changed. Start a new analysis with "Read the documents again" for a fresh reading.',
    );
  });

  it("says nothing about a reuse for a document read now", () => {
    render(<DocumentCoveragePanel capability={capability(READ)} />);
    expect(screen.queryByTestId("document-coverage-reused")).toBeNull();
  });
});

/**
 * Issue #2596 — the panel said 12 (statements read) where the summary said 8
 * (requirements extracted from them) and the checkpoints 18 (the 8 plus 10
 * NFRs the analysis found).
 */
describe("#2596 — statements read against the requirements extracted", () => {
  /** READ less its unread document, so the statements account for every requirement. */
  const ALL_READ: DocumentReadingCoverage = {
    documents: READ.documents.filter((d) => d.status !== "unread"),
  };

  it("says how the statements became fewer requirements", () => {
    render(<DocumentCoveragePanel capability={capability(ALL_READ)} extractedRequirements={2} />);
    expect(screen.getByTestId("document-coverage-reconciled")).toHaveTextContent(
      "The analysis combined these 3 statements into 2 requirements: one requirement can rest on several statements.",
    );
  });

  it("says nothing when the counts agree or the extraction count is unknown", () => {
    render(<DocumentCoveragePanel capability={capability(ALL_READ)} extractedRequirements={3} />);
    expect(screen.queryByTestId("document-coverage-reconciled")).toBeNull();
    expect(describeStatementsToRequirements(3, undefined)).toBeNull();
    expect(describeStatementsToRequirements(0, 4)).toBeNull();
    expect(describeStatementsToRequirements(1, 1)).toBeNull();
    expect(describeStatementsToRequirements(12, 1)).toBe(
      "The analysis combined these 12 statements into 1 requirement: one requirement can rest on several statements.",
    );
  });

  it("says nothing when the statements cannot account for the requirements", () => {
    // More requirements than statements: some came from text not counted here.
    expect(describeStatementsToRequirements(4, 9)).toBeNull();
    // A document went unread: its requirements are not among the statements.
    expect(describeStatementsToRequirements(12, 8, false)).toBeNull();
    // READ holds an unread document (old.docx), so even 3 statements to 2 says nothing.
    render(<DocumentCoveragePanel capability={capability(READ)} extractedRequirements={2} />);
    expect(screen.queryByTestId("document-coverage-reconciled")).toBeNull();
  });

  it("counts the reviewed list less what the analysis added to it", () => {
    const metadata = {
      structuredRequirements: {
        requirements: [
          { id: "a" },
          { id: "b" },
          { id: "NFR-1", elicitedNfr: { nfrCategory: "security", evidenceFindingIds: [] } },
          { id: "SYN-1", synthesisItemKey: "k" },
        ],
      },
    };
    expect(extractedRequirementCount(metadata)).toBe(2);
    expect(extractedRequirementCount({ structuredRequirements: { requirements: [] } })).toBe(
      undefined,
    );
    expect(extractedRequirementCount(null)).toBe(undefined);
  });
});

describe("describeKinds", () => {
  it("lists the kinds in their order, singular and plural", () => {
    expect(describeKinds({ example: 2, requirement: 1 })).toBe("1 requirement, 2 examples");
    expect(describeKinds({})).toBe("");
  });
});
