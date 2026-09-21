/**
 * Tests for the FinOps AlertRuleEditor component (Epic #47 / Issue #54).
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AlertRuleEditor } from "@/components/finops/AlertRuleEditor";
import type { AlertRule } from "@/lib/finops-api";

const { api } = vi.hoisted(() => ({
  api: {
    getRules: vi.fn(),
    createRule: vi.fn(),
    updateRule: vi.fn(),
    deleteRule: vi.fn(),
  },
}));

vi.mock("@/lib/finops-api", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return { ...actual, finopsApi: { ...(actual.finopsApi as object), ...api } };
});

function rule(over: Partial<AlertRule> = {}): AlertRule {
  return {
    id: "r1",
    workspaceId: "w1",
    name: "80% projected",
    thresholdPct: 80,
    basis: "projected",
    cooldownSec: 3600,
    enabled: true,
    lastFiredAt: null,
    ...over,
  };
}

function renderEditor() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <AlertRuleEditor workspaceId="w1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  Object.values(api).forEach((m) => (m as ReturnType<typeof vi.fn>).mockReset());
  api.getRules.mockResolvedValue({ rules: [rule()] });
  api.createRule.mockResolvedValue({ rule: rule({ id: "r2" }) });
  api.updateRule.mockResolvedValue({ rule: rule({ enabled: false }) });
  api.deleteRule.mockResolvedValue({ deleted: true });
});

describe("AlertRuleEditor", () => {
  it("lists existing rules", async () => {
    renderEditor();
    expect(await screen.findByText("80% projected")).toBeTruthy();
    expect(screen.getByText(/\(80% projected\)/)).toBeTruthy();
  });

  it("creates a rule with the entered threshold + basis", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText("80% projected");
    const thresholdInput = screen.getByLabelText("Threshold percent");
    await user.clear(thresholdInput);
    await user.type(thresholdInput, "50");
    await user.click(screen.getByRole("button", { name: /add rule/i }));
    await waitFor(() =>
      expect(api.createRule).toHaveBeenCalledWith(
        "w1",
        expect.objectContaining({ thresholdPct: 50, basis: "projected" }),
      ),
    );
  });

  it("applies a preset threshold when a preset button is clicked", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText("80% projected");
    await user.click(screen.getByRole("button", { name: "100%" }));
    await user.click(screen.getByRole("button", { name: /add rule/i }));
    await waitFor(() =>
      expect(api.createRule).toHaveBeenCalledWith(
        "w1",
        expect.objectContaining({ thresholdPct: 100 }),
      ),
    );
  });

  it("toggles a rule's enabled state", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText("80% projected");
    await user.click(screen.getByLabelText("Toggle rule 80% projected"));
    await waitFor(() =>
      expect(api.updateRule).toHaveBeenCalledWith("w1", "r1", { enabled: false }),
    );
  });

  it("deletes a rule", async () => {
    const user = userEvent.setup();
    renderEditor();
    await screen.findByText("80% projected");
    await user.click(screen.getByLabelText("Delete rule 80% projected"));
    await waitFor(() => expect(api.deleteRule).toHaveBeenCalledWith("w1", "r1"));
  });
});
