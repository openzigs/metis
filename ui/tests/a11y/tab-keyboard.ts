/**
 * #268 — shared assertion for the APG Tabs keyboard contract, used by each
 * page that used to hand-roll its tablist. The hand-rolled versions had
 * `role="tab"` but no key handling, so every step below failed on them.
 */
import { expect } from "vitest";
import { act, screen, within } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export async function expectApgTabKeyboard(user: UserEvent, tablistName: string | RegExp) {
  const tablist = screen.getByRole("tablist", { name: tablistName });
  const tabs = within(tablist).getAllByRole("tab");
  expect(tabs.length).toBeGreaterThan(1);
  const selected = tabs.findIndex((t) => t.getAttribute("aria-selected") === "true");
  expect(selected).toBeGreaterThanOrEqual(0);

  act(() => tabs[selected].focus());
  const next = (selected + 1) % tabs.length;
  await user.keyboard("{ArrowRight}");
  expect(tabs[next]).toHaveFocus();
  expect(tabs[next]).toHaveAttribute("aria-selected", "true");
  expect(tabs[selected]).toHaveAttribute("aria-selected", "false");

  // Each tab points at its panel; the active panel is labelled by the tab.
  const panel = document.getElementById(tabs[next].getAttribute("aria-controls") ?? "");
  expect(panel).not.toBeNull();
  expect(panel).toHaveAttribute("role", "tabpanel");
  expect(panel).toHaveAttribute("aria-labelledby", tabs[next].id);

  await user.keyboard("{ArrowLeft}");
  expect(tabs[selected]).toHaveFocus();
  expect(tabs[selected]).toHaveAttribute("aria-selected", "true");

  await user.keyboard("{End}");
  expect(tabs[tabs.length - 1]).toHaveFocus();
  await user.keyboard("{Home}");
  expect(tabs[0]).toHaveFocus();
}
