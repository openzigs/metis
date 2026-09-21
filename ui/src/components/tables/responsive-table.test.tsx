/**
 * ResponsiveTable component tests — Epic #55 / #60.
 *
 * Verifies the two-layout behaviour that backs WCAG 1.4.10 (Reflow) and
 * 2.5.8 (Target Size): a semantic <table> for wide viewports and a stacked
 * <dl> card list for narrow ones, with column labels associated to values in
 * both, plus a helper class that yields ≥44px touch targets on mobile.
 *
 * The active layout is chosen at runtime from a `matchMedia` query, so each
 * test sets `window.matchMedia` to emulate a wide or narrow viewport.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { ResponsiveTable, touchTargetClass, type ResponsiveColumn } from "./responsive-table";

interface Row {
  id: string;
  name: string;
  count: number;
}

const rows: Row[] = [
  { id: "a", name: "Alpha", count: 1 },
  { id: "b", name: "Beta", count: 2 },
];

const columns: ResponsiveColumn<Row>[] = [
  { key: "name", header: "Name", cell: (r) => r.name },
  { key: "count", header: "Count", cell: (r) => String(r.count), align: "right" },
  {
    key: "actions",
    header: <span className="sr-only">Actions</span>,
    cardLabel: "Actions",
    hideCardLabel: true,
    cell: (r) => (
      <a href={`/x/${r.id}`} className={touchTargetClass} data-testid={`open-${r.id}`}>
        Open
      </a>
    ),
  },
];

/** Force `matchMedia` to report a given viewport for the reflow query. */
function setViewport(isMobile: boolean) {
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

function renderTable(props?: Partial<React.ComponentProps<typeof ResponsiveTable<Row>>>) {
  return render(
    <ResponsiveTable
      columns={columns}
      data={rows}
      getRowKey={(r) => r.id}
      ariaLabel="Things"
      rowTestId={(r) => `row-${r.id}`}
      data-testid="things-table"
      {...props}
    />,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("ResponsiveTable — desktop layout", () => {
  it("renders a semantic table with column headers at wide viewports", () => {
    setViewport(false);
    renderTable();
    const table = screen.getByRole("table", { name: "Things" });
    expect(table).toBeInTheDocument();
    // scope=col headers are exposed as columnheaders to assistive tech.
    expect(within(table).getByRole("columnheader", { name: "Name" })).toBeInTheDocument();
    expect(within(table).getByRole("columnheader", { name: "Count" })).toBeInTheDocument();
    // Every data row is present (+ the header row).
    expect(within(table).getAllByRole("row")).toHaveLength(rows.length + 1);
    // No mobile card list is mounted.
    expect(screen.queryByRole("list", { name: "Things" })).not.toBeInTheDocument();
  });

  it("renders an empty-state row when there is no data", () => {
    setViewport(false);
    renderTable({ data: [], emptyContent: "Nothing here" });
    expect(screen.queryByRole("row", { name: /Alpha/ })).not.toBeInTheDocument();
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
  });

  it("supports a visible caption", () => {
    setViewport(false);
    renderTable({ caption: "My caption" });
    expect(screen.getByText("My caption").tagName).toBe("CAPTION");
  });
});

describe("ResponsiveTable — mobile layout", () => {
  it("renders a card list where each value keeps its column label in order", () => {
    setViewport(true);
    renderTable();
    // The mobile layout is a labelled list of cards; no <table> is mounted.
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    const list = screen.getByRole("list", { name: "Things" });
    const cards = within(list).getAllByRole("listitem");
    expect(cards).toHaveLength(rows.length);

    // Definition-list association: each field label (dt) sits with its value (dd)
    // so screen readers announce "Name: Alpha" in column/reading order.
    const firstCard = cards[0];
    const terms = within(firstCard)
      .getAllByRole("term")
      .map((t) => t.textContent);
    // Actions column hides its label on the card; Name + Count remain, in order.
    expect(terms).toEqual(["Name", "Count"]);
    expect(within(firstCard).getByText("Alpha")).toBeInTheDocument();
    expect(within(firstCard).getByText("1")).toBeInTheDocument();
  });

  it("gives interactive card content a ≥44px touch target via touchTargetClass", () => {
    setViewport(true);
    renderTable();
    // touchTargetClass encodes the WCAG 2.5.8 minimum (44px) on mobile and
    // resets it at md+ so desktop rows stay compact.
    expect(touchTargetClass).toContain("min-h-[44px]");
    expect(touchTargetClass).toContain("min-w-[44px]");
    expect(touchTargetClass).toContain("md:min-h-0");

    const link = screen.getByTestId("open-a");
    expect(link).toHaveClass("min-h-[44px]", "min-w-[44px]");
  });

  it("renders the empty state when there is no data", () => {
    setViewport(true);
    renderTable({ data: [], emptyContent: "Nothing here" });
    expect(screen.getByText("Nothing here")).toBeInTheDocument();
    expect(screen.queryByRole("listitem")).not.toBeInTheDocument();
  });
});
