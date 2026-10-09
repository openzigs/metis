/**
 * Issue #994 — the analysis page states what a Spec Kit handoff sent and left
 * out, from the run's own metadata.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { SpecKitHandoffNotice, specKitHandoffOf } from "./spec-kit-handoff-notice";

const HANDOFF = {
  artifacts: ["specs/001-a/spec.md", "specs/001-a/plan.md"],
  sent: ["AC-1", "AC-2"],
  omitted: ["AC-3", "NFR-1"],
};

describe("SpecKitHandoffNotice (#994)", () => {
  it("names the artifacts, what was sent, and what was left out", () => {
    render(<SpecKitHandoffNotice metadata={{ specKitHandoff: HANDOFF }} />);
    const notice = screen.getByTestId("spec-kit-handoff-notice");
    expect(notice).toHaveTextContent("Sent 2 requirements from spec.md: AC-1, AC-2.");
    expect(screen.getByTestId("spec-kit-handoff-omitted")).toHaveTextContent(
      "Not sent — they did not fit the analysis input limit: AC-3, NFR-1. This run did not evaluate them.",
    );
  });

  it("speaks of one omitted part, and of an unstructured spec's cut tail", () => {
    render(
      <SpecKitHandoffNotice
        metadata={{
          specKitHandoff: { artifacts: ["spec.md"], sent: [], omitted: ["the end of spec.md"] },
        }}
      />,
    );
    expect(screen.getByTestId("spec-kit-handoff-notice")).not.toHaveTextContent("Sent");
    expect(screen.getByTestId("spec-kit-handoff-omitted")).toHaveTextContent(
      "Not sent — it did not fit the analysis input limit: the end of spec.md. This run did not evaluate it.",
    );
  });

  it("says only spec.md's requirements were sent, and names the context files as not sent (#994)", () => {
    render(
      <SpecKitHandoffNotice
        metadata={{
          specKitHandoff: {
            artifacts: [
              "specs/001-a/spec.md",
              "specs/001-a/plan.md",
              "specs/001-a/tasks.md",
              "constitution.md",
            ],
            sent: ["AC-1"],
            omitted: [],
          },
        }}
      />,
    );
    const notice = screen.getByTestId("spec-kit-handoff-notice");
    expect(notice).toHaveTextContent(
      "Started from a Spec Kit handoff. Only spec.md's requirements were sent.",
    );
    // The context files are never listed as if they were sent.
    expect(notice.querySelector("p")).not.toHaveTextContent("plan.md");
    expect(screen.getByTestId("spec-kit-handoff-context-not-sent")).toHaveTextContent(
      "Not sent: specs/001-a/plan.md, specs/001-a/tasks.md, constitution.md (context; see #1027).",
    );
  });

  it("names nothing as not sent when spec.md was the only artifact", () => {
    render(
      <SpecKitHandoffNotice
        metadata={{
          specKitHandoff: { artifacts: ["specs/001-a/spec.md"], sent: ["AC-1"], omitted: [] },
        }}
      />,
    );
    expect(screen.queryByTestId("spec-kit-handoff-context-not-sent")).toBeNull();
  });

  it("shows no warning when everything was sent", () => {
    render(
      <SpecKitHandoffNotice
        metadata={{ specKitHandoff: { artifacts: ["spec.md"], sent: ["AC-1"], omitted: [] } }}
      />,
    );
    expect(screen.getByTestId("spec-kit-handoff-notice")).toHaveTextContent(
      "Sent 1 requirement from spec.md: AC-1.",
    );
    expect(screen.queryByTestId("spec-kit-handoff-omitted")).toBeNull();
  });

  it("renders nothing for a run not started from a handoff, or a malformed record", () => {
    for (const metadata of [null, undefined, {}, { specKitHandoff: { omitted: "AC-1" } }]) {
      const { container } = render(<SpecKitHandoffNotice metadata={metadata} />);
      expect(container).toBeEmptyDOMElement();
    }
    expect(specKitHandoffOf({ specKitHandoff: HANDOFF })).toEqual(HANDOFF);
  });
});
