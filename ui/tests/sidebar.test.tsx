import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { assignedReviewsText, Sidebar } from "@/components/layout/sidebar";
import { NAV_ITEMS } from "@/lib/navigation";
import { usePathname } from "next/navigation";
import type { AuthUser } from "@/lib/auth-types";
import { makeWrapper, TEST_USER } from "./test-utils";

const { list, socketHandlers, fakeSocket } = vi.hoisted(() => {
  const socketHandlers = new Map<string, Set<() => void>>();
  return {
    list: vi.fn(),
    socketHandlers,
    fakeSocket: {
      on: (event: string, handler: () => void) => {
        if (!socketHandlers.has(event)) socketHandlers.set(event, new Set());
        socketHandlers.get(event)!.add(handler);
      },
      off: (event: string, handler: () => void) => {
        socketHandlers.get(event)?.delete(handler);
      },
    },
  };
});

vi.mock("@/lib/reviews-api", () => ({ reviewsApi: { list } }));
vi.mock("@/lib/socket-client", () => ({ useSocket: () => fakeSocket }));

const usePathnameMock = vi.mocked(usePathname);

function emit(event: string) {
  act(() => {
    for (const h of socketHandlers.get(event) ?? []) h();
  });
}

function renderSidebar({
  pathname = "/dashboard",
  role = "admin",
  mobileOpen = false,
  onMobileClose = () => {},
}: {
  pathname?: string;
  role?: AuthUser["role"];
  mobileOpen?: boolean;
  onMobileClose?: () => void;
} = {}) {
  usePathnameMock.mockReturnValue(pathname);
  return render(<Sidebar mobileOpen={mobileOpen} onMobileClose={onMobileClose} />, {
    wrapper: makeWrapper({ initialUser: { ...TEST_USER, role } }),
  });
}

const sections = () => screen.getByRole("navigation", { name: "Sections" });

beforeEach(() => {
  list.mockReset();
  list.mockResolvedValue({ reviews: [], total: 0, page: 1, pageSize: 1 });
  socketHandlers.clear();
});

