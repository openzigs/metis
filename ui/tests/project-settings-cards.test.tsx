/**
 * Epic #164 — UI tests for the project Settings safety/budget/autopilot
 * cards + the new /projects/:id/usage page.
 *
 * The cards share the Phase 12 dirty-state Save + 2s Saved-toast pattern; the
 * tests exercise the dirty/saved/error transitions and the special handling
 * for the budget 402 / autopilot warning.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type React from "react";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { ApiError } from "@/lib/api-client";
import { SafetySettingsCard } from "@/components/projects/safety-settings-card";
import { BudgetSettingsCard } from "@/components/projects/budget-settings-card";
import { AutopilotSettingsCard } from "@/components/projects/autopilot-settings-card";
import { makeWrapper } from "./test-utils";

vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}));
import { toast } from "sonner";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      updateSafety: vi.fn(),
      updateBudget: vi.fn(),
      updateAutopilot: vi.fn(),
    },
  };
});

import { projectsApi } from "@/lib/projects-api";

const updateSafety = projectsApi.updateSafety as unknown as ReturnType<typeof vi.fn>;
const updateBudget = projectsApi.updateBudget as unknown as ReturnType<typeof vi.fn>;
const updateAutopilot = projectsApi.updateAutopilot as unknown as ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  updateSafety.mockReset();
  updateBudget.mockReset();
  updateAutopilot.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

function renderWithWrapper(node: React.ReactElement) {
  const Wrapper = makeWrapper({});
  return render(<Wrapper>{node}</Wrapper>);
}

describe("SafetySettingsCard", () => {
  it("renders current mode and disables Save until dirty", () => {
    renderWithWrapper(<SafetySettingsCard projectId="p1" current="standard" />);
    expect((screen.getByTestId("safety-mode-select") as HTMLSelectElement).value).toBe("standard");
    expect(screen.getByTestId("safety-save-button")).toBeDisabled();
    expect(screen.getByTestId("safety-hint")).toHaveTextContent(/Default/);
  });

  it("saves a new mode and shows the 2s toast", async () => {
    updateSafety.mockResolvedValue({ id: "p1", safetyMode: "strict" });
    renderWithWrapper(<SafetySettingsCard projectId="p1" current="standard" />);
    fireEvent.change(screen.getByTestId("safety-mode-select"), { target: { value: "strict" } });
    expect(screen.getByTestId("safety-save-button")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("safety-save-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(updateSafety).toHaveBeenCalledWith("p1", { safetyMode: "strict" });
    expect(screen.getByTestId("safety-saved-toast")).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(screen.queryByTestId("safety-saved-toast")).not.toBeInTheDocument();
  });
});

describe("BudgetSettingsCard", () => {
  it("blocks editing when canEdit is false", () => {
    renderWithWrapper(<BudgetSettingsCard projectId="p1" current={1000} canEdit={false} />);
    expect(screen.getByTestId("budget-input")).toBeDisabled();
    expect(screen.getByTestId("budget-save-button")).toBeDisabled();
    expect(screen.getByTestId("budget-readonly-note")).toBeInTheDocument();
  });

  it("rejects non-positive integers locally", async () => {
    renderWithWrapper(<BudgetSettingsCard projectId="p1" current={null} />);
    const input = screen.getByTestId("budget-input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0" } });
    fireEvent.click(screen.getByTestId("budget-save-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(updateBudget).not.toHaveBeenCalled();
    expect(screen.getByTestId("budget-error")).toHaveTextContent(/positive integer/i);
  });

  it("surfaces the 402 BUDGET_EXCEEDED toast inline on save failure", async () => {
    updateBudget.mockRejectedValueOnce(
      new ApiError(402, "Project monthly budget exceeded", "BUDGET_EXCEEDED"),
    );
    renderWithWrapper(<BudgetSettingsCard projectId="p1" current={null} />);
    fireEvent.change(screen.getByTestId("budget-input"), { target: { value: "500" } });
    fireEvent.click(screen.getByTestId("budget-save-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(updateBudget).toHaveBeenCalledWith("p1", { monthlyTokenBudget: 500 });
    expect(screen.getByTestId("budget-error")).toHaveTextContent(/budget exceeded/i);
    expect(screen.queryByTestId("budget-saved-toast")).not.toBeInTheDocument();
  });

  it("surfaces a 403 inline as 'Admin role required'", async () => {
    updateBudget.mockRejectedValueOnce(new ApiError(403, "Forbidden", "FORBIDDEN"));
    renderWithWrapper(<BudgetSettingsCard projectId="p1" current={null} />);
    fireEvent.change(screen.getByTestId("budget-input"), { target: { value: "1000" } });
    fireEvent.click(screen.getByTestId("budget-save-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(screen.getByTestId("budget-error")).toHaveTextContent(/admin role required/i);
  });
});

describe("AutopilotSettingsCard", () => {
  it("hides the warning when autopilot is disabled", () => {
    renderWithWrapper(
      <AutopilotSettingsCard projectId="p1" enabled={false} costCeilingCents={null} />,
    );
    expect(screen.queryByTestId("autopilot-warning")).not.toBeInTheDocument();
  });

  it("shows the warning banner when toggled on", () => {
    renderWithWrapper(
      <AutopilotSettingsCard projectId="p1" enabled={false} costCeilingCents={null} />,
    );
    fireEvent.click(screen.getByTestId("autopilot-toggle"));
    expect(screen.getByTestId("autopilot-warning")).toBeInTheDocument();
  });

  it("converts the USD ceiling to integer cents on save", async () => {
    updateAutopilot.mockResolvedValue({ id: "p1", autopilotEnabled: true });
    renderWithWrapper(
      <AutopilotSettingsCard projectId="p1" enabled={true} costCeilingCents={null} />,
    );
    fireEvent.change(screen.getByTestId("autopilot-ceiling-input"), {
      target: { value: "12.34" },
    });
    fireEvent.click(screen.getByTestId("autopilot-save-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(updateAutopilot).toHaveBeenCalledWith("p1", {
      enabled: true,
      costCeilingCents: 1234,
    });
  });

  it("shows a Sonner toast (not a local Saved badge) on save", async () => {
    updateAutopilot.mockResolvedValue({ id: "p1", autopilotEnabled: true });
    renderWithWrapper(
      <AutopilotSettingsCard projectId="p1" enabled={true} costCeilingCents={null} />,
    );
    fireEvent.change(screen.getByTestId("autopilot-ceiling-input"), {
      target: { value: "5.00" },
    });
    fireEvent.click(screen.getByTestId("autopilot-save-button"));
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(toast.success).toHaveBeenCalledWith("Autopilot settings saved");
    expect(screen.queryByTestId("autopilot-saved-toast")).not.toBeInTheDocument();
  });
});
