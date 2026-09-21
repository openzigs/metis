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

  it("ignores empty draft values", () => {
    renderEditor();
    fireEvent.click(screen.getByTestId("acl-add"));
    expect(screen.queryByTestId("acl-subjects")).not.toBeInTheDocument();
  });
});
