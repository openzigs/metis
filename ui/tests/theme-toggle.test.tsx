import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ThemeProvider } from "next-themes";
import { ThemeToggle } from "@/components/layout/theme-toggle";

function renderToggle(initial: "light" | "dark" | "system" = "light") {
  return render(
    <ThemeProvider attribute="class" defaultTheme={initial} enableSystem>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("<ThemeToggle />", () => {
  it("opens a menu with all three theme options", async () => {
    const user = userEvent.setup();
    renderToggle("light");
    await user.click(screen.getByRole("button", { name: /toggle theme/i }));
    expect(await screen.findByRole("menuitem", { name: /light/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /dark/i })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /system/i })).toBeInTheDocument();
  });

  it("persists the selection to next-themes (localStorage)", async () => {
    const user = userEvent.setup();
    renderToggle("light");
    await user.click(screen.getByRole("button", { name: /toggle theme/i }));
    await user.click(await screen.findByRole("menuitem", { name: /dark/i }));
    // next-themes writes to localStorage under the "theme" key by default.
    expect(window.localStorage.getItem("theme")).toBe("dark");
  });
});
