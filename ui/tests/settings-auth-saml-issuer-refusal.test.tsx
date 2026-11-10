/**
 * #1562 — since #1555 a SAML assertion whose Issuer is not the configured IdP
 * issuer is refused, which after an upgrade can refuse every sign-in. The SAML
 * 2.0 tab shows the configured issuer beside the Issuer the last refused
 * assertion named, and what to do about it.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { makeWrapper, TEST_USER } from "./test-utils";
import AdminAuthPage from "@/app/(authed)/settings/auth/page";

const ADMIN = { ...TEST_USER, role: "admin" as const };
const CONFIGURED = "https://sts.windows.net/aaaa0000-1562-4000-8000-000000000001/";
const ASSERTED = "https://sts.windows.net/bbbb0000-1562-4000-8000-000000000002/";

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

/** Answer the issuer-refusal endpoint with `refusal`, everything else with an empty body. */
function stubFetch(refusal: unknown, ok = true) {
  const fetchMock = vi.fn((url: string) =>
    Promise.resolve(
      url === "/api/admin/auth/saml/issuer-refusal" ? respond(refusal, ok) : respond({}),
    ),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Admin Authentication page — SAML Issuer refusal (#1562)", () => {
  it("shows the configured issuer beside the last refused one, and the fix", async () => {
    stubFetch({
      configuredIssuer: CONFIGURED,
      lastRefused: { assertionIssuer: ASSERTED, at: "2026-11-10T09:00:00.000Z" },
    });
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    const warning = await screen.findByTestId("saml-issuer-refusal-warning");
    expect(warning).toHaveAttribute("role", "alert");
    expect(warning).toHaveTextContent("METIS refused a SAML sign-in for its Issuer");
    expect(within(warning).getByTestId("saml-configured-issuer")).toHaveTextContent(CONFIGURED);
    expect(within(warning).getByTestId("saml-refused-issuer")).toHaveTextContent(ASSERTED);
    expect(warning).toHaveTextContent("current metadata below and save");
  });

  it("says the refused assertion named no Issuer", async () => {
    stubFetch({
      configuredIssuer: CONFIGURED,
      lastRefused: { assertionIssuer: null, at: "2026-11-10T09:00:00.000Z" },
    });
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    expect(await screen.findByTestId("saml-refused-issuer")).toHaveTextContent("(no Issuer)");
  });

  it("#2204: saving the SAML configuration reads the refusal again, so the warning clears", async () => {
    let refusal: unknown = {
      configuredIssuer: CONFIGURED,
      lastRefused: { assertionIssuer: ASSERTED, at: "2026-11-10T09:00:00.000Z" },
    };
    const fetchMock = vi.fn((url: string, init?: { method?: string }) => {
      if (url === "/api/admin/auth/providers/saml" && init?.method === "PUT") {
        // The save re-reads the issuer from the pasted metadata.
        refusal = { configuredIssuer: ASSERTED, lastRefused: null };
        return Promise.resolve(respond({ provider: {} }));
      }
      return Promise.resolve(respond(url === "/api/admin/auth/saml/issuer-refusal" ? refusal : {}));
    });
    vi.stubGlobal("fetch", fetchMock);
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    expect(await screen.findByTestId("saml-issuer-refusal-warning")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Save SAML/ }));

    await waitFor(() =>
      expect(screen.queryByTestId("saml-issuer-refusal-warning")).not.toBeInTheDocument(),
    );
  });

  it.each([
    ["nothing was refused", { configuredIssuer: CONFIGURED, lastRefused: null }, true],
    ["the read fails", null, false],
  ])("shows no warning when %s", async (_label, refusal, ok) => {
    const fetchMock = stubFetch(refusal, ok);
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/admin/auth/saml/issuer-refusal"),
    );
    expect(screen.queryByTestId("saml-issuer-refusal-warning")).not.toBeInTheDocument();
  });
});
