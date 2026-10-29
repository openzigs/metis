/**
 * #1552 — the admin Authentication page warns when SAML sign-ins arrived with
 * a group overage (Microsoft Entra ID sends a Graph link instead of the groups
 * past 150), naming the users who got the default role and the Entra setting
 * that fixes it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";
import AdminAuthPage from "@/app/(authed)/settings/auth/page";

const ADMIN = { ...TEST_USER, role: "admin" as const };

function respond(data: unknown, ok = true) {
  const body = JSON.stringify({ success: ok, data });
  return {
    ok,
    status: ok ? 200 : 500,
    statusText: ok ? "OK" : "Internal Server Error",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

/** Answer the overage endpoint with `overage`, everything else with an empty body. */
function stubFetch(overage: unknown, ok = true) {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      url === "/api/admin/auth/saml/group-overage" ? respond(overage, ok) : respond({}),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Admin Authentication page — SAML group overage warning (#1552)", () => {
  it("names the users who got the default role and the Entra setting to choose", async () => {
    stubFetch({
      total: 3,
      recent: [
        { userId: "u1", username: "olga", at: "2026-10-29T10:00:00.000Z" },
        { userId: "u2", username: null, at: "2026-10-29T09:00:00.000Z" },
        { userId: "u1", username: "olga", at: "2026-10-28T09:00:00.000Z" },
      ],
    });
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    const warning = await screen.findByTestId("saml-group-overage-warning");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent("3 SAML sign-ins arrived without the user's groups");
    expect(warning).toHaveTextContent("got the default role: olga, u2.");
    expect(warning).toHaveTextContent("Groups assigned to the application");
  });

  it("says one sign-in in the singular", async () => {
    stubFetch({ total: 1, recent: [{ userId: "u1", username: "olga", at: "x" }] });
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    expect(await screen.findByTestId("saml-group-overage-warning")).toHaveTextContent(
      "1 SAML sign-in arrived without the user's groups",
    );
  });

  it.each([
    ["no overage was recorded", { total: 0, recent: [] }, true],
    ["the read fails", null, false],
  ])("shows no warning when %s", async (_label, overage, ok) => {
    const fetchMock = stubFetch(overage, ok);
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/auth/saml/group-overage"),
    );
    expect(screen.queryByTestId("saml-group-overage-warning")).not.toBeInTheDocument();
  });
});
