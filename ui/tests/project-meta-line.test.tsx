/**
 * Issue #430 — project card meta line render. The AC regression: no stray
 * leading "· draft" when the slug is missing.
 */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ProjectMetaLine } from "@/components/projects/project-meta-line";

describe("<ProjectMetaLine />", () => {
  it("renders slug (as <code>) and status joined by a middot", () => {
    render(<ProjectMetaLine slug="acme-migration" status="draft" />);
    const line = screen.getByTestId("project-meta-line");
    expect(line).toHaveTextContent("acme-migration · draft");
    // The slug is rendered as a <code> element.
    expect(line.querySelector("code")?.textContent).toBe("acme-migration");
  });

  it("does NOT render a leading '· ' when the slug is missing", () => {
    render(<ProjectMetaLine slug="" status="draft" />);
    const line = screen.getByTestId("project-meta-line");
    expect(line).toHaveTextContent("draft");
    expect(line.textContent ?? "").not.toMatch(/^\s*·/);
    // No <code> element when there is no slug.
    expect(line.querySelector("code")).toBeNull();
  });

  it("handles a null slug the same as missing (status only, no separator)", () => {
    render(<ProjectMetaLine slug={null} status="active" />);
    const line = screen.getByTestId("project-meta-line");
    expect(line.textContent ?? "").not.toContain("·");
    expect(line).toHaveTextContent("active");
  });

  it("renders nothing when neither slug nor status is present", () => {
    render(<ProjectMetaLine slug="" status="" />);
    expect(screen.queryByTestId("project-meta-line")).toBeNull();
  });
});
