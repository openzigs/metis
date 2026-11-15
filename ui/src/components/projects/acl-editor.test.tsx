/**
 * #2547 — the document access-list editor, now mounted on the Documents page
 * and the quarantine reviewer: it edits the list, saves it through
 * `PATCH /documents/:id/acl`, re-reads the lists that show the badge, and warns
 * an editor who is about to shut themselves out.
 *
 * #2555 — a person is picked by name from the project's people and a role from
 * the role list; every subject is listed by name, never by internal id.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AclSubject, AclUserName } from "@/lib/projects-api";

let viewer: { id: string; role: string } | null = { id: "u-bob", role: "developer" };
vi.mock("@/lib/auth-context", () => ({ useAuth: () => ({ user: viewer }) }));
const updateAcl = vi.fn();
vi.mock("@/lib/projects-api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/projects-api")>()),
  aclApi: { update: (...a: unknown[]) => updateAcl(...a) },
}));
const apiFetch = vi.fn();
vi.mock("@/lib/api-client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api-client")>()),
  apiFetch: (...a: unknown[]) => apiFetch(...a),
}));

const { AclEditor, aclLocksOut } = await import("./acl-editor");

const ALICE: AclUserName = { id: "u-alice", username: "asmith", displayName: "Alice Smith" };
const BOB: AclUserName = { id: "u-bob", username: "bjones", displayName: "Bob Jones" };

function renderEditor(
  initialSubjects: AclSubject[] = [],
  onSaved = vi.fn(),
  initialUsers?: AclUserName[],
) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(qc, "invalidateQueries");
  render(
    <QueryClientProvider client={qc}>
      <AclEditor
        projectId="p1"
        documentId="d1"
        initialSubjects={initialSubjects}
        initialUsers={initialUsers}
        onSaved={onSaved}
      />
    </QueryClientProvider>,
  );
  return { invalidate, onSaved };
}

function addRole(role: string) {
  fireEvent.change(screen.getByTestId("acl-kind-select"), { target: { value: "role" } });
  fireEvent.change(screen.getByTestId("acl-role-select"), { target: { value: role } });
  fireEvent.click(screen.getByTestId("acl-add"));
}

async function addPerson(term: string, person: AclUserName) {
  fireEvent.change(screen.getByTestId("acl-kind-select"), { target: { value: "user" } });
  fireEvent.change(screen.getByTestId("acl-person-search"), { target: { value: term } });
  fireEvent.click(await screen.findByTestId(`acl-person-option-${person.id}`));
}

beforeEach(() => {
  viewer = { id: "u-bob", role: "developer" };
  updateAcl.mockReset();
  updateAcl.mockResolvedValue({ chunkCount: 2, aclSubjects: [] });
  apiFetch.mockReset();
  apiFetch.mockResolvedValue([ALICE, BOB]);
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

  it("adds and removes subjects, never twice", () => {
    renderEditor([{ kind: "role", value: "coordinator" }]);
    expect(screen.getByTestId("acl-subjects")).toHaveTextContent("the coordinator role");
    fireEvent.change(screen.getByTestId("acl-kind-select"), { target: { value: "role" } });
    fireEvent.change(screen.getByTestId("acl-role-select"), { target: { value: "coordinator" } });
    expect(screen.getByTestId("acl-add")).toBeDisabled();
    addRole("reader");
    expect(screen.getByTestId("acl-subjects").querySelectorAll("li")).toHaveLength(2);
    fireEvent.click(screen.getByRole("button", { name: "Remove the coordinator role" }));
    expect(screen.getByTestId("acl-subjects")).not.toHaveTextContent("coordinator");
  });

  it("saves the edited list, re-reads the quarantine and Documents lists, and reports saved", async () => {
    const { invalidate, onSaved } = renderEditor();
    addRole("developer");
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

  it("warns an editor whose list would leave them out, and not one it names", async () => {
    renderEditor();
    expect(screen.queryByTestId("acl-lockout-warning")).toBeNull();
    addRole("coordinator");
    expect(screen.getByTestId("acl-lockout-warning")).toHaveTextContent(/not on this list/);
    await addPerson("bob", BOB);
    expect(screen.queryByTestId("acl-lockout-warning")).toBeNull();
  });

  it("still lists a legacy group subject with its warning", () => {
    renderEditor([{ kind: "group", value: "finance" }]);
    expect(screen.getByTestId("acl-group-warning")).toBeInTheDocument();
  });
});

describe("AclEditor — people by name (#2555)", () => {
  it("finds a person among the project's people by name and adds them by id", async () => {
    renderEditor();
    await addPerson("ali", ALICE);
    // Searched in this project only.
    expect(apiFetch).toHaveBeenCalledWith("/users?search=ali&limit=8&projectId=p1");
    const list = screen.getByTestId("acl-subjects");
    expect(list).toHaveTextContent("Alice Smith");
    expect(list).toHaveTextContent("@asmith");
    expect(list).not.toHaveTextContent("u-alice");
    // The search clears, and Alice is not offered again.
    expect(screen.getByTestId("acl-person-search")).toHaveValue("");
    fireEvent.change(screen.getByTestId("acl-person-search"), { target: { value: "a" } });
    await screen.findByTestId("acl-person-option-u-bob");
    expect(screen.queryByTestId("acl-person-option-u-alice")).toBeNull();
    fireEvent.click(screen.getByTestId("acl-save"));
    await waitFor(() =>
      expect(updateAcl).toHaveBeenCalledWith("p1", "d1", [{ kind: "user", value: "u-alice" }]),
    );
  });

  it("lists the people a document starts with by the names the server sent", () => {
    renderEditor([{ kind: "user", value: "u-alice" }], vi.fn(), [ALICE]);
    expect(screen.getByTestId("acl-subjects")).toHaveTextContent("Alice Smith @asmith");
    expect(screen.getByRole("button", { name: "Remove Alice Smith" })).toBeInTheDocument();
  });

  it("calls a person the server did not name someone outside the project, never their id", () => {
    renderEditor([{ kind: "user", value: "cmurr3lo11r2nns9kfurops14" }]);
    const list = screen.getByTestId("acl-subjects");
    expect(list).toHaveTextContent("a person not in this project");
    expect(list).not.toHaveTextContent("cmurr3lo11r2nns9kfurops14");
  });

  it("says when no one else matches, and when the search failed", async () => {
    apiFetch.mockResolvedValueOnce([ALICE]);
    renderEditor([{ kind: "user", value: "u-alice" }], vi.fn(), [ALICE]);
    fireEvent.change(screen.getByTestId("acl-person-search"), { target: { value: "alice" } });
    expect(await screen.findByTestId("acl-person-none")).toHaveTextContent(
      "No one else in this project matches",
    );
    apiFetch.mockRejectedValueOnce(new Error("down"));
    fireEvent.change(screen.getByTestId("acl-person-search"), { target: { value: "zed" } });
    expect(await screen.findByTestId("acl-person-error")).toBeInTheDocument();
  });

  it("offers the role list, not a free-text value", () => {
    renderEditor();
    expect(screen.queryByTestId("acl-value-input")).toBeNull();
    fireEvent.change(screen.getByTestId("acl-kind-select"), { target: { value: "role" } });
    const roles = Array.from(
      (screen.getByTestId("acl-role-select") as HTMLSelectElement).options,
    ).map((o) => o.value);
    // Not `admin`: an admin reads every restricted document already, so it
    // grants nothing, and it is not the default an Add without a choice takes.
    expect(roles).toEqual(["coordinator", "developer", "reader"]);
    expect((screen.getByTestId("acl-role-select") as HTMLSelectElement).value).toBe("coordinator");
    // No search runs for a role.
    expect(apiFetch).not.toHaveBeenCalled();
  });
});
