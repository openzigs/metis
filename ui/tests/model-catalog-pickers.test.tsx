/**
 * #135 — both model pickers render from the server-side model catalog; no
 * model list lives in `ui/src`.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeWrapper } from "./test-utils";

vi.mock("next/navigation", () => ({
  useParams: () => ({ id: "proj-1" }),
  useRouter: () => ({ push: vi.fn() }),
}));

const mockPrefsGet = vi.fn();
vi.mock("@/lib/model-preferences-api", () => ({
  modelPreferencesApi: { get: (...a: unknown[]) => mockPrefsGet(...a), update: vi.fn() },
}));

const mockCatalogList = vi.fn();
vi.mock("@/lib/model-catalog-api", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/model-catalog-api")>("@/lib/model-catalog-api");
  return { ...actual, modelCatalogApi: { list: (...a: unknown[]) => mockCatalogList(...a) } };
});

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      list: vi.fn(async () => ({
        items: [
          {
            id: "proj-1",
            name: "Alpha",
            slug: "alpha",
            status: "active",
            createdById: "u-1",
            createdAt: "",
            updatedAt: "",
          },
        ],
        total: 1,
        limit: 50,
        offset: 0,
      })),
    },
  };
});

const { default: ModelSettingsPage } =
  await import("@/app/(authed)/projects/[id]/settings/models/page");
const { AgentAuthoringWizard } = await import("@/components/custom-agents/AgentAuthoringWizard");
const { formatModelPrice } = await import("@/lib/model-catalog-api");

const CAPS = { tools: true, jsonSchema: true, jsonObject: true, vision: false, thinking: false };

beforeEach(() => {
  vi.clearAllMocks();
});

describe("formatModelPrice", () => {
  it("formats USD per MTok and says nothing for an unpriced model", () => {
    expect(formatModelPrice({ price: { inputPerMTok: 2.2, outputPerMTok: 11 } })).toBe(
      "$2.20 / $11 per MTok",
    );
    expect(formatModelPrice({ price: null })).toBeNull();
  });
});

describe("model settings page renders the catalog's router models", () => {
  it("options, labels, prices and override choices all come from availableModels", async () => {
    mockPrefsGet.mockResolvedValue({
      projectId: "proj-1",
      defaultModel: null,
      taskTypeOverrides: {},
      budgetDowngradeThreshold: null,
      availableModels: [
        {
          id: "catalog-model-a",
          name: "Catalog Model A",
          tier: "fast",
          price: { inputPerMTok: 1, outputPerMTok: 5 },
        },
        { id: "catalog-model-b", name: "Catalog Model B", tier: "exotic", price: null },
      ],
    });
    const Wrapper = makeWrapper({ withAuth: false });
    render(
      <Wrapper>
        <ModelSettingsPage />
      </Wrapper>,
    );
    await waitFor(() => expect(screen.getByTestId("default-model-select")).toBeInTheDocument());
    const options = Array.from(
      (screen.getByTestId("default-model-select") as HTMLSelectElement).options,
    );
    expect(options.map((o) => o.value)).toEqual(["auto", "catalog-model-a", "catalog-model-b"]);
    expect(options[1].textContent).toContain("Catalog Model A");
    expect(options[1].textContent).toContain("$1 / $5 per MTok");
    expect(options[2].textContent).toContain("exotic");
    fireEvent.click(screen.getByTestId("advanced-toggle"));
    const override = screen.getByTestId("override-general") as HTMLSelectElement;
    expect(Array.from(override.options).map((o) => o.value)).toEqual([
      "",
      "catalog-model-a",
      "catalog-model-b",
    ]);
  });
});

describe("agent wizard renders the configured provider's catalog", () => {
  it("offers exactly the catalog's models after the inherit option", async () => {
    mockCatalogList.mockResolvedValue({
      provider: "local-gemma",
      defaultModel: "gemma3:12b",
      models: [
        {
          provider: "local-gemma",
          id: "gemma3:12b",
          displayName: "gemma3:12b",
          contextWindow: 131072,
          maxOutputTokens: null,
          price: { inputPerMTok: 0, outputPerMTok: 0 },
          capabilities: CAPS,
          source: "discovered",
        },
      ],
    });
    const Wrapper = makeWrapper({});
    render(
      <Wrapper>
        <AgentAuthoringWizard workspaceId="ws-1" />
      </Wrapper>,
    );
    await waitFor(() => expect(mockCatalogList).toHaveBeenCalled());
    await waitFor(() => expect(screen.getByText("Alpha")).toBeInTheDocument());
    fireEvent.change(screen.getByTestId("wizard-name-input"), { target: { value: "My Analyst" } });
    fireEvent.change(screen.getByTestId("wizard-project-select"), { target: { value: "proj-1" } });
    fireEvent.click(screen.getByTestId("wizard-next")); // prompt
    fireEvent.change(screen.getByTestId("wizard-prompt-input"), { target: { value: "P." } });
    fireEvent.click(screen.getByTestId("wizard-next")); // tools
    fireEvent.click(screen.getByTestId("wizard-next")); // model
    await waitFor(() => {
      const opts = Array.from(
        (screen.getByTestId("wizard-model-select") as HTMLSelectElement).options,
      ).map((o) => o.value);
      expect(opts).toEqual(["", "gemma3:12b"]);
    });
    expect(screen.getByTestId("wizard-model-select").textContent).toContain(
      "gemma3:12b — $0 / $0 per MTok",
    );
  });
});
