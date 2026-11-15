/**
 * #2547 — the document access-list editor, now mounted on the Documents page
 * and the quarantine reviewer: it edits the list, saves it through
 * `PATCH /documents/:id/acl`, re-reads the lists that show the badge, and warns
 * an editor who is about to shut themselves out.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AclSubject } from "@/lib/projects-api";

let viewer: { id: string; role: string } | null = { id: "u-bob", role: "developer" };
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: viewer }) }));
const updateAcl = vi.fn();
vi.mock("@/lib/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects-api")>()),
  aclApi: { update: (...a: unknown[]) => updateAcl(...a) },
}));

const { AclEditor, aclLocksOut } = await import("./acl-editor");

function renderEditor(initialSubjects: AclSubject[] = [], onSaved = vi.fn()) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <AclEditor
        projectId="p1"
        documentId="d1"
        initialSubjects={initialSubjects}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { invalidate, onSaved };
}

function addSubject(kind: "user" | "role", value: string) {
  fireEvent.change(screen.getByTestId("acl-kind-select"), { target: { value: kind } });
  fireEvent.change(screen.getByTestId("acl-value-input"), { target: { value } });
  fireEvent.click(screen.getByTestId("acl-add"));
}

beforeEach(() => {
  viewer = { id: "u-bob", role: "developer" };
  updateAcl.mockReset();
  updateAcl.mockResolvedValue({ chunkCount: 2, aclSubjects: [] });
});

describe("aclLocksOut (#2547)", () => {
  const bob = { id: "u-bob", role: "developer" };
  it("is false for an empty list, an admin, or no viewer", () => {
    expect(aclLocksOut([], bob)).toBe(false);
    expect(aclLocksOut([{ kind: "role", value: "coordinator" }], { id: "a", role: "admin" })).toBe(
      false,
    );
    expect(aclLocksOut([{ kind: "role", value: "coordinator" }], null)).toBe(false);
  });
  it("is false when the list names the viewer's id or role", () => {
    expect(aclLocksOut([{ kind: "user", value: "u-bob" }], bob)).toBe(false);
    expect(aclLocksOut([{ kind: "role", value: "developer" }], bob)).toBe(false);
  });
  it("is true when the list names neither, a group included", () => {
    expect(aclLocksOut([{ kind: "role", value: "coordinator" }], bob)).toBe(true);
    expect(aclLocksOut([{ kind: "user", value: "u-alice" }], bob)).toBe(true);
    expect(aclLocksOut([{ kind: "group", value: "developer" }], bob)).toBe(true);
  });
});

describe("AclEditor (#2547)", () => {
  it("says an empty list is unrestricted, and lists the subjects it starts with", () => {
    renderEditor();
    expect(screen.getByText(/No restrictions/)).toBeInTheDocument();
  });

  it("adds and removes subjects, ignoring a blank value", () => {
    renderEditor([{ kind: "role", value: "coordinator" }]);
    expect(screen.getByTestId("acl-subjects")).toHaveTextContent("role · coordinator");
    addSubject("user", "   ");
    expect(screen.getByTestId("acl-subjects").querySelectorAll("li")).toHaveLength(1);
    addSubject("user", " u-bob ");
    expect(screen.getByTestId("acl-subjects")).toHaveTextContent("user · u-bob");
    fireEvent.click(screen.getByRole("button", { name: "Remove role coordinator" }));
    expect(screen.getByTestId("acl-subjects")).not.toHaveTextContent("coordinator");
  });

  it("saves the edited list, re-reads the quarantine and Documents lists, and reports saved", async () => {
    const { invalidate, onSaved } = renderEditor();
    addSubject("role", "developer");
    fireEvent.click(screen.getByTestId("acl-save"));
    await waitFor(() =>
      expect(updateAcl).toHaveBeenCalledWith("p1", "d1", [{ kind: "role", value: "developer" }]),
    );
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    const keys = invalidate.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    expect(keys).toContain(JSON.stringify(["quarantine", "p1"]));
    expect(keys).toContain(JSON.stringify(["documents", "project", "p1"]));
  });

  it("shows why a save was refused, and does not report it saved", async () => {
    updateAcl.mockRejectedValue(new Error("You cannot change who can read it."));
    const { onSaved } = renderEditor();
    fireEvent.click(screen.getByTestId("acl-save"));
    expect(await screen.findByTestId("acl-save-error")).toHaveTextContent(
      "You cannot change who can read it.",
    );
    expect(onSaved).not.toHaveBeenCalled();
  });

  it("warns an editor whose list would leave them out, and not one it names", () => {
    renderEditor();
    expect(screen.queryByTestId("acl-lockout-warning")).toBeNull();
    addSubject("role", "coordinator");
    expect(screen.getByTestId("acl-lockout-warning")).toHaveTextContent(/not on this list/);
    addSubject("user", "u-bob");
    expect(screen.queryByTestId("acl-lockout-warning")).toBeNull();
  });

  it("still lists a legacy group subject with its warning", () => {
    renderEditor([{ kind: "group", value: "finance" }]);
    expect(screen.getByTestId("acl-group-warning")).toBeInTheDocument();
  });
});
