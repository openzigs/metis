import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Header } from "@/components/layout/header";
import { makeWrapper, TEST_USER } from "./test-utils";

describe("<Header />", () => {
  it("renders the breadcrumb hierarchy and theme toggle", () => {
    render(<Header onMenuClick={() => {}} />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    expect(screen.getByRole("navigation", { name: "Breadcrumb" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /toggle theme/i })).toBeInTheDocument();
  });

  it("invokes onMenuClick when the mobile menu button is clicked", async () => {
    const onMenuClick = vi.fn();
    const user = userEvent.setup();
    render(<Header onMenuClick={onMenuClick} />, {
      wrapper: makeWrapper({ initialUser: TEST_USER }),
    });
    await user.click(screen.getByRole("button", { name: /open navigation/i }));
    expect(onMenuClick).toHaveBeenCalled();
  });
});
