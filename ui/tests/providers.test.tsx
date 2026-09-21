import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { render, waitFor } from "@testing-library/react";
import { Providers } from "@/components/providers";

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  // /me probe issued by AuthProvider on mount when initialUser is null.
  fetchMock.mockResolvedValue({
    ok: false,
    status: 401,
    statusText: "Unauthorized",
    text: () => Promise.resolve(JSON.stringify({ success: false })),
  } as unknown as Response);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("<Providers />", () => {
  it("mounts children inside the full provider tree", async () => {
    const { getByTestId } = render(
      <Providers initialUser={null}>
        <div data-testid="child">ok</div>
      </Providers>,
    );
    expect(getByTestId("child")).toBeInTheDocument();
    // Drain the AuthProvider's pending /me effect so React doesn't warn about
    // an unwrapped state update after the test completes.
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
  });
});
