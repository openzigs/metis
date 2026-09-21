/**
 * #1104 (F) — a stranded batch must have a remedy, and a live one must not.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import {
  BatchRowActions,
  cancelDisabledHint,
  type BatchRowActionsBatch,
} from "@/components/publishing/batch-row-actions";

const NOW = Date.parse("2026-07-28T12:00:00.000Z");

function batch(over: Partial<BatchRowActionsBatch> = {}): BatchRowActionsBatch {
  return {
    id: "cms3u7y09003g259kej42fn4q",
    status: "pending",
    archived: false,
    startedAt: new Date(NOW - 13 * 60 * 60 * 1000),
    ...over,
  } as BatchRowActionsBatch;
}

describe("BatchRowActions", () => {
  it("offers Cancel for a batch stranded in pending, and reports the batch id", () => {
    const onCancel = vi.fn();
    render(<BatchRowActions batch={batch()} onWatch={() => {}} onCancel={onCancel} now={NOW} />);
    const button = screen.getByTestId("cancel-batch-cms3u7y09003g259kej42fn4q");
    expect(button).toBeEnabled();
    fireEvent.click(button);
    expect(onCancel).toHaveBeenCalledWith("cms3u7y09003g259kej42fn4q");
  });

  it("shows Cancel disabled — with the reason — while the run may still be in flight", () => {
    const onCancel = vi.fn();
    render(
      <BatchRowActions
        batch={batch({ status: "running", startedAt: new Date(NOW - 60_000) })}
        onWatch={() => {}}
        onCancel={onCancel}
        now={NOW}
      />,
    );
    const button = screen.getByTestId("cancel-batch-cms3u7y09003g259kej42fn4q");
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", expect.stringContaining("may still be running"));
    fireEvent.click(button);
    expect(onCancel).not.toHaveBeenCalled();
  });

  it("offers no Cancel at all for a settled batch", () => {
    render(
      <BatchRowActions
        batch={batch({ status: "completed" })}
        onWatch={() => {}}
        onCancel={() => {}}
        now={NOW}
      />,
    );
    expect(screen.queryByTestId("cancel-batch-cms3u7y09003g259kej42fn4q")).toBeNull();
    expect(screen.getByRole("button", { name: "Watch" })).toBeInTheDocument();
  });

  it("reflects an in-flight cancel request", () => {
    render(
      <BatchRowActions
        batch={batch()}
        onWatch={() => {}}
        onCancel={() => {}}
        cancelPending
        now={NOW}
      />,
    );
    const button = screen.getByTestId("cancel-batch-cms3u7y09003g259kej42fn4q");
    expect(button).toBeDisabled();
    expect(button).toHaveTextContent("Cancelling…");
  });

  it("Watch still works", () => {
    const onWatch = vi.fn();
    render(<BatchRowActions batch={batch()} onWatch={onWatch} onCancel={() => {}} now={NOW} />);
    fireEvent.click(screen.getByRole("button", { name: "Watch" }));
    expect(onWatch).toHaveBeenCalledWith("cms3u7y09003g259kej42fn4q");
  });
});

describe("cancelDisabledHint", () => {
  it("rounds up to whole minutes and never says 0", () => {
    expect(cancelDisabledHint(1)).toContain("1 minute");
    expect(cancelDisabledHint(0)).toContain("1 minute");
    expect(cancelDisabledHint(5 * 60_000)).toContain("5 minutes");
  });

  it("says out loud that cancelling does not recall published issues", () => {
    expect(cancelDisabledHint(60_000)).toMatch(/cannot recall issues already created/i);
  });
});
