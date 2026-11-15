/** #2547 — the "Restricted" badge a listed document carries. */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { describeAclSubjects, RestrictedBadge } from "./restricted-badge";

describe("RestrictedBadge (#2547)", () => {
  it("renders nothing for an unrestricted document or a row with no access field", () => {
    const { container, rerender } = render(<RestrictedBadge access={undefined} testId="b" />);
    expect(container).toBeEmptyDOMElement();
    rerender(
      <RestrictedBadge access={{ restricted: false, canRead: true, subjects: [] }} testId="b" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("names who can read a restricted document", () => {
    render(
      <RestrictedBadge
        access={{
          restricted: true,
          canRead: true,
          subjects: [
            { kind: "role", value: "coordinator" },
            { kind: "user", value: "u-alice" },
          ],
        }}
        testId="b"
      />,
    );
    const badge = screen.getByTestId("b");
    expect(badge).toHaveTextContent("Restricted");
    expect(badge).toHaveTextContent("Readable by role coordinator, user u-alice and admins");
    expect(badge).not.toHaveTextContent("you cannot read it");
  });

  it("tells a member left off the list that they cannot read it", () => {
    render(
      <RestrictedBadge
        access={{ restricted: true, canRead: false, subjects: [{ kind: "role", value: "x" }] }}
        testId="b"
      />,
    );
    expect(screen.getByTestId("b")).toHaveTextContent("you cannot read it");
  });

  it("describes subjects in the editor's words", () => {
    expect(describeAclSubjects([{ kind: "group", value: "finance" }])).toBe("group finance");
    expect(describeAclSubjects([])).toBe("");
  });
});
