/**
 * Epic #405 / Issue #415 — ConnectionStatus banner tests.
 *
 * Drives the banner by mocking `useSocketStatus` and re-rendering with new
 * status values. Uses fake timers to assert the debounce (no flash on a brief
 * reconnect) and the min-visible window, and asserts accessibility
 * (role="status" / aria-live) + that `auth:error` is toasted via sonner.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, act } from "@testing-library/react";

vi.mock("@/lib/socket-client", () => ({
  useSocketStatus: vi.fn(),
}));

const toastError = vi.fn();
vi.mock("sonner", () => ({
  toast: { error: (...args: unknown[]) => toastError(...args) },
}));

import { useSocketStatus } from "@/lib/socket-client";
import { ConnectionStatus } from "@/components/realtime/connection-status";

const useSocketStatusMock = useSocketStatus as ReturnType<typeof vi.fn>;

type Status = "connected" | "reconnecting" | "disconnected";
function setStatus(status: Status, error: string | null = null) {
  useSocketStatusMock.mockReturnValue({ status, error });
}

beforeEach(() => {
  vi.useFakeTimers();
  toastError.mockClear();
  useSocketStatusMock.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("<ConnectionStatus />", () => {
  it("renders nothing while connected", () => {
    setStatus("connected");
    const { container } = render(<ConnectionStatus />);
    expect(container.firstChild).toBeNull();
  });

  it("does NOT flash for a brief reconnect shorter than the debounce", () => {
    setStatus("reconnecting");
    const { rerender } = render(<ConnectionStatus />);
    // Below the show-delay → still hidden.
    act(() => vi.advanceTimersByTime(1000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    // Reconnect resolves before the debounce elapses.
    setStatus("connected");
    rerender(<ConnectionStatus />);
    act(() => vi.advanceTimersByTime(2000));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("shows a 'Reconnecting…' banner after the debounce when reconnecting", () => {
    setStatus("reconnecting");
    render(<ConnectionStatus />);
    act(() => vi.advanceTimersByTime(1500));
    const banner = screen.getByRole("status");
    expect(banner).toHaveTextContent(/reconnecting/i);
    expect(banner).toHaveAttribute("aria-live", "polite");
  });

  it("shows an 'Offline' banner when disconnected", () => {
    setStatus("disconnected");
    render(<ConnectionStatus />);
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("status")).toHaveTextContent(/offline/i);
  });

  it("clears the banner after reconnect, honouring the min-visible window", () => {
    setStatus("reconnecting");
    const { rerender } = render(<ConnectionStatus />);
    act(() => vi.advanceTimersByTime(1500)); // banner now visible
    expect(screen.getByRole("status")).toBeInTheDocument();

    // Connection restored.
    setStatus("connected");
    rerender(<ConnectionStatus />);
    // Still within min-visible window → banner persists briefly.
    act(() => vi.advanceTimersByTime(500));
    expect(screen.queryByRole("status")).toBeInTheDocument();
    // After the min-visible window elapses it disappears.
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it("updates the label when status changes while already visible", () => {
    setStatus("reconnecting");
    const { rerender } = render(<ConnectionStatus />);
    act(() => vi.advanceTimersByTime(1500));
    expect(screen.getByRole("status")).toHaveTextContent(/reconnecting/i);
    // Escalates to a hard offline while still showing.
    setStatus("disconnected");
    rerender(<ConnectionStatus />);
    expect(screen.getByRole("status")).toHaveTextContent(/offline/i);
  });

  it("toasts an auth:error message via sonner", () => {
    setStatus("connected", "Forbidden room");
    render(<ConnectionStatus />);
    expect(toastError).toHaveBeenCalledWith("Forbidden room");
  });

  it("does not re-toast the same error on re-render", () => {
    setStatus("connected", "Forbidden room");
    const { rerender } = render(<ConnectionStatus />);
    setStatus("connected", "Forbidden room");
    rerender(<ConnectionStatus />);
    expect(toastError).toHaveBeenCalledTimes(1);
  });

  it("re-toasts when a new distinct error arrives", () => {
    setStatus("connected", "Forbidden room");
    const { rerender } = render(<ConnectionStatus />);
    setStatus("connected", "Another error");
    rerender(<ConnectionStatus />);
    expect(toastError).toHaveBeenCalledTimes(2);
  });
});
