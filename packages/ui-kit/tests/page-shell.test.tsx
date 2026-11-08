/**
 * #270 — page shell primitives: one PageHeader (title, description, actions)
 * with the single page-title style, an EmptyState, and the skeleton a route
 * `loading.tsx` shows while the page's header and content load.
 *
 * #271 — shadcn-style Breadcrumb primitives; only BreadcrumbPage carries
 * `aria-current="page"`.
 */
import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
  EmptyState,
  PAGE_HEADER_TEXT_COLUMN_CLASS,
  PAGE_HEADER_UNFLOORED_CLASS,
  PAGE_HEADER_WITH_ACTIONS_CLASS,
  PAGE_TITLE_CLASS,
  PageHeader,
  PageHeaderSkeleton,
} from "../src/index";

describe("PageHeader (#270)", () => {
  it("renders the title as the page's h1 in the one page-title style", () => {
    render(<PageHeader title="Projects" />);
    const h1 = screen.getByRole("heading", { level: 1, name: "Projects" });
    expect(h1.className).toBe(PAGE_TITLE_CLASS);
    expect(PAGE_TITLE_CLASS).toBe("text-2xl font-semibold tracking-tight");
  });

  it("renders the description, the actions and the eyebrow when given", () => {
    render(
      <PageHeader
        eyebrow={<a href="/back">Back</a>}
        title="Agents"
        titleExtra={<span>beta</span>}
        description="Persona definitions."
        actions={<button type="button">New agent</button>}
      />,
    );
    const header = screen.getByRole("banner", { hidden: true });
    expect(within(header).getByText("Persona definitions.")).toBeInTheDocument();
    expect(within(header).getByRole("button", { name: "New agent" })).toBeInTheDocument();
    expect(within(header).getByRole("link", { name: "Back" })).toBeInTheDocument();
    expect(within(header).getByText("beta")).toBeInTheDocument();
    // The adornment sits beside the heading, not inside its accessible name.
    expect(screen.getByRole("heading", { level: 1 })).toHaveAccessibleName("Agents");
  });

  // #1889 — layout is the e2e spec's to prove (`page-header-long-actions.spec.ts`);
  // this pins the classes it depends on, so a revert fails in seconds, not on CI.
  it("lays a header with actions out as a grid whose actions may shrink and wrap", () => {
    render(<PageHeader title="Chat" actions={<button type="button">New chat</button>} />);
    const header = screen.getByRole("banner", { hidden: true });
    for (const cls of PAGE_HEADER_WITH_ACTIONS_CLASS.split(" ")) {
      expect(header).toHaveClass(cls);
    }
    expect(PAGE_HEADER_WITH_ACTIONS_CLASS).toBe(
      "sm:grid sm:grid-cols-[minmax(min-content,1fr)_auto]",
    );
    const actions = header.querySelector('[data-slot="page-header-actions"]');
    expect(actions).toHaveClass("min-w-0", "flex-wrap");
    expect(actions).not.toHaveClass("shrink-0");
  });

  it("keeps a header with no actions a plain flex row", () => {
    render(<PageHeader title="Only a title" />);
    const header = screen.getByRole("banner", { hidden: true });
    expect(header).not.toHaveClass("sm:grid");
    expect(header).toHaveClass("sm:flex-row", "sm:justify-between");
  });

  // #1960 — the grid's `min-content` floor is measured over the whole title
  // column, so a long unbreakable token in the description (or a child, or the
  // eyebrow) widened the title track and pushed the actions past the header's
  // right edge. Everything but the title row is left out of that measurement.
  // jsdom has no layout (Chromium's measurements are in the PR); this pins the
  // classes, and the DOM shape they rely on.
  describe("a long description token beside actions (#1960)", () => {
    const TOKEN = "x".repeat(200);

    function renderWithActions() {
      return render(
        <PageHeader
          eyebrow={<a href="/back">Back</a>}
          title="Chat"
          titleExtra={<span>beta</span>}
          description={`Description ${TOKEN}`}
          actions={<button type="button">New chat</button>}
        >
          <p>First child {TOKEN}</p>
          <a href="/more">Inline child</a>
        </PageHeader>,
      );
    }

    it("floors the title column on the title row alone, so the actions keep their place", () => {
      renderWithActions();
      const header = screen.getByRole("banner", { hidden: true });
      const description = within(header).getByText(`Description ${TOKEN}`);
      expect(description).toHaveClass(PAGE_HEADER_UNFLOORED_CLASS);
      expect(within(header).getByRole("link", { name: "Back" }).parentElement).toHaveClass(
        PAGE_HEADER_UNFLOORED_CLASS,
      );
      // One wrapper holds the children, so an inline child (which containment
      // does not apply to on its own) is left out of the floor as well.
      const first = within(header).getByText(`First child ${TOKEN}`);
      const inline = within(header).getByRole("link", { name: "Inline child" });
      expect(first.parentElement).toBe(inline.parentElement);
      expect(first.parentElement).toHaveClass(PAGE_HEADER_UNFLOORED_CLASS, "space-y-1");
      // The title row still sets the floor: neither the h1 nor its row is contained.
      const h1 = screen.getByRole("heading", { level: 1, name: "Chat" });
      expect(h1).not.toHaveClass(PAGE_HEADER_UNFLOORED_CLASS);
      expect(h1.parentElement).not.toHaveClass(PAGE_HEADER_UNFLOORED_CLASS);
      expect(PAGE_HEADER_UNFLOORED_CLASS).toBe("sm:contain-inline-size");
      // The actions keep their own column, after the title column.
      const actions = header.querySelector('[data-slot="page-header-actions"]');
      expect(actions?.previousElementSibling).toBe(description.parentElement);
    });

    it("drops the flex-row classes the grid makes dead", () => {
      renderWithActions();
      const header = screen.getByRole("banner", { hidden: true });
      expect(header).not.toHaveClass("sm:flex-row");
      expect(header).not.toHaveClass("sm:justify-between");
    });

    it("contains nothing in a header with no actions, whose width the description still sets", () => {
      const { container } = render(
        <PageHeader eyebrow={<a href="/back">Back</a>} title="Projects" description={TOKEN}>
          <p>Child</p>
        </PageHeader>,
      );
      expect(container.getElementsByClassName(PAGE_HEADER_UNFLOORED_CLASS)).toHaveLength(0);
    });

    it("renders no children wrapper when the children are empty", () => {
      const { container } = render(
        <PageHeader title="Chat" actions={<button type="button">New chat</button>}>
          {null}
          {false}
        </PageHeader>,
      );
      const column = screen.getByRole("heading", { level: 1 }).parentElement;
      expect(column?.children).toHaveLength(1);
      expect(container.getElementsByClassName(PAGE_HEADER_UNFLOORED_CLASS)).toHaveLength(0);
    });

    // #1985 — contained, the description lays out at the column's width, but
    // an unbreakable token still overflowed its `<p>` and painted over the
    // actions. The column breaks it (`break-word`, which leaves min-content,
    // and so the title row's floor, as it was).
    it("breaks a long token inside the text column, not over the actions", () => {
      renderWithActions();
      const description = screen.getByText(`Description ${TOKEN}`);
      const column = description.parentElement;
      expect(column).toHaveClass(...PAGE_HEADER_TEXT_COLUMN_CLASS.split(" "));
      expect(PAGE_HEADER_TEXT_COLUMN_CLASS.split(" ")).toEqual(
        expect.arrayContaining(["min-w-0", "break-words"]),
      );
      expect(column).toBe(screen.getByRole("heading", { level: 1 }).parentElement?.parentElement);
    });

    it("hides the children wrapper when a child element renders nothing", () => {
      function Nothing() {
        return null;
      }
      const { container } = render(
        <PageHeader title="Chat" actions={<button type="button">New chat</button>}>
          <Nothing />
        </PageHeader>,
      );
      const wrapper = container.querySelector(`.${CSS.escape(PAGE_HEADER_UNFLOORED_CLASS)}`);
      expect(wrapper).toBeEmptyDOMElement();
      expect(wrapper).toHaveClass("empty:hidden");
    });
  });

  it("omits the description and actions containers when not given", () => {
    const { container } = render(<PageHeader title="Only a title" />);
    expect(container.querySelector("p")).toBeNull();
    expect(container.querySelector('[data-slot="page-header-actions"]')).toBeNull();
  });

  it("forwards an id to the h1 for aria-labelledby wiring", () => {
    render(
      <section aria-labelledby="page-title">
        <PageHeader title="Settings" titleId="page-title" />
      </section>,
    );
    expect(screen.getByRole("region", { name: "Settings" })).toBeInTheDocument();
  });
});

