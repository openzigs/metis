/**
 * Epic #593 / Issue #602 — Model preferences settings page tests.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { makeWrapper } from "./test-utils";

// Mock next/navigation
const mockPush = vi.fn();
vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "proj-1" }),
  useRouter: () => ({ push: mockPush }),
}));

// Mock the API
const mockGet = vi.fn();
const mockUpdate = vi.fn();
vi.mock("@/lib/model-preferences-api", () => ({
  modelPreferencesApi: {
    get: (...args: unknown[]) => mockGet(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

const MOCK_PREFS = {
  projectId: "proj-1",
  defaultModel: null,
  taskTypeOverrides: {},
  budgetDowngradeThreshold: null,
  availableModels: [
    { id: "us.anthropic.claude-haiku-4-5-20251001-v1:0", name: "Claude Haiku 4.5", tier: "fast" },
    {
      id: "us.anthropic.claude-sonnet-5",
      name: "Claude Sonnet 5",
      tier: "balanced",
    },
    { id: "us.anthropic.claude-fable-5", name: "Claude Fable 5", tier: "fast" },
    { id: "us.anthropic.claude-opus-4-8", name: "Claude Opus 4.8", tier: "complex" },
  ],
};

// Dynamically import after mocks
const { default: ModelSettingsPage } =
  await import("@/app/(authed)/projects/[id]/settings/models/page");

function renderPage() {
  const Wrapper = makeWrapper({ withAuth: false });
  render(
    <Wrapper>
      <ModelSettingsPage />
    </Wrapper>,
  );
}

describe("ProjectModelSettingsPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGet.mockResolvedValue(MOCK_PREFS);
    mockUpdate.mockResolvedValue(MOCK_PREFS);
  });

  it("renders loading state then settings", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("model-settings-root")).toBeInTheDocument();
    });
    expect(screen.getByText("Model Preferences")).toBeInTheDocument();
  });

  it("renders default model selector", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
    });
    const select = screen.getByTestId("default-model-select") as HTMLSelectElement;
    expect(select.value).toBe("auto");
  });

  it("renders budget threshold slider", async () => {
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("budget-threshold-slider")).toBeInTheDocument();
    });
  });

  it("calls update API on save", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("save-model-prefs")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("save-model-prefs"));
    await waitFor(() => {
      expect(mockUpdate).toHaveBeenCalledWith("proj-1", {
        defaultModel: null,
        budgetDowngradeThreshold: null,
        taskTypeOverrides: undefined,
      });
    });
  });

  it("shows advanced section when toggled", async () => {
    const user = userEvent.setup();
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("advanced-toggle")).toBeInTheDocument();
    });
    await user.click(screen.getByTestId("advanced-toggle"));
    expect(screen.getByTestId("override-document_analysis")).toBeInTheDocument();
    expect(screen.getByTestId("override-code_review")).toBeInTheDocument();
  });

  it("populates form with existing preferences", async () => {
    mockGet.mockResolvedValue({
      ...MOCK_PREFS,
      defaultModel: "us.anthropic.claude-sonnet-5",
      budgetDowngradeThreshold: 500000,
    });
    renderPage();
    await waitFor(() => {
      const select = screen.getByTestId("default-model-select") as HTMLSelectElement;
      expect(select.value).toBe("us.anthropic.claude-sonnet-5");
    });
  });

  it("offers exactly the backend-accepted model ids and aligned labels", async () => {
    // Source of truth: server/src/routes/model-preferences.ts (validModelIds)
    // and server/src/lib/ai/model-router.ts (MODEL_REGISTRY).
    const HAIKU_ID = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    const SONNET_ID = "us.anthropic.claude-sonnet-5";
    const FABLE_ID = "us.anthropic.claude-fable-5";
    const OPUS_ID = "us.anthropic.claude-opus-4-8";
    renderPage();
    await waitFor(() => {
      expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
    });
    const options = Array.from(
      (screen.getByTestId("default-model-select") as HTMLSelectElement).options,
    );
    expect(options.map((o) => o.value)).toEqual(["auto", HAIKU_ID, SONNET_ID, FABLE_ID, OPUS_ID]);
    expect(options[0].textContent).toContain("Auto (recommended)");
    expect(options[1].textContent).toContain("Claude Haiku 4.5");
    expect(options[2].textContent).toContain("Claude Sonnet 5");
    expect(options[3].textContent).toContain("Claude Fable 5");
    expect(options[4].textContent).toContain("Claude Opus 4.8");
  });

  // #713 — "Claude Fable 5" is routed `fast` but is the dearest option; it was
  // labelled "Faster and cheaper" at $11 / $55, and Opus "most expensive" at
  // $5.50 / $27.50. Cost wording now follows the listed prices, not the tier.
  describe("cost wording follows the listed prices (#713)", () => {
    const price = (inputPerMTok: number, outputPerMTok: number) => ({
      inputPerMTok,
      outputPerMTok,
    });
    const PRICED = {
      ...MOCK_PREFS,
      availableModels: [
        { ...MOCK_PREFS.availableModels[0], price: price(1.1, 5.5) },
        { ...MOCK_PREFS.availableModels[1], price: price(2.2, 11) },
        { ...MOCK_PREFS.availableModels[2], price: price(11, 55) },
        { ...MOCK_PREFS.availableModels[3], price: price(5.5, 27.5) },
      ],
    };

    async function optionTexts(): Promise<string[]> {
      mockGet.mockResolvedValue(PRICED);
      renderPage();
      await waitFor(() => {
        expect(
          (screen.getByTestId("default-model-select") as HTMLSelectElement).options,
        ).toHaveLength(5);
      });
      return Array.from(
        (screen.getByTestId("default-model-select") as HTMLSelectElement).options,
      ).map((o) => o.textContent ?? "");
    }

    it("never calls Fable cheaper, and calls it the most expensive", async () => {
      const fable = (await optionTexts())[3];
      expect(fable).toContain("Claude Fable 5");
      expect(fable).not.toMatch(/cheap/i);
      expect(fable).toContain("most expensive ($11 / $55 per MTok)");
    });

    it("calls only the cheapest model cheapest, and Opus not the most expensive", async () => {
      const texts = await optionTexts();
      expect(texts[1]).toContain("Claude Haiku 4.5 — Best for simple tasks — cheapest");
      expect(texts.filter((t) => /cheap/i.test(t))).toHaveLength(1);
      expect(texts[4]).toContain("Claude Opus 4.8 — Highest capability ($5.50");
      expect(texts[4]).not.toContain("most expensive");
    });

    it("makes no cost claim when prices are unknown", async () => {
      renderPage();
      await waitFor(() => {
        expect(
          (screen.getByTestId("default-model-select") as HTMLSelectElement).options,
        ).toHaveLength(5);
      });
      const all = Array.from(
        (screen.getByTestId("default-model-select") as HTMLSelectElement).options,
      )
        .map((o) => o.textContent)
        .join(" ");
      expect(all).not.toMatch(/cheap|expensive/i);
    });
  });

  describe("on a provider that does not serve the Claude tiers (#713)", () => {
    const DEEPSEEK_PREFS = {
      ...MOCK_PREFS,
      availableModels: [
        { id: "deepseek-flash", name: "deepseek-flash", tier: "configured", price: null },
      ],
      servesTierModels: false,
    };

    it("offers the provider's model, with no Claude option and no price", async () => {
      mockGet.mockResolvedValue(DEEPSEEK_PREFS);
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
      });
      const options = Array.from(
        (screen.getByTestId("default-model-select") as HTMLSelectElement).options,
      );
      expect(options.map((o) => o.value)).toEqual(["auto", "deepseek-flash"]);
      expect(options[1].textContent).toBe(
        "deepseek-flash — The model this deployment's provider runs",
      );
      expect(options.map((o) => o.textContent).join(" ")).not.toMatch(/Claude|\$/);
    });

    it("saves the provider's model as the default", async () => {
      mockGet.mockResolvedValue(DEEPSEEK_PREFS);
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
      });
      await user.selectOptions(screen.getByTestId("default-model-select"), "deepseek-flash");
      await user.click(screen.getByTestId("save-model-prefs"));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      expect(mockUpdate.mock.calls[0][1]).toMatchObject({ defaultModel: "deepseek-flash" });
    });

    it("shows a Claude tier pinned before the switch as Auto, and saves Auto", async () => {
      mockGet.mockResolvedValue({
        ...DEEPSEEK_PREFS,
        defaultModel: "us.anthropic.claude-sonnet-5",
      });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect((screen.getByTestId("default-model-select") as HTMLSelectElement).value).toBe(
          "auto",
        );
      });
      await user.click(screen.getByTestId("save-model-prefs"));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      expect(mockUpdate.mock.calls[0][1]).toMatchObject({ defaultModel: null });
    });

    it("does not promise a Sonnet-to-Haiku downgrade, and disables the threshold", async () => {
      mockGet.mockResolvedValue(DEEPSEEK_PREFS);
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId("budget-threshold-help")).toBeInTheDocument();
      });
      const help = screen.getByTestId("budget-threshold-help").textContent ?? "";
      expect(help).not.toMatch(/Sonnet|Haiku/);
      expect(help).toContain("no cheaper model");
      expect(screen.getByTestId("budget-threshold-slider")).toBeDisabled();
    });

    it("keeps the downgrade wording where the tiers are served", async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId("budget-threshold-help")).toBeInTheDocument();
      });
      expect(screen.getByTestId("budget-threshold-help").textContent).toContain(
        "downgrades from Sonnet to Haiku",
      );
      expect(screen.getByTestId("budget-threshold-slider")).not.toBeDisabled();
    });
  });

  // #713 cycle 2 — a model saved under one provider and absent from the
  // current provider's list must not survive in state behind an "Auto" display,
  // whatever the provider: every Save would send it and the server would 400.
  describe("a saved model the current provider does not list (#713)", () => {
    it("on a tier-serving provider, shows a DeepSeek pin as Auto and saves Auto", async () => {
      mockGet.mockResolvedValue({ ...MOCK_PREFS, defaultModel: "deepseek-flash" });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId("save-model-prefs")).toBeInTheDocument();
      });
      expect((screen.getByTestId("default-model-select") as HTMLSelectElement).value).toBe("auto");
      await user.click(screen.getByTestId("save-model-prefs"));
      await waitFor(() => expect(mockUpdate).toHaveBeenCalled());
      expect(mockUpdate.mock.calls[0][1]).toMatchObject({ defaultModel: null });
    });

    it("says the saved model is unavailable and that saving switches to Auto", async () => {
      mockGet.mockResolvedValue({ ...MOCK_PREFS, defaultModel: "deepseek-flash" });
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
      });
      expect(screen.getByTestId("stale-default-model-notice").textContent).toBe(
        "Your saved model deepseek-flash isn't available on this provider; saving will switch to Auto.",
      );
    });

    it("withdraws the notice once another model is picked", async () => {
      mockGet.mockResolvedValue({ ...MOCK_PREFS, defaultModel: "deepseek-flash" });
      const user = userEvent.setup();
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId("stale-default-model-notice")).toBeInTheDocument();
      });
      await user.selectOptions(
        screen.getByTestId("default-model-select"),
        "us.anthropic.claude-sonnet-5",
      );
      expect(screen.queryByTestId("stale-default-model-notice")).not.toBeInTheDocument();
    });

    it("shows no notice when the saved model is listed", async () => {
      mockGet.mockResolvedValue({ ...MOCK_PREFS, defaultModel: "us.anthropic.claude-sonnet-5" });
      renderPage();
      await waitFor(() => {
        expect((screen.getByTestId("default-model-select") as HTMLSelectElement).value).toBe(
          "us.anthropic.claude-sonnet-5",
        );
      });
      expect(screen.queryByTestId("stale-default-model-notice")).not.toBeInTheDocument();
    });

    it("shows no notice when nothing is saved", async () => {
      renderPage();
      await waitFor(() => {
        expect(screen.getByTestId("default-model-select")).toBeInTheDocument();
      });
      expect(screen.queryByTestId("stale-default-model-notice")).not.toBeInTheDocument();
    });
  });
});
