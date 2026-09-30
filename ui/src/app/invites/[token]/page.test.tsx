/**
 * #579 — the invite accept page shows a "gone" state for an invite whose
 * workspace was deleted, instead of offering a join the accept route refuses.
 *
 * The validate route now answers `valid: false, workspaceDeleted: true` and
 * withholds the workspace and inviter. The live-invite case is the control: a
 * page that showed the gone state for every invite would fail it.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const push = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ token: "tok-579" }),
  useRouter: () => ({ push }),
}));

import InviteAcceptPage from "./page";

const base = {
  expired: false,
  consumed: false,
  email: "invitee@example.test",
  role: "member",
  expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
};

function stubValidate(data: Record<string, unknown>) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({ data }), { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("InviteAcceptPage (#579)", () => {
  beforeEach(() => push.mockReset());
  afterEach(() => vi.unstubAllGlobals());

  it("shows the gone state, with no accept button, for a deleted workspace", async () => {
    const fetchMock = stubValidate({
      ...base,
      valid: false,
      workspaceDeleted: true,
      workspace: null,
      invitedBy: null,
    });
    render(<InviteAcceptPage />);

    expect(await screen.findByText("Workspace No Longer Exists")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /accept invitation/i })).toBeNull();
    // Not the expired/used card, which would misstate the reason.
    expect(screen.queryByText("Invitation Used")).toBeNull();
    expect(fetchMock).toHaveBeenCalledWith("/api/workspaces/invites/tok-579");
  });

  it("offers the join for a live workspace", async () => {
    stubValidate({
      ...base,
      valid: true,
      workspaceDeleted: false,
      workspace: { id: "ws-1", name: "Live Workspace", slug: "live" },
      invitedBy: "Inviter",
    });
    render(<InviteAcceptPage />);

    expect(await screen.findByRole("button", { name: /accept invitation/i })).toBeInTheDocument();
    expect(screen.getByText("Live Workspace")).toBeInTheDocument();
    expect(screen.queryByText("Workspace No Longer Exists")).toBeNull();
  });
});
