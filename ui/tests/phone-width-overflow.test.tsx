/**
 * #508 — phone-width (390px) regression check, as a class contract.
 *
 * jsdom does no layout, so these tests pin the Tailwind classes that keep the
 * layout inside the viewport; e2e/tests/settings-phone-width.spec.ts measures
 * the result in a real browser.
 *
 * - `/settings/mcp` and `/settings/auth`: a tab row that neither wraps nor
 *   scrolls pushes `document.scrollWidth` past the viewport. The tab list must
 *   be its own horizontal scroll container, start-aligned (a centred overflow
 *   puts its first tabs out of reach to the left), bounded by its parent.
 * - Header breadcrumb: a crumb may shrink (`min-w-0`), so the switcher button
 *   inside it must be able to shrink too — truncating its label and clipping
 *   the rest — or it paints over the next crumb.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { usePathname, useRouter } from "next/navigation";
import { makeWrapper, TEST_USER } from "./test-utils";
import McpSettingsPage from "@/app/(authed)/settings/mcp/page";
import AdminAuthPage from "@/app/(authed)/settings/auth/page";
import { WorkspaceSwitcher } from "@/components/layout/workspace-switcher";
import { ProjectSwitcher } from "@/components/layout/project-switcher";
import { Breadcrumbs } from "@/components/layout/breadcrumbs";

const ADMIN = { ...TEST_USER, role: "admin" as const };

function jsonResponse(data: unknown) {
  const body = JSON.stringify({ success: true, data });
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: () => Promise.resolve(body),
    json: () => Promise.resolve(JSON.parse(body)),
  };
}

function stubFetch(data: unknown) {
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(data)));
}

function classesOf(el: Element): string[] {
  return (el.getAttribute("class") ?? "").split(/\s+/);
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("#508 settings tab rows scroll within themselves at phone width", () => {
  beforeEach(() => stubFetch({ items: [], total: 0, limit: 50, offset: 0 }));

  it("/settings/mcp: the tab list is a bounded, start-aligned horizontal scroller", () => {
    render(<McpSettingsPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });
    const list = screen.getByRole("tablist", { name: "MCP platform sections" });
    const cls = classesOf(list);
    expect(cls).toEqual(expect.arrayContaining(["w-full", "overflow-x-auto", "justify-start"]));
    // The underline is an inset shadow, not a border the triggers overlap with
    // a negative margin — that 1px overhang would make the scroller scroll
    // vertically too.
    expect(cls).not.toContain("border-b");
    for (const tab of screen.getAllByRole("tab")) {
      expect(classesOf(tab)).not.toContain("-mb-px");
      expect(classesOf(tab)).toContain("shrink-0");
      // The scroller clips overflow, so the focus ring must sit inside the
      // trigger or keyboard users lose it (PR #520 review).
      expect(classesOf(tab)).toEqual(
        expect.arrayContaining(["focus-visible:ring-inset", "focus-visible:ring-offset-0"]),
      );
    }
  });

  it("/settings/auth: the tab list is a bounded, start-aligned horizontal scroller", () => {
    render(<AdminAuthPage />, { wrapper: makeWrapper({ initialUser: ADMIN }) });
    const list = screen.getByRole("tablist");
    const cls = classesOf(list);
    expect(cls).toEqual(expect.arrayContaining(["max-w-full", "overflow-x-auto", "justify-start"]));
    expect(cls).not.toContain("justify-center");
  });
});

describe("#508 header switchers shrink inside their breadcrumb item", () => {
  it("WorkspaceSwitcher: the trigger can shrink and clips; the label truncates", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          jsonResponse([{ id: "w1", name: "Acme", slug: "acme", logoUrl: null, role: "admin" }]),
        ),
    );
    render(<WorkspaceSwitcher />, { wrapper: makeWrapper({ initialUser: ADMIN }) });
    const trigger = await screen.findByTestId("workspace-switcher");
    expect(classesOf(trigger)).toEqual(expect.arrayContaining(["min-w-0", "overflow-hidden"]));
    const label = screen.getByText("Acme");
    expect(classesOf(label)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
  });

  it("ProjectSwitcher: the trigger can shrink and clips; the label truncates", async () => {
    stubFetch({
      items: [{ id: "p-1", name: "Demo Project", slug: "demo", status: "active" }],
      total: 1,
      limit: 50,
      offset: 0,
    });
    render(<ProjectSwitcher />, { wrapper: makeWrapper({ initialUser: ADMIN }) });
    const trigger = await screen.findByRole("button", { name: /active project: demo project/i });
    expect(classesOf(trigger)).toEqual(expect.arrayContaining(["min-w-0", "overflow-hidden"]));
    const label = screen.getByText("Demo Project");
    expect(classesOf(label)).toEqual(expect.arrayContaining(["min-w-0", "truncate"]));
  });
});

// #529 — not overlapping was not enough: sharing one row with the header's
// controls left the breadcrumb ~100px at 390px, and the current-page crumb was
// cut to "M" / "A.". Below `sm` the breadcrumb wraps onto a full-width second
// row (the header's row half is pinned in header.test.tsx), and the current-page
// crumb does not shrink: the switchers truncate instead.
describe("#529 the current-page crumb keeps a readable width", () => {
  beforeEach(() => {
    vi.mocked(usePathname).mockReturnValue("/projects/p-1/requirements");
    const projects = {
      items: [{ id: "p-1", name: "Demo Project", slug: "demo", status: "active" }],
      total: 1,
      limit: 50,
      offset: 0,
    };
    const workspaces = [{ id: "w1", name: "Acme", slug: "acme", logoUrl: null, role: "admin" }];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string) =>
        Promise.resolve(jsonResponse(String(url).includes("/workspaces") ? workspaces : projects)),
      ),
    );
  });

  it("below sm the breadcrumb is its own full-width, last row; from sm it rejoins the row", () => {
    render(<Breadcrumbs />, { wrapper: makeWrapper({ initialUser: ADMIN }) });
    const nav = screen.getByTestId("header-breadcrumb");
    expect(classesOf(nav)).toEqual(
      expect.arrayContaining([
        "min-w-0",
        "order-last",
        "basis-full",
        "sm:order-none",
        "sm:basis-auto",
      ]),
    );
  });

  it("below sm the current-page crumb does not shrink; it truncates only past its max width", async () => {
    render(<Breadcrumbs />, { wrapper: makeWrapper({ initialUser: ADMIN }) });
    await screen.findByRole("button", { name: /active project: demo project/i });
    const current = screen
      .getByTestId("header-breadcrumb")
      .querySelector('[aria-current="page"]') as HTMLElement;
    expect(current).toHaveTextContent("Review");
    expect(classesOf(current)).toContain("truncate");
    const item = current.closest("li") as HTMLElement;
    expect(classesOf(item)).toEqual(expect.arrayContaining(["max-sm:shrink-0", "max-w-[12rem]"]));
    // Only below sm, where the crumb has a row of its own: from sm it shares the
    // header row again and must not take all the width from the switchers.
    expect(classesOf(item)).not.toContain("shrink-0");
    // The switchers' items are the ones that give way (separators are fixed-size).
    const items = screen
      .getByTestId("header-breadcrumb")
      .querySelectorAll('[data-slot="breadcrumb-item"]');
    expect(items.length).toBeGreaterThan(2);
    for (const li of items) {
      if (li !== item) {
        // PR #538 review: neither the phone-only nor a bare shrink-0.
        expect(classesOf(li)).not.toContain("max-sm:shrink-0");
        expect(classesOf(li)).not.toContain("shrink-0");
      }
    }
  });
});

// The class change above is the only edit #508 makes to WorkspaceSwitcher; these
// cover the menu actions it had no test for, lifting the touched file past the
// 80% floor.
describe("WorkspaceSwitcher menu actions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse([
          { id: "w1", name: "Acme", slug: "acme", logoUrl: null, role: "admin" },
          { id: "w2", name: "Globex", slug: "globex", logoUrl: null, role: "member" },
        ]),
      ),
    );
  });

  it("selecting a workspace stores it as active and refreshes the router", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher />, { wrapper: makeWrapper({ initialUser: ADMIN }) });
    await user.click(await screen.findByTestId("workspace-switcher"));
    await user.click(await screen.findByRole("menuitem", { name: "Globex" }));
    expect(window.localStorage.getItem("metis.activeWorkspaceId")).toBe("w2");
    expect(vi.mocked(useRouter)().refresh).toHaveBeenCalledTimes(1);
  });

  it("'Create workspace' navigates to the workspaces settings page", async () => {
    const user = userEvent.setup();
    render(<WorkspaceSwitcher />, { wrapper: makeWrapper({ initialUser: ADMIN }) });
    await user.click(await screen.findByTestId("workspace-switcher"));
    await user.click(await screen.findByRole("menuitem", { name: "Create workspace" }));
    await waitFor(() =>
      expect(vi.mocked(useRouter)().push).toHaveBeenCalledWith("/settings/workspaces"),
    );
  });
});
