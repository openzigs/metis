/**
 * Issue #1027 (review) — the analysis page shows the context text the code
 * agent was given, for any run that has one.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AgentContextDisclosure, agentContextOf } from "./agent-context-disclosure";

const CONTEXT =
  "Plan components (plan.md):\n- FeedStore — Extends storage/feed.go\n- T01: Add index";

describe("AgentContextDisclosure (#1027)", () => {
  it("shows the stored text with its length, collapsed by default", () => {
    render(<AgentContextDisclosure metadata={{ agentContext: CONTEXT }} />);
    const details = screen.getByTestId("analysis-agent-context") as HTMLDetailsElement;
    expect(details.tagName).toBe("DETAILS");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")).toHaveTextContent(
      `Context given to the code agent, not requirements (${CONTEXT.length} characters)`,
    );
    expect(screen.getByTestId("analysis-agent-context-text").textContent).toBe(CONTEXT);
  });

  // A direct API caller can send the field with no handoff record: the text
  // must be visible on that run too.
  it("shows for a run that was not started from a Spec Kit handoff", () => {
    render(<AgentContextDisclosure metadata={{ agentContext: "steer the agent" }} />);
    expect(screen.getByTestId("analysis-agent-context-text").textContent).toBe("steer the agent");
  });

  it("renders Markdown and HTML in the text as the characters they are", () => {
    const hostile =
      '# Heading\n**bold** [link](javascript:alert(1))\n<img src=x onerror="alert(1)"><script>x()</script>';
    render(<AgentContextDisclosure metadata={{ agentContext: hostile }} />);
    const pre = screen.getByTestId("analysis-agent-context-text");
    expect(pre.tagName).toBe("PRE");
    expect(pre.textContent).toBe(hostile);
    // One text node: nothing in the stored text became an element.
    expect(pre.children).toHaveLength(0);
    const details = screen.getByTestId("analysis-agent-context");
    for (const tag of ["img", "script", "a", "h1", "strong"]) {
      expect(details.querySelector(tag)).toBeNull();
    }
  });

  it("groups the length and speaks of one character", () => {
    const { unmount } = render(
      <AgentContextDisclosure metadata={{ agentContext: "x".repeat(4096) }} />,
    );
    expect(screen.getByTestId("analysis-agent-context")).toHaveTextContent("(4,096 characters)");
    unmount();
    render(<AgentContextDisclosure metadata={{ agentContext: "x" }} />);
    expect(screen.getByTestId("analysis-agent-context")).toHaveTextContent("(1 character)");
  });

  it("renders nothing for a run without a context", () => {
    for (const metadata of [
      null,
      undefined,
      {},
      { agentContext: "" },
      { agentContext: "  \n " },
      { agentContext: 7 },
      { agentContext: ["T01"] },
      { specKitHandoff: { artifacts: ["spec.md"], sent: [], omitted: [] } },
    ]) {
      const { container, unmount } = render(
        <AgentContextDisclosure
          metadata={metadata as Record<string, unknown> | null | undefined}
        />,
      );
      expect(container).toBeEmptyDOMElement();
      unmount();
    }
    expect(agentContextOf({ agentContext: "  kept  " })).toBe("kept");
  });
});
