/**
 * #464 (epic #459) — Sessions guided empty state.
 *  - Empty data renders guidance + a "Start a chat" CTA linking to /chat.
 *  - Non-empty data still renders the resumable-session list.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { makeWrapper } from "./test-utils";
import SessionsPage from "@/app/(authed)/sessions/page";
import { sdkApi } from "@/lib/sdk-alignment-api";

vi.mock("@/lib/sdk-alignment-api", () => ({
  sdkApi: {
    listResumable: vi.fn(),
    resumeSession: vi.fn(),
  },
}));

const listResumableMock = vi.mocked(sdkApi.listResumable);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("<SessionsPage /> — guided empty state (#464)", () => {
  it("renders guidance and a CTA to /chat when there are no resumable sessions", async () => {
    listResumableMock.mockResolvedValue([]);
    render(<SessionsPage />, { wrapper: makeWrapper({ withAuth: false }) });

    expect(await screen.findByTestId("sessions-empty")).toBeInTheDocument();
    expect(screen.getByText(/last 24 hours/i)).toBeInTheDocument();
    const cta = screen.getByTestId("sessions-empty-cta");
    expect(cta).toHaveAttribute("href", "/chat");
  });

  it("renders the resumable-session list when data is present", async () => {
    listResumableMock.mockResolvedValue([
      {
        id: "sess-1",
        title: "My session",
        model: "claude-sonnet-4-6",
        currentModel: "claude-sonnet-4-6",
        planModeActive: false,
      },
    ] as unknown as Awaited<ReturnType<typeof sdkApi.listResumable>>);
    render(<SessionsPage />, { wrapper: makeWrapper({ withAuth: false }) });

    expect(await screen.findByTestId("sess-row-sess-1")).toBeInTheDocument();
    expect(screen.queryByTestId("sessions-empty")).not.toBeInTheDocument();
  });
});
