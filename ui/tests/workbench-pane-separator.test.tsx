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
      />
    </div>,
  );
  vi.spyOn(container.current as HTMLDivElement, "getBoundingClientRect").mockReturnValue({
    width,
  } as DOMRect);
  return {
    separator: within(view.container).getByRole("separator", { name: "Resize pane" }),
    onChange,
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
});
