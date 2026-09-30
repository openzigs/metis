/**
 * Issue #30 — the results tabs, their counts, and the pre-tab anchors.
 */
import { describe, it, expect, vi } from "vitest";
import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { TabsContent } from "@/components/ui/tabs";
import { AnalysisResultTabs } from "./AnalysisResultTabs";
import type { AnalysisTab } from "./analysis-views";

function Harness({
  initial = "summary",
  counts = {},
  onChange = () => {},
  onAnchor,
}: {
  initial?: AnalysisTab;
  counts?: Partial<Record<AnalysisTab, number>>;
  onChange?: (t: AnalysisTab) => void;
  onAnchor?: (anchor: string) => void;
}) {
  const [tab, setTab] = useState<AnalysisTab>(initial);
  return (
    <AnalysisResultTabs
      value={tab}
      onValueChange={(t) => {
        setTab(t);
        onChange(t);
      }}
      counts={counts}
      onAnchor={onAnchor}
    >
      <TabsContent value="summary">
        <p>summary body</p>
        <a href="#approvals">Go to approvals</a>
        <a href="#clarifying-questions">Review questions</a>
        <a href="#somewhere-else">Elsewhere</a>
      </TabsContent>
      <TabsContent value="approvals">
        <p>approvals body</p>
      </TabsContent>
      <TabsContent value="questions">
        <p>questions body</p>
      </TabsContent>
    </AnalysisResultTabs>
  );
}

describe("AnalysisResultTabs (#30)", () => {
  it("mounts only the active tab's content", () => {
    render(<Harness />);
    expect(screen.getByText("summary body")).toBeInTheDocument();
    expect(screen.queryByText("approvals body")).not.toBeInTheDocument();
  });

  it("switches tab on a trigger click and reports it", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("tab", { name: /^Approvals/ }));
    expect(onChange).toHaveBeenCalledWith("approvals");
    expect(screen.getByText("approvals body")).toBeInTheDocument();
    expect(screen.queryByText("summary body")).not.toBeInTheDocument();
  });

  it("shows counts, wording Questions and Approvals as outstanding", () => {
    render(<Harness counts={{ findings: 29, questions: 14, approvals: 0 }} />);
    expect(screen.getByTestId("analysis-tab-count-findings")).toHaveTextContent("29");
    expect(screen.getByRole("tab", { name: /^Questions\s*\(14 open\)$/ })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /^Approvals\s*\(0 pending\)$/ })).toBeInTheDocument();
    // Outstanding work is highlighted; nothing outstanding is not.
    expect(screen.getByTestId("analysis-tab-count-questions").className).toMatch(/warning/);
    expect(screen.getByTestId("analysis-tab-count-approvals").className).not.toMatch(/warning/);
    expect(screen.getByTestId("analysis-tab-count-findings").className).not.toMatch(/warning/);
    // No count at all where none is known.
    expect(screen.queryByTestId("analysis-tab-count-agents")).not.toBeInTheDocument();
  });

  it("turns a 'Go to approvals' anchor into a switch to the Approvals tab", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("link", { name: "Go to approvals" }));
    expect(onChange).toHaveBeenCalledWith("approvals");
    expect(screen.getByText("approvals body")).toBeInTheDocument();
  });

  // #406 — the switch alone left the reader at the top of the page; the page
  // needs the anchor to scroll to once the tab's content mounts.
  it("reports the anchor it intercepted, so the page can scroll to it", async () => {
    const onAnchor = vi.fn();
    render(<Harness onAnchor={onAnchor} />);
    await userEvent.click(screen.getByRole("link", { name: "Go to approvals" }));
    expect(onAnchor).toHaveBeenCalledWith("#approvals");
    await userEvent.click(screen.getByRole("tab", { name: /^Summary/ }));
    await userEvent.click(screen.getByRole("link", { name: "Elsewhere" }));
    expect(onAnchor).toHaveBeenCalledTimes(1);
  });

  it("turns 'Review questions' into a switch to the Questions tab", async () => {
    render(<Harness />);
    await userEvent.click(screen.getByRole("link", { name: "Review questions" }));
    expect(screen.getByText("questions body")).toBeInTheDocument();
  });

  it("lets an anchor into the CURRENT tab scroll as a normal link", () => {
    const onChange = vi.fn();
    const onAnchor = vi.fn();
    render(<Harness initial="questions" onChange={onChange} onAnchor={onAnchor} />);
    const link = document.createElement("a");
    link.setAttribute("href", "#clarifying-questions");
    screen.getByText("questions body").appendChild(link);

    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    link.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(onAnchor).not.toHaveBeenCalled();
  });

  it("leaves any other link alone", async () => {
    const onChange = vi.fn();
    render(<Harness onChange={onChange} />);
    await userEvent.click(screen.getByRole("link", { name: "Elsewhere" }));
    await userEvent.click(screen.getByText("summary body"));
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByText("summary body")).toBeInTheDocument();
  });
});
