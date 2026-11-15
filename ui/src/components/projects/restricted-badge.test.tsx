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
  });

  it("says only Restricted to a member left off the list: no readers named", () => {
    render(<RestrictedBadge access={{ restricted: true, canRead: false }} testId="b" />);
    expect(screen.getByTestId("b")).toHaveTextContent(/^Restricted$/);
  });

  it("does not name a legacy group subject as a reader: it matches no one (#2261)", () => {
    const { rerender } = render(
      <RestrictedBadge
        access={{
          restricted: true,
          canRead: true,
          subjects: [
            { kind: "group", value: "finance" },
            { kind: "role", value: "coordinator" },
          ],
        }}
        testId="b"
      />,
    );
    expect(screen.getByTestId("b")).toHaveTextContent("Readable by role coordinator and admins");
    expect(screen.getByTestId("b")).not.toHaveTextContent("finance");
    rerender(
      <RestrictedBadge
        access={{
          restricted: true,
          canRead: true,
          subjects: [{ kind: "group", value: "finance" }],
        }}
        testId="b"
      />,
    );
    expect(screen.getByTestId("b")).toHaveTextContent("Readable by admins only");
  });

  it("describes subjects in the editor's words", () => {
    expect(describeAclSubjects([{ kind: "group", value: "finance" }])).toBe("group finance");
    expect(describeAclSubjects([])).toBe("");
  });
});
