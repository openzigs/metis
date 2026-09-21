/**
 * Epic #852 (#858) — database-aware analysis settings card tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DatabaseAwareAnalysisSettingsCard } from "@/components/projects/database-aware-analysis-settings-card";
import type { DatabaseAwareAnalysisState } from "@/lib/projects-api";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      getDatabaseAwareAnalysis: vi.fn(),
      updateDatabaseAwareAnalysis: vi.fn(),
    },
  };
});

import { projectsApi } from "@/lib/projects-api";

const mocks = projectsApi as unknown as {
  getDatabaseAwareAnalysis: ReturnType<typeof vi.fn>;
  updateDatabaseAwareAnalysis: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mocks.getDatabaseAwareAnalysis.mockReset();
  mocks.updateDatabaseAwareAnalysis.mockReset();
});

function renderCard() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <DatabaseAwareAnalysisSettingsCard projectId="proj_1" />
    </Wrapper>,
  );
}

function state(overrides: Partial<DatabaseAwareAnalysisState>): DatabaseAwareAnalysisState {
  return {
    setting: "auto",
    enabled: true,
    ran: true,
    reason: "auto->resolved-on",
    hasSchemaData: true,
    ...overrides,
  };
}

describe("DatabaseAwareAnalysisSettingsCard", () => {
  it("renders the three options with the current setting selected", async () => {
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(state({ setting: "on" }));
    renderCard();
    const select = (await screen.findByTestId(
      "database-aware-analysis-select",
    )) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["auto", "on", "off"]);
    await waitFor(() => expect(select.value).toBe("on"));
  });

  it("dispatches PATCH with the new setting when the user changes the mode and saves", async () => {
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(state({ setting: "auto" }));
    mocks.updateDatabaseAwareAnalysis.mockResolvedValue({});
    renderCard();
    const select = (await screen.findByTestId(
      "database-aware-analysis-select",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("auto"));

    fireEvent.change(select, { target: { value: "off" } });
    expect(select.value).toBe("off");

    const saveButton = screen.getByTestId("database-aware-analysis-save-button");
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(mocks.updateDatabaseAwareAnalysis).toHaveBeenCalledWith("proj_1", {
        databaseAwareAnalysis: "off",
      }),
    );
  });

  it("disables Save until the draft differs from the loaded setting", async () => {
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(state({ setting: "auto" }));
    renderCard();
    const saveButton = await screen.findByTestId("database-aware-analysis-save-button");
    await waitFor(() => expect(saveButton).toBeDisabled());
  });

  it("shows the no-schema-data hint with an actionable link when resolved on/auto but no schema data exists (skipped-no-schema-data)", async () => {
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(
      state({
        setting: "on",
        enabled: true,
        ran: false,
        reason: "skipped-no-schema-data",
        hasSchemaData: false,
      }),
    );
    renderCard();
    const hint = await screen.findByTestId("database-aware-analysis-no-schema-data-hint");
    expect(hint).toHaveTextContent(
      "No schema data yet — connect a database or re-ingest to enable schema-impact analysis.",
    );
    const link = screen.getByTestId("database-aware-analysis-connect-link");
    expect(link).toHaveAttribute("href", "/projects/proj_1/connections");
  });

  it("shows the no-schema-data hint when auto resolves off due to missing data (auto->resolved-off-no-data)", async () => {
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(
      state({
        setting: "auto",
        enabled: false,
        ran: false,
        reason: "auto->resolved-off-no-data",
        hasSchemaData: false,
      }),
    );
    renderCard();
    expect(
      await screen.findByTestId("database-aware-analysis-no-schema-data-hint"),
    ).toBeInTheDocument();
  });

  it("does NOT render the no-schema-data hint when schema data is present", async () => {
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(
      state({
        setting: "auto",
        enabled: true,
        ran: true,
        reason: "auto->resolved-on",
        hasSchemaData: true,
      }),
    );
    renderCard();
    await screen.findByTestId("database-aware-analysis-select");
    expect(
      screen.queryByTestId("database-aware-analysis-no-schema-data-hint"),
    ).not.toBeInTheDocument();
  });

  it("does NOT render the no-schema-data hint for an explicit off setting even without schema data", async () => {
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(
      state({ setting: "off", enabled: false, ran: false, reason: "off", hasSchemaData: false }),
    );
    renderCard();
    await screen.findByTestId("database-aware-analysis-select");
    expect(
      screen.queryByTestId("database-aware-analysis-no-schema-data-hint"),
    ).not.toBeInTheDocument();
  });

  it("explains a platform-disabled decision and points at the per-project override, without the no-schema-data hint (#849)", async () => {
    // An operator turned the platform flag off; this project never opted out,
    // so the copy must not read as an explicit per-project override — and
    // connecting a database would not change anything, so no hint.
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(
      state({
        setting: "auto",
        enabled: false,
        ran: false,
        reason: "auto->platform-disabled",
        hasSchemaData: true,
      }),
    );
    renderCard();
    const resolved = await screen.findByTestId("database-aware-analysis-resolved-state");
    expect(resolved).toHaveTextContent("disabled by platform configuration");
    expect(resolved).toHaveTextContent("override it for this project");
    expect(
      screen.queryByTestId("database-aware-analysis-no-schema-data-hint"),
    ).not.toBeInTheDocument();
  });

  it("surfaces a save error without leaving a stale Saved toast", async () => {
    mocks.getDatabaseAwareAnalysis.mockResolvedValue(state({ setting: "auto" }));
    mocks.updateDatabaseAwareAnalysis.mockRejectedValue(new Error("network down"));
    renderCard();
    const select = (await screen.findByTestId(
      "database-aware-analysis-select",
    )) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("auto"));
    fireEvent.change(select, { target: { value: "on" } });
    fireEvent.click(screen.getByTestId("database-aware-analysis-save-button"));

    const errorEl = await screen.findByTestId("database-aware-analysis-error");
    expect(errorEl).toHaveTextContent("Failed to save database-aware analysis setting");
    expect(screen.queryByTestId("database-aware-analysis-saved-toast")).not.toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    mocks.getDatabaseAwareAnalysis.mockRejectedValue(new Error("boom"));
    renderCard();
    expect(await screen.findByTestId("database-aware-analysis-load-error")).toBeInTheDocument();
  });
});
