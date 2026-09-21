/**
 * Epic #157 — Chronicle panel tests.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { ChroniclePanel } from "@/components/projects/chronicle-panel";
import { makeWrapper } from "./test-utils";

vi.mock("@/lib/projects-api", async () => {
  const actual = await vi.importActual<typeof import("@/lib/projects-api")>("@/lib/projects-api");
  return {
    ...actual,
    chronicleApi: {
      list: vi.fn(),
      record: vi.fn(),
      forget: vi.fn(),
      updateSettings: vi.fn(),
    },
  };
});

import { chronicleApi } from "@/lib/projects-api";

const mocks = chronicleApi as {
  list: ReturnType<typeof vi.fn>;
  record: ReturnType<typeof vi.fn>;
  forget: ReturnType<typeof vi.fn>;
  updateSettings: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  mocks.list.mockReset();
  mocks.record.mockReset();
  mocks.forget.mockReset();
  mocks.updateSettings.mockReset();
});

function renderPanel() {
  const Wrapper = makeWrapper({});
  return render(
    <Wrapper>
      <ChroniclePanel projectId="proj_1" />
    </Wrapper>,
  );
}

describe("ChroniclePanel", () => {
  it("shows the disabled hint when chronicle is off", async () => {
    mocks.list.mockResolvedValue({ items: [], enabled: false });
    renderPanel();
    expect(await screen.findByText(/Chronicle is disabled/i)).toBeInTheDocument();
  });

  it("renders entries when enabled", async () => {
    mocks.list.mockResolvedValue({
      enabled: true,
      items: [
        {
          id: "c1",
          projectId: "proj_1",
          key: "stack",
          value: "node 22",
          sourceSessionId: null,
          expiresAt: null,
          createdAt: new Date().toISOString(),
        },
      ],
    });
    renderPanel();
    expect(await screen.findByTestId("chronicle-row-c1")).toBeInTheDocument();
    expect(screen.getByText("stack")).toBeInTheDocument();
    expect(screen.getByText("node 22")).toBeInTheDocument();
  });

  it("records a new entry", async () => {
    mocks.list.mockResolvedValue({ enabled: true, items: [] });
    mocks.record.mockResolvedValue({});
    renderPanel();
    fireEvent.change(await screen.findByTestId("chronicle-key-input"), {
      target: { value: "deploy" },
    });
    fireEvent.change(screen.getByTestId("chronicle-value-input"), {
      target: { value: "us-east-1" },
    });
    fireEvent.click(screen.getByTestId("chronicle-record"));
    await waitFor(() =>
      expect(mocks.record).toHaveBeenCalledWith("proj_1", {
        key: "deploy",
        value: "us-east-1",
      }),
    );
  });

  it("toggles enable/disable", async () => {
    mocks.list.mockResolvedValue({ enabled: false, items: [] });
    mocks.updateSettings.mockResolvedValue({});
    renderPanel();
    const toggle = (await screen.findByTestId("chronicle-enable")) as HTMLInputElement;
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(mocks.updateSettings).toHaveBeenCalledWith("proj_1", {
        chronicleEnabled: true,
      }),
    );
  });
});
