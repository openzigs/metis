/**
 * Issue #406 — scroll to an in-page anchor whose target mounts late.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { useState } from "react";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useScrollToAnchor } from "./use-scroll-to-anchor";

function Harness({
  anchor,
  onArrived,
  initiallyMounted = false,
}: {
  anchor: string | null;
  onArrived: () => void;
  initiallyMounted?: boolean;
}) {
  const [mounted, setMounted] = useState(initiallyMounted);
  useScrollToAnchor(anchor, onArrived);
  return (
    <div>
      <button type="button" onClick={() => setMounted(true)}>
        Mount
      </button>
      {mounted ? <section id="approvals">approvals</section> : null}
      <section id="other">other</section>
    </div>
  );
}

let scrolled: Element[];
const original = HTMLElement.prototype.scrollIntoView;

beforeEach(() => {
  scrolled = [];
  HTMLElement.prototype.scrollIntoView = vi.fn(function (this: Element) {
    scrolled.push(this);
  });
});

afterEach(() => {
  HTMLElement.prototype.scrollIntoView = original;
});

describe("useScrollToAnchor (#406)", () => {
  it("scrolls once the target mounts, then reports arrival", async () => {
    const onArrived = vi.fn();
    render(<Harness anchor="#approvals" onArrived={onArrived} />);
    expect(scrolled).toEqual([]);
    expect(onArrived).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "Mount" }));
    await act(async () => {});

    expect(scrolled).toEqual([document.getElementById("approvals")]);
    expect(onArrived).toHaveBeenCalledTimes(1);
  });

  it("scrolls straight away when the target is already in the DOM", () => {
    const onArrived = vi.fn();
    render(<Harness anchor="#approvals" onArrived={onArrived} initiallyMounted />);
    expect(scrolled).toEqual([document.getElementById("approvals")]);
    expect(onArrived).toHaveBeenCalledTimes(1);
  });

  it("does nothing without an anchor", async () => {
    const onArrived = vi.fn();
    render(<Harness anchor={null} onArrived={onArrived} />);
    await userEvent.click(screen.getByRole("button", { name: "Mount" }));
    await act(async () => {});
    expect(scrolled).toEqual([]);
    expect(onArrived).not.toHaveBeenCalled();
  });

  it("ignores anything that is not a fragment", () => {
    const onArrived = vi.fn();
    render(<Harness anchor="approvals" onArrived={onArrived} initiallyMounted />);
    expect(scrolled).toEqual([]);
    expect(onArrived).not.toHaveBeenCalled();
  });

  it("stops watching once unmounted", async () => {
    const onArrived = vi.fn();
    const { unmount } = render(<Harness anchor="#approvals" onArrived={onArrived} />);
    unmount();
    const late = document.createElement("section");
    late.id = "approvals";
    document.body.appendChild(late);
    await act(async () => {});
    expect(scrolled).toEqual([]);
    expect(onArrived).not.toHaveBeenCalled();
    late.remove();
  });
});
