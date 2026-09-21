import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const restore = vi.fn();
vi.mock("@/lib/history-api", () => ({
  historyApi: { restore: (...args: unknown[]) => restore(...args) },
}));

import { RestoreVersionDialog } from "@/components/requirements/RestoreVersionDialog";
import { ApiError } from "@/lib/api-client";

describe("RestoreVersionDialog", () => {
  beforeEach(() => {
    restore.mockReset();
  });

  it("stays closed when version is null", () => {
    render(
      <RestoreVersionDialog
        requirementId="req-1"
        version={null}
        onClose={vi.fn()}
        onRestored={vi.fn()}
      />,
    );
    expect(screen.queryByText(/This creates a new version/)).toBeNull();
  });

  it("keeps confirm disabled until the exact phrase is typed", () => {
    render(
      <RestoreVersionDialog
        requirementId="req-1"
        version={3}
        onClose={vi.fn()}
        onRestored={vi.fn()}
      />,
    );
    const confirmBtn = screen.getByRole("button", { name: "Restore" });
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirmation phrase"), {
      target: { value: "Restore version 2" },
    });
    expect(confirmBtn).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Confirmation phrase"), {
      target: { value: "Restore version 3" },
    });
    expect(confirmBtn).toBeEnabled();
  });

  it("calls restore with the trimmed reason and reports success", async () => {
    restore.mockResolvedValue({ id: "req-1", version: 4, restoredFrom: 3 });
    const onRestored = vi.fn();
    const onClose = vi.fn();
    render(
      <RestoreVersionDialog
        requirementId="req-1"
        version={3}
        onClose={onClose}
        onRestored={onRestored}
      />,
    );
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), {
      target: { value: "Restore version 3" },
    });
    fireEvent.change(screen.getByLabelText("Reason (optional)"), {
      target: { value: "  rollback  " },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));

    await waitFor(() => expect(restore).toHaveBeenCalledWith("req-1", 3, "rollback"));
    expect(onRestored).toHaveBeenCalledWith({ id: "req-1", version: 4, restoredFrom: 3 });
    expect(onClose).toHaveBeenCalled();
  });

  it("sends undefined reason when blank", async () => {
    restore.mockResolvedValue({ id: "req-1", version: 4, restoredFrom: 3 });
    render(
      <RestoreVersionDialog
        requirementId="req-1"
        version={3}
        onClose={vi.fn()}
        onRestored={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), {
      target: { value: "Restore version 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restore).toHaveBeenCalledWith("req-1", 3, undefined));
  });

  it("surfaces an API error and keeps the dialog open", async () => {
    restore.mockRejectedValue(new ApiError(403, "Forbidden"));
    const onClose = vi.fn();
    render(
      <RestoreVersionDialog
        requirementId="req-1"
        version={3}
        onClose={onClose}
        onRestored={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), {
      target: { value: "Restore version 3" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("Forbidden"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("invokes onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(
      <RestoreVersionDialog
        requirementId="req-1"
        version={3}
        onClose={onClose}
        onRestored={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onClose).toHaveBeenCalled();
  });
});
