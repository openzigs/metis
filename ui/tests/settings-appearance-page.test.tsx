/**
 * Epic #196 / #220 — Settings sub-page: Appearance tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import SettingsAppearancePage from "@/app/(authed)/settings/appearance/page";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false, withTheme: true });
  render(
    <Wrapper>
      <SettingsAppearancePage />
    </Wrapper>,
  );
}

describe("<SettingsAppearancePage />", () => {
  it("renders the theme + density sections", () => {
    renderPage();
    expect(screen.getByTestId("settings-appearance-root")).toBeInTheDocument();
    expect(screen.getByTestId("settings-appearance-theme")).toBeInTheDocument();
    expect(screen.getByTestId("settings-appearance-density")).toBeInTheDocument();
  });

  it("persists the chosen density to localStorage and shows a Saved toast", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("settings-appearance-density-compact"));
    expect(window.localStorage.getItem("metis.settings.density")).toBe("compact");
    expect(screen.getByTestId("settings-appearance-saved")).toBeInTheDocument();
  });

  it("flips back to comfortable when the comfortable button is clicked", () => {
    window.localStorage.setItem("metis.settings.density", "compact");
    renderPage();
    fireEvent.click(screen.getByTestId("settings-appearance-density-comfortable"));
    expect(window.localStorage.getItem("metis.settings.density")).toBe("comfortable");
  });
});
