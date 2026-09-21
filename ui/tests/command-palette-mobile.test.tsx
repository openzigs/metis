/**
 * CommandPalette render tests — Epic #55 / #61.
 *
 * Covers the mobile bottom-sheet variant and the keyboard + screen-reader
 * semantics of the ⌘K palette:
 *   - Mobile (<768px): the dialog is anchored to the bottom as a sheet; desktop
 *     keeps the centered dialog. The active layout is chosen at runtime from a
 *     `matchMedia` query (same convention as ResponsiveTable / #60).
 *   - Keyboard: ArrowUp/ArrowDown move the active option, Enter selects it,
 *     Escape dismisses (Radix), and focus is trapped on the search input.
 *   - Screen reader: a dialog with an accessible name + aria-modal (Radix), a
 *     combobox input wired to a listbox via aria-controls / aria-activedescendant,
 *     role=option children with aria-selected, and a polite results announcement.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, within, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useRouter } from "next/navigation";

// Deterministic project list so the palette has a project option in addition to
// the static NAV_ITEMS registry.
const listProjects = vi.fn();
vi.mock("@/lib/projects-api", () => ({
  projectsApi: {
    list: (...args: unknown[]) => listProjects(...args),
  },
}));

import { CommandPalette } from "@/components/command-palette/command-palette";

/** Force `matchMedia` to report a given viewport for the bottom-sheet query. */
function setViewport(isMobile: boolean): void {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: isMobile,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function renderPalette(): void {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <CommandPalette />
    </QueryClientProvider>,
  );
}

/** Render, open the palette via its ⌘K global shortcut, and wait for the dialog. */
async function openPalette(): Promise<HTMLElement> {
  renderPalette();
  fireEvent.keyDown(window, { key: "k", ctrlKey: true });
  return screen.findByRole("dialog", { name: "Command palette" });
}

beforeEach(() => {
  vi.clearAllMocks();
  listProjects.mockResolvedValue({ items: [{ id: "p1", name: "Alpha Project" }] });
  setViewport(false);
});

afterEach(() => {
  cleanup();
});

describe("CommandPalette — accessibility semantics", () => {
  it("exposes a modal dialog with an accessible name (screen reader)", async () => {
    const dialog = await openPalette();
    // Radix supplies role=dialog + aria-modal; DialogTitle supplies the name.
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Command palette");
  });

  it("wires the search input as a combobox controlling the results listbox", async () => {
    await openPalette();
    const input = screen.getByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    expect(input).toHaveAttribute("aria-controls", listbox.id);
    expect(input).toHaveAttribute("aria-expanded", "true");
    expect(input).toHaveAttribute("aria-autocomplete", "list");
    // Results are exposed as options; the first is active by default.
    const options = within(listbox).getAllByRole("option");
    expect(options.length).toBeGreaterThan(0);
    expect(options[0]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[0].id);
  });

  it("announces the result count in a polite live region", async () => {
    await openPalette();
    const status = screen.getByTestId("command-palette-status");
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status.textContent).toMatch(/\d+ results?/);
  });

  it("keeps focus trapped on the search input when opened", async () => {
    await openPalette();
    const input = screen.getByRole("combobox", { name: "Search commands" });
    await waitFor(() => expect(input).toHaveFocus());
  });
});

describe("CommandPalette — keyboard navigation", () => {
  it("moves the active option with ArrowDown / ArrowUp", async () => {
    await openPalette();
    const input = screen.getByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    expect(options[0]).toHaveAttribute("aria-selected", "true");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    expect(within(listbox).getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    expect(input).toHaveAttribute("aria-activedescendant", options[1].id);

    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(within(listbox).getAllByRole("option")[0]).toHaveAttribute("aria-selected", "true");
  });

  it("wraps from the first option to the last on ArrowUp", async () => {
    await openPalette();
    const input = screen.getByRole("combobox", { name: "Search commands" });
    const listbox = screen.getByRole("listbox");
    const options = within(listbox).getAllByRole("option");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(options[options.length - 1]).toHaveAttribute("aria-selected", "true");
  });

  it("selects the active option with Enter and navigates", async () => {
    await openPalette();
    const input = screen.getByRole("combobox", { name: "Search commands" });
    const firstOption = within(screen.getByRole("listbox")).getAllByRole("option")[0];
    const href = firstOption.getAttribute("data-href");
    fireEvent.keyDown(input, { key: "Enter" });
    const push = vi.mocked(useRouter)().push;
    expect(push).toHaveBeenCalledWith(href);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("dismisses on Escape", async () => {
    const dialog = await openPalette();
    fireEvent.keyDown(dialog, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("selects an option on mouse click", async () => {
    await openPalette();
    const firstOption = within(screen.getByRole("listbox")).getAllByRole("option")[0];
    const href = firstOption.getAttribute("data-href");
    fireEvent.click(firstOption);
    const push = vi.mocked(useRouter)().push;
    expect(push).toHaveBeenCalledWith(href);
  });

  it("shows an empty state and announces no results for an unmatched query", async () => {
    await openPalette();
    const input = screen.getByRole("combobox", { name: "Search commands" });
    fireEvent.change(input, { target: { value: "zzzqqqnope" } });
    await waitFor(() => expect(screen.getByText("No matches.")).toBeInTheDocument());
    expect(within(screen.getByRole("listbox")).queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByTestId("command-palette-status").textContent).toBe("No results");
    // Enter with no active option is a no-op (does not navigate).
    fireEvent.keyDown(input, { key: "Enter" });
    expect(vi.mocked(useRouter)().push).not.toHaveBeenCalled();
  });
});

describe("CommandPalette — responsive variant", () => {
  it("renders the centered dialog variant on wide viewports", async () => {
    setViewport(false);
    await openPalette();
    const content = screen.getByTestId("command-palette");
    expect(content).toHaveAttribute("data-variant", "dialog");
    expect(content).not.toHaveClass("bottom-0");
  });

  it("renders a bottom-sheet variant on narrow viewports", async () => {
    setViewport(true);
    await openPalette();
    const content = screen.getByTestId("command-palette");
    expect(content).toHaveAttribute("data-variant", "sheet");
    // Anchored to the bottom edge, full-width, un-centered.
    expect(content).toHaveClass("bottom-0", "max-w-full", "translate-y-0");
    // Bottom sheet keeps its keyboard + SR semantics.
    expect(screen.getByRole("combobox", { name: "Search commands" })).toBeInTheDocument();
    expect(within(screen.getByRole("listbox")).getAllByRole("option").length).toBeGreaterThan(0);
  });
});
