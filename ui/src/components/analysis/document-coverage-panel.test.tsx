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
import { DocumentCoveragePanel, describeKinds } from "./document-coverage-panel";

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
      "booking.docx — 3 requirements (with constraints and business rules) from 3 sections.",
    );
    expect(doc).toHaveTextContent("1 section produced nothing.");
    const sections = within(doc).getAllByTestId("document-coverage-section");
    expect(sections[0]).toHaveTextContent("Booking FRD — nothing extracted");
    expect(sections[1]).toHaveTextContent(
      "Booking FRD › 3 Booking — 2 requirements, 1 business rule, 1 background statement",
    );
    expect(sections[2]).toHaveTextContent("not read");
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

describe("describeKinds", () => {
  it("lists the kinds in their order, singular and plural", () => {
    expect(describeKinds({ example: 2, requirement: 1 })).toBe("1 requirement, 2 examples");
    expect(describeKinds({})).toBe("");
  });
});
