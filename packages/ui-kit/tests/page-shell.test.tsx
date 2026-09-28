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
