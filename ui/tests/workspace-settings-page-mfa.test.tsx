/**
 * #1745 — the workspace settings actions the server gates on MFA say why they
 * were refused instead of failing silently: removing a member, changing a
 * member's role and deleting the workspace.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "ws-1" }),
  useRouter: () => ({ push }),
}));

vi.mock("@/lib/api-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api-client")>();
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch, ApiError, MFA_REQUIRED_CODE, MFA_REQUIRED_MESSAGE } from "@/lib/api-client";
import WorkspaceSettingsPage from "@/app/(authed)/settings/workspaces/[id]/page";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

const WORKSPACE = {
  id: "ws-1",
  name: "Team",
  slug: "team",
  logoUrl: null,
  members: [
    {
      id: "m-1",
      role: "owner",
      user: { id: "u-1", username: "ana", displayName: "Ana", email: "ana@example.test" },
    },
    {
      id: "m-2",
      role: "member",
      user: { id: "u-2", username: "bo", displayName: "Bo", email: "bo@example.test" },
    },
  ],
  _count: { projects: 1 },
};

const mfaRefusal = () => new ApiError(403, MFA_REQUIRED_MESSAGE, MFA_REQUIRED_CODE);

/** GET resolves the workspace; every write is refused for MFA. */
function refuseWrites() {
  apiFetchMock.mockImplementation(async (_path: string, opts?: { method?: string }) => {
    if (!opts?.method || opts.method === "GET") return WORKSPACE;
    throw mfaRefusal();
  });
}

async function renderPage() {
  const Wrapper = makeWrapper({});
  render(
    <Wrapper>
      <WorkspaceSettingsPage />
    </Wrapper>,
  );
  await screen.findByText("Bo");
}

beforeEach(() => {
  apiFetchMock.mockReset();
  push.mockReset();
  refuseWrites();
});

describe("Workspace settings — an MFA refusal is shown (#1745)", () => {
  it("removing a member", async () => {
    await renderPage();
    expect(screen.queryByTestId("ws-member-error")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Remove Bo" }));
    const alert = await screen.findByTestId("ws-member-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(MFA_REQUIRED_MESSAGE);
  });

  it("clears the refusal when the next member action succeeds", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Remove Bo" }));
    await screen.findByTestId("ws-member-error");
    apiFetchMock.mockImplementation(async () => WORKSPACE);
    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "admin" } });
    await waitFor(() => expect(screen.queryByTestId("ws-member-error")).not.toBeInTheDocument());
  });

  it("changing a member's role", async () => {
    await renderPage();
    fireEvent.change(screen.getAllByRole("combobox")[1]!, { target: { value: "admin" } });
    expect(await screen.findByTestId("ws-member-error")).toHaveTextContent(MFA_REQUIRED_MESSAGE);
  });

  it("deleting the workspace, inside the confirmation, without leaving the page", async () => {
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Delete workspace" }));
    const alert = await within(dialog).findByTestId("ws-delete-error");
    expect(alert).toHaveAttribute("role", "alert");
    expect(alert).toHaveTextContent(MFA_REQUIRED_MESSAGE);
    expect(push).not.toHaveBeenCalled();
  });
});
