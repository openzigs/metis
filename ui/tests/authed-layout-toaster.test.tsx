import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { Providers } from "@/components/providers";
import AuthedLayout from "@/app/(authed)/layout";
import { makeWrapper, TEST_USER } from "./test-utils";
import { usePathname } from "next/navigation";

vi.mock("sonner", () => ({
  Toaster: () => <div data-testid="sonner-toaster" />,
  toast: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(usePathname).mockReturnValue("/dashboard");
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: () => Promise.resolve(JSON.stringify({ success: true, data: TEST_USER })),
    }),
  );
});

describe("Providers — Toaster", () => {
  it("renders the sonner Toaster component", () => {
    render(
      <Providers initialUser={TEST_USER}>
        <p>child content</p>
      </Providers>,
    );
    expect(screen.getByTestId("sonner-toaster")).toBeInTheDocument();
  });
});

describe("AuthedLayout", () => {
  it("renders children inside the layout", () => {
    render(
      <AuthedLayout>
        <p>hello world</p>
      </AuthedLayout>,
      { wrapper: makeWrapper({ initialUser: TEST_USER }) },
    );
    expect(screen.getByText("hello world")).toBeInTheDocument();
  });
});
