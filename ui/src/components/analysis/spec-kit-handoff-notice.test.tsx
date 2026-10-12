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
      "Not sent: specs/001-a/plan.md, specs/001-a/tasks.md, constitution.md (not read by this analysis).",
    );
    // A handoff from before #1027 sent no context, and the notice claims none.
    expect(screen.queryByTestId("spec-kit-handoff-context")).toBeNull();
  });

  describe("context from plan.md and tasks.md (#1027)", () => {
    const artifacts = [
      "specs/001-a/spec.md",
      "specs/001-a/plan.md",
      "specs/001-a/tasks.md",
      "constitution.md",
    ];
    const show = (context: {
      components: string[];
      tasks: string[];
      omitted: string[];
      unrecognised?: Array<"plan.md" | "tasks.md">;
    }) =>
      render(
        <SpecKitHandoffNotice
          metadata={{ specKitHandoff: { artifacts, sent: ["AC-1"], omitted: [], context } }}
        />,
      );

    it("shows the context as context, apart from the requirements from spec.md", () => {
      show({ components: ["FeedStore", "NoticeView"], tasks: ["T01"], omitted: [] });
      expect(screen.getByTestId("spec-kit-handoff-context")).toHaveTextContent(
        "Sent as context for the code agent, not as requirements — from plan.md: 2 components (FeedStore, NoticeView); from tasks.md: 1 task (T01).",
      );
      // The requirements line still counts only spec.md's requirements.
      const requirements = screen.getByTestId("spec-kit-handoff-notice").querySelector("p")!;
      expect(requirements).toHaveTextContent("Sent 1 requirement from spec.md: AC-1.");
      expect(requirements).not.toHaveTextContent("T01");
      expect(requirements).not.toHaveTextContent("FeedStore");
      // Only the file nothing was read from is named as not sent.
      expect(screen.getByTestId("spec-kit-handoff-context-not-sent")).toHaveTextContent(
        "Not sent: constitution.md (not read by this analysis).",
      );
      expect(screen.queryByTestId("spec-kit-handoff-context-omitted")).toBeNull();
    });

    it("names what did not fit the context limit", () => {
      show({ components: ["FeedStore"], tasks: ["T01"], omitted: ["T02", "T03"] });
      expect(screen.getByTestId("spec-kit-handoff-context-omitted")).toHaveTextContent(
        "Left out of the context, as reported by the Spec Kit page — they did not fit the 4,096-character context limit: T02, T03.",
      );
      // Context left out is not a requirement left out.
      expect(screen.queryByTestId("spec-kit-handoff-omitted")).toBeNull();
    });

    it("speaks of one item left out", () => {
      show({ components: [], tasks: ["T01"], omitted: ["T02"] });
      expect(screen.getByTestId("spec-kit-handoff-context-omitted")).toHaveTextContent(
        "Left out of the context, as reported by the Spec Kit page — it did not fit",
      );
    });

    // Review of #1027 — "not read by this analysis" was said of a file that
    // was read and whose Markdown the handoff did not recognise.
    it("says a file was read with nothing recognised, not that it was not read", () => {
      show({ components: [], tasks: ["T01"], omitted: [], unrecognised: ["plan.md"] });
      const notSent = screen.getByTestId("spec-kit-handoff-context-not-sent");
      expect(notSent).toHaveTextContent(
        "Not sent: specs/001-a/plan.md (read, but no components were recognised); constitution.md (not read by this analysis).",
      );
    });

    it("gives each unrecognised file its own reason", () => {
      show({ components: [], tasks: [], omitted: [], unrecognised: ["plan.md", "tasks.md"] });
      expect(screen.getByTestId("spec-kit-handoff-context-not-sent")).toHaveTextContent(
        "Not sent: specs/001-a/plan.md (read, but no components were recognised); specs/001-a/tasks.md (read, but no tasks were recognised); constitution.md (not read by this analysis).",
      );
    });

    it("does not call a file unrecognised when something was sent from it", () => {
      show({ components: ["A"], tasks: ["T01"], omitted: [], unrecognised: ["plan.md"] });
      expect(screen.getByTestId("spec-kit-handoff-context-not-sent")).toHaveTextContent(
        "Not sent: constitution.md (not read by this analysis).",
      );
    });

    it("names a file as not sent when nothing was read from it", () => {
      show({ components: [], tasks: ["T01", "T02"], omitted: [] });
      expect(screen.getByTestId("spec-kit-handoff-context")).toHaveTextContent(
        "not as requirements — from tasks.md: 2 tasks (T01, T02).",
      );
      expect(screen.getByTestId("spec-kit-handoff-context-not-sent")).toHaveTextContent(
        "Not sent: specs/001-a/plan.md, constitution.md (not read by this analysis).",
      );
    });

    it("claims no context when none was found to send", () => {
      show({ components: [], tasks: [], omitted: [] });
      expect(screen.queryByTestId("spec-kit-handoff-context")).toBeNull();
      expect(screen.getByTestId("spec-kit-handoff-context-not-sent")).toHaveTextContent(
        "Not sent: specs/001-a/plan.md, specs/001-a/tasks.md, constitution.md",
      );
    });
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
