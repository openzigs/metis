/**
 * #429 — the sonner Toaster follows the theme chosen in the app's toggle.
 *
 * Sonner defaults to `light`, so without a `theme` prop every toast rendered
 * light on a dark page. The Toaster is mocked to expose the `theme` it receives;
 * next-themes is real, driven through the same localStorage key its toggle writes.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render, screen } from "@testing-library/react";
import { useTheme } from "next-themes";
import { Providers } from "@/components/providers";
import { TEST_USER } from "./test-utils";

vi.mock("sonner", () => ({
  Toaster: ({ theme }: { theme?: string }) => (
    <div data-testid="sonner-toaster" data-theme={theme ?? "(unset)"} />
  ),
  toast: vi.fn(),
}));

// Real next-themes, with `useTheme` spied so one case can simulate the
// pre-resolution render (SSR), where `resolvedTheme` is still undefined.
vi.mock("next-themes", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next-themes")>();
  return { ...actual, useTheme: vi.fn(actual.useTheme) };
});

let setThemeRef: ((theme: string) => void) | undefined;
function ThemeHandle() {
  setThemeRef = useTheme().setTheme;
  return null;
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: TEST_USER })),
    }),
  );
});

afterEach(async () => {
  const actual = await vi.importActual<typeof import("next-themes")>("next-themes");
  vi.mocked(useTheme).mockImplementation(actual.useTheme);
  vi.unstubAllGlobals();
  localStorage.clear();
});

function renderProviders() {
  return render(
    <Providers initialUser={TEST_USER}>
      <ThemeHandle />
    </Providers>,
  );
}

describe("Providers — Toaster theme (#429)", () => {
  it("renders toasts dark when Dark is chosen", () => {
    localStorage.setItem("theme", "dark");
    renderProviders();
    expect(screen.getByTestId("sonner-toaster")).toHaveAttribute("data-theme", "dark");
  });

  it("renders toasts light when Light is chosen", () => {
    localStorage.setItem("theme", "light");
    renderProviders();
    expect(screen.getByTestId("sonner-toaster")).toHaveAttribute("data-theme", "light");
  });

  it("follows a theme change made after mount", () => {
    localStorage.setItem("theme", "light");
    renderProviders();
    act(() => setThemeRef?.("dark"));
    expect(screen.getByTestId("sonner-toaster")).toHaveAttribute("data-theme", "dark");
    act(() => setThemeRef?.("light"));
    expect(screen.getByTestId("sonner-toaster")).toHaveAttribute("data-theme", "light");
  });

  it("resolves System to the OS scheme rather than passing 'system' through", () => {
    // setup.ts stubs matchMedia with matches:false, i.e. a light OS.
    localStorage.setItem("theme", "system");
    renderProviders();
    expect(screen.getByTestId("sonner-toaster")).toHaveAttribute("data-theme", "light");
  });

  it("leaves sonner on 'system' until next-themes has resolved a theme", () => {
    vi.mocked(useTheme).mockImplementation(() => ({
      themes: [],
      setTheme: () => {},
      resolvedTheme: undefined,
    }));
    renderProviders();
    expect(screen.getByTestId("sonner-toaster")).toHaveAttribute("data-theme", "system");
  });
});
