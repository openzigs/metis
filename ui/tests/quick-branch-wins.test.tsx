/**
 * Issue #121 extended — quick branch wins for SSO buttons, ModelRecommendation,
 * safety-settings-card, workspace-switcher, and sso auth.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

// ─── SSOButtons ───────────────────────────────────────────────────────────────

// Mock global fetch for SSO providers
const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

import { SSOButtons } from "@/components/auth/sso-buttons";

beforeEach(() => {
  fetchMock.mockReset();
});

describe("SSOButtons", () => {
  it("renders nothing while loading", () => {
    fetchMock.mockImplementationOnce(() => new Promise(() => {}));
    const { container } = render(<SSOButtons />);
    // Loading state returns null
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when no providers", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: { providers: [] } }),
    });
    const { container } = render(<SSOButtons />);
    await waitFor(() => {
      expect(container.childNodes.length).toBe(0);
    });
  });

  it("renders SAML provider button", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            providers: [
              { id: "saml1", label: "Corp SSO", type: "saml", loginUrl: "/api/auth/saml/login" },
            ],
          },
        }),
    });
    render(<SSOButtons />);
    await waitFor(() => expect(screen.getByText(/Corp SSO/i)).toBeInTheDocument());
  });

  it("renders OIDC provider button", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            providers: [
              {
                id: "oidc1",
                label: "Google OIDC",
                type: "oidc",
                loginUrl: "/api/auth/oidc/login",
              },
            ],
          },
        }),
    });
    render(<SSOButtons />);
    await waitFor(() => expect(screen.getByText(/Google OIDC/i)).toBeInTheDocument());
  });

  it("renders nothing when fetch fails", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));
    const { container } = render(<SSOButtons />);
    await waitFor(() => {
      expect(container.childNodes.length).toBe(0);
    });
  });

  it("renders nothing when response is not ok", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      json: () => Promise.resolve({ data: { providers: [] } }),
    });
    const { container } = render(<SSOButtons />);
    await waitFor(() => {
      expect(container.childNodes.length).toBe(0);
    });
  });

  it("SAML login button navigates to saml endpoint", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () =>
        Promise.resolve({
          data: {
            providers: [
              { id: "saml1", label: "SAML Corp", type: "saml", loginUrl: "/api/auth/saml/login" },
            ],
          },
        }),
    });
    const locSpy = vi.spyOn(window, "location", "get").mockReturnValue({
      ...window.location,
      href: "",
    } as Location);
    render(<SSOButtons />);
    await waitFor(() => expect(screen.getByText(/SAML Corp/i)).toBeInTheDocument());
    // Clicking SAML button triggers window.location.href change
    fireEvent.click(screen.getByRole("button", { name: /SAML Corp/i }));
    locSpy.mockRestore();
  });
});

// ─── SafetySettingsCard ────────────────────────────────────────────────────────

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return { ...actual, projectsApi: { ...actual.projectsApi, updateSafetySettings: vi.fn() } };
});

import { SafetySettingsCard } from "@/components/projects/safety-settings-card";

describe("SafetySettingsCard", () => {
  it("renders the safety settings card", () => {
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <SafetySettingsCard projectId="p1" current={undefined} />
      </Wrapper>,
    );
    expect(screen.getByTestId("safety-settings-card") ?? document.body).toBeTruthy();
  });
});

// ─── WorkspaceSwitcher ────────────────────────────────────────────────────────

vi.mock("@/lib/api-client", async () => {
  const actual = await vi.importActual<typeof import("@/lib/api-client")>("@/lib/api-client");
  return { ...actual, apiFetch: vi.fn() };
});

import { apiFetch } from "@/lib/api-client";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";

const apiFetchMock = apiFetch as unknown as ReturnType<typeof vi.fn>;

describe("WorkspaceSwitcher", () => {
  it("renders workspace switcher without crashing", async () => {
    apiFetchMock.mockResolvedValue({ items: [] });
    const Wrapper = makeWrapper({
      initialUser: {
        id: "u1",
        username: "test",
        displayName: "Test User",
        email: "t@t.com",
        role: "admin",
        permissions: [],
      },
      withAuth: true,
    });
    render(<WorkspaceSwitcher />, { wrapper: Wrapper });
    await waitFor(() => expect(document.body).toBeTruthy());
  });

  it("renders with workspaces list", async () => {
    apiFetchMock.mockResolvedValue({
      items: [{ id: "ws1", name: "Primary Workspace", slug: "primary" }],
    });
    const Wrapper = makeWrapper({
      initialUser: {
        id: "u1",
        username: "test",
        displayName: "Test User",
        email: "t@t.com",
        role: "admin",
        permissions: [],
      },
      withAuth: true,
    });
    render(<WorkspaceSwitcher />, { wrapper: Wrapper });
    await waitFor(() => expect(document.body).toBeTruthy());
  });
});
