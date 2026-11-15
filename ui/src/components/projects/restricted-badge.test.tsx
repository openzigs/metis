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
    // #2555 — a person the server did not name is never shown by id.
    expect(badge).toHaveTextContent(
      "Readable by the coordinator role, a person not in this project and admins",
    );
    expect(badge).not.toHaveTextContent("u-alice");
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
    expect(screen.getByTestId("b")).toHaveTextContent(
      "Readable by the coordinator role and admins",
    );
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
    expect(describeAclSubjects([{ kind: "group", value: "finance" }])).toBe("the finance group");
    expect(describeAclSubjects([])).toBe("");
  });

  it("counts the people it cannot name once, instead of repeating them", () => {
    const users = [{ id: "u1", username: "alice", displayName: "Alice Smith" }];
    expect(
      describeAclSubjects(
        [
          { kind: "user", value: "gone-1" },
          { kind: "user", value: "u1" },
          { kind: "user", value: "gone-2" },
          { kind: "role", value: "reader" },
        ],
        users,
      ),
    ).toBe("Alice Smith, the reader role, 2 people not in this project");
    expect(describeAclSubjects([{ kind: "user", value: "gone-1" }], users)).toBe(
      "a person not in this project",
    );
  });

  // #2555 — the walkthrough's badge read "Readable by user cmurr3lo11r2nns9kfurops14".
  it("names a person by display name, from the people the server sent", () => {
    render(
      <RestrictedBadge
        access={{
          restricted: true,
          canRead: true,
          subjects: [
            { kind: "user", value: "cmurr3lo11r2nns9kfurops14" },
            { kind: "role", value: "coordinator" },
          ],
          users: [
            { id: "cmurr3lo11r2nns9kfurops14", username: "asmith", displayName: "Alice Smith" },
          ],
        }}
        testId="b"
      />,
    );
    expect(screen.getByTestId("b")).toHaveTextContent(
      "Readable by Alice Smith, the coordinator role and admins",
    );
    expect(screen.getByTestId("b")).not.toHaveTextContent("cmurr3lo11r2nns9kfurops14");
  });
});
