/**
 * #1554 — saving SSO settings, testing LDAP or rotating the SCIM token needs a
 * sign-in with MFA. A password-only SSO session gets 403 `MFA_REQUIRED`, and
 * the admin Authentication page says so plainly, naming the fix.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";
import AdminAuthPage from "@/app/(authed)/settings/auth/page";
import { MFA_REQUIRED_MESSAGE } from "@/lib/api-client";

const ADMIN = { ...TEST_USER, role: "admin" as const };

function respond(status: number, body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: status < 400,
    status,
    statusText: "",
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text)),
  };
}

const MFA_REFUSAL = {
  success: false,
  error: { code: "MFA_REQUIRED", message: "server wording" },
};

/** Every write is refused for MFA; reads answer empty. */
function stubFetch() {
  const fetchMock = vi.fn((_url: string, init?: { method?: string }) =>
    Promise.resolve(
      init?.method && init.method !== "GET"
        ? respond(403, MFA_REFUSAL)
        : respond(200, { success: true, data: {} }),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Admin Authentication page — MFA_REQUIRED (#1554)", () => {
  it("a refused SAML save shows the MFA message, once", async () => {
    const fetchMock = stubFetch();
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    fireEvent.click(await screen.findByRole("button", { name: /Save SAML/ }));

    expect(await screen.findByRole("status")).toHaveTextContent(MFA_REQUIRED_MESSAGE);
    const saves = fetchMock.mock.calls.filter(([url]) => url === "/api/admin/auth/providers/saml");
    expect(saves).toHaveLength(1);
  });

  it("a refused SCIM token rotation shows the MFA message instead of nothing", async () => {
    stubFetch();
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    // Radix tabs switch on mouse down.
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /SCIM/ }));
    fireEvent.click(await screen.findByRole("button", { name: /Rotate/ }));

    expect(await screen.findByRole("status")).toHaveTextContent(MFA_REQUIRED_MESSAGE);
  });
});
