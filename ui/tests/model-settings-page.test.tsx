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
});
