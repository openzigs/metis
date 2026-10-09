/**
 * #993 — the Spec Kit export's task selection and created-issue links.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { createdIssueLinks, sameTaskSelection, toggleTaskSelection } from "@/lib/spec-kit-export";
import { IssueLinks } from "@/components/spec-kit/issue-links";

const ALL = ["T01", "T02", "T03"];

describe("toggleTaskSelection", () => {
  it("unchooses one task from every task, in tasks.md order", () => {
    expect(toggleTaskSelection(ALL, null, "T02")).toEqual(["T01", "T03"]);
  });

  it("collapses back to every task (null) when the last one is chosen again", () => {
    expect(toggleTaskSelection(ALL, ["T01", "T03"], "T02")).toBeNull();
  });

  it("keeps tasks.md order whatever order tasks are chosen in", () => {
    expect(toggleTaskSelection(ALL, ["T03"], "T01")).toEqual(["T01", "T03"]);
  });

  it("never unchooses the last chosen task", () => {
    const only = ["T02"];
    expect(toggleTaskSelection(ALL, only, "T02")).toBe(only);
  });
});

describe("sameTaskSelection", () => {
  it("compares null as every task, and lists element by element", () => {
    expect(sameTaskSelection(null, null)).toBe(true);
    expect(sameTaskSelection(null, ["T01"])).toBe(false);
    expect(sameTaskSelection(["T01"], null)).toBe(false);
    expect(sameTaskSelection(["T01", "T02"], ["T01", "T02"])).toBe(true);
    expect(sameTaskSelection(["T01", "T02"], ["T01", "T03"])).toBe(false);
    expect(sameTaskSelection(["T01"], ["T01", "T02"])).toBe(false);
  });
});

describe("createdIssueLinks", () => {
  it("keeps real issues with an https URL only", () => {
    expect(
      createdIssueLinks([
        { taskId: "T01", issueNumber: 5, url: "https://github.com/o/r/issues/5" },
        { taskId: "T02", issueNumber: 0, url: "dryrun://x" },
        { taskId: "T03", issueNumber: 6, url: "javascript:alert(1)" },
        { taskId: "T04", issueNumber: 7, url: "http://github.com/o/r/issues/7" },
      ]),
    ).toEqual([{ taskId: "T01", issueNumber: 5, url: "https://github.com/o/r/issues/5" }]);
    expect(createdIssueLinks(undefined)).toEqual([]);
  });
});

describe("IssueLinks", () => {
  it("links at most ten issues and counts the rest", () => {
    const links = Array.from({ length: 12 }, (_, i) => ({
      taskId: `T${String(i + 1).padStart(2, "0")}`,
      issueNumber: i + 1,
      url: `https://github.com/o/r/issues/${i + 1}`,
    }));
    render(<IssueLinks links={links} testId="links" />);
    const list = screen.getByTestId("links");
    const anchors = within(list).getAllByRole("link");
    expect(anchors).toHaveLength(10);
    expect(anchors[0]).toHaveAttribute("rel", "noopener noreferrer");
    expect(anchors[0]).toHaveAttribute("target", "_blank");
    expect(list).toHaveTextContent("and 2 more");
  });

  it("adds no count when every issue is listed", () => {
    render(
      <IssueLinks
        links={[{ taskId: "T01", issueNumber: 1, url: "https://github.com/o/r/issues/1" }]}
        testId="links"
      />,
    );
    expect(screen.getByTestId("links")).not.toHaveTextContent("more");
  });
});
