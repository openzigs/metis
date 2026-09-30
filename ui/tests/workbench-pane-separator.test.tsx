/**
 * #526 — the Workbench pane separator: pointer drag and keyboard, in both
 * directions, clamped to the pane bounds.
 */
import { describe, expect, it, vi } from "vitest";
import { createRef } from "react";
import { fireEvent, render, within } from "@testing-library/react";
import { PaneSeparator } from "@/components/workbench/pane-separator";

function setup(side: "left" | "right", value = 22, width = 1000) {
  const container = createRef<HTMLDivElement>();
  const onChange = vi.fn();
  const onCommit = vi.fn();
  const view = render(
    <div ref={container}>
      <PaneSeparator
        ariaLabel="Resize pane"
        controls="pane"
        side={side}
        value={value}
        min={12}
        max={50}
        container={container}
        onChange={onChange}
        onCommit={onCommit}
      />
    </div>,
  );
  vi.spyOn(container.current as HTMLDivElement, "getBoundingClientRect").mockReturnValue({
    width,
  } as DOMRect);
  return {
    separator: within(view.container).getByRole("separator", { name: "Resize pane" }),
    onChange,
    onCommit,
    unmount: view.unmount,
  };
}

describe("PaneSeparator", () => {
  it("is a focusable vertical separator that reports its value and bounds", () => {
    const { separator } = setup("left");
    expect(separator).toHaveAttribute("tabindex", "0");
    expect(separator).toHaveAttribute("aria-orientation", "vertical");
    expect(separator).toHaveAttribute("aria-valuenow", "22");
    expect(separator).toHaveAttribute("aria-valuemin", "12");
    expect(separator).toHaveAttribute("aria-valuemax", "50");
    expect(separator).toHaveAttribute("aria-controls", "pane");
  });

  it("widens a left pane as it is dragged right", () => {
    const { separator, onChange } = setup("left");
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 150 });
    expect(onChange).toHaveBeenLastCalledWith(27);
  });

  it("narrows a right pane as it is dragged right", () => {
    const { separator, onChange } = setup("right", 26);
    fireEvent.pointerDown(separator, { button: 0, clientX: 800 });
    fireEvent.pointerMove(window, { clientX: 850 });
    expect(onChange).toHaveBeenLastCalledWith(21);
  });

  it("clamps a drag to the bounds", () => {
    const { separator, onChange } = setup("left");
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 2000 });
    expect(onChange).toHaveBeenLastCalledWith(50);
    fireEvent.pointerMove(window, { clientX: -2000 });
    expect(onChange).toHaveBeenLastCalledWith(12);
  });

  it("stops following the pointer once released or cancelled", () => {
    const { separator, onChange } = setup("left");
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    fireEvent.pointerUp(window);
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    fireEvent.pointerCancel(window);
    fireEvent.pointerMove(window, { clientX: 300 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores a secondary button, and a container with no width", () => {
    const { separator, onChange } = setup("left");
    fireEvent.pointerDown(separator, { button: 2, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(onChange).not.toHaveBeenCalled();

    const hidden = setup("right", 26, 0);
    fireEvent.pointerDown(hidden.separator, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 200 });
    expect(hidden.onChange).not.toHaveBeenCalled();
  });

  it("steps with the arrow keys, further with Shift, in the pane's direction", () => {
    const left = setup("left");
    fireEvent.keyDown(left.separator, { key: "ArrowRight" });
    expect(left.onChange).toHaveBeenLastCalledWith(23);
    fireEvent.keyDown(left.separator, { key: "ArrowLeft", shiftKey: true });
    expect(left.onChange).toHaveBeenLastCalledWith(17);

    const right = setup("right", 26);
    fireEvent.keyDown(right.separator, { key: "ArrowRight" });
    expect(right.onChange).toHaveBeenLastCalledWith(25);
    fireEvent.keyDown(right.separator, { key: "ArrowLeft" });
    expect(right.onChange).toHaveBeenLastCalledWith(27);
  });

  it("jumps to the bounds with Home and End, and ignores other keys", () => {
    const { separator, onChange } = setup("left");
    fireEvent.keyDown(separator, { key: "Home" });
    expect(onChange).toHaveBeenLastCalledWith(12);
    fireEvent.keyDown(separator, { key: "End" });
    expect(onChange).toHaveBeenLastCalledWith(50);
    onChange.mockClear();
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("clamps a key step at the bound", () => {
    const { separator, onChange } = setup("left", 50);
    fireEvent.keyDown(separator, { key: "ArrowRight", shiftKey: true });
    expect(onChange).toHaveBeenLastCalledWith(50);
  });

  // #526 review — a handled key must not also scroll the page (Arrow, Home and
  // End all scroll it by default); `fireEvent` returns false once prevented.
  it("cancels the default action of the keys it handles, and only those", () => {
    const { separator } = setup("left");
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      expect(fireEvent.keyDown(separator, { key }), key).toBe(false);
    }
    expect(fireEvent.keyDown(separator, { key: "Tab" })).toBe(true);
  });

  it("cancels a primary-button pointerdown (no text selection), but not a secondary one", () => {
    const { separator } = setup("left");
    expect(fireEvent.pointerDown(separator, { button: 2, clientX: 100 })).toBe(true);
    expect(fireEvent.pointerDown(separator, { button: 0, clientX: 100 })).toBe(false);
    fireEvent.pointerUp(window);
  });

  it("commits once at the end of a drag, with the last width, however many moves", () => {
    const { separator, onChange, onCommit } = setup("left");
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    for (let x = 101; x <= 150; x++) fireEvent.pointerMove(window, { clientX: x });
    expect(onChange).toHaveBeenCalledTimes(50);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerUp(window);
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith(27);
  });

  it("commits a cancelled drag too, and nothing for a press that never moved", () => {
    const { separator, onCommit } = setup("left");
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    fireEvent.pointerUp(window);
    expect(onCommit).not.toHaveBeenCalled();
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    fireEvent.pointerMove(window, { clientX: 110 });
    fireEvent.pointerCancel(window);
    expect(onCommit).toHaveBeenCalledOnce();
    expect(onCommit).toHaveBeenCalledWith(23);
  });

  it("commits every key press", () => {
    const { separator, onCommit } = setup("left");
    fireEvent.keyDown(separator, { key: "ArrowRight" });
    fireEvent.keyDown(separator, { key: "End" });
    expect(onCommit.mock.calls).toEqual([[23], [50]]);
    fireEvent.keyDown(separator, { key: "Enter" });
    expect(onCommit).toHaveBeenCalledTimes(2);
  });

  it("stops listening on the window when unmounted mid-drag", () => {
    const removed = vi.spyOn(window, "removeEventListener");
    const { separator, onChange, onCommit, unmount } = setup("left");
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    unmount();
    const types = removed.mock.calls.map(([type]) => type);
    expect(types).toEqual(expect.arrayContaining(["pointermove", "pointerup", "pointercancel"]));
    fireEvent.pointerMove(window, { clientX: 300 });
    fireEvent.pointerUp(window);
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
    removed.mockRestore();
  });

  it("drops a stale drag's listeners if a new drag starts before it ended", () => {
    const { separator, onChange } = setup("left");
    fireEvent.pointerDown(separator, { button: 0, clientX: 100 });
    fireEvent.pointerDown(separator, { button: 0, clientX: 500 });
    fireEvent.pointerMove(window, { clientX: 510 });
    // Only the second drag follows the pointer: +10px of 1000 → 23, once.
    expect(onChange.mock.calls).toEqual([[23]]);
  });
});
