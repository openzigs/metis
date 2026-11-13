/**
 * Epic #157 — ACL editor tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { AclEditor } from "@/components/projects/acl-editor";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    aclApi: {
      update: vi.fn(),
    },
  };
});

import { aclApi } from "@/lib/projects-api";

const updateMock = aclApi.update as unknown as ReturnType<typeof vi.fn>;

beforeEach(() => {
  updateMock.mockReset();
});

function renderEditor(initial: { kind: "user" | "role" | "group"; value: string }[] = []) {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <AclEditor projectId="proj_1" documentId="doc_1" initialSubjects={initial} />
    </Wrapper>,
  );
}

describe("AclEditor", () => {
  it("renders the unrestricted hint when empty", () => {
    renderEditor();
    expect(screen.getByText(/No restrictions/i)).toBeInTheDocument();
  });

  it("adds a subject and saves", async () => {
    updateMock.mockResolvedValue({ chunkCount: 4, aclSubjects: [] });
    renderEditor();
    fireEvent.change(screen.getByTestId("acl-kind-select"), {
      target: { value: "role" },
    });
    fireEvent.change(screen.getByTestId("acl-value-input"), {
      target: { value: "manager" },
    });
    fireEvent.click(screen.getByTestId("acl-add"));
    expect(screen.getByTestId("acl-subjects")).toHaveTextContent("role");
    expect(screen.getByTestId("acl-subjects")).toHaveTextContent("manager");
    fireEvent.click(screen.getByTestId("acl-save"));
    await waitFor(() =>
      expect(updateMock).toHaveBeenCalledWith("proj_1", "doc_1", [
        { kind: "role", value: "manager" },
      ]),
    );
  });

  it("removes a subject", () => {
    renderEditor([{ kind: "user", value: "u1" }]);
    fireEvent.click(screen.getByRole("button", { name: /Remove user u1/i }));
    expect(screen.queryByTestId("acl-subjects")).not.toBeInTheDocument();
  });

  // #2248 — METIS stores no group membership, so a group subject matches no one.
  it("offers user and role subjects, not group", () => {
    renderEditor();
    const options = Array.from(
      (screen.getByTestId("acl-kind-select") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).toEqual(["user", "role"]);
  });

  it("warns that an existing group subject matches no one, and lets it be removed", () => {
    renderEditor([
      { kind: "group", value: "eng-team" },
      { kind: "user", value: "u1" },
    ]);
    expect(screen.getAllByTestId("acl-group-warning")).toHaveLength(1);
    expect(screen.getByTestId("acl-group-warning")).toHaveTextContent(/grants no access/i);
    fireEvent.click(screen.getByRole("button", { name: /Remove group eng-team/i }));
    expect(screen.queryByTestId("acl-group-warning")).not.toBeInTheDocument();
    expect(screen.getByTestId("acl-subjects")).toHaveTextContent("u1");
  });

  it("ignores empty draft values", () => {
    renderEditor();
    fireEvent.click(screen.getByTestId("acl-add"));
    expect(screen.queryByTestId("acl-subjects")).not.toBeInTheDocument();
  });

  // #2356 — a refused save says why: another editor saved at the same time.
  it("shows why a save was refused", async () => {
    const { ApiError } = await import("@/lib/api-client");
    updateMock.mockRejectedValue(
      new ApiError(
        409,
        "Someone else changed this document's access at the same time. Reload it and save again.",
        "ACL_CONFLICT",
      ),
    );
    renderEditor([{ kind: "user", value: "u1" }]);
    expect(screen.queryByTestId("acl-save-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("acl-save"));
    expect(await screen.findByTestId("acl-save-error")).toHaveTextContent(
      /changed this document's access at the same time/i,
    );
  });
});
