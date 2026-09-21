/**
 * Epic #882 (#894) — SQL-lineage settings card tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SqlLineageSettingsCard } from "@/components/projects/sql-lineage-settings-card";
import type { SqlLineageState } from "@/lib/projects-api";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    projectsApi: {
      ...actual.projectsApi,
      getSqlLineage: vi.fn(),
      updateSqlLineage: vi.fn(),
    },
  };
});

import { projectsApi } from "@/lib/projects-api";

const mocks = projectsApi as unknown as {
  getSqlLineage: ReturnType<typeof vi.fn>;
  updateSqlLineage: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mocks.getSqlLineage.mockReset();
  mocks.updateSqlLineage.mockReset();
});

function renderCard() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <SqlLineageSettingsCard projectId="proj_1" />
    </Wrapper>,
  );
}

function state(overrides: Partial<SqlLineageState>): SqlLineageState {
  return {
    setting: "auto",
    enabled: true,
    reason: "auto->platform-enabled",
    sidecarConfigured: true,
    ...overrides,
  };
}

describe("SqlLineageSettingsCard", () => {
  it("renders the three options with the current setting selected", async () => {
    mocks.getSqlLineage.mockResolvedValue(state({ setting: "on" }));
    renderCard();
    const select = (await screen.findByTestId("sql-lineage-select")) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.value);
    expect(options).toEqual(["auto", "on", "off"]);
    await waitFor(() => expect(select.value).toBe("on"));
  });

  it("dispatches PATCH with the new setting when the user changes the mode and saves", async () => {
    mocks.getSqlLineage.mockResolvedValue(state({ setting: "auto" }));
    mocks.updateSqlLineage.mockResolvedValue({});
    renderCard();
    const select = (await screen.findByTestId("sql-lineage-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("auto"));

    fireEvent.change(select, { target: { value: "off" } });
    expect(select.value).toBe("off");

    const saveButton = screen.getByTestId("sql-lineage-save-button");
    expect(saveButton).toBeEnabled();
    fireEvent.click(saveButton);

    await waitFor(() =>
      expect(mocks.updateSqlLineage).toHaveBeenCalledWith("proj_1", { sqlLineage: "off" }),
    );
  });

  it("disables Save until the draft differs from the loaded setting", async () => {
    mocks.getSqlLineage.mockResolvedValue(state({ setting: "auto" }));
    renderCard();
    const saveButton = await screen.findByTestId("sql-lineage-save-button");
    await waitFor(() => expect(saveButton).toBeDisabled());
  });

  it("shows the sidecar-unconfigured hint when enabled but the token is not configured", async () => {
    mocks.getSqlLineage.mockResolvedValue(
      state({ setting: "on", enabled: true, reason: "on", sidecarConfigured: false }),
    );
    renderCard();
    const hint = await screen.findByTestId("sql-lineage-sidecar-unconfigured-hint");
    expect(hint).toHaveTextContent("SQL_LINEAGE_TOKEN");
  });

  it("does NOT render the sidecar-unconfigured hint when the sidecar is configured", async () => {
    mocks.getSqlLineage.mockResolvedValue(
      state({ setting: "on", enabled: true, reason: "on", sidecarConfigured: true }),
    );
    renderCard();
    await screen.findByTestId("sql-lineage-select");
    expect(screen.queryByTestId("sql-lineage-sidecar-unconfigured-hint")).not.toBeInTheDocument();
  });

  it("does NOT render the sidecar-unconfigured hint when disabled", async () => {
    mocks.getSqlLineage.mockResolvedValue(
      state({
        setting: "auto",
        enabled: false,
        reason: "auto->platform-disabled",
        sidecarConfigured: false,
      }),
    );
    renderCard();
    await screen.findByTestId("sql-lineage-select");
    expect(screen.queryByTestId("sql-lineage-sidecar-unconfigured-hint")).not.toBeInTheDocument();
  });

  it("surfaces a save error without leaving a stale Saved toast", async () => {
    mocks.getSqlLineage.mockResolvedValue(state({ setting: "auto" }));
    mocks.updateSqlLineage.mockRejectedValue(new Error("network down"));
    renderCard();
    const select = (await screen.findByTestId("sql-lineage-select")) as HTMLSelectElement;
    await waitFor(() => expect(select.value).toBe("auto"));
    fireEvent.change(select, { target: { value: "on" } });
    fireEvent.click(screen.getByTestId("sql-lineage-save-button"));

    const errorEl = await screen.findByTestId("sql-lineage-error");
    expect(errorEl).toHaveTextContent("Failed to save SQL-lineage setting");
    expect(screen.queryByTestId("sql-lineage-saved-toast")).not.toBeInTheDocument();
  });

  it("surfaces a load error", async () => {
    mocks.getSqlLineage.mockRejectedValue(new Error("boom"));
    renderCard();
    expect(await screen.findByTestId("sql-lineage-load-error")).toBeInTheDocument();
  });
});
