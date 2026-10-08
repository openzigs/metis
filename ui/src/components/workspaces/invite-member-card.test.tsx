/**
 * #941 — Settings → Workspaces had no way to invite a member. The card posts
 * `POST /workspaces/:id/invites` and shows the resulting link to share.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();
vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});

import { ApiError } from "@/lib/api-client";
import { InviteMemberCard, canInviteMembers } from "./invite-member-card";

function renderCard() {
  const qc = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <InviteMemberCard workspaceId="ws-1" />
    </QueryClientProvider>,
  );
}

describe("InviteMemberCard (#941)", () => {
  beforeEach(() => {
    apiFetch.mockReset();
  });

  it("posts the email and chosen role, then shows the invite link", async () => {
    apiFetch.mockResolvedValue({
      id: "inv-1",
      email: "reviewer@example.com",
      expiresAt: "2026-10-15T00:00:00.000Z",
      token: "tok-abc",
    });
    renderCard();

    fireEvent.change(screen.getByLabelText("Email"), {
      target: { value: "  reviewer@example.com " },
    });
    fireEvent.change(screen.getByLabelText("Role"), { target: { value: "admin" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));

    const link = await screen.findByLabelText("Invite link");
    expect(link).toHaveValue(`${window.location.origin}/invites/tok-abc`);
    expect(apiFetch).toHaveBeenCalledWith("/workspaces/ws-1/invites", {
      method: "POST",
      body: { email: "reviewer@example.com", role: "admin" },
    });
    expect(screen.getByText("reviewer@example.com")).toBeInTheDocument();
    // The form clears for the next invite.
    expect(screen.getByLabelText("Email")).toHaveValue("");
  });

  it("disables the submit until an email is entered", () => {
    renderCard();
    expect(screen.getByRole("button", { name: /create invite/i })).toBeDisabled();
  });

  it("shows the server's refusal, e.g. an existing member", async () => {
    apiFetch.mockRejectedValue(
      new ApiError(409, "User is already a member of this workspace", "CONFLICT"),
    );
    renderCard();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "m@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "User is already a member of this workspace",
    );
    expect(screen.queryByLabelText("Invite link")).toBeNull();
  });

  it("falls back to a generic message for a non-API failure", async () => {
    apiFetch.mockImplementation(async () => {
      throw new TypeError("network");
    });
    renderCard();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "m@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Failed to create invite");
  });

  it("copies the link to the clipboard", async () => {
    apiFetch.mockResolvedValue({
      id: "inv-1",
      email: "r@example.com",
      expiresAt: "2026-10-15T00:00:00.000Z",
      token: "tok-copy",
    });
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    renderCard();

    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "r@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: /create invite/i }));
    fireEvent.click(await screen.findByRole("button", { name: "Copy" }));

    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith(`${window.location.origin}/invites/tok-copy`),
    );
    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
  });
});

describe("canInviteMembers (#941)", () => {
  const members = [
    { role: "owner", user: { id: "u-owner" } },
    { role: "admin", user: { id: "u-admin" } },
    { role: "member", user: { id: "u-member" } },
  ];

  it("allows owners and admins", () => {
    expect(canInviteMembers(members, "u-owner")).toBe(true);
    expect(canInviteMembers(members, "u-admin")).toBe(true);
  });

  it("refuses members, non-members and a signed-out user", () => {
    expect(canInviteMembers(members, "u-member")).toBe(false);
    expect(canInviteMembers(members, "u-stranger")).toBe(false);
    expect(canInviteMembers(members, undefined)).toBe(false);
  });
});