describe("<Sidebar /> — desktop column", () => {
  it("renders every nav item with an accessible link", () => {
    renderSidebar();
    for (const item of NAV_ITEMS) {
      // Drawer is closed so each label appears exactly once (desktop column).
      expect(screen.getByRole("link", { name: item.label })).toBeInTheDocument();
    }
  });

  it("renders a single flat level of seven destinations, no section headings (#27, #2332)", () => {
    renderSidebar();
    expect(within(sections()).getAllByRole("link")).toHaveLength(7);
    expect(within(sections()).queryAllByRole("heading")).toHaveLength(0);
    expect(within(sections()).getAllByRole("list")).toHaveLength(1);
  });

  it("marks the hub as the current location, not the page, on a page it absorbed", () => {
    renderSidebar({ pathname: "/portfolio" });
    // The hub tab carries aria-current=page; the sidebar entry must not repeat it.
    expect(screen.getByRole("link", { name: "Projects" })).toHaveAttribute("aria-current", "true");
  });

  it("marks a single-page hub as the current page", () => {
    renderSidebar();
    expect(screen.getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
  });

  it("marks only the active hub", () => {
    renderSidebar({ pathname: "/projects/abc-123" });
    const projects = screen.getByRole("link", { name: "Projects" });
    expect(projects).toHaveAttribute("aria-current", "true");
    expect(projects).toHaveAttribute("data-active", "true");
    expect(screen.getByRole("link", { name: "Home" })).not.toHaveAttribute("aria-current");
  });

  it("does not render the mobile drawer content while closed (not tabbable)", () => {
    renderSidebar();
    // Radix removes the dialog content from the tree entirely when closed —
    // i.e. nothing inside the drawer is reachable by Tab or screen readers.
    expect(screen.queryByTestId("sidebar-drawer")).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});

describe("<Sidebar /> — by role (#2332)", () => {
  // No review is assigned (the default mock), so each link's text is its label.
  const entries = () =>
    within(sections())
      .getAllByRole("link")
      .map((l) => [l.textContent, l.getAttribute("href")]);

  it("gives an admin every entry, in order, each on its usual page", () => {
    renderSidebar({ role: "admin" });
    expect(entries()).toEqual([
      ["Home", "/dashboard"],
      ["Projects", "/projects"],
      ["Chat", "/chat"],
      ["Activity", "/tasks"],
      ["Reviews", "/reviews"],
      ["Library", "/library"],
      ["Settings", "/settings"],
    ]);
  });

  it.each(["developer", "reader", "coordinator"] as const)(
    "never links a %s to an operations page: Activity lands on Sessions",
    (role) => {
      renderSidebar({ role });
      expect(entries()).toEqual([
        ["Home", "/dashboard"],
        ["Projects", "/projects"],
        ["Chat", "/chat"],
        ["Activity", "/sessions"],
        ["Reviews", "/reviews"],
        ["Library", "/library"],
        ["Settings", "/settings"],
      ]);
    },
  );

  it("does not mark a non-admin's Activity entry on a run's own page, which is not in it", () => {
    renderSidebar({ role: "developer", pathname: "/runs/42" });
    expect(screen.getByRole("link", { name: "Activity" })).not.toHaveAttribute("aria-current");
  });
});

describe("<Sidebar /> — Reviews count (#2332)", () => {
  const reviewsLink = () => screen.getByRole("link", { name: "Reviews" });

  it("asks for in-review reviews waiting on my decision, one row (#2370)", async () => {
    renderSidebar();
    await waitFor(() => expect(list).toHaveBeenCalled());
    // `decision: "pending"` leaves out a review I already decided while the
    // other reviewers have not: the predicate Home's "My work" uses (#2348).
    expect(list).toHaveBeenCalledWith({
      assignee: "me",
      status: "in_review",
      decision: "pending",
      pageSize: 1,
    });
  });

  it("shows the count, and describes it to screen readers without renaming the link", async () => {
    list.mockResolvedValue({ reviews: [], total: 3, page: 1, pageSize: 1 });
    renderSidebar({ role: "developer" });
    expect(await screen.findByTestId("reviews-count")).toHaveTextContent("3");
    expect(reviewsLink()).toHaveAccessibleName("Reviews");
    expect(reviewsLink()).toHaveAccessibleDescription("3 reviews assigned to you");
  });

  it("shows no badge and no description at 0", async () => {
    renderSidebar();
    await waitFor(() => expect(list).toHaveBeenCalled());
    // Let the query settle on 0.
    await act(async () => {});
    expect(screen.queryByTestId("reviews-count")).not.toBeInTheDocument();
    expect(reviewsLink()).not.toHaveAttribute("aria-describedby");
  });

  it("shows no badge while the count fails to load", async () => {
    list.mockRejectedValue(new Error("boom"));
    renderSidebar();
    await waitFor(() => expect(list).toHaveBeenCalled());
    await act(async () => {});
    expect(screen.queryByTestId("reviews-count")).not.toBeInTheDocument();
    expect(reviewsLink()).toHaveAccessibleName("Reviews");
  });

  it("drops a number it showed when a later re-read fails, rather than keep a stale one (#2370)", async () => {
    list.mockResolvedValue({ reviews: [], total: 3, page: 1, pageSize: 1 });
    renderSidebar();
    expect(await screen.findByTestId("reviews-count")).toHaveTextContent("3");

    list.mockRejectedValue(new Error("boom"));
    emit("review:changed");
    await waitFor(() => expect(list).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByTestId("reviews-count")).not.toBeInTheDocument());
    expect(reviewsLink()).not.toHaveAttribute("aria-describedby");
  });

  it("caps the badge at 99+", async () => {
    list.mockResolvedValue({ reviews: [], total: 120, page: 1, pageSize: 1 });
    renderSidebar();
    expect(await screen.findByTestId("reviews-count")).toHaveTextContent("99+");
    expect(reviewsLink()).toHaveAccessibleDescription("120 reviews assigned to you");
  });

  it("counts on the drawer's Reviews entry too, with its own description", async () => {
    list.mockResolvedValue({ reviews: [], total: 2, page: 1, pageSize: 1 });
    renderSidebar({ mobileOpen: true });
    await waitFor(() => expect(screen.getAllByTestId("reviews-count")).toHaveLength(2));
    // The open modal drawer hides the desktop column from the a11y tree.
    const links = screen.getAllByRole("link", { name: "Reviews", hidden: true });
    expect(links).toHaveLength(2);
    expect(links[0].getAttribute("aria-describedby")).not.toBe(
      links[1].getAttribute("aria-describedby"),
    );
    for (const l of links) expect(l).toHaveAccessibleDescription("2 reviews assigned to you");
  });

  it("re-reads the count when I am assigned a review, and announces the change", async () => {
    list.mockResolvedValue({ reviews: [], total: 1, page: 1, pageSize: 1 });
    renderSidebar();
    expect(await screen.findByTestId("reviews-count")).toHaveTextContent("1");
    // The first value is not announced: nothing changed.
    expect(screen.getByTestId("reviews-count-status")).toHaveTextContent("");

    list.mockResolvedValue({ reviews: [], total: 2, page: 1, pageSize: 1 });
    emit("review:notification");
    await waitFor(() => expect(screen.getByTestId("reviews-count")).toHaveTextContent("2"));
    expect(screen.getByTestId("reviews-count-status")).toHaveTextContent(
      "2 reviews assigned to you",
    );
  });

  it("re-reads the count when a review changes state, and announces 0 when it is done", async () => {
    list.mockResolvedValue({ reviews: [], total: 1, page: 1, pageSize: 1 });
    renderSidebar();
    expect(await screen.findByTestId("reviews-count")).toHaveTextContent("1");

    list.mockResolvedValue({ reviews: [], total: 0, page: 1, pageSize: 1 });
    emit("review:changed");
    await waitFor(() => expect(screen.queryByTestId("reviews-count")).not.toBeInTheDocument());
    expect(screen.getByTestId("reviews-count-status")).toHaveTextContent(
      "No reviews assigned to you",
    );
  });

  it("stops listening when it unmounts", async () => {
    const { unmount } = renderSidebar();
    await waitFor(() => expect(socketHandlers.get("review:notification")?.size).toBe(1));
    unmount();
    expect(socketHandlers.get("review:notification")?.size).toBe(0);
    expect(socketHandlers.get("review:changed")?.size).toBe(0);
  });

  it("words the count for one and for many", () => {
    expect(assignedReviewsText(0)).toBe("No reviews assigned to you");
    expect(assignedReviewsText(1)).toBe("1 review assigned to you");
    expect(assignedReviewsText(4)).toBe("4 reviews assigned to you");
  });
});

describe("<Sidebar /> — mobile drawer (a11y)", () => {
  it("renders as a modal dialog when open", () => {
    renderSidebar({ mobileOpen: true });
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAttribute("aria-label", "Primary navigation");
  });

  it("closes via Escape key", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ mobileOpen: true, onMobileClose: onClose });
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalled();
  });

  it("closes when the built-in close button is activated", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ mobileOpen: true, onMobileClose: onClose });
    await user.click(screen.getByRole("button", { name: /^close$/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("invokes onMobileClose when a nav link inside the drawer is clicked", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderSidebar({ mobileOpen: true, onMobileClose: onClose });
    // Drawer-rendered link (second occurrence — first is in the desktop column).
    const chatLinks = screen.getAllByRole("link", { name: /chat/i });
    await user.click(chatLinks[chatLinks.length - 1]);
    expect(onClose).toHaveBeenCalled();
  });
});