describe("EmptyState (#270)", () => {
  it("renders a title, a description, an icon hidden from AT and an action", () => {
    render(
      <EmptyState
        icon={<svg data-testid="icon" />}
        title="No projects yet"
        description="Create one to get started."
        action={<button type="button">New project</button>}
      />,
    );
    expect(screen.getByText("No projects yet")).toBeInTheDocument();
    expect(screen.getByText("Create one to get started.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New project" })).toBeInTheDocument();
    expect(screen.getByTestId("icon").parentElement).toHaveAttribute("aria-hidden", "true");
  });

  it("can render its title as a heading, so it stays in the page outline", () => {
    render(<EmptyState title="All synced up!" titleAs="h2" />);
    expect(screen.getByRole("heading", { level: 2, name: "All synced up!" })).toBeInTheDocument();
  });

  it("renders only the title when that is all it is given", () => {
    const { container } = render(<EmptyState title="Nothing here" />);
    expect(container.querySelectorAll("p")).toHaveLength(1);
    expect(container.querySelector('[aria-hidden="true"]')).toBeNull();
  });
});

describe("PageHeaderSkeleton (#270)", () => {
  it("is an announced loading region built from Skeleton blocks", () => {
    render(<PageHeaderSkeleton label="Loading projects…" />);
    const status = screen.getByRole("status");
    expect(status).toHaveAttribute("aria-busy", "true");
    expect(status).toHaveTextContent("Loading projects…");
    expect(status.querySelectorAll(".animate-pulse").length).toBeGreaterThanOrEqual(2);
  });
});

describe("Breadcrumb (#271)", () => {
  it("is a labelled nav whose current page alone carries aria-current", () => {
    render(
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink href="/projects/p1/connections">Sources</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>Connections</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>,
    );
    const nav = screen.getByRole("navigation", { name: "Breadcrumb" });
    const current = nav.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent("Connections");
    expect(screen.getByRole("link", { name: "Sources" })).not.toHaveAttribute("aria-current");
    // The separator is decoration.
    expect(nav.querySelector('li[aria-hidden="true"]')).not.toBeNull();
  });

  it("BreadcrumbLink can render a router link through asChild", () => {
    render(
      <BreadcrumbLink asChild>
        <a href="/x" data-router="yes">
          X
        </a>
      </BreadcrumbLink>,
    );
    expect(screen.getByRole("link", { name: "X" })).toHaveAttribute("data-router", "yes");
  });
});
