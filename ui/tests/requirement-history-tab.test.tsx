import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

const list = vi.fn();
const restore = vi.fn();
const exportFn = vi.fn();
vi.mock("@/lib/history-api", () => ({
  historyApi: {
    list: (...a: unknown[]) => list(...a),
    restore: (...a: unknown[]) => restore(...a),
    export: (...a: unknown[]) => exportFn(...a),
  },
}));

const useAuth = vi.fn();
vi.mock("@/lib/auth-context", () => ({
  useAuth: () => useAuth(),
}));

// Replace the heavy diff viewer with a marker so we can assert it rendered.
vi.mock("react-diff-viewer-continued", () => ({
  default: ({ leftTitle, rightTitle }: { leftTitle: string; rightTitle: string }) => (
    <div data-testid="diff">
      {leftTitle} vs {rightTitle}
    </div>
  ),
}));

// Radix dropdown relies on pointer APIs jsdom lacks; render a flat menu instead.
vi.mock("@/components/ui/dropdown-menu", () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({
    children,
    onSelect,
  }: {
    children: React.ReactNode;
    onSelect?: () => void;
  }) => (
    <button type="button" onClick={onSelect}>
      {children}
    </button>
  ),
}));

import { RequirementHistoryTab } from "@/components/requirements/RequirementHistoryTab";
import type { RequirementHistoryEntry } from "@/lib/history-api";

function entry(
  version: number,
  overrides: Partial<RequirementHistoryEntry> = {},
): RequirementHistoryEntry {
  return {
    version,
    changedFields: { title: { from: "old", to: "new" } },
    actorId: "user-1",
    reason: null,
    createdAt: "2026-06-09T10:00:00.000Z",
    snapshot: { title: `Title v${version}`, body: "Body", priority: "high" },
    ...overrides,
  };
}

function page(
  entries: RequirementHistoryEntry[],
  total = entries.length,
  currentVersion = entries[0]?.version ?? 0,
) {
  return { versions: entries, total, page: 1, pageSize: 20, currentVersion };
}

describe("RequirementHistoryTab", () => {
  beforeEach(() => {
    list.mockReset();
    restore.mockReset();
    exportFn.mockReset();
    useAuth.mockReturnValue({ user: { role: "reader" } });
  });

  it("renders the timeline from the API", async () => {
    list.mockResolvedValue(page([entry(2), entry(1)]));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText("Version 2")).toBeInTheDocument());
    expect(screen.getByText("Version 1")).toBeInTheDocument();
    expect(screen.getByText(/current v2/)).toBeInTheDocument();
  });

  it("shows an empty state when there is no history", async () => {
    list.mockResolvedValue(page([], 0, 0));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText("No version history yet.")).toBeInTheDocument());
  });

  it("reveals a diff once two versions are selected", async () => {
    list.mockResolvedValue(page([entry(2), entry(1)]));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText("Version 2")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: /Version 2/ }));
    expect(screen.getByText("Select a second version to compare.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Version 1/ }));

    await waitFor(() => expect(screen.getByTestId("version-diff")).toBeInTheDocument());
    expect(screen.getByTestId("diff")).toHaveTextContent("Version 1 vs Version 2");
  });

  it("hides restore controls for readers", async () => {
    list.mockResolvedValue(page([entry(1)]));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText("Version 1")).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
  });

  it("shows restore controls for coordinators and opens the dialog", async () => {
    useAuth.mockReturnValue({ user: { role: "coordinator" } });
    list.mockResolvedValue(page([entry(1)]));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText("Version 1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    expect(screen.getByText(/This creates a new version/)).toBeInTheDocument();
  });

  it("invokes export with the chosen format", async () => {
    exportFn.mockResolvedValue(undefined);
    list.mockResolvedValue(page([entry(1)]));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText("Version 1")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Export as CSV" }));
    await waitFor(() => expect(exportFn).toHaveBeenCalledWith("req-1", "csv"));
    fireEvent.click(screen.getByRole("button", { name: "Export as JSON" }));
    await waitFor(() => expect(exportFn).toHaveBeenCalledWith("req-1", "json"));
  });

  it("renders an error when the list request fails", async () => {
    const { ApiError } = await import("@/lib/api-client");
    list.mockRejectedValue(new ApiError(500, "boom"));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByRole("alert")).toHaveTextContent("boom"));
  });

  it("paginates when there are multiple pages", async () => {
    list.mockResolvedValue(page([entry(1)], 40, 1));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument());
    list.mockResolvedValue({
      versions: [entry(1)],
      total: 40,
      page: 2,
      pageSize: 20,
      currentVersion: 1,
    });
    fireEvent.click(screen.getByRole("button", { name: "Next" }));
    await waitFor(() => expect(list).toHaveBeenLastCalledWith("req-1", { page: 2, pageSize: 20 }));
  });

  it("toggling a selected version off removes it", async () => {
    list.mockResolvedValue(page([entry(2), entry(1)]));
    render(<RequirementHistoryTab requirementId="req-1" />);
    await waitFor(() => expect(screen.getByText("Version 2")).toBeInTheDocument());
    const v2 = screen.getByRole("button", { name: /Version 2/ });
    fireEvent.click(v2);
    expect(v2).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(v2);
    expect(v2).toHaveAttribute("aria-pressed", "false");
  });

  it("calls onRestored after a successful restore", async () => {
    useAuth.mockReturnValue({ user: { role: "admin" } });
    list.mockResolvedValue(page([entry(2)]));
    restore.mockResolvedValue({ id: "req-1", version: 3, restoredFrom: 2 });
    const onRestored = vi.fn();
    render(<RequirementHistoryTab requirementId="req-1" onRestored={onRestored} />);
    await waitFor(() => expect(screen.getByText("Version 2")).toBeInTheDocument());
    // The timeline "Restore" button opens the confirmation dialog.
    fireEvent.click(screen.getByRole("button", { name: "Restore" }));
    fireEvent.change(screen.getByLabelText("Confirmation phrase"), {
      target: { value: "Restore version 2" },
    });
    // Two "Restore" buttons now exist (timeline + dialog confirm); the dialog
    // confirm is rendered last in the document.
    const restoreButtons = screen.getAllByRole("button", { name: "Restore" });
    fireEvent.click(restoreButtons[restoreButtons.length - 1]);
    await waitFor(() => expect(restore).toHaveBeenCalledWith("req-1", 2, undefined));
    await waitFor(() => expect(onRestored).toHaveBeenCalled());
  });
});
