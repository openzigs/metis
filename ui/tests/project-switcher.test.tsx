/**
 * #370 — the header ProjectSwitcher names the project in the URL even when the
 * cached switcher list does not (yet) contain it, e.g. straight after Create
 * navigates to a project the 30s-stale list has never seen.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter } from "next/navigation";
import { ProjectSwitcher } from "@/components/layout/project-switcher";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";
import { makeWrapper, TEST_USER } from "./test-utils";

const row = (id: string, name: string) => ({
  id,
  name,
  slug: id,
  status: "active",
  createdById: "u-1",
  createdAt: "2026-09-29T00:00:00Z",
  updatedAt: "2026-09-29T00:00:00Z",
});

// The list the header cached before the create: it has no "p-new".
const STALE_LIST = { items: [row("p-sample", "Sample Project")], total: 1, limit: 50, offset: 0 };

function respond(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status < 400,
    status,
    statusText: status < 400 ? "OK" : "Not Found",
    text: () =>
      Promise.resolve(
        JSON.stringify(
          status < 400 ? { success: true, data } : { success: false, error: { code: "NOT_FOUND" } },
        ),
      ),
  });
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  window.localStorage.clear();
  window.localStorage.setItem("metis.activeProjectId", "p-sample");
  fetchMock = vi.fn((input: RequestInfo | URL) => {
    const url = String(input);
    if (/\/projects\/p-new(\?|$)/.test(url)) return respond(row("p-new", "Fresh Project"));
    if (/\/projects\/p-gone(\?|$)/.test(url)) return respond(null, 404);
    if (/\/projects(\?|$)/.test(url)) return respond(STALE_LIST);
    return respond(null, 404);
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(usePathname).mockReturnValue("/");
});

describe("<ProjectSwitcher /> (#370)", () => {
  it("shows the URL's project, not the previously active one, when the list lacks it", async () => {
    vi.mocked(usePathname).mockReturnValue("/projects/p-new");
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    expect(
      await screen.findByRole("button", { name: /active project: fresh project/i }),
    ).toBeInTheDocument();
    expect(screen.queryByText("Sample Project")).not.toBeInTheDocument();
    expect(window.localStorage.getItem("metis.activeProjectId")).toBe("p-new");
  });

  it("does not fetch the project on its own when the list already has it", async () => {
    vi.mocked(usePathname).mockReturnValue("/projects/p-sample");
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await screen.findByRole("button", { name: /active project: sample project/i });
    const urls = fetchMock.mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => /\/projects\/p-sample(\?|$)/.test(u))).toBe(false);
  });

  // PR #409 review — right after Create the project is still loading; the
  // header must say so rather than flash "No project".
  it("says Loading…, never 'No project', while the URL's project is still loading", async () => {
    let release: () => void = () => {};
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/projects\/p-new(\?|$)/.test(url))
        return new Promise((r) => (release = () => r(respond(row("p-new", "Fresh Project")))));
      if (/\/projects(\?|$)/.test(url)) return respond(STALE_LIST);
      return respond(null, 404);
    });
    vi.mocked(usePathname).mockReturnValue("/projects/p-new");
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    // Wait until the project's own request is in flight (the list has loaded
    // and lacks it), then the label must read Loading…, not "No project".
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([u]) => /\/projects\/p-new(\?|$)/.test(String(u)))).toBe(
        true,
      ),
    );
    expect(screen.getByRole("button", { name: /active project: loading/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /active project: no project/i })).toBeNull();
    release();
    expect(
      await screen.findByRole("button", { name: /active project: fresh project/i }),
    ).toBeInTheDocument();
  });

  // PR #409 review — a failed list must not hide the project the page loaded.
  it("still names the URL's project when the project list request fails", async () => {
    fetchMock.mockImplementation((input: RequestInfo | URL) => {
      const url = String(input);
      if (/\/projects\/p-new(\?|$)/.test(url)) return respond(row("p-new", "Fresh Project"));
      if (/\/projects(\?|$)/.test(url)) return respond(null, 500);
      return respond(null, 404);
    });
    vi.mocked(usePathname).mockReturnValue("/projects/p-new");
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    expect(
      await screen.findByRole("button", { name: /active project: fresh project/i }),
    ).toBeInTheDocument();
  });

  it("falls back to 'No project' when the URL's project cannot be loaded", async () => {
    vi.mocked(usePathname).mockReturnValue("/projects/p-gone");
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    expect(
      await screen.findByRole("button", { name: /active project: no project/i }),
    ).toBeInTheDocument();
  });

  // #411 — the list is capped at 50, so the active project may not be in it.
  // It must still have a menu entry, pinned first, marked as current.
  it("pins the active project at the top of the menu when the capped list lacks it", async () => {
    const user = userEvent.setup();
    vi.mocked(usePathname).mockReturnValue("/projects/p-new");
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await user.click(await screen.findByRole("button", { name: /active project: fresh project/i }));
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Fresh Project", "Sample Project"]);
    expect(items[0]).toHaveAttribute("aria-current", "true");
    expect(items[1]).toHaveAttribute("aria-current", "false");
    vi.mocked(useRouter().push).mockClear();
    await user.click(items[0]);
    await waitFor(() => expect(useRouter().push).toHaveBeenCalledWith("/projects/p-new"));
  });

  it("does not pin a duplicate entry when the list already has the active project", async () => {
    const user = userEvent.setup();
    vi.mocked(usePathname).mockReturnValue("/projects/p-sample");
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await user.click(
      await screen.findByRole("button", { name: /active project: sample project/i }),
    );
    const items = await screen.findAllByRole("menuitem");
    expect(items.map((i) => i.textContent)).toEqual(["Sample Project"]);
    expect(items[0]).toHaveAttribute("aria-current", "true");
  });

  // #411 — a 404 (deleted or foreign) id must never be stored as active.
  it("does not persist the URL's project id when that project returns 404", async () => {
    vi.mocked(usePathname).mockReturnValue("/projects/p-gone");
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    await screen.findByRole("button", { name: /active project: no project/i });
    expect(window.localStorage.getItem("metis.activeProjectId")).toBe("p-sample");
  });

  it("names the new project in the header breadcrumb on its Overview", async () => {
    vi.mocked(usePathname).mockReturnValue("/projects/p-new");
    render(<Breadcrumbs />, { wrapper: makeWrapper({ initialUser: TEST_USER }) });
    const trail = await screen.findByTestId("header-breadcrumb");
    expect(
      await screen.findByRole("button", { name: /active project: fresh project/i }),
    ).toBeInTheDocument();
    expect(trail).not.toHaveTextContent("Sample Project");
  });
});
