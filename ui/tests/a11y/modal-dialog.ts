/**
 * #268 — shared assertion for a modal dialog (APG Dialog pattern): named
 * `role="dialog"` with `aria-modal`, Tab never leaves it, Escape closes it,
 * and focus returns to the control that opened it. The three hand-made
 * overlays this replaced had none of the keyboard behaviour, and one had no
 * dialog role at all.
 */
import { expect } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import type { UserEvent } from "@testing-library/user-event";

export async function expectAccessibleModal(
  user: UserEvent,
  name: string | RegExp,
  opener: HTMLElement,
): Promise<void> {
  const dialog = await screen.findByRole("dialog", { name });
  // Radix marks everything outside the dialog aria-hidden (its modality
  // mechanism, instead of aria-modal), so a screen reader cannot wander out.
  expect(opener.closest("[aria-hidden='true']")).not.toBeNull();
  expect(dialog.contains(document.activeElement)).toBe(true);
  for (let i = 0; i < 8; i += 1) {
    await user.tab();
    expect(dialog.contains(document.activeElement)).toBe(true);
  }
  await user.tab({ shift: true });
  expect(dialog.contains(document.activeElement)).toBe(true);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("dialog", { name })).not.toBeInTheDocument());
  expect(opener).toHaveFocus();
}
