/**
 * Epic #165 — quick smoke tests for the SDK-alignment UI pages.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import HooksSettingsPage from "@/app/(authed)/settings/hooks/page";
import { sdkApi } from "@/lib/sdk-alignment-api";

vi.mock("@/lib/sdk-alignment-api", () => ({
  sdkApi: {
    listAgents: vi.fn(),
    createAgent: vi.fn(),
    deleteAgent: vi.fn(),
    listHooks: vi.fn(),
    createHook: vi.fn(),
    updateHook: vi.fn(),
    deleteHook: vi.fn(),
  },
}));

const api = vi.mocked(sdkApi);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Hooks settings page (#114)", () => {
  it("requires a project id before showing the form", () => {
    render(<HooksSettingsPage />, { wrapper: makeWrapper() });
    expect(screen.queryByTestId("hk-save")).not.toBeInTheDocument();
  });

  it("disables save until url is https", async () => {
    api.listHooks.mockResolvedValue([]);
    render(<HooksSettingsPage />, { wrapper: makeWrapper() });
    fireEvent.change(screen.getByTestId("hk-project-id"), { target: { value: "p1" } });
    const save = await screen.findByTestId("hk-save");
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByTestId("hk-url"), { target: { value: "https://example.com" } });
    expect(save).not.toBeDisabled();
  });
});
