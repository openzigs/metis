import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProjectSwitcher } from "@/components/layout/project-switcher";
import { UserMenu } from "@/components/layout/user-menu";
import { makeWrapper, TEST_USER } from "./test-utils";

const PUSH_MOCK = vi.fn();
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: PUSH_MOCK, replace: vi.fn(), back: vi.fn() }),
  usePathname: () => "/dashboard",
}));

const MOCK_PROJECT_LIST = {
  items: [
    {
      id: "p-1",
      name: "Demo Project",
      slug: "demo",
      status: "active",
      createdById: "u-1",
      createdAt: "2026-04-25T00:00:00Z",
      updatedAt: "2026-04-25T00:00:00Z",
    },
    {
      id: "p-3",
      name: "Forecast UI",
      slug: "forecast-ui",
      status: "active",
      createdById: "u-1",
      createdAt: "2026-04-25T00:00:00Z",
      updatedAt: "2026-04-25T00:00:00Z",
    },
  ],
  total: 2,
  limit: 50,
  offset: 0,
};

describe("<ProjectSwitcher />", () => {
  beforeEach(() => {
    PUSH_MOCK.mockReset();
    window.localStorage.clear();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        statusText: "OK",
        text: () => Promise.resolve(JSON.stringify({ success: true, data: MOCK_PROJECT_LIST })),
      }),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens the menu and navigates when a project is selected", async () => {
    const user = userEvent.setup();
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    const trigger = await screen.findByRole("button", { name: /active project: demo project/i });
    await user.click(trigger);
    const item = await screen.findByRole("menuitem", { name: /forecast ui/i });
    await user.click(item);
    await waitFor(() => expect(PUSH_MOCK).toHaveBeenCalledWith("/projects/p-3"));
    expect(window.localStorage.getItem("metis.activeProjectId")).toBe("p-3");
  });
});

describe("<UserMenu />", () => {
  it("renders nothing when the user is missing", async () => {
    // The AuthProvider issues a /me probe on mount when initialUser is null;
    // stub it so the resulting state update settles inside this test (no act warnings).
    const fetchMock = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      statusText: "Unauthorized",
      text: () => Promise.resolve(JSON.stringify({ success: false })),
    });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<UserMenu />, {
      wrapper: makeWrapper({ initialUser: null }),
    });
    expect(container.firstChild).toBeNull();
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    vi.unstubAllGlobals();
  });

  it("shows the username and a logout option", async () => {
    const user = userEvent.setup();
    render(<UserMenu />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    expect(screen.getByRole("button", { name: /account menu for tester/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /account menu for tester/i }));
    expect(await screen.findByRole("menuitem", { name: /sign out/i })).toBeInTheDocument();
  });

  it("invokes logout when sign out is selected", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      text: () => Promise.resolve(JSON.stringify({ success: true, data: null })),
    });
    vi.stubGlobal("fetch", fetchMock);
    const user = userEvent.setup();
    render(<UserMenu />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    await user.click(screen.getByRole("button", { name: /account menu for tester/i }));
    await user.click(await screen.findByTestId("user-menu-logout"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/auth/logout",
      expect.objectContaining({ method: "POST" }),
    );
    vi.unstubAllGlobals();
  });
});
