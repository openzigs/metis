/**
 * DataMappingsPanel tests (Epic #889, issue #894).
 *
 * Covers render (list + connector label + confidence), empty/error states,
 * add, remove, and suggest→accept flows against mocked #892/#893 APIs.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { RequirementDataMappingDetail, SuggestDataMappingsResult } from "@metis/shared";

const { dataMappingsApi, dbConnectorsApi, toast } = vi.hoisted(() => ({
  dataMappingsApi: {
    list: vi.fn(),
    create: vi.fn(),
    remove: vi.fn(),
    suggest: vi.fn(),
  },
  dbConnectorsApi: { list: vi.fn() },
  toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("@/lib/data-mappings-api", () => ({ dataMappingsApi }));
vi.mock("@/lib/connectors-api", () => ({ dbConnectorsApi }));
vi.mock("sonner", () => ({ toast }));

import { DataMappingsPanel } from "@/components/traceability/data-mappings-panel";

function mapping(over: Partial<RequirementDataMappingDetail> = {}): RequirementDataMappingDetail {
  return {
    id: "m1",
    requirementId: "req-1",
    dbConnectorId: "db-1",
    dbConnectorLabel: "Prod DB",
    schemaName: "public",
    tableName: "users",
    columnName: "email",
    confidence: 0.9,
    source: "manual",
    note: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...over,
  };
}

function renderPanel() {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  return render(
    <QueryClientProvider client={qc}>
      <DataMappingsPanel projectId="proj-1" requirementId="req-1" />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  dataMappingsApi.list.mockResolvedValue([]);
  dbConnectorsApi.list.mockResolvedValue([{ id: "db-1", label: "Prod DB" }]);
});

describe("DataMappingsPanel", () => {
  it("renders linked mappings with connector label and confidence", async () => {
    dataMappingsApi.list.mockResolvedValue([mapping()]);
    renderPanel();

    const row = await screen.findByTestId("data-mapping-row");
    expect(within(row).getByText("public.users.email")).toBeInTheDocument();
    expect(within(row).getByText(/90% confidence/)).toBeInTheDocument();
    expect(within(row).getByText("Prod DB")).toBeInTheDocument();
  });

  it("shows the empty state when there are no mappings", async () => {
    renderPanel();
    expect(await screen.findByText(/No data mappings linked yet/i)).toBeInTheDocument();
  });

  it("shows an error state when the list query fails", async () => {
    dataMappingsApi.list.mockRejectedValue(new Error("boom"));
    renderPanel();
    expect(await screen.findByRole("alert")).toHaveTextContent(/Failed to load data mappings/i);
  });

  it("adds a mapping via the form", async () => {
    const user = userEvent.setup();
    dataMappingsApi.create.mockResolvedValue(mapping());
    renderPanel();
    await screen.findByText(/No data mappings linked yet/i);

    await user.click(screen.getByRole("button", { name: "Add mapping" }));
    // Radix Select: open the trigger, then choose the option.
    await user.click(screen.getByRole("combobox", { name: "Database connector" }));
    await user.click(await screen.findByRole("option", { name: "Prod DB" }));
    await user.type(screen.getByLabelText("Table"), "orders");
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    await waitFor(() =>
      expect(dataMappingsApi.create).toHaveBeenCalledWith("proj-1", "req-1", {
        dbConnectorId: "db-1",
        tableName: "orders",
        schemaName: null,
        columnName: null,
        note: null,
      }),
    );
    expect(toast.success).toHaveBeenCalledWith("Data mapping added");
  });

  it("validates required fields before submitting", async () => {
    const user = userEvent.setup();
    renderPanel();
    await screen.findByText(/No data mappings linked yet/i);

    await user.click(screen.getByRole("button", { name: "Add mapping" }));
    // Bypass native required by submitting via the save button without selecting.
    await user.click(screen.getByRole("button", { name: "Save mapping" }));

    expect(dataMappingsApi.create).not.toHaveBeenCalled();
  });

  it("removes a mapping", async () => {
    const user = userEvent.setup();
    dataMappingsApi.list.mockResolvedValue([mapping()]);
    dataMappingsApi.remove.mockResolvedValue(undefined);
    renderPanel();

    const row = await screen.findByTestId("data-mapping-row");
    await user.click(within(row).getByRole("button", { name: /Remove mapping/ }));

    await waitFor(() =>
      expect(dataMappingsApi.remove).toHaveBeenCalledWith("proj-1", "req-1", "m1"),
    );
    expect(toast.success).toHaveBeenCalledWith("Data mapping removed");
  });

  it("suggests candidates and accepts one", async () => {
    const user = userEvent.setup();
    const result: SuggestDataMappingsResult = {
      candidates: [
        {
          dbConnectorId: "db-1",
          dbConnectorLabel: "Prod DB",
          schemaName: "public",
          tableName: "accounts",
          columnName: "email",
          confidence: 0.42,
          lowConfidence: true,
          rationale: "email column likely stores user emails",
          source: "llm-suggested",
        },
      ],
      budgetExhausted: false,
      note: null,
    };
    dataMappingsApi.suggest.mockResolvedValue(result);
    dataMappingsApi.create.mockResolvedValue(mapping());
    renderPanel();
    await screen.findByText(/No data mappings linked yet/i);

    await user.click(screen.getByRole("button", { name: "Suggest mappings" }));

    const candidate = await screen.findByTestId("data-mapping-candidate");
    expect(within(candidate).getByText("public.accounts.email")).toBeInTheDocument();
    expect(within(candidate).getByText(/42% confidence/)).toBeInTheDocument();
    expect(within(candidate).getByText(/email column likely/)).toBeInTheDocument();

    await user.click(within(candidate).getByRole("button", { name: /Accept suggestion/ }));

    await waitFor(() =>
      expect(dataMappingsApi.create).toHaveBeenCalledWith("proj-1", "req-1", {
        dbConnectorId: "db-1",
        tableName: "accounts",
        schemaName: "public",
        columnName: "email",
        confidence: 0.42,
        source: "llm-suggested",
        note: "email column likely stores user emails",
      }),
    );
  });

  it("surfaces the suggest note when no candidates are returned", async () => {
    const user = userEvent.setup();
    dataMappingsApi.suggest.mockResolvedValue({
      candidates: [],
      budgetExhausted: false,
      note: "No ingested database schema found for this project.",
    });
    renderPanel();
    await screen.findByText(/No data mappings linked yet/i);

    await user.click(screen.getByRole("button", { name: "Suggest mappings" }));
    expect(await screen.findByText(/No ingested database schema/i)).toBeInTheDocument();
  });
});
