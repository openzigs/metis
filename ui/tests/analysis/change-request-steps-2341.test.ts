/**
 * Issue #2341 — the UI half of the change request's steps: where each step's
 * screen is, and the title the start form proposes. The step states themselves
 * are tested where they live, in `@metis/shared`
 * (packages/shared/src/change-request-steps.test.ts).
 */
import { describe, expect, it } from "vitest";
import { changeRequestTitleSchema, type ChangeRequestStepKey } from "@metis/shared";
import { proposedChangeRequestTitle, stepHref } from "@/components/analysis/change-request-steps";

describe("#2341 — stepHref", () => {
  it("links each step to its existing screen", () => {
    const href = (k: ChangeRequestStepKey) => stepHref(k, "p 1", "an-1");
    expect(href("read")).toBe("/projects/p%201/analysis?analysisId=an-1&tab=agents");
    expect(href("questions")).toBe("/projects/p%201/analysis?analysisId=an-1&tab=questions");
    expect(href("requirements")).toBe("/projects/p%201/analysis?analysisId=an-1&tab=requirements");
    expect(href("policy")).toBe("/projects/p%201/analysis?analysisId=an-1&tab=findings");
    expect(href("impact")).toBe("/projects/p%201/impact");
    expect(href("portfolio")).toBe("/portfolio");
    expect(href("review")).toBe("/projects/p%201/requirements");
    expect(href("handoff")).toBe("/projects/p%201/publish?analysisId=an-1");
  });
});

describe("#2341 — proposedChangeRequestTitle", () => {
  const docs = [
    { id: "d1", filename: "brief.docx", title: null },
    { id: "d2", filename: "page-9.html", title: " Refund  policy " },
  ];
  it("is the first chosen document's name, with how many more", () => {
    expect(proposedChangeRequestTitle(["d2"], docs)).toBe("Refund policy");
    expect(proposedChangeRequestTitle(["d1", "d2"], docs)).toBe("brief.docx and 1 more");
  });
  it("is empty when no document is chosen or known", () => {
    expect(proposedChangeRequestTitle([], docs)).toBe("");
    expect(proposedChangeRequestTitle(["gone"], docs)).toBe("");
  });
  it("stays within the title limit", () => {
    const long = [{ id: "d", filename: "x".repeat(300), title: null }];
    expect(proposedChangeRequestTitle(["d", "e"], long).length).toBe(200);
    expect(proposedChangeRequestTitle(["d", "e"], long).endsWith(" and 1 more")).toBe(true);
  });
  it("strips the control characters a filename can hold, so the server accepts what it proposes", () => {
    const odd = [
      { id: "c", filename: "spec\u0000v2\u0007\u001b.docx", title: null },
      { id: "z", filename: "\u0001\u0002", title: null },
      { id: "del", filename: "a\u007fb", title: " \t " },
    ];
    const proposed = proposedChangeRequestTitle(["c"], odd);
    expect(proposed).toBe("spec v2 .docx");
    expect(changeRequestTitleSchema.safeParse(proposed).success).toBe(true);
    expect(proposedChangeRequestTitle(["del"], odd)).toBe("a b");
    // Nothing printable left: no title is proposed (the server names it).
    expect(proposedChangeRequestTitle(["z", "c"], odd)).toBe("");
  });
});
