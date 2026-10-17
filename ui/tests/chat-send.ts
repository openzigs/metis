/**
 * #1139 — chat creates its session on the FIRST SEND, never on page load. Specs
 * that need a session send a message the way a user does.
 */
import { expect } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

/** Type `text` into the chat composer and submit it, once the page is ready. */
export async function sendChatMessage(text = "hello"): Promise<void> {
  const box = screen.getByLabelText("Message") as HTMLInputElement;
  await waitFor(() => expect(box.disabled).toBe(false));
  fireEvent.change(box, { target: { value: text } });
  fireEvent.submit(box.closest("form")!);
}

/** A `streamChat` stand-in: an accepted turn that streams one delta, then ends. */
export async function* acceptedTurn(
  _sessionId: string,
  _message: string,
  _signal?: AbortSignal,
  _model?: string,
  onAccepted?: () => void,
): AsyncGenerator<{ type: "delta"; content: string } | { type: "done" }> {
  onAccepted?.();
  yield { type: "delta", content: "ok" };
  yield { type: "done" };
}
