/** #31 — a panel's header is an h2: the page hosting the panel owns the h1. */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { PanelHeader } from "@/components/layout/panel-header";

describe("<PanelHeader />", () => {
  it("renders the title as a level-2 heading with its description and actions", () => {
    render(
      <PanelHeader title="Skills" description="Reusable blocks" actions={<button>New</button>} />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "Skills" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 1 })).not.toBeInTheDocument();
    expect(screen.getByText("Reusable blocks")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New" })).toBeInTheDocument();
  });

  it("renders nothing it was not given", () => {
    const { container } = render(<PanelHeader />);
    expect(screen.queryByRole("heading")).not.toBeInTheDocument();
    expect(container.querySelector("p")).toBeNull();
    expect(container.firstElementChild?.childElementCount).toBe(1);
  });
});
