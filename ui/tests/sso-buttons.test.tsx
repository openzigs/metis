/**
 * Tests for <SSOButtons /> — the configured-SSO-provider buttons on /login.
 *
 * Issue #429 (Epic #407): the component fetches `GET /api/auth/sso/providers`
 * and renders one branded button per configured provider, navigating to the
 * server-provided live `loginUrl` on click. When no providers are configured
 * (empty list) — or the endpoint 404s / errors — it renders NOTHING and surfaces
 * no error, so it coexists cleanly with the rest of the login form (e.g. the
 * session-expired banner from #411).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { SSOButtons } from "@/components/auth/sso-buttons";

const fetchMock = vi.fn();

function jsonRes(body: unknown, status = 200): Response {
  return {
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "ERR",
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<SSOButtons />", () => {
  it("renders one button per configured provider using the safe label + type", async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        success: true,
        data: {
          providers: [
            { id: "p1", label: "Okta SAML", type: "saml", loginUrl: "/api/auth/saml/login" },
            { id: "p2", label: "Google OIDC", type: "oidc", loginUrl: "/api/auth/oidc/login" },
          ],
        },
      }),
    );

    render(<SSOButtons />);

    expect(await screen.findByRole("button", { name: /sign in with okta saml/i })).toBeVisible();
    expect(screen.getByRole("button", { name: /sign in with google oidc/i })).toBeVisible();
    // Exactly the two provider buttons, no more.
    expect(screen.getAllByRole("button")).toHaveLength(2);
    // It calls the providers endpoint (and only that).
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/sso/providers",
      expect.objectContaining({ headers: { accept: "application/json" } }),
    );
  });

  it("navigates to the server-provided live loginUrl on click (not a hard-coded path)", async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        success: true,
        data: {
          providers: [
            { id: "p2", label: "Google OIDC", type: "oidc", loginUrl: "/api/auth/oidc/login" },
          ],
        },
      }),
    );

    // Capture window.location.href assignment without triggering a jsdom navigation.
    const hrefSetter = vi.fn();
    const original = Object.getOwnPropertyDescriptor(window, "location");
    Object.defineProperty(window, "location", {
      configurable: true,
      value: {
        ...window.location,
        set href(v: string) {
          hrefSetter(v);
        },
      },
    });

    try {
      const user = userEvent.setup();
      render(<SSOButtons />);
      const btn = await screen.findByRole("button", { name: /sign in with google oidc/i });
      await user.click(btn);
      expect(hrefSetter).toHaveBeenCalledWith("/api/auth/oidc/login");
    } finally {
      if (original) Object.defineProperty(window, "location", original);
    }
  });

  it("renders nothing (and no error) when no providers are configured", async () => {
    fetchMock.mockResolvedValue(jsonRes({ success: true, data: { providers: [] } }));

    const { container } = render(<SSOButtons />);

    // Wait for the fetch effect to settle, then assert the component is empty.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing (and no error) when the endpoint 404s (SSO not configured)", async () => {
    fetchMock.mockResolvedValue(jsonRes({ error: "not found" }, 404));

    const { container } = render(<SSOButtons />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("renders nothing (and no error) when the fetch rejects (network failure)", async () => {
    fetchMock.mockRejectedValue(new Error("network down"));

    const { container } = render(<SSOButtons />);

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await waitFor(() => expect(container).toBeEmptyDOMElement());
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("falls back to a default icon for an unknown provider type without crashing", async () => {
    fetchMock.mockResolvedValue(
      jsonRes({
        success: true,
        data: {
          providers: [
            // `type` outside the icon map exercises the `?? "🔐"` fallback branch.
            { id: "p3", label: "Mystery IdP", type: "ldap", loginUrl: "/api/auth/ldap/login" },
          ],
        },
      }),
    );

    render(<SSOButtons />);
    expect(await screen.findByRole("button", { name: /sign in with mystery idp/i })).toBeVisible();
  });
});
